// dshome-agent-roles — 角色卡 → 独立 persona 子代理（host 插件）。
//
// 为什么：官方团队插件（@deepseek-ai/dsh-experimental-tool-agent-team）给不了「每个成员独立系统提示词」——
//   它只按 Team membership 装同一套工具 + 同一段 POLICY，persona 是部署级/预设级的一份。
//   本插件把「角色卡」（markdown：frontmatter 定能力面/模型，正文=系统提示词）接到 DSH 原生子代理接缝上：
//   persona 真替换部署 persona（`request.persona` → 子会话 `deployment:persona-prefix` 作用域段），
//   工具面按卡收窄（`request.toolFilter` → `childCtx.tools.restrict`），模型按卡路由（`request.agentOptions`）。
//
// 与官方范式的同构点（照抄结构、不照抄内容）：
//   · 三把工具注册进「顶层 agent 的精确 scope」而不是宿主平面全局 —— `dsh-experimental-tool-agent-team/lib/index.js:225-548`
//     （全局注册会让子代理也看得见、`restrict` 又管不到；`dsh-tools/lib/index.js:2781,2854-2880`）。
//   · 管控者协议不是 pre-step 塞消息，而是同一 scoped install 里的 `systemPrompt.section`（官方 `:238-245`）。
//   · `exec.agent` 是唯一正确的 parent（`dsh-tools/lib/types/index.d.ts:208`；官方 `dsh-tool-subagent/lib/index.js:490-492`
//     —— 先判空、缺则抛清晰错误）。`exec.parent` 是 token，绝不能当 parent。
//   · `startContinuable({ provider, label, request, signal })`（`dsh-subagent/lib/types/types.d.ts:26-44`）。
//     `maxDepth` 是**绝对**深度上限（校验 `delegationDepth(parent)+1 > maxDepth`），顶层(=0)起成员必须传 1
//     （`dsh-subagent/lib/index.js:432-437`）；传 0 直接抛。
//   · `role_send` 以 `dsh-tool-subagent-control/lib/index.js:51-59` 的 `send_message` 为范式：
//     `ctx.subagents.sendMessage(sender, targetId, content, { signal })`。
//   · 工具定义形态照 `packages/imagegen-plugin/lib/index.js:956-1045`：raw `ctx.tools.register({name,description,
//     parameters: <JSON Schema>, output:{schema,render}, execute})`，**不引 `defineTool`**（少一个 import 面）。
//     `register` 只校验 output.schema（`dsh-tools/lib/index.js:2773-2782`），execute 的返回值会被
//     `validateJsonSchemaValue(output.schema, value)` 逐一校验（`:3415-3418`）——所以 schema 与返回形态必须对齐。
//
// 全程 fails-open：apply 外层 try/catch，初始化失败只 warn、绝不 rethrow；工具内部错误一律返回结构化值，
// 不抛穿工具边界（`dispatchToolBody` 虽会兜住 throw，但结构化错误对模型更可读）。
//
// 导出纯函数（供 `scripts/verify-agent-roles.mjs` 真断言）：parseCard / discoverCards / selectCard /
// buildToolFilter / composePersona / renderPolicyText / buildStartSpec / reportHint / parseRoleLabel /
// normalizeTools / normalizeModel。fs 只出现在 discoverCards / saveCardAtomic / writeMarker 里，
// 测试传临时目录即可。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (row: `name: dshome/agent-roles`). */
export const name = 'dshome-agent-roles';

/** Services this row requires before activation（照官方 team 插件 `:9-14` 的服务名）。 */
export const inject = ['agents', 'tools', 'subagents'];

/** 管控者协议段的稳定名字（照官方 `team:policy` 的形态；scoped 段会 shadow 同名全局段）。 */
const POLICY_SECTION_NAME = 'agent-roles:policy';
/** 段落位置：与官方团队 POLICY 同槽（`dsh-system-prompt` SECTION_ORDERS.TEAM_POLICY = 600）。 */
const POLICY_SECTION_ORDER_NAME = 'TEAM_POLICY';
/** 诊断 marker 文件名（`profiles/dshome/.dsh-market/` 下，追加式、最近 20 行）。 */
const MARKET_MARKER_FILE = 'agent-roles-marker.txt';

/** 成员创建 label 前缀：`role:<roleId>:<memberName>`（进程重启后靠它回填 name→childId）。 */
export const ROLE_LABEL_PREFIX = 'role:';
/** 默认子代理 provider（`dsh-subagent-spawn-in-process/lib/index.js:13`）。 */
export const DEFAULT_PROVIDER = 'spawn';
/**
 * 顶层(=delegationDepth 0)起成员必须传的绝对深度上限。
 * ⚠️ 传 0 会被 `delegationDepth(parent)+1 > maxDepth` 直接拒（`dsh-subagent/lib/index.js:432-437`）。
 */
export const MEMBER_MAX_DEPTH = 1;
/** 固定级联闸：成员不得再起成员/跑编排（先按调用者可见性过滤后再进 filter，见 buildToolFilter）。 */
export const CASCADE_DENY = ['subagent', 'subagent_fork', 'workflow', 'ralph'];
/** 本插件自己的三把工具：只在顶层 own-scope，属于「子成员不可解析」的名字（绝不能进 filter）。 */
export const ROLE_TOOL_NAMES = ['role_list', 'role_spawn', 'role_send'];
/** `restrict()` 明确拒收的保留名（PTC 传输层，`dsh-tools/lib/index.js:2800`）。 */
const RESERVED_TOOL_NAMES = ['run_code'];

/**
 * 执行期工具闸（guard）谓词：把「角色能力面」从**可见性**升级为**调用即拒绝**。
 *
 * 为什么必须有它（2026-09-23 真机验收实测的缺陷）：`toolFilter` 走 `childCtx.tools.restrict()`，
 * 而 restrict 的语义是「只过滤该 scope **继承来的**工具，不过滤它自己注册的」
 * （`dsh-tools/lib/index.js:2839-2844`）。主实例的 preset 开了 `modelSelectionSettings: true` ⇒
 * `subagent` 由 `dsh-tool-subagent` **按每个 agent 自己的 scope 注册**
 * （`node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js:582-650` 的 `installScoped` +
 * `agent/created`），所以 deny/allow 都 mask 不掉它 —— 实测成员手里仍有 `subagent`，
 * 「成员不得再起成员」的级联闸名存实亡。本闸在**执行期**拦，覆盖 own-scope 工具。
 *
 * 语义（`ToolGuard = (execution) => string | undefined`，见
 * `dsh-tools/lib/types/index.d.ts`）：返回字符串 = 拒绝该次调用，返回 undefined = 放行。
 * @param {{allow?:string[], deny?:string[]}} filter - 卡解析后的能力面（allow 为空数组 = 不限白）
 * @returns {(execution:{name?:string}) => string|undefined}
 */
export function buildToolGuard(filter = {}) {
  const allow = toNameList(filter.allow);
  const deny = new Set(toNameList(filter.deny));
  const allowSet = allow.length > 0 ? new Set(allow) : null;
  return (execution) => {
    const name = execution && typeof execution.name === 'string' ? execution.name : '';
    if (name === '') return undefined;
    if (deny.has(name)) return `角色能力面未放行 ${name}（级联闸或卡内 deny）`;
    if (allowSet && !allowSet.has(name)) return `角色能力面只含 ${allow.join('、')}，未放行 ${name}`;
    return undefined;
  };
}

/** 私密卡目录（相对 home root）：`<home>\mind-private\L0\agents\<id>.md`。 */
const PRIVATE_CARD_SEGMENTS = ['mind-private', 'L0', 'agents'];
/** 项目卡目录（相对调用者 cwd）：`<cwd>\.agent-roles\<id>.md`。 */
const WORKSPACE_CARD_DIRNAME = '.agent-roles';
/** 角色卡 id 合法性：不含 `:`（label 用 `:` 分段），非空、以字母数字开头。 */
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 成员名合法性：lower-kebab（与官方 `spawn_teammate` 的 name 口径一致）。 */
const MEMBER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** 省略 task 时的首条唤醒消息（prompt 是 startContinuable 的必填项）。 */
const DEFAULT_TASK = '（初始唤醒）请确认你的角色；等待 Lead 下发任务，收到即执行，完成后用一条消息回报。';

/**
 * 成员协作协议尾注（固定，卡正文不可覆盖）。
 * 规格四条：身份=Lead 派的成员 / 收到任务即执行 / 完成后一条消息回报 / 不得自建成员、不改分工。
 */
export const PERSONA_TAIL = [
  '---',
  '【协作协议（固定尾注，角色卡正文不得覆盖）】',
  '1. 身份：你是顶层 Lead 派出的成员，身份与分工由 Lead 决定；你只对自己的任务负责。',
  '2. 收到任务即执行：不要先反问确认；只有缺关键信息导致无法动手时，才在回报里说明缺什么。',
  '3. 完成后用**一条**消息向上回报：做完什么 / 证据（命令与原始输出）/ 未完成或存疑的部分。',
  '4. 不得自建成员、不得改分工、不得请求扩大工具面；需要更多能力时在回报里说明，由 Lead 决策。',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具函数
// ─────────────────────────────────────────────────────────────────────────────

/** 宿主根：env DSH_HOME 优先（且含 mind 目录），否则 dev 上溯到仓库根（同 mind-inject.js:40-44 口径）。 */
function homeRoot() {
  const env = process.env.DSH_HOME;
  if (env && existsSync(join(env, 'mind'))) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

/** 卡 id → 合法成员名（lower-kebab）：小写、非法字符折成 `-`、去首尾/折叠连字符。 */
function sanitizeMemberName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Error → 单行诊断文本（绝不抛）。 */
function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try { return String(error); } catch { return '(无法字符串化的错误)'; }
}

/** 诊断 marker：追加式、最近 20 行；失败绝不影响功能（照 mind-inject.js:74-85 写法）。 */
function writeMarker(line) {
  try {
    const dir = join(homeRoot(), 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, MARKET_MARKER_FILE);
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), line].slice(-20);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch { /* 诊断 marker 失败不影响插件 */ }
}

/** 只在 ctx.logger 可用时 warn（cordis 的 logger 是 intrinsic，不在 inject 里）。 */
function logWarn(ctx, message) {
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('dshome') : null;
    if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch { /* 日志失败不影响功能 */ }
}

/** 只在 ctx.logger 可用时 info。 */
function logInfo(ctx, message) {
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('dshome') : null;
    if (logger && typeof logger.info === 'function') logger.info(message);
  } catch { /* 日志失败不影响功能 */ }
}

/** 归一化成「去重、去空的字符串名列表」；接受数组 / Set / 单个字符串。 */
function toNameList(value) {
  const out = [];
  const add = (v) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  };
  if (typeof value === 'string') { add(value); return out; }
  if (value && typeof value[Symbol.iterator] === 'function') {
    for (const item of value) add(item);
    return out;
  }
  return out;
}

/** 去掉首尾成对引号（frontmatter 子集允许 `value` / 'value'）。 */
function stripQuotes(raw) {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 解析一个标量/内联列表；返回 `{ value }` 或 `{ error }`（不抛）。 */
function parseScalar(raw) {
  const text = raw.trim();
  if (text === '') return { value: null };
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return { error: `内联列表缺少 "]"：${JSON.stringify(text)}` };
    const inner = text.slice(1, -1).trim();
    if (inner === '') return { value: [] };
    const items = inner.split(',').map((part) => stripQuotes(part));
    if (items.some((item) => item === '')) return { error: `内联列表含空项：${JSON.stringify(text)}` };
    return { value: items };
  }
  if (text.startsWith('{')) return { error: `不支持 YAML 流式 map {}：${JSON.stringify(text)}（请用缩进子键）` };
  if (text.endsWith(']')) return { error: `内联列表缺少 "["：${JSON.stringify(text)}` };
  return { value: stripQuotes(text) };
}

// ─────────────────────────────────────────────────────────────────────────────
// frontmatter 解析（自写；零依赖）
//
// 支持的 YAML 子集（多一点都不支持，遇到就报错并给行号）：
//   · 顶层 `key: value`
//   · 嵌套一层 map：`key:` 换行后缩进的 `subkey: value`（`tools:` / `model:`）
//   · 列表：`- item`（可挂在顶层键或嵌套子键下）或内联 `[a, b]`
//   · `#` 整行注释与空行忽略
//   · 不支持 tab 缩进 / 流式 map {} / 未闭合的内联列表 / 非 `key: value` 的行
// ─────────────────────────────────────────────────────────────────────────────

const TOP_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^-\s*(.*)$/;

/**
 * 解析 frontmatter 行（含空行/注释）。返回 `{ value }` 或 `{ error }`。
 * @param entries - `{ text, line }` 数组（line 为文件内 1-based 行号）
 */
function parseFrontmatter(entries) {
  const result = {};
  /** @type {{key:string,value:unknown,listKey:string|null}|null} */
  let container = null;
  const finalize = () => {
    if (container) {
      result[container.key] = container.value;
      container = null;
    }
  };
  for (const { text, line } of entries) {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indentText = /^[ \t]*/.exec(text)[0];
    if (indentText.includes('\t')) return { error: `第 ${line} 行：不支持 tab 缩进，请改用空格` };
    const indent = indentText.length;

    if (indent === 0) {
      const m = TOP_KEY_RE.exec(trimmed);
      if (!m) return { error: `第 ${line} 行：无法解析的顶层语法 ${JSON.stringify(trimmed)}（应为 key: value）` };
      finalize();
      const key = m[1];
      const rest = m[2].trim();
      if (rest === '') {
        container = { key, value: null, listKey: null };
      } else {
        const parsed = parseScalar(rest);
        if (parsed.error) return { error: `第 ${line} 行：${parsed.error}` };
        result[key] = parsed.value;
      }
      continue;
    }

    if (container === null) {
      return { error: `第 ${line} 行：缩进层级错误——本级没有父键（顶层键须先写成 "key:"）` };
    }

    const item = LIST_ITEM_RE.exec(trimmed);
    if (item) {
      const parsed = parseScalar(item[1]);
      if (parsed.error) return { error: `第 ${line} 行：${parsed.error}` };
      if (parsed.value === null) return { error: `第 ${line} 行：列表项为空` };
      if (container.listKey !== null) {
        const bag = container.value && typeof container.value === 'object' ? container.value : {};
        if (!Array.isArray(bag[container.listKey])) bag[container.listKey] = [];
        bag[container.listKey].push(parsed.value);
        container.value = bag;
      } else if (Array.isArray(container.value)) {
        container.value.push(parsed.value);
      } else if (container.value === null) {
        container.value = [parsed.value];
      } else {
        return { error: `第 ${line} 行：列表项缺少所属子键（在 ${container.key}: 下先写 "allow:" / "deny:"）` };
      }
      continue;
    }

    const nested = TOP_KEY_RE.exec(trimmed);
    if (!nested) return { error: `第 ${line} 行：无法解析的嵌套语法 ${JSON.stringify(trimmed)}` };
    if (container.value === null) container.value = {};
    if (Array.isArray(container.value)) {
      return { error: `第 ${line} 行：${container.key} 已声明为列表，不能再写子键 ${nested[1]}` };
    }
    const key = nested[1];
    const rest = nested[2].trim();
    if (rest === '') {
      container.value[key] = null;
      container.listKey = key;
    } else {
      const parsed = parseScalar(rest);
      if (parsed.error) return { error: `第 ${line} 行：${parsed.error}` };
      container.value[key] = parsed.value;
      container.listKey = null;
    }
  }
  finalize();
  return { value: result };
}

/**
 * 归一化 tools 声明。返回 `{ allow, deny, warnings }`；接受数组（=allow 简写）/对象/缺省。
 * @param raw - frontmatter 的 `tools` 值或 role_spawn 的 `tools` 覆盖值
 * @param warnings - 收集非致命告警
 */
export function normalizeTools(raw, warnings = []) {
  const allow = [];
  const deny = [];
  const push = (target, value) => {
    for (const n of toNameList(value)) {
      if (!target.includes(n)) target.push(n);
    }
  };
  if (raw === undefined || raw === null) return { allow, deny, warnings };
  if (Array.isArray(raw)) { push(allow, raw); return { allow, deny, warnings }; }
  if (typeof raw === 'string') { push(allow, raw); return { allow, deny, warnings }; }
  if (typeof raw !== 'object') {
    warnings.push(`tools 既不是列表也不是对象（${typeof raw}），已忽略`);
    return { allow, deny, warnings };
  }
  push(allow, raw.allow);
  push(deny, raw.deny);
  for (const key of Object.keys(raw)) {
    if (key !== 'allow' && key !== 'deny') warnings.push(`tools 有未支持的子键 "${key}"（只认 allow/deny）`);
  }
  return { allow, deny, warnings };
}

/** 已知的 model 子键（对应 AgentOptions 的 provider/model/reasoningEffort/maxTokens）。 */
const MODEL_KEYS = ['provider', 'model', 'reasoningEffort', 'maxTokens'];

/**
 * 归一化 model 声明：标量 → `{ model }`；嵌套一层 map → 只收 MODEL_KEYS。
 * @returns 归一化对象或 null
 */
export function normalizeModel(raw, warnings = []) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') return { model: raw };
  if (typeof raw === 'number') return { model: String(raw) };
  if (Array.isArray(raw)) { warnings.push('model 不支持列表写法，已忽略'); return null; }
  if (typeof raw !== 'object') { warnings.push(`model 不支持 ${typeof raw} 写法，已忽略`); return null; }
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!MODEL_KEYS.includes(key)) { warnings.push(`model 有未支持的子键 "${key}"（只认 ${MODEL_KEYS.join('/')}）`); continue; }
    const value = raw[key];
    if (value === null || value === undefined) continue;
    if (key === 'maxTokens') {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) { warnings.push(`model.maxTokens 不是数字（${JSON.stringify(value)}），已忽略`); continue; }
      out.maxTokens = num;
      continue;
    }
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 已知的顶层 frontmatter 键；其余键进 card.extra（不报错，只留痕）。 */
const CARD_TOP_KEYS = ['id', 'name', 'description', 'model', 'tools'];

/**
 * 解析一张角色卡。正文（closing `---` 之后）trim 后即系统提示词。
 * @param text - 卡文件全文
 * @param sourcePath - 文件路径（仅用于诊断与 fileName）
 * @returns `{ ok:true, card }` 或 `{ ok:false, sourcePath, fileName, reason }`
 */
export function parseCard(text, sourcePath = '') {
  const fileName = sourcePath ? basename(sourcePath) : '';
  const fail = (reason) => ({ ok: false, sourcePath, fileName, reason });
  if (typeof text !== 'string') return fail('文件内容不是字符串');

  const raw = text.replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);

  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first < 0) return fail('文件为空');
  if (lines[first].trim() !== '---') {
    return fail(`缺少 frontmatter（首个非空行应为 ---，第 ${first + 1} 行实际为 ${JSON.stringify(lines[first].trim().slice(0, 40))}）`);
  }
  let close = -1;
  for (let i = first + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close < 0) return fail(`frontmatter 缺少结束 ---（第 ${first + 1} 行开始）`);

  const entries = [];
  for (let i = first + 1; i < close; i += 1) entries.push({ text: lines[i], line: i + 1 });
  const parsed = parseFrontmatter(entries);
  if (parsed.error) return fail(`frontmatter 语法不支持：${parsed.error}`);
  const fm = parsed.value;

  const warnings = [];
  const idRaw = fm.id;
  const id = typeof idRaw === 'string' ? idRaw.trim() : '';
  if (id === '') {
    const detail = idRaw === undefined || idRaw === null ? 'frontmatter 未声明 id' : `id 不是非空字符串（${JSON.stringify(idRaw)}）`;
    return fail(`缺 id：${detail}`);
  }
  if (!CARD_ID_RE.test(id)) {
    return fail(`id 不合法：${JSON.stringify(id)}（只允许 [A-Za-z0-9._-]，且不能含 ":"——label 用 ":" 分段）`);
  }

  const nameRaw = fm.name;
  let cardName = id;
  if (typeof nameRaw === 'string' && nameRaw.trim() !== '') cardName = nameRaw.trim();
  else if (nameRaw !== undefined && nameRaw !== null) warnings.push(`name 不是非空字符串（${JSON.stringify(nameRaw)}），已回退为 id`);

  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  const model = normalizeModel(fm.model, warnings);
  const toolsRaw = normalizeTools(fm.tools, warnings);
  const tools = { allow: toolsRaw.allow, deny: toolsRaw.deny };

  const extra = {};
  for (const key of Object.keys(fm)) {
    if (!CARD_TOP_KEYS.includes(key)) extra[key] = fm[key];
  }

  const body = lines.slice(close + 1).join('\n').trim();
  if (body === '') return fail('正文为空（正文即系统提示词/persona，不能空）');

  return {
    ok: true,
    sourcePath,
    fileName,
    card: {
      id,
      name: cardName,
      description,
      model,
      tools,
      body,
      extra,
      warnings,
      sourcePath,
      fileName,
      source: 'inline',
      overridesPrivate: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 角色卡发现（私密 + 项目；同 id 项目覆盖私密）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扫描两个目录里的角色卡。
 * @param {{privateDir?:string, workspaceDir?:string}} options
 * @returns `{ cards, broken, dirs }`；broken 带 file/source/reason，绝不静默跳过
 */
export function discoverCards({ privateDir, workspaceDir } = {}) {
  const byId = new Map();
  const broken = [];
  const dirs = { private: privateDir ?? '', workspace: workspaceDir ?? '' };

  const scan = (dir, source) => {
    if (!dir) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fileName = entry && entry.name ? String(entry.name) : '';
      if (fileName === '') continue;
      if (!/\.md$/i.test(fileName)) continue;        // 只收 .md
      if (fileName.startsWith('_')) continue;        // `_` 前缀 = 模板/草稿，跳过
      if (typeof entry.isDirectory === 'function' && entry.isDirectory()) continue;
      const sourcePath = join(dir, fileName);
      let text;
      try { text = readFileSync(sourcePath, 'utf8'); }
      catch (error) { broken.push({ file: fileName, sourcePath, source, reason: `读取失败：${describeError(error)}` }); continue; }
      const parsed = parseCard(text, sourcePath);
      if (!parsed.ok) { broken.push({ file: fileName, sourcePath, source, reason: parsed.reason }); continue; }
      const card = { ...parsed.card, source };
      const prev = byId.get(card.id);
      if (prev && prev.source === source) {
        broken.push({ file: fileName, sourcePath, source, reason: `id "${card.id}" 在同一目录内重复（被 ${fileName} 覆盖，先前来自 ${prev.fileName}）` });
      }
      if (prev && prev.source === 'private' && source === 'workspace') card.overridesPrivate = true;
      byId.set(card.id, card);
    }
  };

  scan(privateDir, 'private');
  scan(workspaceDir, 'workspace');

  const cards = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { cards, broken, dirs };
}

/**
 * 按 id 选卡（未知 role 的响亮失败：列出可用 id 与 broken 数）。
 * @returns `{ ok:true, card }` 或 `{ ok:false, error, ids, broken }`
 */
export function selectCard(discovery, roleId) {
  const cards = discovery && Array.isArray(discovery.cards) ? discovery.cards : [];
  const ids = cards.map((card) => card.id);
  const broken = discovery && Array.isArray(discovery.broken) ? discovery.broken : [];
  const wanted = typeof roleId === 'string' ? roleId.trim() : '';
  if (wanted === '') return { ok: false, error: '未指定角色卡 id', ids, broken };
  const card = cards.find((item) => item.id === wanted);
  if (!card) {
    return {
      ok: false,
      error: `未找到角色卡 "${wanted}"（可用：${ids.length > 0 ? ids.join('、') : '无'}${broken.length > 0 ? `；另有 ${broken.length} 张坏卡见 role_list` : ''}）`,
      ids,
      broken,
    };
  }
  return { ok: true, card };
}

// ─────────────────────────────────────────────────────────────────────────────
// persona 组装
// ─────────────────────────────────────────────────────────────────────────────

/** 卡正文 + 固定协作协议尾注（正文为空时只给尾注，绝不产出空 persona）。 */
export function composePersona(card) {
  const body = card && typeof card.body === 'string' ? card.body.trim() : '';
  return body === '' ? PERSONA_TAIL : `${body}\n\n${PERSONA_TAIL}`;
}

/** 管控者协议文本（顶层会话可见；与三把工具一一对应）。 */
export function renderPolicyText() {
  return [
    '【角色卡管控者协议（dshome/agent-roles）】',
    '你可以把「角色卡」起成独立成员：每个成员有自己的系统提示词（卡正文）、自己的工具面（卡 frontmatter 的 tools）和自己的模型路由（卡 model）。',
    '· role_list：列出可用角色卡（私密目录 + 项目 .agent-roles；同 id 项目卡覆盖私密卡）与坏卡原因。',
    '· role_spawn：role=<卡 id> 起一个 durable 成员；或 persona+name 内联建卡（save=true 才落盘，scope=workspace|private）。可选 tools/model 覆盖卡，task 作为首条任务消息。',
    '· role_send：给已起成员发消息（target=成员 name 或 childId）；成员在跑就 steer，空闲就唤醒。',
    '规则：',
    '1. 起成员前先 role_list；同 id 时项目卡优先，别凭印象猜卡里有什么。',
    '2. 成员工具面 = 卡声明（allow/deny）+ 固定级联闸（subagent/subagent_fork/workflow/ralph 一律禁），卡里写了子成员不可解析的工具名会**直接报错**，不会静默放宽。',
    '3. 成员完成后用一条消息回报；你负责验收并给最终答复。成员不得自建成员、不得改分工。',
    '4. 卡正文即成员系统提示词：改卡只影响之后起的成员，已起的成员不受影响。',
    '5. 同一把工具不能同时写进 allow 与 deny —— 那是自相矛盾的声明，role_spawn 会直接报错（不会静默按 deny 处理）。',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具面收窄
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由角色卡 + 调用者当前可下发的工具面，算出子会话的 `toolFilter`。
 *
 * 语义（关键，别改错）：
 *   · `visible` 必须是「**该子会话会继承到的**工具名」——即调用者 `ctx.tools.view(agent).restrictableNames`
 *     （global + 祖先链层，**不含**调用者 own-scope）。写 role_* 会因 unknown name 让整次 spawn 回滚
 *     （`dsh-tools/lib/index.js:2790-2805,2854-2880`）。
 *   · 卡里的 allow/deny 名字先按这个集合解析；出现不可解析的名字 → `ok:false` 响亮失败，绝不静默放宽。
 *   · 固定级联 deny 只在「可见」时才进 filter（不存在的名字进 filter 会让整次 spawn 失败）。
 *   · `role_*` / `run_code` 永远不进 filter。
 * @param {{card?:object, visible?:Iterable<string>|string, localOnly?:Iterable<string>}} options
 */
export function buildToolFilter({ card, visible, localOnly = ROLE_TOOL_NAMES } = {}) {
  const allVisible = toNameList(visible);
  const localSet = new Set([...toNameList(localOnly), ...ROLE_TOOL_NAMES]);
  const blockedReasons = new Map();
  const restrictable = [];
  for (const toolName of allVisible) {
    if (localSet.has(toolName)) { blockedReasons.set(toolName, '只在顶层 own-scope（子成员不继承）'); continue; }
    if (RESERVED_TOOL_NAMES.includes(toolName)) { blockedReasons.set(toolName, '保留的 PTC 传输名（restrict 不接受）'); continue; }
    restrictable.push(toolName);
  }
  const restrictSet = new Set(restrictable);

  const toolsRaw = card && card.tools ? card.tools : {};
  const cardAllow = toNameList(toolsRaw.allow);
  const cardDeny = toNameList(toolsRaw.deny);

  const unknown = [];
  const reasons = {};
  for (const toolName of [...cardAllow, ...cardDeny]) {
    if (restrictSet.has(toolName) || Object.hasOwn(reasons, toolName)) continue;
    unknown.push(toolName);
    reasons[toolName] = blockedReasons.get(toolName) ?? '调用者当前不可见（不在可下发给子成员的工具面内）';
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      unknown,
      reasons,
      available: restrictable,
      allVisible,
      error: `角色卡声明了子成员不可解析的工具名：${unknown.map((toolName) => `${toolName}（${reasons[toolName]}）`).join('、')}；`
        + `调用者当前可下发给子成员的工具：${restrictable.length > 0 ? restrictable.join('、') : '无'}`,
    };
  }

  // 自相矛盾的声明 = 响亮失败（2026-09-23 W3 独立验证发现）：同名同时进 allow 与 deny 时，运行时
  //   `restrict` 是 **deny 赢**（`dsh-tools/lib/index.js:2546`）⇒ 卡作者想要的能力被**静默丢掉**，
  //   而 role_spawn 仍返回 ok:true —— 这正是本仓最反对的"看起来成功、其实被悄悄削了"。故直接拒。
  const bothLists = cardAllow.filter((toolName) => cardDeny.includes(toolName));
  if (bothLists.length > 0) {
    return {
      ok: false,
      unknown: [],
      reasons: Object.fromEntries(bothLists.map((toolName) => [toolName, '同时出现在 allow 与 deny'])),
      available: restrictable,
      allVisible,
      error: `角色卡把同一个工具同时写进了 allow 与 deny：${bothLists.join('、')}——这是自相矛盾的声明`
        + '（如果放行，运行时会按 deny 生效，等于静默丢掉你要的能力）。请二选一。',
    };
  }

  const allow = [];
  const deny = [];
  for (const toolName of cardAllow) if (!allow.includes(toolName)) allow.push(toolName);
  for (const toolName of cardDeny) if (!deny.includes(toolName)) deny.push(toolName);
  for (const toolName of CASCADE_DENY) {
    if (restrictSet.has(toolName) && !deny.includes(toolName)) deny.push(toolName);
  }

  const hasFilter = allow.length > 0 || deny.length > 0;
  const filter = hasFilter ? { ...(allow.length > 0 ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) } : null;
  return { ok: true, filter, allow, deny, available: restrictable, allVisible };
}

// ─────────────────────────────────────────────────────────────────────────────
// 起成员：request 组装（纯函数，便于断言 maxDepth / persona / toolFilter）
// ─────────────────────────────────────────────────────────────────────────────

/** `role:<roleId>:<memberName>`。 */
export function roleLabel(roleId, memberName) {
  return `${ROLE_LABEL_PREFIX}${roleId}:${memberName}`;
}

/** 解析 label；不是 `role:` 开头则返回 null。 */
export function parseRoleLabel(label) {
  if (typeof label !== 'string' || !label.startsWith(ROLE_LABEL_PREFIX)) return null;
  const rest = label.slice(ROLE_LABEL_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx < 0) return { roleId: rest, name: '' };
  return { roleId: rest.slice(0, idx), name: rest.slice(idx + 1) };
}

/**
 * 回报地址尾注（只进**首条 prompt**，绝不进 persona）。
 *
 * 为什么必须给：成员手里没有 Lead 的 agent_id，`send_message` 的 target 就无从填写 —— 2026-09-23 上线
 * 评审时发现 persona 尾注只写「用一条消息向上回报」，而 `send_message` 参数只能填 agent_id。
 * 为什么不能进 persona：persona 必须恒等于「卡正文 + 固定尾注」，否则每张卡的系统提示词都被运维信息
 * 污染、也不再等于卡正文（W3 沙盒 e2e 的判据之一正是「子会话 persona == 卡正文」）。
 * @param {{id?:string}} parent - 调用者 agent（`exec.agent`）
 * @returns 尾注字符串；拿不到 lead id 时返回 ''（绝不产出半截指引）
 */
export function reportHint(parent) {
  const leadId = parent && typeof parent.id === 'string' ? parent.id.trim() : '';
  if (leadId === '') return '';
  return `\n\n【回报地址】你的 Lead agent_id = ${leadId}；完成后用 send_message 发给它（target 填这个 id）。若你本轮直接结束，Lead 也会收到你的最终答复。`;
}

/**
 * 组装 `ctx.subagents.startContinuable` 的 spec。
 * @param {{parent:object, card:object, name?:string, task?:string, toolFilter?:object|null, persona?:string}} options
 */
export function buildStartSpec({ parent, card, name, task, toolFilter, persona } = {}) {
  const roleId = card && card.id ? String(card.id) : 'inline';
  const requested = typeof name === 'string' && name.trim() !== '' ? name.trim() : '';
  const memberName = requested !== '' ? requested : (sanitizeMemberName(roleId) || roleId);
  const taskText = typeof task === 'string' && task.trim() !== '' ? task.trim() : DEFAULT_TASK;
  const promptText = taskText + reportHint(parent);
  const model = card && card.model && typeof card.model === 'object' ? card.model : null;
  const request = {
    prompt: [{ type: 'text', text: promptText }],
    parent,
    persona: typeof persona === 'string' && persona !== '' ? persona : composePersona(card),
    maxDepth: MEMBER_MAX_DEPTH,
  };
  if (model && Object.keys(model).length > 0) request.agentOptions = { ...model };
  if (toolFilter && typeof toolFilter === 'object') request.toolFilter = toolFilter;
  return { provider: DEFAULT_PROVIDER, label: roleLabel(roleId, memberName), request };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具输出 schema（raw register 只校验 output.schema；execute 返回值会被逐一校验）
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS_SUB_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['allow', 'deny'],
  properties: {
    allow: { type: 'array', items: { type: 'string' } },
    deny: { type: 'array', items: { type: 'string' } },
  },
};

const ROLE_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'name', 'source', 'model', 'bodyChars', 'overridesPrivate', 'tools'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    source: { type: 'string' },
    description: { type: 'string' },
    model: { type: 'string' },
    bodyChars: { type: 'integer' },
    overridesPrivate: { type: 'boolean' },
    file: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    tools: TOOLS_SUB_SCHEMA,
  },
};

const BROKEN_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['file', 'source', 'reason'],
  properties: {
    file: { type: 'string' },
    source: { type: 'string' },
    reason: { type: 'string' },
  },
};

const ROLE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    roles: { type: 'array', items: ROLE_ROW_SCHEMA },
    broken: { type: 'array', items: BROKEN_ROW_SCHEMA },
    dirs: {
      type: 'object',
      additionalProperties: true,
      required: ['private', 'workspace'],
      properties: { private: { type: 'string' }, workspace: { type: 'string' } },
    },
  },
};

const ROLE_SPAWN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    childId: { type: 'string' },
    label: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    model: { type: 'string' },
    messageId: { type: 'string' },
    cardPath: { type: 'string' },
    saved: { type: 'boolean' },
    allow: { type: 'array', items: { type: 'string' } },
    deny: { type: 'array', items: { type: 'string' } },
    guardInstalled: { type: 'boolean' },
    guardReason: { type: 'string' },
    unknown: { type: 'array', items: { type: 'string' } },
    available: { type: 'array', items: { type: 'string' } },
    broken: { type: 'array', items: BROKEN_ROW_SCHEMA },
  },
};

const ROLE_SEND_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    name: { type: 'string' },
    childId: { type: 'string' },
    messageId: { type: 'string' },
    status: { type: 'string' },
    members: { type: 'array', items: { type: 'string' } },
  },
};

/** 统一的模型可见渲染：整条 JSON（结构化错误也在里面）。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

// ─────────────────────────────────────────────────────────────────────────────
// 三把工具（注册进顶层 agent 的精确 scope）
// ─────────────────────────────────────────────────────────────────────────────

/** exec.agent 是唯一正确的调用者身份（exec.parent 是 token，不能当 parent）。 */
function callerOf(exec) {
  return exec && exec.agent ? exec.agent : null;
}

/** 调用者 cwd（成员卡的工作区目录、子会话工作目录都跟着它）。 */
function agentCwd(agent) {
  const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/** 两个卡目录。 */
function cardDirs(state, cwd) {
  return {
    privateDir: join(state.home, ...PRIVATE_CARD_SEGMENTS),
    workspaceDir: join(cwd, WORKSPACE_CARD_DIRNAME),
  };
}

/** 目录发现 + 返回给模型的可序列化 broken 列表。 */
function briefBroken(discovery) {
  const broken = discovery && Array.isArray(discovery.broken) ? discovery.broken : [];
  return broken.map((item) => ({ file: String(item.file ?? ''), source: String(item.source ?? ''), reason: String(item.reason ?? '') }));
}

/**
 * 调用者「可下发给子会话」的工具名集合。
 * 用 `view(agent).restrictableNames`（= global + 祖先链层，不含 own-scope）——这正是子会话 `restrict()` 认的集合。
 */
function restrictableNamesFor(ctx, agent) {
  try {
    const view = ctx.tools.view(agent);
    const names = view ? view.restrictableNames : null;
    if (names && typeof names[Symbol.iterator] === 'function') return [...names];
  } catch { /* 回退 */ }
  try {
    const schemas = ctx.tools.schemas(agent);
    if (Array.isArray(schemas)) return schemas.map((schema) => (schema && schema.name ? String(schema.name) : '')).filter(Boolean);
  } catch { /* 回退失败 = 空面 */ }
  return [];
}

/** 进程内 name→childId 索引键（按父会话隔离，避免多顶层会话串号）。 */
function indexKeyOf(parentId, memberName) {
  return `${String(parentId ?? '')}::${memberName}`;
}

/** 分裂索引键。 */
function splitIndexKey(key) {
  const idx = key.indexOf('::');
  if (idx < 0) return { parentId: '', name: key };
  return { parentId: key.slice(0, idx), name: key.slice(idx + 2) };
}

/** 原子落盘：temp + rename（同目录 rename 是原子的）。 */
function saveCardAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

/** 把内联卡序列化成 parseCard 能原样读回的 markdown（导出以便自测 round-trip）。 */
export function serializeCard({ id, name, description, persona, model, tools }) {
  const lines = ['---', `id: ${id}`];
  if (name) lines.push(`name: ${name}`);
  if (description) lines.push(`description: ${description}`);
  const modelKeys = model && typeof model === 'object' ? Object.keys(model) : [];
  if (modelKeys.length > 0) {
    lines.push('model:');
    for (const key of modelKeys) lines.push(`  ${key}: ${model[key]}`);
  }
  const allow = toNameList(tools ? tools.allow : null);
  const deny = toNameList(tools ? tools.deny : null);
  if (allow.length > 0 || deny.length > 0) {
    lines.push('tools:');
    if (allow.length > 0) {
      lines.push('  allow:');
      for (const item of allow) lines.push(`    - ${item}`);
    }
    if (deny.length > 0) {
      lines.push('  deny:');
      for (const item of deny) lines.push(`    - ${item}`);
    }
  }
  lines.push('---', '', String(persona ?? '').trim(), '');
  return lines.join('\n');
}

/** 成员寻址：name（进程内索引 + listChildren 回填 label）/ childId / roleId。 */
async function resolveMember(ctx, state, agent, target) {
  const parentId = String(agent && agent.id ? agent.id : '');
  let childId = '';
  let memberName = '';
  for (const [key, value] of state.nameIndex) {
    const parsedKey = splitIndexKey(key);
    if (parsedKey.parentId === parentId && parsedKey.name === target) { childId = value; memberName = parsedKey.name; break; }
  }

  let entries = [];
  try {
    if (typeof ctx.subagents.listChildren === 'function') entries = await ctx.subagents.listChildren(parentId, undefined);
  } catch { entries = []; }

  const members = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.kind !== 'child') continue;
    const label = typeof entry.label === 'string' ? entry.label : '';
    const parsedLabel = parseRoleLabel(label);
    const entryName = parsedLabel && parsedLabel.name ? parsedLabel.name : '';
    if (entryName !== '') {
      members.push(`${entryName}(${String(entry.id)})`);
      state.nameIndex.set(indexKeyOf(parentId, entryName), String(entry.id));
    }
    if (childId === '' && entryName !== '' && (entryName === target || (parsedLabel && parsedLabel.roleId === target))) {
      childId = String(entry.id);
      memberName = entryName;
    }
  }
  if (childId === '') {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && entry.kind === 'child' && String(entry.id) === target) { childId = String(entry.id); memberName = memberName || target; break; }
    }
  }
  if (childId === '') {
    return { ok: false, members, error: `未找到成员 "${target}"（本会话可用成员：${members.length > 0 ? members.join('、') : '无'}）` };
  }
  return { ok: true, childId, name: memberName || target, members };
}

/**
 * 造三把工具的定义（raw register 形态；不用 defineTool）。
 * @param {{ctx:object, state:object}} deps
 */
function makeRoleTools({ ctx, state }) {
  return {
    roleList: {
      name: 'role_list',
      description: '列出可用角色卡（角色卡 = 独立系统提示词 + 工具面 + 模型路由）。卡目录：私密 <DSH_HOME>/mind-private/L0/agents 与项目 <cwd>/.agent-roles；同 id 时项目卡覆盖私密卡。坏卡（缺 id / frontmatter 语法不支持 / 正文为空）在 broken 里带原因，不会静默跳过。',
      parameters: { type: 'object', properties: {} },
      output: { schema: ROLE_LIST_SCHEMA, render: renderJson },
      async execute(_args, exec) {
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_list 需要调用者 agent（exec.agent 为空）' };
        try {
          const cwd = agentCwd(agent);
          const dirs = cardDirs(state, cwd);
          const discovery = discoverCards(dirs);
          return {
            ok: true,
            roles: discovery.cards.map((card) => ({
              id: card.id,
              name: card.name || card.id,
              source: card.source,
              description: card.description || '',
              model: card.model && card.model.model ? card.model.model : '',
              bodyChars: card.body.length,
              overridesPrivate: card.overridesPrivate === true,
              file: card.fileName || '',
              warnings: Array.isArray(card.warnings) ? card.warnings : [],
              tools: { allow: toNameList(card.tools ? card.tools.allow : null), deny: toNameList(card.tools ? card.tools.deny : null) },
            })),
            broken: briefBroken(discovery),
            dirs: { private: dirs.privateDir, workspace: dirs.workspaceDir },
          };
        } catch (error) {
          return { ok: false, error: `role_list 失败：${describeError(error)}` };
        }
      },
    },

    roleSpawn: {
      name: 'role_spawn',
      description: '用角色卡起一个 durable 成员子代理。给 role=<卡 id>；或给 persona（正文=系统提示词）+ name 内联建卡（save=true 才落盘，scope=workspace|private）。可选 tools/model 覆盖卡（tools={allow:[],deny:[]}，名字必须是调用者当前可下发的工具，否则直接报错）。task 是首条任务消息。成员的 persona/工具面/模型都按卡落地；成员只能被本工具起的顶层会话看到。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '角色卡 id（与 persona+name 二选一）' },
          persona: { type: 'string', description: '内联卡正文=系统提示词（与 role 二选一，须配 name）' },
          name: { type: 'string', description: '成员名，lower-kebab（如 code-reviewer）；内联建卡时必填，也是 role_send 的寻址名' },
          task: { type: 'string', description: '首条任务消息；省略则只发一条初始唤醒' },
          tools: {
            type: 'object',
            additionalProperties: false,
            properties: {
              allow: { type: 'array', items: { type: 'string' }, description: '白名单（只保留这些工具）' },
              deny: { type: 'array', items: { type: 'string' }, description: '黑名单' },
            },
            description: '覆盖卡的工具面（整体替换卡里的 tools）',
          },
          model: { type: 'string', description: '覆盖卡的模型 id（等价 model.model）' },
          save: { type: 'boolean', description: '内联卡是否落盘（需 persona+name；已存在同名文件时拒绝覆盖）' },
          scope: { type: 'string', enum: ['workspace', 'private'], description: '内联卡落盘位置，默认 workspace' },
        },
      },
      output: { schema: ROLE_SPAWN_SCHEMA, render: renderJson },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {};
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_spawn 需要调用者 agent（exec.agent 为空）' };
        const cwd = agentCwd(agent);
        try {
          const discovery = discoverCards(cardDirs(state, cwd));
          const roleArg = typeof input.role === 'string' ? input.role.trim() : '';
          const personaArg = typeof input.persona === 'string' ? input.persona.trim() : '';
          const nameArg = typeof input.name === 'string' ? input.name.trim() : '';
          const overrideTools = input.tools === undefined ? null : normalizeTools(input.tools, []);
          const overrideModel = input.model === undefined ? null : normalizeModel(input.model, []);

          let card = null;
          let cardPath = '';
          let saved = false;

          if (roleArg !== '') {
            const picked = selectCard(discovery, roleArg);
            if (!picked.ok) return { ok: false, error: picked.error, available: picked.ids, broken: briefBroken(discovery) };
            card = picked.card;
          } else if (personaArg !== '' && nameArg !== '') {
            if (!MEMBER_NAME_RE.test(nameArg)) {
              return { ok: false, error: `name 必须是 lower-kebab（如 code-reviewer），实际 ${JSON.stringify(nameArg)}` };
            }
            const effToolsForCard = overrideTools ? { allow: overrideTools.allow, deny: overrideTools.deny } : { allow: [], deny: [] };
            card = {
              id: nameArg,
              name: nameArg,
              description: '',
              model: overrideModel,
              tools: effToolsForCard,
              body: personaArg,
              extra: {},
              warnings: [],
              sourcePath: '',
              fileName: '',
              source: 'inline',
              overridesPrivate: false,
            };
            if (input.save === true) {
              const scope = input.scope === 'private' ? 'private' : 'workspace';
              const dir = scope === 'private'
                ? join(state.home, ...PRIVATE_CARD_SEGMENTS)
                : join(cwd, WORKSPACE_CARD_DIRNAME);
              const target = join(dir, `${nameArg}.md`);
              if (existsSync(target)) {
                return { ok: false, error: `角色卡已存在，拒绝覆盖：${target}（改用 role=${nameArg} 复用，或换一个 name）` };
              }
              saveCardAtomic(target, serializeCard({
                id: nameArg,
                name: nameArg,
                persona: personaArg,
                model: overrideModel,
                tools: effToolsForCard,
              }));
              cardPath = target;
              saved = true;
              writeMarker(`card: saved ${scope} ${nameArg} -> ${target} @ ${new Date().toISOString()}`);
            }
          } else {
            return {
              ok: false,
              error: '必须给 role=<卡 id>，或给 persona + name（内联建卡）',
              available: discovery.cards.map((item) => item.id),
              broken: briefBroken(discovery),
            };
          }

          const effTools = overrideTools ? { allow: overrideTools.allow, deny: overrideTools.deny } : (card.tools || { allow: [], deny: [] });
          const effModel = overrideModel ?? card.model ?? null;
          const effCard = { ...card, tools: effTools, model: effModel };

          const built = buildToolFilter({ card: effCard, visible: restrictableNamesFor(ctx, agent) });
          if (!built.ok) {
            return { ok: false, error: built.error, unknown: built.unknown, available: built.available, broken: briefBroken(discovery) };
          }

          const memberName = nameArg !== '' ? nameArg : sanitizeMemberName(effCard.id);
          if (!MEMBER_NAME_RE.test(memberName)) {
            return { ok: false, error: `成员名必须是 lower-kebab（如 code-reviewer），实际 ${JSON.stringify(memberName)}（卡 id ${JSON.stringify(effCard.id)} 无法直接当成员名，请显式传 name）` };
          }
          const indexKey = indexKeyOf(agent.id, memberName);
          if (state.nameIndex.has(indexKey)) {
            return { ok: false, error: `本会话已有同名成员 ${memberName}（childId=${state.nameIndex.get(indexKey)}）` };
          }

          if (typeof ctx.subagents.getProvider === 'function') {
            const provider = ctx.subagents.getProvider(DEFAULT_PROVIDER);
            if (!provider) {
              let known = [];
              try { known = typeof ctx.subagents.list === 'function' ? ctx.subagents.list() : []; } catch { known = []; }
              return { ok: false, error: `子代理 provider "${DEFAULT_PROVIDER}" 未注册，无法起成员（已注册：${known.length > 0 ? known.join('、') : '无'}）` };
            }
          }
          if (typeof ctx.subagents.startContinuable !== 'function') {
            return { ok: false, error: 'ctx.subagents.startContinuable 不可用：缺少 continuable 子代理管理器/会话持久化，无法起 durable 成员' };
          }

          const spec = buildStartSpec({ parent: agent, card: effCard, name: memberName, task: input.task, toolFilter: built.filter });
          const started = await ctx.subagents.startContinuable({
            provider: spec.provider,
            label: spec.label,
            request: spec.request,
            signal: exec.signal,
          });
          const childId = started && started.childId ? String(started.childId) : '';
          state.nameIndex.set(indexKey, childId);
          writeMarker(`spawn: ${spec.label} -> ${childId} @ ${new Date().toISOString()}`);
          // 执行期闸：能力面 = 无条件级联闸 ∪ 卡内 deny ∪ restrict 解析出的 deny；allow 用 restrict 解析出的 allow。
          // 覆盖 `restrict` 管不到的 own-scope 工具（实测 subagent）——见 buildToolGuard 头注。
          const guardFilter = {
            allow: toNameList(built.allow),
            deny: [...new Set([...CASCADE_DENY, ...toNameList(effTools.deny), ...toNameList(built.deny)])],
          };
          const guard = installChildGuard(ctx, state, childId, guardFilter);
          writeMarker(`guard: ${spec.label} -> ${guard.installed ? 'installed' : `pending/failed: ${guard.reason}`} @ ${new Date().toISOString()}`);
          return {
            ok: true,
            childId,
            label: spec.label,
            name: memberName,
            role: effCard.id,
            model: effModel && effModel.model ? effModel.model : '',
            messageId: started && started.messageId ? String(started.messageId) : '',
            cardPath,
            saved,
            allow: built.allow,
            deny: built.deny,
            guardInstalled: guard.installed === true,
            guardReason: guard.reason || '',
          };
        } catch (error) {
          writeMarker(`spawn: failed ${describeError(error)} @ ${new Date().toISOString()}`);
          return { ok: false, error: `role_spawn 失败：${describeError(error)}` };
        }
      },
    },

    roleSend: {
      name: 'role_send',
      description: '给本会话已起的角色成员发一条唤醒/steer 消息：target 给成员 name（role_spawn 的 name）或 childId。成员在跑就在最近一步边界收到；空闲就被唤醒；进程重启后按 label "role:<roleId>:<name>" 从 listChildren 回填。返回投递确认，不含成员答复。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '成员 name 或 childId' },
          message: { type: 'string', description: '要投递的消息内容（自包含）' },
        },
        required: ['target', 'message'],
      },
      output: { schema: ROLE_SEND_SCHEMA, render: renderJson },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {};
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_send 需要调用者 agent（exec.agent 为空）' };
        try {
          const target = typeof input.target === 'string' ? input.target.trim() : '';
          const message = typeof input.message === 'string' ? input.message : '';
          if (target === '') return { ok: false, error: 'target 必填（成员 name 或 childId）' };
          if (message.trim() === '') return { ok: false, error: 'message 必填且不能为空' };
          if (typeof ctx.subagents.sendMessage !== 'function') {
            return { ok: false, error: 'ctx.subagents.sendMessage 不可用：缺少 continuable 子代理管理器' };
          }
          const resolved = await resolveMember(ctx, state, agent, target);
          if (!resolved.ok) return { ok: false, error: resolved.error, members: resolved.members };
          const messageId = await ctx.subagents.sendMessage(
            agent,
            resolved.childId,
            [{ type: 'text', text: message }],
            { signal: exec.signal },
          );
          writeMarker(`send: ${resolved.name} -> ${resolved.childId} @ ${new Date().toISOString()}`);
          return {
            ok: true,
            name: resolved.name,
            childId: resolved.childId,
            messageId: messageId ? String(messageId) : '',
            status: 'accepted',
          };
        } catch (error) {
          writeMarker(`send: failed ${describeError(error)} @ ${new Date().toISOString()}`);
          return { ok: false, error: `role_send 失败：${describeError(error)}` };
        }
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// scoped install / 生命周期
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 给刚起的成员装「执行期工具闸」。
 * ① 先看注册表里有没有它（`startContinuable` 内部已 materialize，通常立刻能拿到）；
 * ② 拿不到就先记进 `pendingGuards`，由 `agent/created` 处理器补装 —— 两条路合起来无竞态。
 */
function installChildGuard(ctx, state, childId, filter) {
  const id = String(childId || '');
  if (id === '') return { installed: false, reason: 'childId 为空，无法装闸' };
  let child = null;
  try { child = (ctx.agents.list() || []).find((candidate) => candidate && String(candidate.id) === id) || null; }
  catch { child = null; }
  if (!child) {
    state.pendingGuards.set(id, filter);
    return { installed: false, reason: '子 agent 尚未进注册表：已挂起，等 agent/created 补装' };
  }
  return applyChildGuard(state, child, filter);
}

/** 真正装闸（幂等）。 */
function applyChildGuard(state, child, filter) {
  try {
    if (!child || !child.ctx || !child.ctx.tools || typeof child.ctx.tools.guard !== 'function') {
      return { installed: false, reason: '子 scope 没有 tools.guard（该 agent 拿不到执行期闸）' };
    }
    const id = String(child.id);
    if (state.childGuards.has(id)) return { installed: true, reason: '已装过（幂等跳过）' };
    const dispose = child.ctx.tools.guard(buildToolGuard(filter));
    state.childGuards.set(id, dispose);
    return { installed: true, reason: '' };
  } catch (error) {
    return { installed: false, reason: describeError(error) };
  }
}

/**
 * 给一个顶层 agent 的精确 scope 装：管控者协议段 + 三把工具。
 * 失败回滚并返回 null（fails-open）。
 */
function installScoped(agent, ctx, state) {
  const scoped = agent.ctx;
  const disposers = [];
  const keep = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer); };
  try {
    const prompt = scoped.systemPrompt;
    if (prompt && typeof prompt.section === 'function' && typeof prompt.getSectionOrder === 'function') {
      keep(prompt.section({
        name: POLICY_SECTION_NAME,
        order: prompt.getSectionOrder(POLICY_SECTION_ORDER_NAME),
        text: () => renderPolicyText(),
      }));
    } else {
      writeMarker(`install: systemPrompt section unavailable — 工具仍注册，仅缺管控者协议 @ ${new Date().toISOString()}`);
    }

    const roleTools = makeRoleTools({ ctx, state });
    const definitions = [roleTools.roleList, roleTools.roleSpawn, roleTools.roleSend];
    for (const definition of definitions) {
      if (!scoped.tools || typeof scoped.tools.register !== 'function') throw new Error('agent scope 没有 tools.register');
      keep(scoped.tools.register(definition));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 回滚失败不回抛 */ }
    }
    writeMarker(`install: failed ${describeError(error)} @ ${new Date().toISOString()}`);
    logWarn(ctx, `dshome-agent-roles: 作用域安装异常（已回滚，不影响宿主）：${describeError(error)}`);
    return null;
  }
  writeMarker(`install: role tools + policy registered for agent ${agent && agent.id ? String(agent.id) : '?'} @ ${new Date().toISOString()}`);
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 卸载失败不回抛 */ }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// plugin apply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 宿主插件主体：每个**顶层** agent（`delegationDepth ?? 0 === 0`）装一次三把工具 + 协议段；
 * `agent/created` 增量装、`agent/disposed` 卸。子代理 agent 不装（否则子成员也能起成员、且 global 注册 restrict 管不到）。
 */
export function apply(ctx) {
  try {
    const agents = ctx && ctx.agents;
    const tools = ctx && ctx.tools;
    const subagents = ctx && ctx.subagents;
    // 服务缺失 = 降级，不是崩溃（verify-host-plugins 的最小 mock ctx 就走这条，且不能命中它的 FAIL_RE 字样）。
    if (!agents || !tools || !subagents) {
      logWarn(ctx, 'dshome-agent-roles: 降级——当前宿主未提供 agents/tools/subagents 服务，角色工具未注册（不影响其它插件）');
      return;
    }

    const state = { home: homeRoot(), nameIndex: new Map(), pendingGuards: new Map(), childGuards: new Map() };
    const installed = new Map();

    const maybeInstall = (agent) => {
      try {
        if (!agent || installed.has(agent)) return;
        const depth = agent.session && agent.session.header ? agent.session.header.delegationDepth : undefined;
        if ((depth ?? 0) > 0) return;                                        // 只装顶层会话
        if (!agent.ctx || !agent.ctx.tools || typeof agent.ctx.tools.register !== 'function') return;
        const dispose = installScoped(agent, ctx, state);
        if (typeof dispose === 'function') installed.set(agent, dispose);
      } catch (error) {
        logWarn(ctx, `dshome-agent-roles: agent 作用域安装异常（已跳过）：${describeError(error)}`);
      }
    };

    let live = [];
    try { live = agents.list() || []; } catch (error) { logWarn(ctx, `dshome-agent-roles: agents.list() 失败：${describeError(error)}`); }
    for (const agent of live) maybeInstall(agent);

    ctx.on('agent/created', (payload) => {
      const created = payload && payload.agent;
      maybeInstall(created);
      // 补装挂起的成员执行期闸：子 agent 进注册表的那一刻装上（早于它跑第一步），无竞态。
      try {
        const createdId = created && created.id ? String(created.id) : '';
        if (createdId !== '' && state.pendingGuards.has(createdId)) {
          const filter = state.pendingGuards.get(createdId);
          state.pendingGuards.delete(createdId);
          const applied = applyChildGuard(state, created, filter);
          writeMarker(`guard: child ${createdId} ${applied.installed ? 'installed' : `FAILED ${applied.reason}`} @ ${new Date().toISOString()}`);
        }
      } catch { /* 补装失败不影响主流程 */ }
    });
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent;
        const dispose = installed.get(agent);
        if (typeof dispose === 'function') dispose();
        installed.delete(agent);
        const agentId = agent && agent.id ? String(agent.id) : '';
        if (agentId !== '') {
          const childDispose = state.childGuards.get(agentId);
          if (typeof childDispose === 'function') childDispose();
          state.childGuards.delete(agentId);
          state.pendingGuards.delete(agentId);
        }
      } catch (error) {
        logWarn(ctx, `dshome-agent-roles: agent 卸载异常：${describeError(error)}`);
      }
    });
    ctx.effect(() => () => {
      for (const dispose of installed.values()) {
        try { dispose(); } catch { /* 清理失败不回抛 */ }
      }
      installed.clear();
      for (const dispose of state.childGuards.values()) {
        try { dispose(); } catch { /* 清理失败不回抛 */ }
      }
      state.childGuards.clear();
      state.pendingGuards.clear();
    }, 'dshome-agent-roles.scopedTools()');

    writeMarker(`apply: mounted (top-level scoped install; ${installed.size} agent(s) now) @ ${new Date().toISOString()}`);
    logInfo(ctx, 'dshome-agent-roles: 角色工具已挂载（顶层 scope 安装 role_list/role_spawn/role_send + 管控者协议）');
  } catch (error) {
    logWarn(ctx, `dshome-agent-roles: 自身挂载异常（已降级，不影响其它插件）：${describeError(error)}`);
  }
}
