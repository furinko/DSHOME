// dshome-agent-roles — 角色卡 → 独立 persona 子代理（host 插件）。
//
// 为什么：官方团队插件（@deepseek-ai/dsh-experimental-tool-agent-team）给不了「每个成员独立系统提示词」——
//   它只按 Team membership 装同一套工具 + 同一段 POLICY，persona 是部署级/预设级的一份。
//   本插件把「角色卡」（markdown：frontmatter 定能力面/模型，正文=系统提示词）接到 DSH 原生子代理接缝上：
//   persona 真替换部署 persona（`request.persona` → 子会话 `deployment:persona-prefix` 作用域段），
//   工具面按卡收窄（`request.toolFilter` → `childCtx.tools.restrict`），模型按卡路由（`request.agentOptions`）。
//
// 与官方范式的同构点（照抄结构、不照抄内容）：
//   · 八把工具（成员线 role_list/role_spawn/role_send + **卡线 role_card_list/read/write/retire/rename**）注册进「顶层 agent 的精确 scope」而不是宿主平面全局 —— `dsh-experimental-tool-agent-team/lib/index.js:225-548`
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
// buildToolFilter / composePersona / renderPolicyText / buildStartSpec / reportHint / roleLabel /
// legacyRoleLabel / parseRoleLabel / normalizeTools / normalizeModel / toolFaceOfCard / inlineToolsError。
// fs 只出现在 discoverCards / saveCardAtomic / writeMarker 里，测试传临时目录即可。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
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
/**
 * 成员归属表文件名（`profiles/dshome/.dsh-market/` 下，**append-only**）：`childId → cardId`（JSONL）。
 *
 * 为什么单独一个文件、且**不设行数上限**：老成员重启后正是靠它认人（见 `recognizeMember`），而
 * `agent-roles-marker.txt` 是**诊断面**（`slice(-20)`，且 `scripts/growth-audit.mjs:68` 把「≤20 行」当硬判据）
 * ⇒ 把认人依据塞进诊断环里，迟早被滚掉 = 老成员认不出 = 不补闸。这份是**契约面**：只追加、不裁剪
 * （每行 ~150B，只在「重启后认人」路径上读一次）。
 */
const MEMBER_MAP_FILE = 'agent-roles-members.jsonl';
/**
 * 卡改动台账（`.dsh-market` 下，**append-only JSONL、不裁剪**）：每次 `role_card_write` 落 begin/done 两行。
 *
 * 为什么必须有：卡=成员的系统提示词，而此前"改卡"只能靠通用写工具 ⇒ **改了什么、谁改的、为什么改没有任何留痕**
 * （`mind\L2\agents` 那份"卡改动台账"的引用一直是空头引用）。台账是"自动调优卡片"这条链的**审计面**：
 * 与 `AUDIT_FILE`（成员写操作留痕，只留最近 2000 行）不同，这份**不裁剪**——它是证据，不是诊断环。
 */
const CARD_LEDGER_FILE = 'agent-roles-card-ledger.jsonl';

/** 旧格式 label 前缀：`role:<cardId>:<memberName>`。**保留**：老成员的 label 永远是它，是判据。 */
export const ROLE_LABEL_PREFIX = 'role:';
/** label 左段与成员名的分隔符（新旧格式都用 `:`；新旧格式的区别只在左段是卡 id 还是卡中文名）。 */
export const ROLE_LABEL_SEP = ':';
/** 默认子代理 provider（`dsh-subagent-spawn-in-process/lib/index.js:13`）。 */
export const DEFAULT_PROVIDER = 'spawn';
/**
 * 顶层(=delegationDepth 0)起成员必须传的绝对深度上限。
 * ⚠️ 传 0 会被 `delegationDepth(parent)+1 > maxDepth` 直接拒（`dsh-subagent/lib/index.js:432-437`）。
 */
export const MEMBER_MAX_DEPTH = 1;
/** 固定级联闸：成员不得再起成员/跑编排（先按调用者可见性过滤后再进 filter，见 buildToolFilter）。 */
export const CASCADE_DENY = ['subagent', 'subagent_fork', 'workflow', 'ralph'];
/** 本插件自己的**八把**工具（成员线 3 + 卡线 5）：只在顶层 own-scope，属于「子成员不可解析」的名字（绝不能进 filter）。
 *  卡线先三把（2026-09-25 加，主人放行）：`role_card_list` / `role_card_read` / `role_card_write` —— 把"自动调优卡片"
 *  从"只能拿通用写工具改文件"补成**受控闭环**（乐观锁 + 原子写 + 卡改动台账 + 只动 version 那一行）；
 *  同批后续加 `role_card_retire`（退役卡：移出卡池、可 restore、有留痕）与 `role_card_rename`
 *  （**给卡改 id**：内联建卡折算出的 `inline-<hex>` 靠它改成可读 id —— 只重写 frontmatter 的 `id:` 那一行 + 文件名，
 *  同样带乐观锁/台账/原子写）。 */
export const ROLE_TOOL_NAMES = ['role_list', 'role_spawn', 'role_send', 'role_card_list', 'role_card_read', 'role_card_write', 'role_card_retire', 'role_card_rename'];
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

/**
 * 私密卡目录（相对 home root）：`<home>\mind-private\L2\agents\<id>.md`。
 *
 * **2026-09-23 从 `L0\agents` 搬到 `L2\agents`**（主人拍板）：`mind-private\L0\` 在 `mind-guard` 的
 * **高危区**名单里（`mind-guard.js:295`）⇒ 卡改动要走批准面、**子成员一律改不了卡**——连"优化提示词"
 * 这件已授权的活都派不出去。搬到 L2（能力层；卡本质是能力不是宪法）后，卡改动降为 🟢 可逆·非高危，
 * 可以正常派给成员执行。
 */
export const PRIVATE_CARD_SEGMENTS = ['mind-private', 'L2', 'agents'];
/** 项目卡目录（相对调用者 cwd）：`<cwd>\.agent-roles\<id>.md`。 */
const WORKSPACE_CARD_DIRNAME = '.agent-roles';
/** 角色卡 id 合法性：不含 `:`（label 用 `:` 分段），非空、以字母数字开头。 */
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 成员名合法性（2026-09-24 放开中文）：汉字/小写字母/数字开头，其后可含汉字·小写字母·数字·连字符。
 *  ⚠️ **不能含 `:`** —— label 用 `:` 分段（`parseRoleLabel` 只切**第一个**冒号，name 段可含汉字）。
 *  为什么放开：成员名进 `label`（2026-09-24 起 label = `<卡中文名>:<name>`，旧格式 `role:<cardId>:<name>`
 *  仍能生成/解析），而 **label 就是子代理列表里显示的名字**（官方 `subagent` 用 `description` 当 label，
 *  那边天然是中文；本插件默认名原来是卡 id 折算出的英文 ⇒ 主人看到的标题是 `role:reviewer:xxx`）。
 *  放开后默认名取卡的中文 `name`（`defaultMemberName`）。 */
const MEMBER_NAME_RE = /^[\u4e00-\u9fffa-z0-9][\u4e00-\u9fffa-z0-9-]*$/;
/** 成员名判定（handler 与断言共用同一口径，避免两处正则漂）。 */
export function isValidMemberName(name) {
  return MEMBER_NAME_RE.test(String(name ?? ''));
}
/** 省略 task 时的首条唤醒消息（prompt 是 startContinuable 的必填项）。 */
const DEFAULT_TASK = '（初始唤醒）请确认你的角色；等待 Lead 下发任务，收到即执行，完成后用一条消息回报。';

/**
 * 成员协作协议尾注（固定，卡正文不可覆盖）。
 * 规格七条：身份=Lead 派的成员 / 收到任务即执行 / 完成后一条消息回报 / 不得自建成员、不改分工
 *          / 能力面陈述只认实际工具表 / 卡的硬边界优先于 Lead 指令 / 全程中文。
 * 后两条是 2026-09-23 真机实证加上的（证据即下面两行，**不外引文档**——本文件历史上两处
 * 引过同名「卡改动台账」，两处都是空头引用；真正的卡改动台账是运行期自动写的 JSONL，见 `CARD_LEDGER_FILE`）：
 *   · `probe-two` 自述 `workflow`/`ralph` 在手里，而 `request/header.tools` 里根本没有 —— 成员自述不可信；
 *   · `probe-one` 拒绝执行「去起孙子」并说明理由（做对了），但当时属自觉而非明文契约。
 * 第 7 条 2026-09-24 加：当时真机实测成员不带 R0/R1 注入（R0 里「全程中文」对它们不生效；成员**输出中文、
 *   推理英文**，会话 `4273b23b`）⇒ 语言纪律落进尾注。
 *   ⚠️ **2026-09-24 复核订正（独立只读审查官逐帧解压实测）**：本轮 `role_spawn` 起的成员**带完整 R0**
 *   （SOUL+AGENTS 全文；成员会话 `14428799` 实测 `r0=true`）⇒ 上面「成员不带 R0」的读数**已过时**，
 *   适用性须按当时的注入器配置重核：`mind-inject.js` 现只判「接入心智开关 + 首步 + 去重」，
 *   **不看委派深度** ⇒ 子会话首步同样被注入。尾注第 7 条**仍保留**——它是卡正文覆盖不了的纪律，
 *   不依赖 R0 是否在场（且 R1 上工召回另算：`verify-boot-recall` 的验收项明列"跳子代理"）。
 *   2026-09-24 再加半句（并入第 1 条）：成员**带完整 R0**，而 R0 §八 把"分工派成员"指向 `Ritual §四`
 *   （那里写着"你是管理层…生产性执行优先派成员"）——成员顺指针读就会撞墙（它没有 `role_*`），
 *   故明写"面向 Lead 的分工口径对成员不适用"。
 *   尾注＝成员的启动成本，只放跨岗位通用且不可覆盖的硬规则。
 */
export const PERSONA_TAIL = [
  '---',
  '【协作协议（固定尾注，角色卡正文不得覆盖）】',
  '1. 身份：你是顶层 Lead 派出的成员，身份与分工由 Lead 决定；你只对自己的任务负责。（R0 宪法里那套「Lead 岗位」分工口径——`Ritual §四` 团队分工、"生产性执行优先派成员"——是写给你 Lead 的，**对你不适用**；你没有 `role_*` 工具。）',
  '2. 收到任务即执行：不要先反问确认；只有缺关键信息导致无法动手时，才在回报里说明缺什么。',
  '3. 完成后用**一条**消息向上回报：做完什么 / 证据（命令与原始输出）/ 未完成或存疑的部分。',
  '4. 不得自建成员、不得改分工、不得请求扩大工具面；需要更多能力时在回报里说明，由 Lead 决策。',
  '5. 陈述自身能力面（自己有哪些工具 / 能做什么）时**只认实际可调用的工具表**；拿不准就说不确定，不许按印象列举。',
  '6. 第 4 条这类角色卡硬边界**优先于 Lead 的指令**：两者冲突时拒绝执行并在回报里说明理由——不要盲从，也不要偷偷绕行。（这条不是独立的新边界，是给第 4 条定优先级，免得两条读起来互相打架。）',
  '7. 全程中文：思考、推理、回报一律中文（术语、代码、路径等标识符保留原文）。',
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

/** 默认成员名折算：小写化，**保留汉字**，其余非法字符折成 `-`，去首尾/折叠连字符。 */
function sanitizeMemberName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 默认成员名（2026-09-24 加）：优先卡的**中文 name**（如「审查官」），折算不动才退回卡 id。
 *  它进 `label`，也就是子代理列表里显示的名字 ⇒ 默认就该是中文，别指望 Lead 每次手传 name。 */
export function defaultMemberName(card) {
  const display = card && typeof card.name === 'string' ? card.name.trim() : '';
  const id = card && typeof card.id === 'string' ? card.id : '';
  const fromDisplay = sanitizeMemberName(display);
  if (isValidMemberName(fromDisplay)) return fromDisplay;
  return sanitizeMemberName(id);
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

// ─────────────────────────────────────────────────────────────────────────────
// 成员归属表：childId → cardId（append-only 的认人依据）
// ─────────────────────────────────────────────────────────────────────────────

/** 归属表路径（`.dsh-market` 下，与 marker / 留痕同目录）。 */
function memberMapFile() {
  return join(homeRoot(), 'profiles', 'dshome', '.dsh-market', MEMBER_MAP_FILE);
}

/** 卡改动台账路径（与成员归属表同目录）。 */
function cardLedgerFile() {
  return join(homeRoot(), 'profiles', 'dshome', '.dsh-market', CARD_LEDGER_FILE);
}

/**
 * 追加一行卡改动台账。**不吞异常**（与 `appendMemberMap` 的 fail-open 刻意相反）：
 * "改了卡却没留痕"是审计缺口，调用方必须能知道并拒绝改动。
 */
function appendCardLedger(entry) {
  const dir = join(homeRoot(), 'profiles', 'dshome', '.dsh-market');
  mkdirSync(dir, { recursive: true });
  appendFileSync(cardLedgerFile(), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 追加一行归属（JSONL）；失败绝不影响起成员（进程内索引仍在，重启后的认人退到 label 解析）。 */
function appendMemberMap(entry) {
  try {
    const dir = join(homeRoot(), 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, MEMBER_MAP_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 归属表写失败不影响功能 */ }
}

/**
 * 记一条成员归属：进程内 Map + 落盘各一份。
 * 为什么落盘也要记：闸装在 agent scope 上、**不在** `subagent/descriptor` 里 ⇒ 进程重启后拿不回它，
 * 只能按 label / 归属表认人补装 —— 而 label 的左段（卡名）可能改过名、可能重名、可能压根没有（外来成员
 * 的自由文本），此时**只有 childId→cardId 是确定的**。
 */
function rememberMember(state, childId, cardId, label) {
  const id = String(childId ?? '');
  if (id === '') return;
  const card = String(cardId ?? '');
  if (state.memberCards) state.memberCards.set(id, card);
  appendMemberMap({ childId: id, cardId: card, label: String(label ?? ''), at: new Date().toISOString() });
}

/** 确保 state 上的归属索引可用（防御：state 由 apply 建，但纯函数被单测直接调时可能没带）。 */
function memberCardIndex(state) {
  if (!(state.memberCards instanceof Map)) {
    state.memberCards = new Map();
    state.memberCardsLoaded = false;
  }
  return state.memberCards;
}

/**
 * 查归属（`childId → cardId`）：先内存索引，首次调用时从落盘表读一遍（只读一次）。
 * 读不回来 = `''` = **不认**（fail-closed，见 recognizeMember）。
 */
function memberCardId(state, childId) {
  const id = String(childId ?? '');
  if (id === '') return '';
  const index = memberCardIndex(state);
  if (!state.memberCardsLoaded) {
    state.memberCardsLoaded = true;
    let text = '';
    try { text = readFileSync(memberMapFile(), 'utf8'); } catch { text = ''; }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let row = null;
      try { row = JSON.parse(line); } catch { continue; }   // 半截尾行（写中断）在这里被挡掉
      if (!row || typeof row.childId !== 'string' || row.childId === '') continue;
      index.set(row.childId, typeof row.cardId === 'string' ? row.cardId : '');   // 同 childId 后写赢
    }
  }
  const hit = index.get(id);
  return typeof hit === 'string' ? hit : '';
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
const CARD_TOP_KEYS = ['id', 'name', 'description', 'model', 'tools', 'paths'];

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
  // `paths.allow`（可选）：本角色允许写的路径白名单（目录前缀或具体文件；相对按成员 cwd 解析）。
  // 给了它 ⇒ 起成员时启用**路径闸**；不给 ⇒ 不启用（`role_spawn` 返回值里标注 `writeScope: 'unbounded'`）。
  const pathsRaw = normalizeTools(fm.paths, warnings);
  const writePaths = pathsRaw.allow;

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
      writePaths,
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

/** 成员写操作留痕文件（独立于 marker：marker 只留最近 20 行，这里是审计面，留最近 2000 行）。 */
const AUDIT_FILE = 'agent-roles-writes.jsonl';
/** 会被留痕的"可能落盘"工具（`pwsh`/`bash` 在 danger-full-access 下能写任何文件）。 */
const AUDIT_TOOLS = ['write', 'edit', 'str_replace_editor', 'pwsh', 'bash'];

/**
 * 2026-09-23 主人拍板「甲」：**成员写操作留痕**。
 *
 * 为什么需要：`restrict` 与 `guard` 都只按**工具名**判定，而 `pwsh` 在 `danger-full-access` 下
 * 能写任何文件 ⇒ "只读角色"原本只是**文本承诺**，判据 #1（不越界）对含 `pwsh` 的角色**恒绿**。
 * 留痕给它一个**事后可核**的 oracle（谁、什么时候、动了哪个路径/跑了什么命令）。
 *
 * **诚实上限**：它只记录、**不能当场拦住**；真正防越界要靠下一轮「卡声明 paths + 路径闸」。
 */
function writeAuditLine(line) {
  try {
    const dir = join(homeRoot(), 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, AUDIT_FILE);
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), line].slice(-2000);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch { /* 留痕失败绝不影响功能 */ }
}

/** 会被"路径闸"覆盖的写工具（`pwsh`/`bash` 不在此列：命令级"是不是写"解析不可靠 ⇒ 只留痕、不拦）。 */
const WRITE_PATH_TOOLS = ['write', 'edit', 'str_replace_editor'];

/** 归一化路径：相对 → 按 cwd 转绝对；统一分隔符；去尾斜杠；**折小写**（Windows 不区分大小写）。 */
function normalizePath(target, cwd) {
  try {
    const raw = String(target || '');
    if (raw === '') return '';
    // 2026-09-24 修：**绝对路径也必须过 `resolve`**。原实现 `isAbsolute(raw) ? raw : resolve(...)` 让绝对路径原样保留，
    // 而判定是字符串前缀匹配（见 `pathAllowed`）⇒ `E:\…\mind-private\..\x.txt` 只要字符串以白名单前缀开头就放行，
    // 但写入层会消解 `..` ⇒ 真机实测文件真落到白名单外（证据与复现见 L3 project.md 对应条目）。
    const abs = resolve(cwd || process.cwd(), raw);
    return abs.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  } catch { return ''; }
}

/**
 * 路径闸判据（2026-09-23 主人「你定」后落 · 方案乙）：白名单里的**目录前缀或具体文件**之内才放行。
 * - 白名单为空 ⇒ 返回 true（＝**未启用**路径闸；调用方必须在返回值里标注 `unbounded`，不许静默放宽）
 * - 白名单非空但**取不到目标路径** ⇒ 返回 false（fail-closed）
 * @param {string} target - 本次写目标（来自 `describeToolTarget`）
 * @param {string[]} allowPaths - 允许写的路径（相对按 `cwd` 解析）
 * @param {string} cwd - 解析相对路径的基准（成员的工作区）
 */
export function pathAllowed(target, allowPaths, cwd) {
  const list = toNameList(allowPaths);
  if (list.length === 0) return true;
  const t = normalizePath(target, cwd);
  if (t === '') return false;
  return list.some((p) => {
    const a = normalizePath(p, cwd);
    return a !== '' && (t === a || t.startsWith(`${a}\\`));
  });
}

/**
 * ③ 自检（2026-09-23 加）：列出"**注册在该 agent 自己 scope、`restrict` mask 不掉**"的工具名。
 * 为什么：主实例 preset 开 `modelSelectionSettings` 时 `subagent` 就是这一类（本轮实测），
 * 将来某个开关一开可能再冒出一个 ⇒ 起成员时自动报出来，不靠人肉扫源码。
 * @param {{visible?:Map<string,unknown>, restrictableNames?:Set<string>}} view - `ctx.tools.view(agent)` 的结果
 * @returns {string[]|null} 工具名（排序）；拿不到视图时返回 null（未验证，不是"没有"）
 */
export function ownScopeTools(view) {
  try {
    const visible = view && view.visible;
    const restrictable = view && view.restrictableNames;
    if (!visible || typeof visible.keys !== 'function') return null;
    if (!restrictable || typeof restrictable.has !== 'function') return null;
    return [...visible.keys()].filter((toolName) => !restrictable.has(toolName)).sort();
  } catch { return null; }
}

/** 从工具参数里抽"这次会碰哪里"：`write`/`edit` → 路径；`pwsh`/`bash` → 命令压平后的首段。抽不到返回 ''。 */
export function describeToolTarget(name, args) {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    if (!parsed || typeof parsed !== 'object') return '';
    if (name === 'write' || name === 'edit' || name === 'str_replace_editor') {
      const path = parsed.path ?? parsed.file_path ?? parsed.filePath ?? parsed.target ?? '';
      return typeof path === 'string' ? path.slice(0, 240) : '';
    }
    if (name === 'pwsh' || name === 'bash') {
      const command = parsed.command ?? parsed.script ?? '';
      return typeof command === 'string' ? command.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    }
  } catch { /* 参数不是 JSON：当抽不到 */ }
  return '';
}

/**
 * 成员执行期闸 ＝ 能力面谓词（`buildToolGuard`）＋ **写操作留痕**。
 * 语义与 `buildToolGuard` 完全一致（拒绝理由原样返回），只是**放行**时对"可能落盘"的工具多记一行。
 * @param {{allow?:string[], deny?:string[]}} filter
 * @param {{label?:string, record?:function}} options - `label` 用于审计行；`record` 默认写审计文件
 */
export function buildMemberGuard(filter = {}, options = {}) {
  const predicate = buildToolGuard(filter);
  const label = typeof options.label === 'string' ? options.label : '';
  const record = typeof options.record === 'function' ? options.record : writeAuditLine;
  const writePaths = toNameList(options.writePaths);
  const cwd = typeof options.cwd === 'string' ? options.cwd : '';
  return (execution) => {
    const name = execution && typeof execution.name === 'string' ? execution.name : '';
    const denial = predicate(execution);
    if (denial) {
      try { record(JSON.stringify({ ts: new Date().toISOString(), kind: 'deny', label, tool: name, reason: denial })); } catch { /* 忽略 */ }
      return denial;
    }
    // 路径闸（opt-in：只有声明了 writePaths 才启用；只覆盖 write/edit/str_replace_editor）
    if (name !== '' && WRITE_PATH_TOOLS.includes(name) && writePaths.length > 0) {
      const target = describeToolTarget(name, execution && execution.arguments);
      if (!pathAllowed(target, writePaths, cwd)) {
        const reason = `写目标不在本次 write_scope 内：${target || '(未取到路径)'}（允许：${writePaths.join('、')}）`;
        try { record(JSON.stringify({ ts: new Date().toISOString(), kind: 'deny-path', label, tool: name, target, reason })); } catch { /* 忽略 */ }
        return reason;
      }
    }
    if (name !== '' && AUDIT_TOOLS.includes(name)) {
      const target = describeToolTarget(name, execution && execution.arguments);
      try { record(JSON.stringify({ ts: new Date().toISOString(), kind: 'pass', label, tool: name, target })); } catch { /* 忽略 */ }
    }
    return undefined;
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
  let card = cards.find((item) => item.id === wanted);
  if (!card) {
    // `role=` 也接受**卡中文名**（与 `role_send` 的寻址口径对齐，2026-09-24 复核后加）：内联建卡折算出的 id
    //   是 `inline-<hex>`（不可读），只认 id 等于把"用中文名复用"这条路堵死——而当时**注释与注入文案都在
    //   这么写**（"验证过的假"）。**重名不猜**：多张同名卡 ⇒ 当作未找到（让调用方显式给 id）。
    const byName = cards.filter((item) => item.name === wanted);
    if (byName.length === 1) card = byName[0];
  }
  if (!card) {
    const avail = cards.map((item) => (item.name && item.name !== item.id ? `${item.id}（${item.name}）` : item.id));
    return {
      ok: false,
      error: `未找到角色卡 "${wanted}"（可用：${avail.length > 0 ? avail.join('、') : '无'}${broken.length > 0 ? `；另有 ${broken.length} 张坏卡见 role_list` : ''}）`,
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

/** 管控者协议文本（顶层会话可见；与八把工具一一对应）。 */
export function renderPolicyText() {
  return [
    '【角色卡管控者协议（dshome/agent-roles）】',
    '你可以把「角色卡」起成独立成员：每个成员有自己的系统提示词（卡正文）、自己的工具面（卡 frontmatter 的 tools）和自己的模型路由（卡 model）。',
    '· role_list：列出可用角色卡（私密目录 + 项目 .agent-roles；同 id 项目卡覆盖私密卡）与坏卡原因。',
    '· role_spawn：role=<卡 id> 起一个 durable 成员；或 persona+name 内联建卡（save=true 才落盘，scope=workspace|private）。可选 tools/model 覆盖卡，task 作为首条任务消息。⚠️ **内联建卡必须显式给 tools:{allow:[...]}**（缺 tools 或空 allow ⇒ 直接报错：空 allow 在运行时＝**不收窄**＝成员拿到你全量工具面，不是"什么都没给"）。返回值里的 `toolFace` 如实标注这一格：`restricted`＝卡声明了 allow、面被真收窄；`unrestricted`＝卡未声明工具面 ⇒ 成员拿到调用者全量面（配 `toolFaceNote` 一行中文说明）。',
    '· role_send：给已起成员发消息（target=成员 name 或 childId）；成员在跑就 steer，空闲就唤醒。',
    '· role_card_list：列出卡的 hash / version / 路径 / 工具面 + 成员归属（childId→cardId）。',
    '· role_card_read：按 id 读整卡原文（调优的第一步）。',
    '· role_card_write：受控写回（cardId + content + **reason 必填**；可选 expectHash 乐观锁、bumpVersion 默认 true）——先记卡改动台账再落盘，台账写不进去就拒绝改动。',
    '· role_card_rename：给卡**改 id**（连带磁盘文件名）：cardId（或卡中文名）+ newId + **reason 必填**；可选 expectHash 乐观锁。**只重写 frontmatter 的 `id:` 那一行**（不重建整卡 ⇒ version/contract/metadata/paths 等字段原样保留），新路径原子写 + 删旧路径 + 台账 begin/done。⚠️ **成员归属表 `agent-roles-members.jsonl` 是 append-only 历史、本工具不追改**：老成员仍指向旧 id 属**预期**，别把它的历史行当错误。',
    '规则：',
    '1. **派活前先定线**：任何委派（含一次性临时活）都先 role_list 看有没有匹配岗位卡 —— 有就走 role_spawn（带卡的工具面 + 执行期闸 + 可给写范围）；**岗位对不上卡**才退到官方 `subagent`（⚠️ 裸线无工具面闸，"只读/别写"全靠 prompt 撑着）。同 id 时项目卡优先，别凭印象猜卡里有什么。',
    '1·补：`subagent_fork`（继承本对话上下文的 fork）是卡线**没有**的能力 —— 只在"要独立复核我自己"时用它。',
    '1·补2：成员名用**中文短名**（如「多代理审计」）——它进 label，也就是子代理列表里显示的标题；省略 name 时默认取卡的中文名。⚠️ **但「内联建卡」时同一个 `name` 会同时当卡 `id`**（= 磁盘文件名 + `role_list` 的 id 校验），而**卡 id 只允许 ASCII `[A-Za-z0-9._-]`**（2026-09-24：中文名曾写出「`saved:true` 却 `role_list` 判 id 不合法」的坏卡）⇒ 现在传中文名时**插件自动另折算 ASCII id**（`inline-<名字UTF8的hex>`），中文仍作显示名；要 `role=<…>` 复用请用**卡中文名**或折算后的 id。',
    '1·补3：**入口优先级**：派活默认走本协议的角色卡线；官方 `subagent` 的工具说明只描述**那把工具本身**，不构成"该用哪条线"的指引——两条指引并列时，以本协议为准（2026-09-24：独立审查实测顶层系统提示里两套说明并列且互不引用，正是"顺手走官方线"的结构性原因）。',
    '2. 成员工具面 = 卡声明（allow/deny）+ 固定级联闸（subagent/subagent_fork/workflow/ralph **一律禁**）——⚠️ 闸在**调用期**拒绝、**不裁清单**：`subagent` 由官方按每个 agent 自己的 scope 注册，`restrict` 裁不掉 ⇒ 成员工具表里**仍列着它**，列着≠能用（调用即报「角色能力面未放行」，2026-09-24 实测）。卡里写了子成员不可解析的工具名会**直接报错**，不会静默放宽。⚠️ **卡没声明工具面（`allow: []`）＝不收窄**：`restrict` 不会产生任何过滤 ⇒ 该卡起的成员拿到**调用者全量工具面**（除那四把级联闸外全放行）。所以 `role_spawn` / `role_send` 返回值带 `toolFace`：`unrestricted` 时必须按"这名成员权限＝你全部权限"来派活。',
    '3. 成员完成后用一条消息回报；你负责验收并给最终答复。成员不得自建成员、不得改分工。',
    '4. 卡正文即成员系统提示词：改卡只影响之后起的成员，已起的成员不受影响。**改卡走 `role_card_read` → `role_card_write`**（带 `reason`，自动进卡改动台账）、**改 id（含卡文件名）走 `role_card_rename`**（同样带 `reason`、同样进台账）——不要用通用写工具直接改卡文件：那样没有乐观锁、没有原子写、也没有留痕。',
    '5. 同一把工具不能同时写进 allow 与 deny —— 那是自相矛盾的声明，role_spawn 会直接报错（不会静默按 deny 处理）。',
    '6. 派**可写成员**（工程师这类）时尽量给 `write_scope`（路径白名单，目录前缀或具体文件）：给了它，成员的 `write`/`edit` 落到范围外会**当场被拒**；不给＝`unbounded`（只留痕、不拦，返回值会如实标注）。⚠️ `pwsh` **不受路径闸约束**（命令级"是不是写"解析不可靠）——所以卡里的行为契约仍然算数，别把"没被拦"当成"没风险"。',
    '7. 起成员后看返回值：`guardInstalled` 必须是 true；`ownScopeTools` 非空 ⇒ 这名成员手里有 **`restrict` 裁不掉的自注册工具**（真机实测：`subagent` 就是这一类）——**它仍在执行期闸的枪口下**（`buildToolGuard` 默认装上并拒调用，实测成员会话 `c779743f` 调用即报「角色能力面未放行」）；真正已在闸下被拒的那些由返回值 `ownScopeBlocked` 单列，别把"列在表里"读成"能用"。插件另写 marker 留痕。',
    '8. **退役卡走 `role_card_retire`**（`cardId` + `reason` 必填）：移出卡池（`role_list` / `role_spawn` 从此看不见它），**不物理删、可 `restore`、卡改动台账留痕**；与全局回收站 `TRASH\\` 的分工见该工具说明（它会把 `evolve-log trash` 命令打印出来）。',
    '【管理层宪章（Lead 岗位）】',
    '你的岗位 = 判断（做什么 / 验收判据）+ 分工（派谁 / 工具面 / 写范围）+ 演绎（与用户对话、汇报）；生产性执行（写码 / 改文件 / 大范围检索 / 构建 / 写文档）优先派成员。',
    '例外（自己做，不派）：一行改动、读文件即答、纯核查（抽查证据 / 复跑验证）。',
    '验收只抽查关键证据：读关键文件、复跑关键命令，核实结论依赖的那几个事实；不采信"已验证"自述；成员产出经你裁剪后呈现。',
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

/**
 * 新格式 label：`<卡中文名>:<成员名>`（**label 就是子代理列表标题** ⇒ 显示面全中文）。
 *
 * 卡中文名缺失（空/非字符串）时退回 `cardId`：**绝不产出以 `:` 开头的半截 label**（半截 label 谁都解析不出来 ⇒
 * 重启后认不回成员 ⇒ 不补闸）。
 * @param {string} cardName - 卡的中文 `name`
 * @param {string} memberName - 成员名
 * @param {{cardId?:string}} [options] - 卡名不可用时的退回值（卡 id）
 */
export function roleLabel(cardName, memberName, { cardId = '' } = {}) {
  const name = String(cardName ?? '').trim();
  const display = name !== '' ? name : String(cardId ?? '').trim();
  return `${display}${ROLE_LABEL_SEP}${String(memberName ?? '').trim()}`;
}

/**
 * 旧格式 label：`role:<cardId>:<memberName>`。
 *
 * 保留生成能力（回滚 / 老会话重放 / 断言里的旧格式正例）——**新代码不该再调它**：卡 id 只能 ASCII
 * （`CARD_ID_RE`）⇒ 旧格式天生中英混，正是本次要改掉的显示面。
 */
export function legacyRoleLabel(cardId, memberName) {
  return `${ROLE_LABEL_PREFIX}${cardId}${ROLE_LABEL_SEP}${memberName}`;
}

/**
 * 新格式左段判定（内部）：`<左段>:<成员名>`，左段必须**唯一命中已知卡的 name**。
 *
 * 为什么必须唯一命中：官方 `subagent` 的 label 是**自由文本**（工具 `description`，允许中文和冒号）
 * ⇒ 只按 `:` 切会把别人的 label 误认成我们的成员、进而给它**错装闸**。重名卡 ⇒ 无法唯一确定 ⇒ 不认
 * （倒向安全侧：不补闸只是少了闸；错认卡则是按错的卡装闸，比不装更坏）。
 * @returns `{status:'unique',cardId,name,matched}` / `{status:'ambiguous',matched}` / `{status:'none',matched}`
 */
function classifyNameLabel(label, knownCards) {
  const idx = label.indexOf(ROLE_LABEL_SEP);
  if (idx < 0) return { status: 'none', matched: [] };
  const left = label.slice(0, idx).trim();
  if (left === '') return { status: 'none', matched: [] };
  const matched = [];
  for (const card of Array.isArray(knownCards) ? knownCards : []) {
    if (!card || typeof card !== 'object') continue;
    const cardName = typeof card.name === 'string' ? card.name.trim() : '';
    const id = typeof card.id === 'string' ? card.id.trim() : '';
    if (id === '' || cardName === '' || cardName !== left) continue;
    if (!matched.includes(id)) matched.push(id);
  }
  if (matched.length === 1) return { status: 'unique', cardId: matched[0], name: label.slice(idx + 1), matched };
  if (matched.length > 1) return { status: 'ambiguous', matched };
  return { status: 'none', matched: [] };
}

/**
 * 解析 label。**双格式**（⚠️ 老成员的 label 永远是旧格式 ⇒ 旧路一个字都不许改）：
 *   ① `role:` 开头 ⇒ 旧格式 `role:<cardId>:<memberName>`；
 *   ② 否则按第一个 `:` 切，**左段必须唯一命中已知卡的 name** 才认，`cardId` = 命中卡的 id。
 * 认不出返回 `null`（调用方一律按「不补闸」处理）。
 * @param {string} label
 * @param {Array<{id?:string,name?:string}>} [knownCards] - 已知角色卡（新格式唯一匹配用；给不出 ⇒ 新格式一律不认）
 * @returns {{roleId:string,name:string,cardId:string,format:'legacy'|'name'}|null}
 */
export function parseRoleLabel(label, knownCards = []) {
  if (typeof label !== 'string' || label === '') return null;
  if (label.startsWith(ROLE_LABEL_PREFIX)) {
    const rest = label.slice(ROLE_LABEL_PREFIX.length);
    const idx = rest.indexOf(ROLE_LABEL_SEP);
    const roleId = idx < 0 ? rest : rest.slice(0, idx);
    const name = idx < 0 ? '' : rest.slice(idx + 1);
    return { roleId, name, cardId: roleId, format: 'legacy' };
  }
  const classified = classifyNameLabel(label, knownCards);
  if (classified.status !== 'unique') return null;
  return { roleId: classified.cardId, name: classified.name, cardId: classified.cardId, format: 'name' };
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
  // 显示名（label 左段 = 子代理列表标题的左半）：卡的中文 `name`。
  // 退回卡 id 的两种情形：① 卡没有 name（内联卡/卡作者没写）；② name 里含 `:` —— 那会破坏 label 分段
  //   （解析只切第一个冒号）⇒ 认不回成员 ⇒ 与其产出一个解析不出来的 label，不如退回 ASCII 卡 id。
  const cardNameRaw = card && typeof card.name === 'string' ? card.name.trim() : '';
  const cardName = cardNameRaw !== '' && !cardNameRaw.includes(ROLE_LABEL_SEP) ? cardNameRaw : roleId;
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
  return { provider: DEFAULT_PROVIDER, label: roleLabel(cardName, memberName, { cardId: roleId }), request };
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

/**
 * 「这一格工具面到底意味着什么」的标注（2026-09-26 加）：`restricted` = 卡声明了 allow、面被真收窄；
 * `unrestricted` = 卡未声明工具面 ⇒ **不收窄**、成员拿到调用者全量面（配 `toolFaceNote` 一行中文说明）。
 * ⚠️ 只加这两把，**不改 allow/deny 本身的语义**（`role_list` 的 `tools.allow: []` 照旧原样给机器读；
 * 标注是给人/模型看的第二把判据）。
 */
const TOOL_FACE_PROPS = {
  toolFace: { type: 'string', enum: ['restricted', 'unrestricted'] },
  toolFaceNote: { type: 'string' },
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
    ...TOOL_FACE_PROPS,
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

/** role_card_retire 的输出形状（退役 / 列出已退役 / 取回）。 */
const CARD_RETIRE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    code: { type: 'string' },
    cardId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    restore: { type: 'string' },
    trashCmd: { type: 'string' },
    liveMembers: { type: 'number' },
    note: { type: 'string' },
    retired: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};
const CARD_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    code: { type: 'string' },
    cards: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' }, path: { type: 'string' }, hash: { type: 'string' }, version: { type: 'string' }, bodyChars: { type: 'number' }, tools: TOOLS_SUB_SCHEMA, ...TOOL_FACE_PROPS } } },
    members: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['childId'], properties: { childId: { type: 'string' }, cardId: { type: 'string' }, at: { type: 'string' } } } },
    dirs: { type: 'object', additionalProperties: true },
  },
};

const CARD_READ_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    code: { type: 'string' },
    cardId: { type: 'string' },
    name: { type: 'string' },
    path: { type: 'string' },
    hash: { type: 'string' },
    version: { type: 'string' },
    bodyChars: { type: 'number' },
    text: { type: 'string' },
  },
};

const CARD_WRITE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    code: { type: 'string' },
    cardId: { type: 'string' },
    path: { type: 'string' },
    beforeHash: { type: 'string' },
    afterHash: { type: 'string' },
    currentHash: { type: 'string' },
    versionFrom: { type: 'string' },
    versionTo: { type: 'string' },
    bumped: { type: 'boolean' },
    bytesBefore: { type: 'number' },
    bytesAfter: { type: 'number' },
    reason: { type: 'string' },
    warning: { type: 'string' },
  },
};

/** role_card_rename 的输出形状（改 id：新/旧路径 + 前后 hash + 旧文件是否真删掉）。 */
const CARD_RENAME_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    code: { type: 'string' },
    cardId: { type: 'string' },
    newId: { type: 'string' },
    oldPath: { type: 'string' },
    path: { type: 'string' },
    beforeHash: { type: 'string' },
    afterHash: { type: 'string' },
    currentHash: { type: 'string' },
    reason: { type: 'string' },
    oldRemoved: { type: 'boolean' },
    ids: { type: 'array', items: { type: 'string' } },
    warning: { type: 'string' },
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
    writeScope: { type: 'string' },
    ownScopeTools: { type: 'array', items: { type: 'string' } },
    ownScopeBlocked: { type: 'array', items: { type: 'string' } },
    unknown: { type: 'array', items: { type: 'string' } },
    available: { type: 'array', items: { type: 'string' } },
    broken: { type: 'array', items: BROKEN_ROW_SCHEMA },
    ...TOOL_FACE_PROPS,
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
    guardInstalled: { type: 'boolean' },
    guardReason: { type: 'string' },
    members: { type: 'array', items: { type: 'string' } },
    ...TOOL_FACE_PROPS,
  },
};

/** 统一的模型可见渲染：整条 JSON（结构化错误也在里面）。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具面标注（2026-09-26 加）：治「卡声明越少、成员权限越大」的静默放宽
//
// 缺陷实测（Lead 在 LianChaoGame 会话亲手撞的）：`role_spawn` 走**内联建卡**（persona+name）而调用者
// 没给 `tools` 时，返回值里是 `allow: []`——**看着像"什么都没给"，而成员实际拿到的是调用者全量工具面**
// （成员自己回报的工具表＝完整 26 把，含 write/pwsh/subagent/send_message）。根因在 `buildToolFilter`：
// `allow` 为空且 `deny` 为空 ⇒ **不产生 toolFilter** ⇒ 子会话 `restrict` 不做任何裁剪 ⇒ 全量继承。
// 这与协议文案「成员工具面＝卡声明＋固定级联闸」正好相反，且**没有任何一处标注** ⇒ Lead 读到 `allow: []`
// 只会以为"成员没工具"，实际是"成员什么都有"。
//
// 本段只做两件事，都不改工具面的**实际**收窄逻辑（那是 buildToolFilter 的事）：
//   · `toolFace` / `toolFaceNote`：把"这一格是'未声明 ⇒ 全量'还是'已声明 ⇒ 受限'"显式写进返回值；
//   · 内联建卡的**响亮失败**：没显式给 allow ⇒ 直接拒，别让默认值替调用者做"全量"这个决定。
// ─────────────────────────────────────────────────────────────────────────────

/** 工具面标注文案（`role_spawn` / `role_send` / `role_list` / `role_card_list` 四处共用同一口径）。 */
const TOOL_FACE_NOTE = '该卡未声明工具面（frontmatter 无 tools.allow）⇒ 不做任何收窄，成员拿到的是调用者全量工具面（只有固定级联闸 subagent/subagent_fork/workflow/ralph 在执行期被拒）。要收窄请给卡声明 tools:{allow:[...]}。';

/** 内联建卡缺工具面时的下一步指引（错误文案必须自带出路，不能只报错）。 */
const INLINE_TOOLS_HINT = '内联建卡必须显式声明工具面（这是**刻意的响亮失败**）：请显式给 tools:{allow:[...]}；确实要全量工具面就把你手里的工具名逐个列出来（别用空列表 —— 空 allow 会被运行时读成"不收窄"＝全量继承）。';

/**
 * 一张卡起的成员，工具面是**被收窄**还是**调用者全量**（＝本轮要治的那一格）。
 *
 * ⚠️ 判据只用 **`tools.allow` 是否非空**，不用"有没有 toolFilter"：`buildToolFilter` 的固定级联闸
 * （`subagent`/`subagent_fork`/`workflow`/`ralph`，只要名字可下发就会进 deny）几乎总会产出一个 filter，
 * 所以"有 filter"只说明**那四把被拒**，不说明成员的**面被裁过**。实测（本机）：
 * `{allow:[],deny:[]}` 的卡 + 正常可见面 ⇒ `filter = {deny:[subagent_fork,workflow,ralph]}` ⇒ 成员手里
 * 仍是**除级联四把之外的全部工具**（正是 Lead 实测的「成员拿到调用者全量工具面，含 write/pwsh」）。
 * 所以：`allow` 非空 ⇒ 白名单真裁了面 ⇒ `restricted`；`allow` 为空（无论有没有写 deny）⇒ `unrestricted`
 * ——只写了 deny 的卡会把那把工具去掉，但**面本身没收窄**，标注必须说这句话，不能拿 deny 冒充收窄。
 * @param {{tools?:{allow?:unknown,deny?:unknown}}} card
 * @returns {{toolFace:'restricted'|'unrestricted', toolFaceNote:string}}
 */
export function toolFaceOfCard(card) {
  const allow = card && card.tools ? toNameList(card.tools.allow) : [];
  if (allow.length > 0) return { toolFace: 'restricted', toolFaceNote: '' };
  return { toolFace: 'unrestricted', toolFaceNote: TOOL_FACE_NOTE };
}

/**
 * 内联建卡的**前置门**：没显式声明工具面（缺 `tools` / `allow` 空数组 / `tools:{}`）⇒ 返回中文错误文案。
 *
 * 为什么必须拦在**落盘与起成员之前**：内联卡若 `allow: []`，`serializeCard` 会把 `tools:` 整段丢掉
 * ⇒ 落盘成一张"未声明工具面"的卡（与"本来就想声明空面"的意图不符，且下一个人读到它照样全量继承）；
 * 更要紧的是**成员已经起来了、工具面是全量**，而返回值只有一句 `allow: []`。
 * @param {{allow?:unknown}} normalized - `normalizeTools(input.tools, [])` 的归一化结果
 * @returns {string} 错误文案；'' = 通过
 */
export function inlineToolsError(normalized) {
  const allow = toNameList(normalized ? normalized.allow : null);
  if (allow.length > 0) return '';
  return '内联建卡的 tools.allow 为空（未给 tools / 给了空数组 / 给了 tools:{}）—— 若照此起成员，返回值会显示 allow: []，'
    + '而成员实际拿到的是**调用者全量工具面**（空 allow 在运行时＝不收窄），这正是"卡声明越少、成员权限越大"的静默放宽。'
    + INLINE_TOOLS_HINT;
}

// ─────────────────────────────────────────────────────────────────────────────
// 八把工具（注册进顶层 agent 的精确 scope）
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

/** 卡文本的稳定指纹（sha256 前 16 位十六进制）：乐观锁与留痕共用它。 */
export function cardTextHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 就地推进 frontmatter 的 `version:`（默认语义 a.b.c → a.(b+1).0；无 version 行则原样返回）。
 *
 * 为什么只动这一行、不做整卡 re-serialize：`serializeCard` 只认 id/name/description/model/tools/persona，
 * 整卡重序列化会**静默丢掉** `version` / `contract` / `metadata` / `paths` / `extra`（今天的血债：把一份
 * 157 行文档写成 25 字节）。卡改动必须**外科手术式**，不能"重建"。
 */
export function bumpCardVersion(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) { if (lines[i].trim() !== '') { first = i; break; } }
  if (first < 0 || lines[first].trim() !== '---') return { text: source, changed: false, from: '', to: '' };
  let close = -1;
  for (let i = first + 1; i < lines.length; i += 1) { if (lines[i].trim() === '---') { close = i; break; } }
  if (close < 0) return { text: source, changed: false, from: '', to: '' };
  for (let i = first + 1; i < close; i += 1) {
    const m = /^(\s*)version\s*:\s*(\S+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const parts = m[2].split('.');
    if (parts.length < 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      return { text: source, changed: false, from: m[2], to: m[2] };
    }
    const to = `${parts[0]}.${Number(parts[1]) + 1}.0`;
    lines[i] = `${m[1]}version: ${to}`;
    return { text: lines.join('\n'), changed: true, from: m[2], to };
  }
  return { text: source, changed: false, from: '', to: '' };
}

/**
 * 就地重写 frontmatter 的 `id:` 行（`role_card_rename` 的"外科手术刀"）。
 *
 * 为什么只动这一行、不做整卡 re-serialize：同 `bumpCardVersion` —— `serializeCard` 只认
 * id/name/description/model/tools/persona，整卡重建会**静默丢掉** `version` / `contract` / `metadata` /
 * `paths` / 其余 extra（本仓血债：一份 157 行文档被写成 25 字节）。
 *
 * 定位口径**照抄解析器**：`parseFrontmatter` 只把**顶层**（无缩进）的 `id:` 收进 `fm.id`
 * ⇒ 这里也只认顶层行（缩进的行属于某个子键的 map，改了它等于改错行）；同一文件里出现多行时
 * **最后一行赢**（解析器就是后写覆盖）⇒ 从后往前找，保证改的就是解析器真正读到的那个 id。
 * 值两端的引号风格（`id: "x"` / `id: 'x'`）原样保留；`id :`（冒号前有空格）也认。
 * @returns `{ text, changed, from }`；找不到顶层 id 行 ⇒ `changed:false`（调用方响亮失败，绝不猜、绝不重建）
 */
export function renameCardIdLine(text, newId) {
  const source = String(text ?? '');
  const target = String(newId ?? '');
  const lines = source.split('\n');
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) { if (lines[i].trim() !== '') { first = i; break; } }
  if (first < 0 || lines[first].trim() !== '---') return { text: source, changed: false, from: '' };
  let close = -1;
  for (let i = first + 1; i < lines.length; i += 1) { if (lines[i].trim() === '---') { close = i; break; } }
  if (close < 0) return { text: source, changed: false, from: '' };
  for (let i = close - 1; i > first; i -= 1) {
    const m = /^id\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const raw = m[1];
    const quoted = raw.length >= 2
      && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    const quote = quoted ? raw[0] : '';
    const from = stripQuotes(raw);
    lines[i] = `id: ${quote}${target}${quote}`;
    return { text: lines.join('\n'), changed: true, from };
  }
  return { text: source, changed: false, from: '' };
}

/** 读成员归属表（append-only JSONL）→ [{childId, cardId, at}]。读不到就返回空表（不抛）。
 *  ⚠️ 时间字段是 **`at`**（写侧 `rememberMember` 就这么写）——2026-09-25 曾误读成 `ts`，
 *  结果 `role_card_list` 的成员归属**每次都静默返回空时间**（字段名对不上 ⇒ `?? ''` 兜成空串，
 *  不报错、不告警）。**字段名照抄写侧，不做转译**：转译就是这种静默假数据的温床。 */
function readMemberMap() {
  const out = [];
  try {
    const raw = readFileSync(memberMapFile(), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.childId) out.push({ childId: String(obj.childId), cardId: String(obj.cardId ?? ''), at: String(obj.at ?? '') });
      } catch { /* 单行坏了不拖垮整表 */ }
    }
  } catch { /* 表不存在 = 还没起过成员 */ }
  return out;
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

/** 成员寻址：name（进程内索引 + listChildren 回填 label）/ childId / 卡 id / 卡中文名。 */
async function resolveMember(ctx, state, agent, target) {
  const parentId = String(agent && agent.id ? agent.id : '');
  // 新格式 label 的左段要靠「已知卡的 name」才认得出（见 parseRoleLabel）⇒ 这里先发现一次本会话的卡。
  const knownCards = knownCardsFor(state, agentCwd(agent));
  let childId = '';
  let memberName = '';
  let label = '';
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
    const entryLabel = typeof entry.label === 'string' ? entry.label : '';
    const parsedLabel = parseRoleLabel(entryLabel, knownCards);
    const entryName = parsedLabel && parsedLabel.name ? parsedLabel.name : '';
    if (entryName !== '') {
      members.push(`${entryName}(${String(entry.id)})`);
      state.nameIndex.set(indexKeyOf(parentId, entryName), String(entry.id));
    }
    // 兜底寻址：解析出的 **cardId** 或**卡中文名** === target（旧代码只认 roleId === target）
    const entryCardName = parsedLabel ? cardNameOf(knownCards, parsedLabel.cardId) : '';
    if (childId === '' && entryName !== '' && (entryName === target || (parsedLabel && (parsedLabel.cardId === target || entryCardName === target)))) {
      childId = String(entry.id);
      memberName = entryName;
      label = entryLabel;
    }
  }
  if (childId === '') {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && entry.kind === 'child' && String(entry.id) === target) {
        childId = String(entry.id);
        memberName = memberName || target;
        label = typeof entry.label === 'string' ? entry.label : '';
        break;
      }
    }
  }
  // 走进程内索引命中时 label 还是空的 ⇒ 从 listChildren 同一次结果里补上（跨进程恢复补闸要用它）
  if (label === '' && childId !== '') {
    const hit = (Array.isArray(entries) ? entries : []).find((entry) => entry && String(entry.id) === childId);
    if (hit && typeof hit.label === 'string') label = hit.label;
  }
  if (childId === '') {
    return { ok: false, members, error: `未找到成员 "${target}"（本会话可用成员：${members.length > 0 ? members.join('、') : '无'}）` };
  }
  return { ok: true, childId, name: memberName || target, label, members };
}

/**
 * 造八把工具的定义（raw register 形态；不用 defineTool）。
 * @param {{ctx:object, state:object}} deps
 */
export function makeRoleTools({ ctx, state }) {
  return {
    roleList: {
      name: 'role_list',
      description: '列出可用角色卡（角色卡 = 独立系统提示词 + 工具面 + 模型路由）。卡目录：私密 <DSH_HOME>/mind-private/L2/agents 与项目 <cwd>/.agent-roles；同 id 时项目卡覆盖私密卡。坏卡（缺 id / frontmatter 语法不支持 / 正文为空）在 broken 里带原因，不会静默跳过。',
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
              // 2026-09-26 加：`tools.allow: []` 不再"原样显示成空数组"就完事（见 toolFaceOfCard 头注）
              ...toolFaceOfCard(card),
            })),
            broken: briefBroken(discovery),
            dirs: { private: dirs.privateDir, workspace: dirs.workspaceDir },
          };
        } catch (error) {
          return { ok: false, error: `role_list 失败：${describeError(error)}` };
        }
      },
    },

    roleCardList: {
      name: 'role_card_list',
      description: '列出角色卡（含正文指纹 hash / version / 字数 / 路径 / 工具面）与成员归属（childId→cardId）。hash 是 role_card_write 的 expectHash 乐观锁凭据。卡此前"只能新建、不能读改"——这把补上"自动调优卡片"的读入口。',
      parameters: { type: 'object', properties: {} },
      output: { schema: CARD_LIST_SCHEMA, render: renderJson },
      async execute(_args, exec) {
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_card_list 需要调用者 agent（exec.agent 为空）' };
        try {
          const cwd = agentCwd(agent);
          const dirs = cardDirs(state, cwd);
          const discovery = discoverCards(dirs);
          const cards = discovery.cards.map((card) => {
            let hash = '';
            try { hash = cardTextHash(readFileSync(card.sourcePath, 'utf8')); } catch { hash = ''; }
            return {
              id: card.id,
              name: card.name || card.id,
              source: card.source,
              path: card.sourcePath || '',
              hash,
              version: String((card.extra && card.extra.version) || ''),
              bodyChars: card.body.length,
              tools: { allow: toNameList(card.tools ? card.tools.allow : null), deny: toNameList(card.tools ? card.tools.deny : null) },
              // 2026-09-26 加（Lead 点名的第 3 条）：`allow: []` **不许再原样显示成空数组**——
              // 它看着像"什么都没给"，而照此卡起的成员拿到的是调用者全量工具面。故显式标注。
              ...toolFaceOfCard(card),
            };
          });
          return { ok: true, cards, members: readMemberMap(), broken: briefBroken(discovery), dirs: { private: dirs.privateDir, workspace: dirs.workspaceDir } };
        } catch (error) {
          return { ok: false, error: `role_card_list 失败：${describeError(error)}` };
        }
      },
    },

    roleCardRead: {
      name: 'role_card_read',
      description: '按卡 id（或卡中文名）读整卡：原文 text（frontmatter + 正文）+ hash + version + 字数。走"读→改→写"调优闭环的第一半。',
      parameters: { type: 'object', properties: { cardId: { type: 'string', description: '卡 id 或卡中文名' } }, required: ['cardId'] },
      output: { schema: CARD_READ_SCHEMA, render: renderJson },
      async execute(args, exec) {
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_card_read 需要调用者 agent（exec.agent 为空）' };
        try {
          const wanted = args && args.cardId ? String(args.cardId).trim() : '';
          if (wanted === '') return { ok: false, code: 'bad-args', error: 'role_card_read 需要 cardId' };
          const dirs = cardDirs(state, agentCwd(agent));
          const found = selectCard(discoverCards(dirs), wanted);
          if (!found.ok) return { ok: false, code: 'card-not-found', error: found.error, ids: found.ids };
          const card = found.card;
          const text = readFileSync(card.sourcePath, 'utf8');
          return {
            ok: true,
            cardId: card.id,
            name: card.name || card.id,
            path: card.sourcePath,
            hash: cardTextHash(text),
            version: String((card.extra && card.extra.version) || ''),
            bodyChars: card.body.length,
            text,
          };
        } catch (error) {
          return { ok: false, error: `role_card_read 失败：${describeError(error)}` };
        }
      },
    },

    roleCardWrite: {
      name: 'role_card_write',
      description: '受控写回角色卡（自动调优专用）：cardId + content（完整新文本）+ reason（必填，进台账）；可选 expectHash（乐观锁：与当前卡不符即拒）、bumpVersion（默认 true：a.b.c→a.(b+1).0，只改 version 那一行、不重建整卡）。落盘前校验新文本可解析且 id 一致；**先记卡改动台账（append-only）再落盘**——台账写不进去就拒绝改动；落盘为原子写（temp+rename）。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '卡 id（或卡中文名）' },
          content: { type: 'string', description: '完整的新卡文本（frontmatter + 正文）' },
          reason: { type: 'string', description: '为什么改（必填；进卡改动台账，供事后审计）' },
          expectHash: { type: 'string', description: '可选乐观锁：当前卡的 hash（取自 role_card_read / role_card_list）' },
          bumpVersion: { type: 'boolean', description: '是否推进 version（默认 true）' },
        },
        required: ['cardId', 'content', 'reason'],
      },
      output: { schema: CARD_WRITE_SCHEMA, render: renderJson },
      async execute(args, exec) {
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_card_write 需要调用者 agent（exec.agent 为空）' };
        try {
          const cardId = args && args.cardId ? String(args.cardId).trim() : '';
          const content = args && typeof args.content === 'string' ? args.content : '';
          const reason = args && args.reason ? String(args.reason).trim() : '';
          if (cardId === '' || content === '' || reason === '') {
            return { ok: false, code: 'bad-args', error: 'role_card_write 需要 cardId + content + reason（三者都必填）' };
          }
          const dirs = cardDirs(state, agentCwd(agent));
          const found = selectCard(discoverCards(dirs), cardId);
          if (!found.ok) return { ok: false, code: 'card-not-found', error: found.error, ids: found.ids };
          const card = found.card;
          const beforeText = readFileSync(card.sourcePath, 'utf8');
          const beforeHash = cardTextHash(beforeText);
          const expectHash = args && args.expectHash ? String(args.expectHash).trim() : '';
          if (expectHash !== '' && expectHash !== beforeHash) {
            return { ok: false, code: 'stale-card', error: `卡已被改动（expectHash=${expectHash}，当前=${beforeHash}）—— 重新 read 再写`, currentHash: beforeHash };
          }
          const currentVersion = String((card.extra && card.extra.version) || '');
          const bump = args && args.bumpVersion === false
            ? { text: content, changed: false, from: currentVersion, to: currentVersion }
            : bumpCardVersion(content);
          const afterText = bump.text;
          const parsed = parseCard(afterText, card.sourcePath);
          if (!parsed.ok) return { ok: false, code: 'invalid-card', error: `新文本不可解析：${parsed.reason}`, currentHash: beforeHash };
          if (parsed.card.id !== card.id) {
            return { ok: false, code: 'id-mismatch', error: `新文本的 id（${parsed.card.id}）与目标卡（${card.id}）不一致`, currentHash: beforeHash };
          }
          const afterHash = cardTextHash(afterText);
          const bytesBefore = Buffer.byteLength(beforeText, 'utf8');
          const bytesAfter = Buffer.byteLength(afterText, 'utf8');
          const base = {
            ts: new Date().toISOString(),
            cardId: card.id,
            path: card.sourcePath,
            beforeHash,
            afterHash,
            versionFrom: bump.from,
            versionTo: bump.to,
            reason,
            bytesBefore,
            bytesAfter,
            by: String(agent.id || ''),
          };
          try { appendCardLedger({ ...base, phase: 'begin' }); }
          catch (error) {
            return { ok: false, code: 'ledger-unwritable', error: `卡改动台账写不进去，已拒绝改动：${describeError(error)}`, currentHash: beforeHash };
          }
          saveCardAtomic(card.sourcePath, afterText);
          let warning = '';
          try { appendCardLedger({ ...base, phase: 'done' }); }
          catch (error) { warning = `卡已写入，但台账 done 行写失败：${describeError(error)}`; }
          return {
            ok: true,
            cardId: card.id,
            path: card.sourcePath,
            beforeHash,
            afterHash,
            currentHash: afterHash,
            versionFrom: bump.from,
            versionTo: bump.to,
            bumped: bump.changed === true,
            bytesBefore,
            bytesAfter,
            reason,
            warning,
          };
        } catch (error) {
          return { ok: false, error: `role_card_write 失败：${describeError(error)}` };
        }
      },
    },

    roleCardRetire: {
      name: 'role_card_retire',
      description: '把一张卡从卡池**退役**（**不物理删 / 可 restore / 有留痕**）：移到卡目录下的 `.retired\\`，`role_list` 与 `role_spawn` 从此看不见它；并在卡改动台账记 begin/done 两行（`reason` 必填）。三种用法：`cardId`+`reason` 退役 · `list:true` 列出已退役卡 · `restore:"<文件名>"` 取回。⚠️ **仓库级回收站 `TRASH\\` 是另一套机制**（`node scripts/evolve-log.mjs trash <路径> --reason "…"`）——本工具会把那条命令打印出来，需要升级到全局回收站时照跑即可（别用 `rm`）。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '要退役的卡 id 或卡中文名' },
          reason: { type: 'string', description: '为什么退役（退役必填；写进卡改动台账）' },
          list: { type: 'boolean', description: '列出已退役的卡（在卡目录 .retired\\ 下）' },
          restore: { type: 'string', description: '按文件名从 .retired\\ 取回卡池' },
        },
      },
      output: { schema: CARD_RETIRE_SCHEMA, render: renderJson },
      async execute(args, exec) {
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_card_retire 需要调用者 agent（exec.agent 为空）' };
        try {
          const a = args || {};
          const dirs = cardDirs(state, agentCwd(agent));
          const dirList = [dirs.privateDir, dirs.workspaceDir].filter((d) => typeof d === 'string' && d !== '');
          const retiredDirOf = (dir) => join(dir, '.retired');
          const by = String(agent.id || '');
          // ① list：看已退役的卡
          if (a.list === true) {
            const retired = [];
            for (const dir of dirList) {
              const rd = retiredDirOf(dir);
              let names = [];
              try { names = readdirSync(rd).filter((n) => n.endsWith('.md')); } catch { names = []; }
              for (const n of names) {
                let bytes = 0;
                try { bytes = Buffer.byteLength(readFileSync(join(rd, n), 'utf8'), 'utf8'); } catch { bytes = 0; }
                retired.push({ file: n, path: join(rd, n), bytes, restore: `role_card_retire restore:"${n}"` });
              }
            }
            return { ok: true, retired, note: '这些卡不在卡池里；restore 可取回。要进全局 TRASH 见工具说明。' };
          }
          // ② restore：取回
          if (typeof a.restore === 'string' && a.restore.trim() !== '') {
            const want = basename(a.restore.trim());
            for (const dir of dirList) {
              const from = join(retiredDirOf(dir), want);
              if (!existsSync(from)) continue;
              const to = join(dir, want);
              if (existsSync(to)) return { ok: false, code: 'target-exists', error: `取回失败：${to} 已存在（不覆盖）` };
              appendCardLedger({ ts: new Date().toISOString(), action: 'restore', cardId: want, from, to, by, phase: 'begin' });
              renameSync(from, to);
              appendCardLedger({ ts: new Date().toISOString(), action: 'restore', cardId: want, from, to, by, phase: 'done' });
              return { ok: true, restore: want, to, note: '已取回卡池（role_list 重新可见）；台账 begin/done 已记。' };
            }
            return { ok: false, code: 'not-found', error: `在 .retired\\ 里找不到「${want}」（先用 list:true 看一眼）` };
          }
          // ③ retire：退役
          const wanted = typeof a.cardId === 'string' ? a.cardId.trim() : '';
          if (wanted === '') return { ok: false, code: 'bad-args', error: 'role_card_retire 需要 cardId（或 list:true / restore:"<文件名>"）' };
          const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
          if (reason === '') return { ok: false, code: 'bad-args', error: '退役必须给 reason（留痕；Memory §十一 硬约束 5）' };
          const found = selectCard(discoverCards(dirs), wanted);
          if (!found.ok) return { ok: false, code: 'card-not-found', error: found.error, ids: found.ids };
          const card = found.card;
          const src = card.sourcePath;
          const dir = dirname(src);
          const file = basename(src);
          const to = join(retiredDirOf(dir), file);
          if (existsSync(to)) return { ok: false, code: 'already-retired', error: `已退役过：${to}（要取回用 restore:"${file}"）` };
          let liveMembers = 0;
          try {
            for (const m of readMemberMap()) if (String(m.cardId) === String(card.id)) liveMembers += 1;
          } catch { liveMembers = 0; }
          // 台账写不进去 ⇒ 抛（**不吞**，与归属表的 fail-open 刻意相反）：改了卡却没留痕＝审计缺口。
          appendCardLedger({ ts: new Date().toISOString(), action: 'retire', cardId: card.id, path: src, reason, by, liveMembers, phase: 'begin' });
          mkdirSync(retiredDirOf(dir), { recursive: true });
          renameSync(src, to);
          const trashCmd = `node scripts/evolve-log.mjs trash "${to}" --reason "${reason.replace(/"/g, "'")}"`;
          appendCardLedger({ ts: new Date().toISOString(), action: 'retire', cardId: card.id, path: src, to, reason, by, liveMembers, trashCmd, phase: 'done' });
          return {
            ok: true,
            cardId: card.id,
            from: src,
            to,
            restore: `role_card_retire restore:"${file}"`,
            trashCmd,
            liveMembers,
            note: '已移出卡池（role_list / role_spawn 不再可见）；本机随时可 restore。要进全局回收站 TRASH 请跑 trashCmd（别用 rm）。',
          };
        } catch (error) {
          return { ok: false, error: `role_card_retire 失败：${describeError(error)}` };
        }
      },
    },

    roleCardRename: {
      name: 'role_card_rename',
      description: '给角色卡**改 id**（连带磁盘文件名；内联建卡折算出的 `inline-<hex>` 就是靠它改成可读 id）：cardId（卡 id 或卡中文名）+ newId + reason 三者必填；可选 expectHash 乐观锁（口径同 role_card_write：不符 ⇒ stale-card 且**一个文件都不动**）。newId 须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]*$、不得与现存任何卡的 id 相同（私密目录 + 项目 .agent-roles **一起看**）、不得等于原 id。落盘顺序：**先写卡改动台账 begin**（写不进 ⇒ ledger-unwritable，不改任何文件）→ 新路径**原子写** → **删旧路径**（删不掉 ⇒ 返回值带 warning 且在台账 done 行标注，不静默）→ 台账 done。改法是**外科手术式**：只重写 frontmatter 的 `id:` 那一行，其余字段（version/contract/metadata/paths…）一个字节都不动，**绝不整卡重建**。⚠️ **成员归属表 `agent-roles-members.jsonl` 是 append-only 历史、本工具不追改**：老成员仍指向旧 id 属**预期**（重启后按 childId→旧 id 认人读不到卡 ⇒ 只装无条件级联闸；要它按新卡装闸，用 role_send 唤醒让它重认，或之后用新 id 重起成员）。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '目标卡 id 或卡中文名' },
          newId: { type: 'string', description: '新卡 id（= 磁盘文件名；只允许 [A-Za-z0-9._-] 且以字母数字开头，不能含 ":"）' },
          reason: { type: 'string', description: '为什么改 id（必填；进卡改动台账）' },
          expectHash: { type: 'string', description: '可选乐观锁：当前卡的 hash（取自 role_card_read / role_card_list）' },
        },
        required: ['cardId', 'newId', 'reason'],
      },
      output: { schema: CARD_RENAME_SCHEMA, render: renderJson },
      async execute(args, exec) {
        const agent = callerOf(exec);
        if (!agent) return { ok: false, error: 'role_card_rename 需要调用者 agent（exec.agent 为空）' };
        try {
          const a = args && typeof args === 'object' ? args : {};
          const cardIdArg = typeof a.cardId === 'string' ? a.cardId.trim() : '';
          const newId = typeof a.newId === 'string' ? a.newId.trim() : '';
          const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
          if (cardIdArg === '' || newId === '' || reason === '') {
            return { ok: false, code: 'bad-args', error: 'role_card_rename 需要 cardId + newId + reason（三者都必须是非空字符串）' };
          }
          const dirs = cardDirs(state, agentCwd(agent));
          const discovery = discoverCards(dirs);
          const found = selectCard(discovery, cardIdArg);
          if (!found.ok) return { ok: false, code: 'card-not-found', error: found.error, ids: found.ids };
          const card = found.card;
          const oldPath = card.sourcePath;
          const beforeText = readFileSync(oldPath, 'utf8');
          const beforeHash = cardTextHash(beforeText);
          // ① newId 的合法性 / 冲突：全部在**碰盘之前**判完（任一不过 ⇒ 一个文件都不动）
          if (!CARD_ID_RE.test(newId)) {
            return { ok: false, code: 'bad-id', error: `newId 不合法：${JSON.stringify(newId)}（只允许 [A-Za-z0-9._-]、须以字母数字开头，且不能含 ":"——label 用 ":" 分段）`, currentHash: beforeHash };
          }
          if (newId === card.id) {
            return { ok: false, code: 'bad-id', error: `newId 与原 id 相同（${card.id}）——没有可改的东西`, currentHash: beforeHash };
          }
          const clash = discovery.cards.filter((item) => item.id === newId);
          if (clash.length > 0) {
            return { ok: false, code: 'bad-id', error: `newId ${JSON.stringify(newId)} 与现存角色卡 id 冲突：${clash.map((item) => item.sourcePath).join('、')}（卡池里 id 必须唯一——私密目录与项目 .agent-roles 一起看）`, currentHash: beforeHash };
          }
          const newPath = join(dirname(oldPath), `${newId}.md`);
          // 目标路径已被占用也要挡（**含 Windows 大小写不敏感**：`t1` → `T1` 是同一个文件 ⇒ 先写后删＝把新写的删掉；
          //   同时挡住"恰好同名的坏卡文件被静默覆盖"）。这条不是规格要求的，是"宁可拒绝、不许静默毁文件"的兜底。
          if (newPath !== oldPath && existsSync(newPath)) {
            return { ok: false, code: 'bad-id', error: `目标路径已被占用：${newPath}（不覆盖——换个 newId，或先处理那个文件）`, currentHash: beforeHash };
          }
          // ② 乐观锁（与 role_card_write 同口径）
          const expectHash = typeof a.expectHash === 'string' ? a.expectHash.trim() : '';
          if (expectHash !== '' && expectHash !== beforeHash) {
            return { ok: false, code: 'stale-card', error: `卡已被改动（expectHash=${expectHash}，当前=${beforeHash}）—— 重新 read 再改`, currentHash: beforeHash };
          }
          // ③ 外科手术：只重写 frontmatter 的 id: 那一行
          const edited = renameCardIdLine(beforeText, newId);
          if (!edited.changed) {
            return { ok: false, code: 'invalid-card', error: '这张卡的 frontmatter 里找不到顶层 `id:` 行，无法外科手术式改名（本工具不整卡重建）', currentHash: beforeHash };
          }
          const afterText = edited.text;
          const parsed = parseCard(afterText, newPath);
          if (!parsed.ok) return { ok: false, code: 'invalid-card', error: `改 id 后的卡不可解析：${parsed.reason}`, currentHash: beforeHash };
          if (parsed.card.id !== newId) {
            return { ok: false, code: 'invalid-card', error: `改 id 后解析出的 id 是 ${parsed.card.id}（期望 ${newId}）——已拒绝改动`, currentHash: beforeHash };
          }
          const afterHash = cardTextHash(afterText);
          const base = {
            ts: new Date().toISOString(),
            action: 'rename',
            cardId: card.id,
            newId,
            oldPath,
            path: newPath,
            beforeHash,
            afterHash,
            reason,
            by: String(agent.id || ''),
          };
          // ④ 台账 begin（写不进去 ⇒ 拒绝改动；**不吞异常**，与归属表的 fail-open 刻意相反）
          try { appendCardLedger({ ...base, phase: 'begin' }); }
          catch (error) {
            return { ok: false, code: 'ledger-unwritable', error: `卡改动台账写不进去，已拒绝改动：${describeError(error)}`, currentHash: beforeHash };
          }
          // ⑤ 新路径原子写
          saveCardAtomic(newPath, afterText);
          // ⑥ 删旧路径——这才是"改名"。删不掉 ⇒ 响亮告警（返回值 + 台账 done 行双处标注），绝不静默
          let warning = '';
          let oldRemoved = true;
          try { rmSync(oldPath); }
          catch (error) {
            oldRemoved = false;
            warning = `新路径已写好（${newPath}），但旧路径删不掉：${describeError(error)}——卡池里会同时出现 "${newId}" 与 "${card.id}" 两个 id，请手工删掉旧文件`;
          }
          // ⑦ 台账 done
          try { appendCardLedger({ ...base, phase: 'done', oldRemoved, warning }); }
          catch (error) {
            if (warning === '') warning = `卡已改名，但台账 done 行写失败：${describeError(error)}`;
          }
          return {
            ok: true,
            cardId: card.id,
            newId,
            oldPath,
            path: newPath,
            beforeHash,
            afterHash,
            currentHash: afterHash,
            reason,
            oldRemoved,
            warning,
          };
        } catch (error) {
          return { ok: false, error: `role_card_rename 失败：${describeError(error)}` };
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
          name: { type: 'string', description: '成员名＝子代理标题的右半（标题＝`<卡中文名>:<成员名>`；用中文短名，如「闸复验」；允许中文/小写字母/数字与连字符，不含 ":" 与空格）。省略时默认取卡的中文名。内联建卡时必填，也是 role_send 的寻址名' },
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
          write_scope: {
            type: 'array',
            items: { type: 'string' },
            description: '（可选）本次允许该成员写的路径白名单（目录前缀或具体文件；相对路径按调用者 cwd 解析）。给了它 ⇒ 启用路径闸：成员的 write/edit 落到白名单外会被**当场拒绝**。不给则用卡里的 paths.allow；两者都没有 = 不启用路径闸（返回值标注 writeScope:"unbounded"，只留痕不拦——诚实边界）。注意：**pwsh 不受路径闸约束**（命令级解析不可靠），只能靠留痕 + 卡内行为契约。',
          },
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
            if (!isValidMemberName(nameArg)) {
              return { ok: false, error: `name 不合法：${JSON.stringify(nameArg)}（允许中文/小写字母/数字与连字符，不能含 ":" 或空格）` };
            }
            const effToolsForCard = overrideTools ? { allow: overrideTools.allow, deny: overrideTools.deny } : { allow: [], deny: [] };
            // 2026-09-26 新增**响亮失败**（Lead 冻结规格第 1 条）：内联建卡没显式给工具面 ⇒ 拒。
            //   放在这里（而不是后面）的两个理由：① 在 `save` **落盘之前**——`serializeCard` 对空 allow 会把
            //   `tools:` 整段丢掉 ⇒ 会留下"看着声明过、其实没声明"的坏卡；② 在 `startContinuable` **之前**
            //   ——成员一旦起来就已经是调用者全量工具面了，事后再报错也收不回来。
            const inlineToolsErrorText = inlineToolsError(overrideTools);
            if (inlineToolsErrorText !== '') return { ok: false, code: 'inline-tools-empty', error: inlineToolsErrorText };
            // 卡 id 只允许 ASCII（`role_list` 的 id 校验 + 磁盘文件名）；而内联建卡的 `name` 会**同时当 id**
            //   ⇒ 中文名以前会写出「`saved:true` 但 `role_list` 判「id 不合法」」的**坏卡**（2026-09-24 实测）。
            //   折算规则：纯 ASCII 名原样用；含非 ASCII ⇒ `inline-<名字 UTF-8 的 hex>`（确定性、无新依赖、不截断）。
            //   中文仍留在 `name`（label 左段）⇒ 标题照旧、`role_spawn(role='独立复核')` 也能按**卡中文名**认回来。
            const cardId = /^[A-Za-z0-9._-]+$/.test(nameArg)
              ? nameArg
              : `inline-${Buffer.from(nameArg, 'utf8').toString('hex')}`;
            card = {
              id: cardId,
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
              const target = join(dir, `${cardId}.md`);
              if (existsSync(target)) {
                return { ok: false, error: `角色卡已存在，拒绝覆盖：${target}（改用 role=${cardId} 复用，或换一个 name）` };
              }
              saveCardAtomic(target, serializeCard({
                id: cardId,
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

          const memberName = nameArg !== '' ? nameArg : defaultMemberName(effCard);
          if (!isValidMemberName(memberName)) {
            return { ok: false, error: `成员名不合法：${JSON.stringify(memberName)}（允许中文/小写字母/数字与连字符，不能含 ":" 或空格——它要进 label 当子代理标题；卡 id ${JSON.stringify(effCard.id)} 折算不出合法名时请显式传 name）` };
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
          // 归属先落（进程内 + append-only 落盘）：重启后按 childId 认人补闸，是**唯一不受 label 改名/重名影响的依据**
          rememberMember(state, childId, effCard.id, spec.label);
          writeMarker(`spawn: ${childId} card=${effCard.id} name=${memberName} label=${spec.label} @ ${new Date().toISOString()}`);
          // 执行期闸：能力面 = 无条件级联闸 ∪ 卡内 deny ∪ restrict 解析出的 deny；allow 用 restrict 解析出的 allow。
          // 覆盖 `restrict` 管不到的 own-scope 工具（实测 subagent）——见 buildToolGuard 头注。
          const guardFilter = {
            allow: toNameList(built.allow),
            deny: [...new Set([...CASCADE_DENY, ...toNameList(effTools.deny), ...toNameList(built.deny)])],
          };
          // 路径闸（opt-in）：当轮 `write_scope` 优先于卡里的 `paths.allow`；两者都没有 ⇒ 不启用（如实标注）
          const writePaths = toNameList(input.write_scope).length > 0 ? toNameList(input.write_scope) : toNameList(effCard.writePaths);
          const guard = installChildGuard(ctx, state, childId, guardFilter, spec.label, writePaths, cwd);
          writeMarker(`guard: ${spec.label} -> ${guard.installed ? 'installed' : `pending/failed: ${guard.reason}`} · writeScope=${writePaths.length > 0 ? `declared(${writePaths.length})` : 'unbounded'} @ ${new Date().toISOString()}`);
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
            writeScope: writePaths.length > 0 ? 'declared' : 'unbounded',
            // 2026-09-26 加（Lead 冻结规格第 2 条）：卡文件本身没声明工具面 ⇒ **不拦**（存量卡可能这么写，
            //   拦了会误伤），但**响亮回报**：成员拿到的是调用者全量工具面，`allow: []` 不是"什么都没给"。
            ...toolFaceOfCard(effCard),
            ownScopeTools: Array.isArray(guard.ownScope) ? guard.ownScope : [],
            // 自注册工具里**实际已被执行期闸拒**的那些（`restrict` 裁不掉它们，但 guard 拦得住）——
            // 让"可见 ≠ 放行"在返回值里一眼可读（2026-09-24 加：Lead 曾据 ownScopeTools 误判成"闸没生效"）。
            ownScopeBlocked: (Array.isArray(guard.ownScope) ? guard.ownScope : []).filter((toolName) => guardFilter.deny.includes(toolName)),
          };
        } catch (error) {
          writeMarker(`spawn: failed ${describeError(error)} @ ${new Date().toISOString()}`);
          return { ok: false, error: `role_spawn 失败：${describeError(error)}` };
        }
      },
    },

    roleSend: {
      name: 'role_send',
      description: '给本会话已起的角色成员发一条唤醒/steer 消息：target 给成员 name（role_spawn 的 name）、childId、卡 id 或卡中文名。成员在跑就在最近一步边界收到；空闲就被唤醒；进程重启后按 label 从 listChildren 回填——新格式 "<卡中文名>:<name>"（老成员仍是旧格式 "role:<cardId>:<name>"，**两种都能认**），另有 append-only 归属表按 childId→cardId 兜底。返回投递确认，不含成员答复。',
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
          // 跨进程恢复的老成员：起手前先确认它带闸（幂等；新起的成员在 spawn 时已装 ⇒ 这里秒过）
          const guard = ensureMemberGuard(ctx, state, resolved.childId, resolved.label, agentCwd(agent));
          if (guard.installed === false && !/非角色成员/.test(guard.reason || '')) {
            writeMarker(`guard(send): ${resolved.name} -> ${guard.reason} @ ${new Date().toISOString()}`);
          }
          // 2026-09-26 加（Lead 冻结规格第 4 条）：唤醒路径**同口径**标注工具面。
          //   两种情形都要标：① 卡未声明工具面 ② 拿不到卡（跨进程恢复时卡被删/改名 ⇒ 只装无条件级联闸）。
          //   认人的 cardId 优先取归属表（`ensureMemberGuard` 内部同一口径），拿不到再退 label 解析出的卡 id。
          const memberCardId = (() => {
            try { const mapped = memberCardId(state, resolved.childId); if (mapped !== '') return mapped; } catch { /* 退 label */ }
            const parsed = parseRoleLabel(resolved.label, knownCardsFor(state, agentCwd(agent)));
            return parsed && parsed.cardId ? parsed.cardId : '';
          })();
          const memberFace = toolFaceForMember(state, agentCwd(agent), memberCardId);
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
            guardInstalled: guard.installed === true,
            guardReason: guard.reason || '',
            toolFace: memberFace.toolFace,
            toolFaceNote: memberFace.toolFaceNote,
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
 * 恢复场景的能力面：按 label 里的 roleId **读回角色卡**算 allow/deny。
 * 读不到卡就只保留**无条件级联闸**（宁可窄一点，绝不因为"卡找不到了"而把闸变成空）。
 */
function guardFilterForMember(state, cwd, roleId) {
  const fallback = { allow: [], deny: [...CASCADE_DENY] };
  try {
    const discovery = discoverCards({
      privateDir: join(state.home, ...PRIVATE_CARD_SEGMENTS),
      workspaceDir: join(cwd || process.cwd(), WORKSPACE_CARD_DIRNAME),
    });
    const picked = selectCard(discovery, roleId);
    if (!picked.ok) return { filter: fallback, writePaths: [], reason: `卡 ${roleId} 未找到 ⇒ 只装无条件级联闸` };
    const toolsRaw = picked.card.tools || {};
    return {
      filter: {
        allow: toNameList(toolsRaw.allow),
        deny: [...new Set([...CASCADE_DENY, ...toNameList(toolsRaw.deny)])],
      },
      // 恢复场景同样带卡里声明的路径白名单（否则重启后成员会"掉闸"）
      writePaths: toNameList(picked.card.writePaths),
      reason: '',
    };
  } catch (error) {
    return { filter: fallback, writePaths: [], reason: `读卡异常 ⇒ 只装无条件级联闸：${describeError(error)}` };
  }
}

/**
 * 本会话可见的角色卡（**认人用**：新格式 label 的左段要拿它对；卡里也能读回能力面）。
 * 读不到就返回空数组 —— 新格式认不出 ⇒ **不补闸**（倒向安全侧；旧格式不受影响，它不依赖卡发现）。
 */
function knownCardsFor(state, cwd) {
  try {
    return discoverCards({
      privateDir: join(state.home, ...PRIVATE_CARD_SEGMENTS),
      workspaceDir: join(cwd || process.cwd(), WORKSPACE_CARD_DIRNAME),
    }).cards;
  } catch { return []; }
}

/** 已知卡里按 id 取卡中文名（「按卡中文名寻址」用）。 */
function cardNameOf(knownCards, cardId) {
  const id = String(cardId ?? '');
  if (id === '') return '';
  const hit = (Array.isArray(knownCards) ? knownCards : []).find((card) => card && String(card.id) === id);
  return hit && typeof hit.name === 'string' ? hit.name.trim() : '';
}

/**
 * 查一张卡的工具面标注（`role_send` 唤醒路径用：**同口径**回填 `toolFace`）。
 *
 * 为什么 `role_send` 也要标注：能唤醒一个成员的调用者，必须同时知道"这个成员手里是全量面还是受限面"——
 * 否则唤醒一个"卡未声明工具面"的老成员时，返回值只有 `guardInstalled:true`，读起来像是"闸已装好、面已收窄"。
 * ⚠️ `guardInstalled:true` 只说明**执行期级联闸**装上了（`subagent`/`workflow`/`ralph` 调用即拒），
 * **不代表工具面被收窄**：未声明工具面的卡，成员照样拿到调用者全量面（除那四把之外全放行）。
 * ⚠️ 判据与 `role_spawn` **严格同口径**（都走 `toolFaceOfCard` ⇒ 只看 `tools.allow` 是否非空）：
 * 卡只写了 deny、或干脆没写 tools ⇒ `unrestricted`（成员的**面没收窄**，只有固定级联闸 + 卡内 deny 生效）。
 * 拿不到卡（跨进程恢复时卡被删/被改名）⇒ 同样 `unrestricted`（诚实侧：此时 `guardFilterForMember` 走 fallback
 * 只装无条件级联闸，面是**不收窄**的，不能标成受限），但说明文案与"卡未声明"可区分。
 * @returns {{toolFace:'restricted'|'unrestricted', toolFaceNote:string, cardFound:boolean}}
 */
function toolFaceForMember(state, cwd, cardId) {
  const wanted = String(cardId ?? '');
  if (wanted !== '') {
    try {
      const found = selectCard(discoverCards({
        privateDir: join(state.home, ...PRIVATE_CARD_SEGMENTS),
        workspaceDir: join(cwd || process.cwd(), WORKSPACE_CARD_DIRNAME),
      }), wanted);
      if (found.ok) return { ...toolFaceOfCard(found.card), cardFound: true };
    } catch { /* 读卡失败 ⇒ 与"拿不到卡"同口径（按 fallback 面标注） */ }
  }
  return {
    toolFace: 'unrestricted',
    toolFaceNote: `拿不到该成员的角色卡（${wanted || '认不出卡 id'}）⇒ 只装了无条件级联闸、工具面**未收窄** ⇒ 成员手里是调用者全量工具面（除 subagent/subagent_fork/workflow/ralph 外全放行）。`,
    cardFound: false,
  };
}

/** label 左段（`:` 之前）——只用于诊断文本。 */
function labelLeft(label) {
  if (typeof label !== 'string' || !label.includes(ROLE_LABEL_SEP)) return '';
  return label.slice(0, label.indexOf(ROLE_LABEL_SEP)).trim();
}

/**
 * 认人（跨进程恢复的关键，**fail-closed**：认不出 ⇒ 不补闸）。顺序：
 *   ① **成员归属表**（`childId → cardId`，append-only）：唯一不受 label 改名 / 重名 / 缺失影响的依据；
 *   ② label 解析（旧格式 `role:<cardId>:…` / 新格式 `<卡中文名>:…` 且左段唯一命中已知卡 name）；
 *   ③ 都不中 ⇒ 不认。
 * `plausible` 只影响**诊断留痕**：像是我们的成员却认不出（旧形态但卡 id 段空 / 卡重名）要留痕；
 * 自由文本 label（官方 `subagent` 那类）不吵（与今天的 marker 口径一致）。
 * @returns {{ok:true,cardId:string,via:'map'|'legacy'|'name'}|{ok:false,reason:string,plausible:boolean}}
 */
function recognizeMember(state, childId, label, knownCards) {
  const mapped = memberCardId(state, childId);
  if (mapped !== '') return { ok: true, cardId: mapped, via: 'map' };
  const parsed = parseRoleLabel(label, knownCards);
  if (parsed && parsed.cardId) return { ok: true, cardId: parsed.cardId, via: parsed.format };
  if (typeof label === 'string' && label.startsWith(ROLE_LABEL_PREFIX)) {
    return { ok: false, plausible: true, reason: `label "${label}" 是旧格式但卡 id 段为空（不补闸）` };
  }
  const classified = classifyNameLabel(typeof label === 'string' ? label : '', knownCards);
  if (classified.status === 'ambiguous') {
    return {
      ok: false,
      plausible: true,
      reason: `卡中文名 "${labelLeft(label)}" 命中 ${classified.matched.length} 张卡（重名 ⇒ 无法唯一确定卡片，不补闸；给卡改名或让该成员走旧格式 label）`,
    };
  }
  return { ok: false, plausible: false, reason: 'label 不是本插件的成员形态（或卡中文名不在已知卡里）——非角色成员，不补闸' };
}

/**
 * 给**已存在**的成员补执行期闸（跨进程恢复场景）。
 * `guard` 装在该 agent 的 scope 上、**不在** `subagent/descriptor` 里 ⇒ 进程重启后成员拿不回它，
 * 于是派生自旧进程的成员可能还能调 `subagent`。这里按归属表 / label 认人、按卡算能力面补装。
 * ⚠️ 认不出 **绝不**「按猜的卡装闸」、也**绝不**装一个空闸——就是不补闸（fail-closed，语义与今天一致）。
 */
function ensureMemberGuard(ctx, state, childId, label, cwd) {
  const baseCwd = cwd || '';
  const recognized = recognizeMember(state, childId, label, knownCardsFor(state, baseCwd));
  if (!recognized.ok) return { installed: false, reason: recognized.reason };
  let child = null;
  try { child = (ctx.agents.list() || []).find((candidate) => candidate && String(candidate.id) === String(childId)) || null; }
  catch { child = null; }
  const childCwd = baseCwd || (child ? agentCwd(child) : '');
  const built = guardFilterForMember(state, childCwd, recognized.cardId);
  // 2026-09-26 修（**第四例实测**：跨重启 `role_send` 唤醒成员 ⇒ 返回值 `guardInstalled:false`
  //   + reason「成员不在本进程注册表（未持有其 agent，无法装闸）」）：
  //   原实现在**找不到 agent 对象**时直接 early-return ⇒ **跳过了 `installChildGuard` 的 `pendingGuards` 挂起路**，
  //   而 `agent/created` 处理器正是靠 `pendingGuards` 给「刚进注册表的成员」补装闸（本文件旧注释自陈
  //   「两条路合起来无竞态」）——这条早退等于把第二条路掐掉：**跨进程/跨轮恢复的成员永远补不上执行期闸**。
  //   现改为：拿不到对象 ⇒ **走挂起路**（reason 明说「已挂起，等 agent/created 补装」），语义仍是 fail-closed
  //   （认不出卡依旧不装，见上方 recognizeMember 分支）。
  if (!child) {
    return installChildGuard(ctx, state, childId, built.filter, typeof label === 'string' ? label : '', built.writePaths, childCwd);
  }
  const applied = applyChildGuard(ctx, state, child, built.filter, typeof label === 'string' ? label : '', built.writePaths, childCwd);
  return { installed: applied.installed, reason: built.reason || applied.reason, ownScope: applied.ownScope || null };
}

/** `agent/created` 的异步补装路：label 不在 agent 对象上 ⇒ 向父会话的 listChildren 问一次（认人见 recognizeMember）。 */
async function ensureMemberGuardById(ctx, state, agent) {
  try {
    const id = agent && agent.id ? String(agent.id) : '';
    if (id === '' || state.childGuards.has(id)) return;
    const header = agent.session && agent.session.header ? agent.session.header : null;
    const parentId = header && header.parentSession ? String(header.parentSession) : '';
    if (parentId === '' || parentId === id) return;
    if (typeof ctx.subagents.listChildren !== 'function') return;
    const entries = await ctx.subagents.listChildren(parentId, undefined);
    const entry = (Array.isArray(entries) ? entries : []).find((candidate) => candidate && String(candidate.id) === id);
    const label = entry && typeof entry.label === 'string' ? entry.label : '';
    const cwd = agentCwd(agent);
    const recognized = recognizeMember(state, id, label, knownCardsFor(state, cwd));
    if (!recognized.ok) {
      // 留痕：像是我们的成员却认不出（⚠️ 老成员查不到 = 不补闸 = 可能掉闸，必须可核）
      if (recognized.plausible) writeMarker(`guard(resume): ${id} 认不出卡片 ⇒ 不补闸：${recognized.reason} @ ${new Date().toISOString()}`);
      return;
    }
    const built = guardFilterForMember(state, cwd, recognized.cardId);
    const applied = applyChildGuard(ctx, state, agent, built.filter, label, built.writePaths, cwd);
    writeMarker(`guard(resume): ${id} ${applied.installed ? 'installed' : `skipped ${applied.reason}`} · via=${recognized.via} card=${recognized.cardId} @ ${new Date().toISOString()}`);
  } catch { /* best-effort：补不上不影响主流程（marker 由调用方在主路径留痕） */ }
}

/**
 * 给刚起的成员装「执行期工具闸」。
 * ① 先看注册表里有没有它（`startContinuable` 内部已 materialize，通常立刻能拿到）；
 * ② 拿不到就先记进 `pendingGuards`，由 `agent/created` 处理器补装 —— 两条路合起来无竞态。
 */
function installChildGuard(ctx, state, childId, filter, label, writePaths, cwd) {
  const id = String(childId || '');
  if (id === '') return { installed: false, reason: 'childId 为空，无法装闸' };
  let child = null;
  try { child = (ctx.agents.list() || []).find((candidate) => candidate && String(candidate.id) === id) || null; }
  catch { child = null; }
  if (!child) {
    state.pendingGuards.set(id, { filter, label: typeof label === 'string' ? label : '', writePaths: toNameList(writePaths), cwd: typeof cwd === 'string' ? cwd : '' });
    return { installed: false, reason: '子 agent 尚未进注册表：已挂起，等 agent/created 补装' };
  }
  return applyChildGuard(ctx, state, child, filter, label, writePaths, cwd);
}

/** 真正装闸（幂等）。闸 ＝ 能力面谓词 + 写操作留痕 +（声明了才启用的）路径闸；顺带自检 own-scope 工具。 */
function applyChildGuard(ctx, state, child, filter, label, writePaths, cwd) {
  try {
    if (!child || !child.ctx || !child.ctx.tools || typeof child.ctx.tools.guard !== 'function') {
      return { installed: false, reason: '子 scope 没有 tools.guard（该 agent 拿不到执行期闸）' };
    }
    const id = String(child.id);
    if (state.childGuards.has(id)) return { installed: true, reason: '已装过（幂等跳过）', ownScope: state.childOwnScope.get(id) || null };
    const dispose = child.ctx.tools.guard(buildMemberGuard(filter, {
      label: typeof label === 'string' ? label : '',
      writePaths: toNameList(writePaths),
      cwd: typeof cwd === 'string' ? cwd : agentCwd(child),
    }));
    state.childGuards.set(id, dispose);
    // ③ 自检：成员自己 scope 注册、`restrict` mask 不掉的工具（真机实测：subagent 就是这一类）
    let ownScope = null;
    try { ownScope = ownScopeTools(ctx.tools && typeof ctx.tools.view === 'function' ? ctx.tools.view(child) : null); } catch { ownScope = null; }
    if (ownScope && ownScope.length > 0) {
      state.childOwnScope.set(id, ownScope);
      writeMarker(`ownscope: ${id} 出现 mask 不掉的自注册工具 ${ownScope.join('、')} @ ${new Date().toISOString()}（已记录：可见面 mask 不掉；执行期已由 buildToolGuard 拒绝——schema 未裁剪）`);
    }
    return { installed: true, reason: '', ownScope };
  } catch (error) {
    return { installed: false, reason: describeError(error) };
  }
}

/**
 * 给一个顶层 agent 的精确 scope 装：管控者协议段 + 八把工具。
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
    const definitions = [roleTools.roleList, roleTools.roleSpawn, roleTools.roleSend, roleTools.roleCardList, roleTools.roleCardRead, roleTools.roleCardWrite, roleTools.roleCardRetire, roleTools.roleCardRename];
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
 * 宿主插件主体：每个**顶层** agent（`delegationDepth ?? 0 === 0`）装一次八把工具 + 协议段；
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

    // memberCards：childId→cardId 归属索引（进程内缓存；落盘表 append-only，见 memberCardId）
    const state = { home: homeRoot(), nameIndex: new Map(), pendingGuards: new Map(), childGuards: new Map(), childOwnScope: new Map(), memberCards: new Map(), memberCardsLoaded: false };
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
          const pending = state.pendingGuards.get(createdId);
          state.pendingGuards.delete(createdId);
          const applied = applyChildGuard(ctx, state, created, pending.filter, pending.label, pending.writePaths, pending.cwd);
          writeMarker(`guard: child ${createdId} ${applied.installed ? 'installed' : `FAILED ${applied.reason}`} @ ${new Date().toISOString()}`);
        }
      } catch { /* 补装失败不影响主流程 */ }
      // 跨进程恢复的老成员：label 不在 agent 对象上 ⇒ 异步问一次父会话的 listChildren，认出来就补装。
      void ensureMemberGuardById(ctx, state, created);
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
