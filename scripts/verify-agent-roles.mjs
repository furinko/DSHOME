#!/usr/bin/env node
// scripts/verify-agent-roles.mjs — dshome/agent-roles 的真断言自测（W1）。
//
// 做什么：用**临时目录**造角色卡与宿主，覆盖规格「验收」里的 9 类反例：
//   ① 工作区覆盖私密 ② 缺 id ③ 坏 frontmatter ④ 未知 role ⑤ 卡里 allow/deny 含不可解析名（响亮失败）
//   ⑥ 固定级联 deny 按可见性过滤 ⑦ role_* 不进 filter ⑧ `_` 前缀跳过 ⑨ maxDepth 传 1
// 外加：frontmatter 子集解析（注释/空行/内联列表/嵌套 map/CRLF）、正文为空、无 frontmatter、
//   persona 组装、**双格式** label（新 `<卡中文名>:<name>` / 老 `role:<cardId>:<name>` 都能解析）、
//   以及**挂载面 + 三把工具真跑**（mock host，临时 DSH_HOME）。
//
// 为什么不碰真实 mind-private/工作区：脚本把 `DSH_HOME` 指到 mkdtemp 出来的临时根（含 mind/ 占位目录），
//   于是 apply 的 marker、卡发现、内联落盘、成员索引全部落在临时目录；跑完恢复 env 并删临时目录。
//
// 退出码：全绿 → 打印 `PASS n/n` 退出 0；任一失败 → 打印 `FAIL` 明细（每条带「期望 vs 实际」）退出 1。
//
// 用法：<node> scripts/verify-agent-roles.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply,
  buildMemberGuard,
  buildStartSpec,
  buildToolFilter,
  buildToolGuard,
  composePersona,
  CASCADE_DENY,
  defaultMemberName,
  describeToolTarget,
  discoverCards,
  inlineToolsError,
  isValidMemberName,
  legacyRoleLabel,
  MEMBER_MAX_DEPTH,
  normalizeModel,
  normalizeTools,
  ownScopeTools,
  pathAllowed,
  parseCard,
  parseRoleLabel,
  PERSONA_TAIL,
  PRIVATE_CARD_SEGMENTS,
  renderPolicyText,
  reportHint,
  roleLabel,
  ROLE_TOOL_NAMES,
  selectCard,
  serializeCard,
  toolFaceOfCard,
} from '../packages/dshome/lib/host/agent-roles.js';

// ── 断言器：每条失败都打印「期望 vs 实际」 ───────────────────────────────────
let pass = 0;
const failures = [];

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}
function assert(label, condition, expected, actual) {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL ${label}`);
  console.log(`       expected: ${show(expected)}`);
  console.log(`       actual:   ${show(actual)}`);
}
function eq(label, actual, expected) {
  assert(label, JSON.stringify(actual) === JSON.stringify(expected), expected, actual);
}

/** 写临时文件（自动建目录）。 */
function put(dir, fileName, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content, 'utf8');
}

/**
 * 极小 JSON Schema 子集校验器（只覆盖本插件用到的关键字）。
 * 为什么自带：raw register 只在校验 output.schema 语法；**execute 的返回值**由宿主
 * `validateJsonSchemaValue(output.schema, value)` 逐一校验（dsh-tools/lib/index.js:3415-3418）——
 * 值不匹配 schema 会变成 ToolOutputError（模型只看到工具报错）。这里把那条口径提前到自测里。
 */
function validateValue(schema, value, path = 'value') {
  const violations = [];
  if (!schema || typeof schema !== 'object') return violations;
  if (Array.isArray(schema.oneOf)) {
    const arms = schema.oneOf.map((arm) => validateValue(arm, value, path));
    if (!arms.some((list) => list.length === 0)) violations.push(`${path}: no oneOf arm matched`);
    return violations;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`${path}: ${JSON.stringify(value)} is not const`);
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : String(value)}`); return violations; }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key}: required but missing`);
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Object.keys(props)) {
      if (Object.hasOwn(value, key)) violations.push(...validateValue(props[key], value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(props, key)) violations.push(`${path}.${key}: additional property not allowed`);
    }
    return violations;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) { violations.push(`${path}: expected array, got ${typeof value}`); return violations; }
    if (schema.items) value.forEach((item, index) => violations.push(...validateValue(schema.items, item, `${path}[${index}]`)));
    return violations;
  }
  if (type === 'string' && typeof value !== 'string') violations.push(`${path}: expected string, got ${typeof value}`);
  if (type === 'integer' && !Number.isInteger(value)) violations.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${path}: expected number, got ${JSON.stringify(value)}`);
  if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${path}: expected boolean, got ${typeof value}`);
  if (type === 'null' && value !== null) violations.push(`${path}: expected null, got ${JSON.stringify(value)}`);
  return violations;
}

// ── 临时世界 ────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'agent-roles-verify-'));
const TMP_HOME = join(TMP, 'home');                       // 临时 DSH_HOME
// 夹具必须镜像真机布局：私密卡在 L2\agents（2026-09-23 从 L0 搬出高危区；见 agent-roles.js 的常量注释）
const PRIVATE_DIR = join(TMP_HOME, 'mind-private', 'L2', 'agents');
const CWD = join(TMP, 'workspace');                       // 临时工作区
const WORKSPACE_DIR = join(CWD, '.agent-roles');
const ORIGINAL_DSH_HOME = process.env.DSH_HOME;

mkdirSync(join(TMP_HOME, 'mind'), { recursive: true });    // homeRoot() 的探测条件
mkdirSync(CWD, { recursive: true });

// 私密卡（含 5 类坏卡 + 1 张 `_` 前缀 + 1 个非 .md）
put(PRIVATE_DIR, 'reviewer.md', [
  '---',
  '# 这是注释，应被忽略',
  'id: reviewer',
  'name: 私密评审员',
  'model: deepseek-chat',
  'tools:',
  '  allow:',
  '    - read',
  '    - grep',
  '  deny: [write, edit]',
  '',
  '---',
  '你是私密评审员。',
].join('\n'));
put(PRIVATE_DIR, '_template.md', ['---', 'id: template', '---', '模板正文', ''].join('\n'));
put(PRIVATE_DIR, 'notes.txt', ['---', 'id: notes', '---', '不是 md，应被忽略', ''].join('\n'));
put(PRIVATE_DIR, 'noid.md', ['---', 'name: 缺 id 卡', '---', '正文', ''].join('\n'));
put(PRIVATE_DIR, 'tabs.md', ['---', 'id: tabs', 'tools:', '\tallow: read', '---', '正文', ''].join('\n'));
put(PRIVATE_DIR, 'unclosed.md', ['---', 'id: unclosed', 'tools:', '  deny: [read, grep', '---', '正文', ''].join('\n'));
put(PRIVATE_DIR, 'emptybody.md', ['---', 'id: emptybody', '---', '', ''].join('\n'));
put(PRIVATE_DIR, 'nofm.md', ['没有 frontmatter 的正文', ''].join('\n'));
put(PRIVATE_DIR, 'bad-tools.md', ['---', 'id: bad-tools', 'tools:', '  allow:', '    - read', '    - ghost_tool', '---', '正文', ''].join('\n'));

// 工作区卡（reviewer 与私密同 id → 覆盖；writer 只在这里）
put(WORKSPACE_DIR, 'reviewer.md', [
  '---',
  'id: reviewer',
  'name: 工作区评审员',
  'model:',
  '  provider: deepseek',
  '  model: deepseek-chat',
  'tools:',
  '  allow: [read]',
  '---',
  '你是工作区评审员。',
].join('\n'));
put(WORKSPACE_DIR, 'writer.md', ['---', 'id: writer', 'tools:', '  deny:', '    - edit', '---', '你是写手。', ''].join('\n'));
// 2026-09-26 加：**未声明工具面**的卡（frontmatter 里连 `tools:` 都没有）——治「卡声明越少、成员权限越大」。
// 它是 Lead 冻结规格第 2/3/4 条的正例夹具：卡文件本身没声明 ⇒ **不拦**（存量卡可能这么写），
// 但 `role_spawn` / `role_send` / `role_card_list` 的返回值必须响亮标注 `unrestricted`。
put(WORKSPACE_DIR, 'noface.md', ['---', 'id: noface', 'name: 未声明面探针', '---', '你是未声明工具面的探针。', ''].join('\n'));

// ── mock 宿主（挂载面 + 工具真跑用；不接触真实宿主） ────────────────────────
// ⚠️ 夹具必须忠实于**真机**（2026-09-23 变异测试抓到本夹具自己"恒绿"）：主实例里 `subagent` 由
// `dsh-tool-subagent` 按**每个 agent 自己的 scope**注册（`modelSelectionSettings: true` 时）⇒ 它
// **不在 `restrictableNames` 里**（`restrict` 管不到它），但成员手里**确实看得见它**。
// 早期夹具把 `subagent` 放进 restrictableNames ⇒ "级联闸不无条件生效"的变异**照样 161/161 全绿**
// —— 夹具与真实缺陷不符 = 断言锁不住修复。所以这里刻意**不含** `subagent`。
const VISIBLE = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'subagent_fork', 'workflow', 'ralph'];
/** own-scope 注册、`restrict` 管不到、但真实存在于成员工具面的那一类（真机实测：subagent）。 */
const OWN_SCOPE_ONLY = ['subagent'];

function makeHost() {
  const record = { registered: [], sections: [], specs: [], sends: [], warns: [], handlers: [], childGuards: [], effectDispose: null, nextChildId: null, children: null };
  const scope = {
    systemPrompt: {
      section: (section) => { record.sections.push(section); return () => {}; },
      getSectionOrder: (orderName) => { record.sectionOrderName = orderName; return 600; },
    },
    tools: { register: (definition) => { record.registered.push(definition); return () => {}; } },
  };
  const topAgent = {
    id: 'lead-session',
    session: { header: { id: 'lead-session', delegationDepth: 0, cwd: CWD } },
    ctx: scope,
  };
  const childAgent = {
    id: 'child-session',
    session: { header: { id: 'child-session', delegationDepth: 1, cwd: CWD } },
    ctx: {
      systemPrompt: scope.systemPrompt,
      tools: { register: () => { record.childInstalled = true; return () => {}; } },
    },
  };
  // 第三个 agent：id 与 `startContinuable` 返回的 childId 对齐，用来验「执行期闸真装到成员 scope 上」。
  // 它的 `register` 故意**不**置 `childInstalled`（那是"子代理被误装工具"的反例探针，必须保持 false）。
  const guardChildAgent = {
    id: 'child-1',
    session: { header: { id: 'child-1', delegationDepth: 1, cwd: CWD } },
    ctx: {
      systemPrompt: scope.systemPrompt,
      tools: {
        register: () => () => {},
        guard: (predicate) => { record.childGuards.push(predicate); return () => {}; },
      },
    },
  };
  // 第四个 agent：模拟「跨进程恢复的老成员」——起它的进程已经没了，而 `guard` **不在**
  // `subagent/descriptor` 里 ⇒ 只能靠 role_send / agent/created 两条路把它认回来补装。
  const resumeChildAgent = {
    id: 'child-9',
    session: { header: { id: 'child-9', delegationDepth: 1, cwd: CWD, parentSession: 'lead-session' } },
    ctx: {
      systemPrompt: scope.systemPrompt,
      tools: {
        register: () => () => {},
        guard: (predicate) => { record.childGuards.push(predicate); return () => {}; },
      },
    },
  };
  // 第五个 agent：只用来验「认人顺序 ① 归属表」（childId→cardId）——它的 label 是**自由文本**，
  // 只有归属表能把它认成我们的成员；预置的那行归属表见 main 里 `apply` 之前。
  const mapChildAgent = {
    id: 'child-55',
    session: { header: { id: 'child-55', delegationDepth: 1, cwd: CWD, parentSession: 'lead-session' } },
    ctx: {
      systemPrompt: scope.systemPrompt,
      tools: {
        register: () => () => {},
        guard: (predicate) => { record.childGuards.push(predicate); return () => {}; },
      },
    },
  };
  const ctx = {
    logger: () => ({ info: () => {}, warn: (message) => record.warns.push(String(message)) }),
    on: (ev, handler) => { record.handlers.push({ ev, handler }); return () => {}; },
    effect: (factory) => { record.effectDispose = factory(); return () => {}; },
    tools: {
      view: (scope) => {
        // 夹具忠实于真机：成员（本 mock 里 id=child-1 那个）的**可见面**含一个 own-scope 注册、
        // `restrict` 管不到的工具 `subagent`（真机实测同型）；其它 scope 保持空可见面。
        if (scope && String(scope.id) === 'child-1') return { visible: new Map([['subagent', {}], ['read', {}]]), restrictableNames: new Set(VISIBLE) };
        return { visible: new Map(), restrictableNames: new Set(VISIBLE) };
      },
      schemas: () => [],
      register: () => () => {},
      get: () => undefined,
    },
    agents: { list: () => [topAgent, childAgent, guardChildAgent, resumeChildAgent, mapChildAgent] },
    subagents: {
      getProvider: () => ({ name: 'spawn' }),
      list: () => ['spawn'],
      startContinuable: async (spec) => { record.specs.push(spec); return { childId: record.nextChildId || 'child-1', messageId: 'msg-1' }; },
      sendMessage: async (sender, targetId, content) => {
        record.sends.push({ senderId: String(sender.id), targetId: String(targetId), text: content[0].text });
        return 'msg-2';
      },
      listChildren: async () => record.children || [{
        kind: 'child',
        id: 'child-1',
        activity: 'running',
        hasChildren: false,
        mode: 'continuable',
        label: 'role:reviewer:alice',
      }],
    },
  };
  return { ctx, topAgent, childAgent, record };
}

async function main() {
  // ── ① frontmatter 解析（合理路径） ────────────────────────────────────────
  console.log('[1] parseCard — frontmatter 子集解析');
  const good = parseCard(readFileSync(join(PRIVATE_DIR, 'reviewer.md'), 'utf8'), join(PRIVATE_DIR, 'reviewer.md'));
  assert('valid card parses ok', good.ok === true, 'ok:true', good.ok === true ? 'ok:true' : good.reason);
  if (good.ok) {
    eq('valid card id', good.card.id, 'reviewer');
    eq('valid card name', good.card.name, '私密评审员');
    eq('valid card model (scalar)', good.card.model, { model: 'deepseek-chat' });
    eq('valid card tools.allow (nested list + comment/blank skipped)', good.card.tools.allow, ['read', 'grep']);
    eq('valid card tools.deny (inline list)', good.card.tools.deny, ['write', 'edit']);
    eq('valid card body', good.card.body, '你是私密评审员。');
  } else {
    assert('valid card id', false, 'ok:true', good.reason);
    assert('valid card name', false, 'ok:true', good.reason);
    assert('valid card model (scalar)', false, 'ok:true', good.reason);
    assert('valid card tools.allow (nested list + comment/blank skipped)', false, 'ok:true', good.reason);
    assert('valid card tools.deny (inline list)', false, 'ok:true', good.reason);
    assert('valid card body', false, 'ok:true', good.reason);
  }

  const crlf = parseCard('---\r\nid: crlf-card\r\ntools:\r\n  allow: [read]\r\n---\r\nCRLF 正文\r\n', 'crlf.md');
  assert('CRLF + inline list parses ok', crlf.ok === true, true, crlf.ok ? true : crlf.reason);
  if (crlf.ok) eq('CRLF card tools.allow', crlf.card.tools.allow, ['read']);

  // 2026-09-24 修：`paths.allow` 原先**解析了但没进返回对象** ⇒ 卡的「默认写范围」形同虚设，
  // 而当时回归 201 全绿（这个字段零覆盖 ⇒ 修了也会再退化）。以下断言把它钉住。
  const withPaths = parseCard('---\nid: paths-card\ntools:\n  allow: [read, write]\npaths:\n  allow:\n    - out-dir/\n---\n带写范围的卡\n', 'paths.md');
  assert('card with paths parses ok', withPaths.ok === true, true, withPaths.ok ? true : withPaths.reason);
  if (withPaths.ok) eq('parseCard 保留 paths.allow（卡默认写范围）', withPaths.card.writePaths, ['out-dir/']);
  if (crlf.ok) eq('无 paths 的卡 ⇒ writePaths 为空数组（路径闸不启用）', crlf.card.writePaths, []);

  const nofm = parseCard('没有 frontmatter', 'nofm.md');
  assert('missing frontmatter -> ok:false', nofm.ok === false, false, nofm.ok);
  assert('missing frontmatter reason names frontmatter', nofm.ok === false && /frontmatter/.test(nofm.reason), 'reason mentions "frontmatter"', nofm.ok ? '(parsed)' : nofm.reason);

  // ── ② discoverCards：覆盖 / 缺 id / 坏卡 / `_` 跳过 ────────────────────────
  console.log('[2] discoverCards — 工作区覆盖私密、缺 id、坏 frontmatter、`_` 前缀');
  const discovery = discoverCards({ privateDir: PRIVATE_DIR, workspaceDir: WORKSPACE_DIR });
  const ids = discovery.cards.map((card) => card.id);
  eq('discovered card ids (sorted; _template.md skipped, notes.txt ignored)', ids, ['bad-tools', 'noface', 'reviewer', 'writer']);

  const brokenFiles = discovery.broken.map((item) => item.file).sort();
  eq('broken files', brokenFiles, ['emptybody.md', 'nofm.md', 'noid.md', 'tabs.md', 'unclosed.md']);
  assert('broken never includes _template.md', !brokenFiles.includes('_template.md'), 'no _template.md in broken', brokenFiles);
  assert('broken never includes notes.txt', !brokenFiles.includes('notes.txt'), 'no notes.txt in broken', brokenFiles);

  const reviewerCard = discovery.cards.find((card) => card.id === 'reviewer');
  eq('workspace overrides private (source)', reviewerCard && reviewerCard.source, 'workspace');
  eq('workspace overrides private (flag)', reviewerCard && reviewerCard.overridesPrivate, true);
  assert('workspace body wins', reviewerCard && reviewerCard.body === '你是工作区评审员。', '你是工作区评审员。', reviewerCard && reviewerCard.body);
  eq('no duplicate reviewer card', discovery.cards.filter((card) => card.id === 'reviewer').length, 1);

  const noId = discovery.broken.find((item) => item.file === 'noid.md');
  assert('missing id (noid.md) broken with reason mentioning id', noId && /id/.test(noId.reason), 'reason mentions "id"', noId && noId.reason);

  const tabs = discovery.broken.find((item) => item.file === 'tabs.md');
  assert('tab indent broken with line number 4', tabs && /第 4 行/.test(tabs.reason), 'reason mentions "第 4 行"', tabs && tabs.reason);
  const unclosed = discovery.broken.find((item) => item.file === 'unclosed.md');
  assert('unclosed inline list broken with line number 4', unclosed && /第 4 行/.test(unclosed.reason), 'reason mentions "第 4 行"', unclosed && unclosed.reason);
  const emptyBody = discovery.broken.find((item) => item.file === 'emptybody.md');
  assert('empty body broken', emptyBody && /正文/.test(emptyBody.reason), 'reason mentions "正文"', emptyBody && emptyBody.reason);

  // ── ③ 未知 role ───────────────────────────────────────────────────────────
  console.log('[3] selectCard — 未知 role 响亮失败');
  const ghost = selectCard(discovery, 'ghost');
  assert('unknown role -> ok:false', ghost.ok === false, false, ghost.ok);
  assert('unknown role error names the id', ghost.ok === false && ghost.error.includes('ghost'), 'error mentions "ghost"', ghost.ok ? '(ok)' : ghost.error);
  assert('unknown role lists available ids', ghost.ok === false && ['bad-tools', 'noface', 'reviewer', 'writer'].every((id) => ghost.ids.includes(id)), ['bad-tools', 'noface', 'reviewer', 'writer'], ghost.ok ? [] : ghost.ids);
  const picked = selectCard(discovery, 'writer');
  assert('known role -> ok:true', picked.ok === true, true, picked.ok);
  eq('known role returns writer card', picked.ok && picked.card.id, 'writer');

  // ── ④ buildToolFilter：不可解析名 / 级联闸 / role_* ────────────────────────
  console.log('[4] buildToolFilter — 不可解析名响亮失败、级联 deny 按可见性过滤、role_* 不进 filter');
  const unknownName = buildToolFilter({ card: { tools: { allow: ['read', 'ghost_tool'], deny: [] } }, visible: VISIBLE });
  assert('card names an unavailable tool -> ok:false', unknownName.ok === false, false, unknownName.ok);
  eq('unknown list', unknownName.ok ? [] : unknownName.unknown, ['ghost_tool']);
  assert('unknown error names the tool', unknownName.ok === false && unknownName.error.includes('ghost_tool'), 'error mentions "ghost_tool"', unknownName.ok ? '(ok)' : unknownName.error);
  assert('unknown error lists currently available tools', unknownName.ok === false && unknownName.error.includes('read'), 'error mentions "read"', unknownName.ok ? '(ok)' : unknownName.error);
  assert('available is the restrictable set', unknownName.ok === false && unknownName.available.includes('read') && !unknownName.available.includes('role_list'), 'available has read, no role_list', unknownName.ok ? [] : unknownName.available);

  const cascadeVisible = buildToolFilter({ card: { tools: { allow: [], deny: [] } }, visible: ['read', 'subagent', 'workflow'] });
  eq('cascade deny filtered by visibility', cascadeVisible.ok && cascadeVisible.deny, ['subagent', 'workflow']);
  eq('cascade deny includes all four when visible', buildToolFilter({ card: { tools: { allow: [], deny: [] } }, visible: ['read', ...CASCADE_DENY] }).deny, ['subagent', 'subagent_fork', 'workflow', 'ralph']);
  eq('no cascade tool visible -> no filter at all', buildToolFilter({ card: { tools: { allow: [], deny: [] } }, visible: ['read'] }).filter, null);

  const roleStar = buildToolFilter({ card: { tools: { allow: ['read'], deny: ['write'] } }, visible: ['read', 'write', ...ROLE_TOOL_NAMES] });
  eq('role_* never enters allow', roleStar.ok && roleStar.allow, ['read']);
  eq('role_* never enters deny', roleStar.ok && roleStar.deny, ['write']);
  assert('role_* excluded from restrictable surface', roleStar.ok && ROLE_TOOL_NAMES.every((toolName) => !roleStar.available.includes(toolName)), 'available excludes role_*', roleStar.ok ? roleStar.available : roleStar);
  const roleNamedInCard = buildToolFilter({ card: { tools: { allow: ['role_spawn'], deny: [] } }, visible: ['read', ...ROLE_TOOL_NAMES] });
  assert('card naming role_spawn -> loud failure', roleNamedInCard.ok === false, false, roleNamedInCard.ok);
  assert('loud failure explains own-scope reason', roleNamedInCard.ok === false && /own-scope/.test(roleNamedInCard.error), 'error mentions "own-scope"', roleNamedInCard.ok ? '(ok)' : roleNamedInCard.error);

  // 2026-09-23（W3 独立验证发现后收口）：同名同时进 allow 与 deny = 自相矛盾声明。
  // 运行时 deny 会赢（dsh-tools/lib/index.js:2546）⇒ 若放行就是"静默丢掉想要的能力"，故必须响亮失败。
  const conflicting = buildToolFilter({ card: { tools: { allow: ['read', 'write'], deny: ['write'] } }, visible: ['read', 'write'] });
  assert('card allow∩deny -> loud failure', conflicting.ok === false, false, conflicting.ok);
  assert('allow∩deny error names the tool', conflicting.ok === false && conflicting.error.includes('write'), 'error names "write"', conflicting.ok ? '(ok)' : conflicting.error);
  assert('allow∩deny never yields a filter', conflicting.filter === undefined, 'no filter on conflict', conflicting.filter);
  eq('disjoint allow/deny still ok', buildToolFilter({ card: { tools: { allow: ['read'], deny: ['write'] } }, visible: ['read', 'write'] }).ok, true);

  // ── ⑤ persona / label / start spec（maxDepth=1） ───────────────────────────
  console.log('[5] composePersona / buildStartSpec — 协议尾注、label、maxDepth');
  const persona = composePersona(picked.ok ? picked.card : { body: '你是写手。' });
  assert('persona starts with card body', persona.startsWith('你是写手。'), 'starts with "你是写手。"', persona.slice(0, 30));
  assert('persona keeps the fixed tail', persona.includes(PERSONA_TAIL), 'contains PERSONA_TAIL', persona.slice(-120));
  for (const marker of ['Lead', '收到任务即执行', '一条', '不得自建成员', '只认实际可调用的工具表', '优先于 Lead 的指令']) {
    assert(`fixed tail mentions ${marker}`, PERSONA_TAIL.includes(marker), `tail contains ${marker}`, PERSONA_TAIL.slice(0, 80));
  }

  eq('parseRoleLabel（旧格式）→ roleId/name/cardId/format', parseRoleLabel('role:reviewer:alice'), { roleId: 'reviewer', name: 'alice', cardId: 'reviewer', format: 'legacy' });
  eq('parseRoleLabel rejects foreign labels', parseRoleLabel('teammate:alice'), null);

  // ⑤''' label 双格式（2026-09-24 改：显示面全中文 `<卡中文名>:<成员名>`；**旧格式必须永远能解析**）
  //   为什么必须双格式：label 的卡 id 段是「重启后认出老成员、给它补装执行期闸」的唯一认人依据
  //   （闸装在 agent scope 上、**不在** descriptor 里 ⇒ 重启拿不回 ⇒ 只能按 label/归属表认人；认不出就不补闸）
  //   ⇒ 老成员的 label 永远是旧格式，只认新格式 = 老成员掉闸 = 开安全洞。
  eq('新格式 label：<卡中文名>:<成员名>', roleLabel('沉淀员', '闸复验'), '沉淀员:闸复验');
  eq('卡名为空 ⇒ 退回卡 id（绝不产 ":name" 半截 label）', roleLabel('', '闸复验', { cardId: 'scribe' }), 'scribe:闸复验');
  eq('旧格式仍能生成（回滚 / 老会话重放用）', legacyRoleLabel('scribe', '闸复验'), 'role:scribe:闸复验');
  const labelCards = [{ id: 'scribe', name: '沉淀员' }, { id: 'reviewer', name: '审查官' }];
  eq('新格式解析：左段唯一命中卡中文名 ⇒ 认，且带 cardId', parseRoleLabel('沉淀员:闸复验', labelCards), { roleId: 'scribe', name: '闸复验', cardId: 'scribe', format: 'name' });
  eq('旧格式解析：老成员照旧能认（回归）', parseRoleLabel('role:scribe:闸复验', labelCards), { roleId: 'scribe', name: '闸复验', cardId: 'scribe', format: 'legacy' });
  eq('旧格式解析：不给已知卡也能认（老路不依赖卡发现）', parseRoleLabel('role:scribe:闸复验'), { roleId: 'scribe', name: '闸复验', cardId: 'scribe', format: 'legacy' });
  eq('自由文本含冒号不得误认（官方 subagent 的 label 是自由文本）', parseRoleLabel('别的什么:随便写', labelCards), null);
  eq('左段不是已知卡名 ⇒ 不认', parseRoleLabel('沉淀:闸复验', labelCards), null);
  eq('不给已知卡 ⇒ 新格式一律不认（fail-closed）', parseRoleLabel('沉淀员:闸复验'), null);
  eq('重名卡 ⇒ 无法唯一确定 ⇒ 不认（fail-closed）', parseRoleLabel('沉淀员:闸复验', [{ id: 'a', name: '沉淀员' }, { id: 'b', name: '沉淀员' }]), null);
  eq('无冒号的自由文本 ⇒ 不认', parseRoleLabel('沉淀员', labelCards), null);

  // ⑤'' 成员名（2026-09-24 加：放开中文 + 默认名取卡中文名 ⇒ 子代理列表标题中文化）
  //   反例必须能红：含 `:`（会破坏 label 分段：parseRoleLabel 只切第一个冒号）、含空格、空串、大写都要被拒。
  eq('成员名：中文短名合法', isValidMemberName('多代理审计'), true);
  eq('成员名：旧英文 kebab 仍合法', isValidMemberName('code-reviewer'), true);
  eq('成员名：含 ":" 必须拒（label 用 : 分段）', isValidMemberName('role:reviewer'), false);
  eq('成员名：含空格必须拒', isValidMemberName('多代理 审计'), false);
  eq('成员名：空串必须拒', isValidMemberName(''), false);
  eq('成员名：大写必须拒（保持小写口径）', isValidMemberName('Reviewer'), false);
  eq('默认名：取卡的中文 name', defaultMemberName({ id: 'reviewer', name: '审查官' }), '审查官');
  eq('默认名：卡无 name 时退回卡 id', defaultMemberName({ id: 'reviewer', name: '' }), 'reviewer');
  eq('默认名：name 含非法字符时折算并保留汉字', defaultMemberName({ id: 'writer', name: '写 手' }), '写-手');
  assert('协议含「派活前先定线」口径', /派活前先定线/.test(renderPolicyText()), '含', renderPolicyText().slice(0, 60));
  assert('协议含「入口优先级」（修指引层真冲突）', /入口优先级/.test(renderPolicyText()), '含', renderPolicyText().slice(0, 60));

  const fakeParent = { id: 'lead-session' };
  const spec = buildStartSpec({ parent: fakeParent, card: picked.ok ? picked.card : { id: 'writer', body: '你是写手。' }, name: 'alice', task: '看这个 diff' });
  eq('start spec provider', spec.provider, 'spawn');
  eq('start spec label（新格式；writer 卡无 name ⇒ 卡名退回卡 id）', spec.label, 'writer:alice');
  eq('start spec label 用卡的中文 name（子代理列表标题全中文）', buildStartSpec({ parent: fakeParent, card: { id: 'scribe', name: '沉淀员', body: '你是沉淀员。' }, name: '闸复验' }).label, '沉淀员:闸复验');
  eq('卡 name 为空 ⇒ 退回卡 id', buildStartSpec({ parent: fakeParent, card: { id: 'scribe', name: '', body: 'x' }, name: '闸复验' }).label, 'scribe:闸复验');
  eq('卡 name 含 ":" ⇒ 退回卡 id（否则 label 分段被破坏、认不回人）', buildStartSpec({ parent: fakeParent, card: { id: 'scribe', name: '沉淀:员', body: 'x' }, name: '闸复验' }).label, 'scribe:闸复验');
  eq('start spec request.maxDepth is 1 (top-level -> absolute cap 1)', spec.request.maxDepth, 1);
  eq('MEMBER_MAX_DEPTH constant', MEMBER_MAX_DEPTH, 1);
  eq('start spec request.parent is exec.agent', spec.request.parent, fakeParent);
  assert('start spec prompt starts with the task', spec.request.prompt[0].text.startsWith('看这个 diff'), 'prompt starts with task text', spec.request.prompt[0].text.slice(0, 40));
  assert('start spec prompt carries lead agent id', spec.request.prompt[0].text.includes('lead-session'), 'prompt names the lead agent id', spec.request.prompt[0].text.slice(-180));
  eq('reportHint empty without a parent id', reportHint({}), '');
  eq('reportHint empty for a blank parent id', reportHint({ id: '   ' }), '');
  eq('reportHint empty for a non-string parent id', reportHint({ id: 42 }), '');
  assert(
    'default-task prompt still carries the report hint',
    buildStartSpec({ parent: fakeParent, card: { id: 'writer', body: '你是写手。' } }).request.prompt[0].text.includes('lead-session'),
    'prompt (no task given) names the lead agent id',
    buildStartSpec({ parent: fakeParent, card: { id: 'writer', body: '你是写手。' } }).request.prompt[0].text.slice(-90),
  );
  assert('report hint never enters the persona', !spec.request.persona.includes('回报地址'), 'persona stays card body + fixed tail', spec.request.persona.slice(-90));

  // ⑤' 执行期闸谓词（2026-09-23 加：修真机验收抓到的"subagent mask 不掉"缺陷）
  const guardDenyOnly = buildToolGuard({ allow: [], deny: ['subagent', 'edit'] });
  assert('guard denies a cascade/deny name', typeof guardDenyOnly({ name: 'subagent' }) === 'string', 'string (deny)', guardDenyOnly({ name: 'subagent' }));
  assert('guard denial names the tool', /subagent/.test(guardDenyOnly({ name: 'subagent' }) || ''), 'mentions subagent', guardDenyOnly({ name: 'subagent' }));
  assert('guard allows a tool outside the deny list', guardDenyOnly({ name: 'read' }) === undefined, undefined, guardDenyOnly({ name: 'read' }));
  assert('guard tolerates a nameless execution', guardDenyOnly({}) === undefined, undefined, guardDenyOnly({}));
  const guardAllowOnly = buildToolGuard({ allow: ['read', 'grep'], deny: [] });
  assert('guard enforces the allow list at execution time', typeof guardAllowOnly({ name: 'write' }) === 'string', 'string (not in allow)', guardAllowOnly({ name: 'write' }));
  assert('guard allows a listed tool', guardAllowOnly({ name: 'read' }) === undefined, undefined, guardAllowOnly({ name: 'read' }));
  assert('guard deny wins over allow for the same name', typeof buildToolGuard({ allow: ['read'], deny: ['read'] })({ name: 'read' }) === 'string', 'string (deny wins)', buildToolGuard({ allow: ['read'], deny: ['read'] })({ name: 'read' }));

  // ⑤'' 写操作留痕（2026-09-23 主人拍板「甲」）：闸只看工具名 ⇒ 含 pwsh 的角色判据恒绿；留痕给事后 oracle
  eq('private cards live under L2 (moved out of the guard high-risk zone)', PRIVATE_CARD_SEGMENTS, ['mind-private', 'L2', 'agents']);
  assert('describeToolTarget extracts a write path', describeToolTarget('write', { path: 'E:/x/y.md' }) === 'E:/x/y.md', 'E:/x/y.md', describeToolTarget('write', { path: 'E:/x/y.md' }));
  assert('describeToolTarget accepts a JSON string arg', describeToolTarget('edit', '{"file_path":"E:/a/b.js"}') === 'E:/a/b.js', 'E:/a/b.js', describeToolTarget('edit', '{"file_path":"E:/a/b.js"}'));
  assert('describeToolTarget flattens a pwsh command', describeToolTarget('pwsh', { command: 'Get-Content  a.txt\n  |\tSet-Content b.txt' }) === 'Get-Content a.txt | Set-Content b.txt', 'flattened command', describeToolTarget('pwsh', { command: 'Get-Content  a.txt\n  |\tSet-Content b.txt' }));
  assert('describeToolTarget tolerates garbage args', describeToolTarget('write', 'not json') === '', '', describeToolTarget('write', 'not json'));
  {
    const seen = [];
    const memberGuard = buildMemberGuard({ allow: [], deny: ['subagent'] }, { label: 'role:x:probe', record: (line) => seen.push(line) });
    assert('member guard denies like the plain predicate', typeof memberGuard({ name: 'subagent' }) === 'string', 'string (deny)', memberGuard({ name: 'subagent' }));
    assert('member guard records the denial', seen.some((l) => l.includes('"kind":"deny"') && l.includes('subagent')), 'deny line recorded', seen);
    assert('member guard allows a permitted tool', memberGuard({ name: 'read' }) === undefined, undefined, memberGuard({ name: 'read' }));
    assert('member guard skips read in the audit trail', !seen.some((l) => l.includes('"kind":"pass"')), 'no pass line for read', seen);
    memberGuard({ name: 'write', arguments: '{"path":"E:/DSHOME/scratch.md"}' });
    assert('member guard audit line carries the target path', seen.some((l) => l.includes('"kind":"pass"') && l.includes('scratch.md')), 'pass line with path', seen);
    assert('member guard audit line carries the label', seen.some((l) => l.includes('role:x:probe')), 'label in audit line', seen);
  }
  assert('start spec carries persona', spec.request.persona.includes('你是写手。'), 'persona contains card body', spec.request.persona.slice(0, 30));

  // ── ⑥ 挂载面 + 八把工具真跑（临时 DSH_HOME / mock host） ───────────────────
  console.log('[6] apply — 顶层 scope 安装 + 八把工具真跑（mock host）');
  process.env.DSH_HOME = TMP_HOME;
  const host = makeHost();
  // 归属表**预置**一行（模拟「上个进程写的记录，本进程重启后读回」）：child-55 只在这一行里，label 是自由文本
  // ⇒ 只有 ① 归属表能认出它（② 卡中文名匹配认不出）。用它把「认人顺序」的两条路分开验（见 ⑥'''''）。
  put(join(TMP_HOME, 'profiles', 'dshome', '.dsh-market'), 'agent-roles-members.jsonl',
    `${JSON.stringify({ childId: 'child-55', cardId: 'reviewer', label: '别的什么:自由文本', at: '2026-09-24T00:00:00.000Z' })}\n`);
  apply(host.ctx);
  const defs = new Map(host.record.registered.map((definition) => [definition.name, definition]));

  // 期望面**写死在测试里**，不从 ROLE_TOOL_NAMES 取——那是拿插件比自己，恒真、零咬合力。
  // 2026-09-25：卡生命周期三工具（role_card_list/read/write）落地，注册面由三把扩到六把，
  // 本行原先写死的「三把」字面量成了恒红断言（verify-agent-roles 实测 248/249）。
  // 2026-09-26：再加 `role_card_retire`（退役卡）⇒ 六把扩到**七把**，同步本行与下方 policy 断言标签。
  // 本轮：再加 `role_card_rename`（给卡改 id）⇒ 七把扩到**八把**，同样同步本行与 policy 断言标签。
  eq('exactly eight tools registered', host.record.registered.map((definition) => definition.name), ['role_list', 'role_spawn', 'role_send', 'role_card_list', 'role_card_read', 'role_card_write', 'role_card_retire', 'role_card_rename']);
  eq('one policy section registered', host.record.sections.map((section) => section.name), ['agent-roles:policy']);
  eq('policy section order name', host.record.sectionOrderName, 'TEAM_POLICY');
  eq('policy section sits at TEAM_POLICY order', host.record.sections[0] && host.record.sections[0].order, 600);
  assert('policy text names all eight role tools', ROLE_TOOL_NAMES.every((toolName) => host.record.sections[0].text().includes(toolName)), 'policy text mentions role_list/role_spawn/role_send/role_card_*', host.record.sections[0].text().slice(0, 120));
  assert('child agent (depth 1) got no install', host.record.childInstalled !== true, 'child register never called', host.record.childInstalled === true);
  assert('no install-scope warning', host.record.warns.filter((message) => /作用域安装异常/.test(message)).length === 0, 'no 作用域安装异常 warn', host.record.warns);
  const markerPath = join(TMP_HOME, 'profiles', 'dshome', '.dsh-market', 'agent-roles-marker.txt');
  assert('marker written under temp DSH_HOME', existsSync(markerPath) && readFileSync(markerPath, 'utf8').includes('apply: mounted'), 'marker has apply: mounted', existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '(missing)');

  for (const toolName of ROLE_TOOL_NAMES) {
    const definition = defs.get(toolName);
    assert(`${toolName} declares output.schema + render`, !!definition && !!definition.output && !!definition.output.schema && typeof definition.output.render === 'function', 'output { schema, render }', definition ? Object.keys(definition.output || {}) : '(missing)');
  }
  /** 工具返回值必须逐字段通过自己的 output.schema（宿主 execute 后就会这么校验）。 */
  const assertSchemaResult = (label, toolName, value) => {
    const definition = defs.get(toolName);
    const violations = definition ? validateValue(definition.output.schema, value) : ['tool not registered'];
    assert(label, violations.length === 0, [], violations);
  };

  const exec = { agent: host.topAgent, signal: new AbortController().signal };

  const listValue = await defs.get('role_list').execute({}, exec);
  assert('role_list ok', listValue.ok === true, true, listValue.ok);
  eq('role_list roles', (listValue.roles || []).map((row) => row.id), ['bad-tools', 'noface', 'reviewer', 'writer']);
  eq('role_list reviewer source', (listValue.roles || []).find((row) => row.id === 'reviewer').source, 'workspace');
  eq('role_list reviewer model', (listValue.roles || []).find((row) => row.id === 'reviewer').model, 'deepseek-chat');
  eq('role_list reviewer tools.allow', (listValue.roles || []).find((row) => row.id === 'reviewer').tools.allow, ['read']);
  // 2026-09-26 加：未声明工具面的卡在 role_list 里也带同一把标注（`tools.allow: []` 不是"什么都没给"）
  eq('role_list 未声明工具面的卡标 unrestricted', (listValue.roles || []).find((row) => row.id === 'noface').toolFace, 'unrestricted');
  assert('role_list 未声明工具面的卡带中文说明', /全量工具面/.test((listValue.roles || []).find((row) => row.id === 'noface').toolFaceNote || ''), 'note 提到「全量工具面」', (listValue.roles || []).find((row) => row.id === 'noface').toolFaceNote);
  assert('role_list shows broken cards', (listValue.broken || []).length === 5, 5, (listValue.broken || []).length);
  eq('role_list dirs.workspace', listValue.dirs && listValue.dirs.workspace, WORKSPACE_DIR);
  const listRendered = defs.get('role_list').output.render({}, listValue);
  assert('role_list render -> one text block of parseable JSON', listRendered.length === 1 && listRendered[0].type === 'text' && JSON.parse(listRendered[0].text).ok === true, 'text block JSON with ok:true', listRendered);
  assertSchemaResult('role_list value conforms to its output.schema', 'role_list', listValue);

  const spawnUnknown = await defs.get('role_spawn').execute({ role: 'ghost' }, exec);
  assert('role_spawn unknown role -> ok:false', spawnUnknown.ok === false, false, spawnUnknown.ok);
  assert('role_spawn unknown role lists candidates', (spawnUnknown.available || []).includes('reviewer'), ['reviewer', '...'], spawnUnknown.available);
  assertSchemaResult('role_spawn unknown-role value conforms to its output.schema', 'role_spawn', spawnUnknown);

  const spawnBadTools = await defs.get('role_spawn').execute({ role: 'bad-tools' }, exec);
  assert('role_spawn card with ghost tool -> ok:false (no silent widening)', spawnBadTools.ok === false, false, spawnBadTools.ok);
  eq('role_spawn unknown tool list', spawnBadTools.unknown, ['ghost_tool']);
  assert('role_spawn ghost tool error lists available tools', /read/.test(spawnBadTools.error || ''), 'error mentions "read"', spawnBadTools.error);
  assertSchemaResult('role_spawn unknown-tool value conforms to its output.schema', 'role_spawn', spawnBadTools);

  const spawnWriter = await defs.get('role_spawn').execute({ role: 'writer', task: '写一段说明' }, exec);
  assert('role_spawn writer ok', spawnWriter.ok === true, true, spawnWriter.ok);
  eq('role_spawn label（新格式：卡无 name ⇒ 左段退回卡 id）', spawnWriter.label, 'writer:writer');
  eq('role_spawn childId', spawnWriter.childId, 'child-1');
  eq('role_spawn deny (card deny + restrictable cascade; own-scope subagent is NOT maskable here)', spawnWriter.deny, ['edit', 'subagent_fork', 'workflow', 'ralph']);
  assert('fixture models the own-scope leak (subagent not in restrictable surface)', !VISIBLE.includes('subagent') && OWN_SCOPE_ONLY.includes('subagent'), 'VISIBLE excludes subagent, OWN_SCOPE_ONLY lists it', { visibleHasSubagent: VISIBLE.includes('subagent') });
  assert('role_spawn deny never carries role_*', !spawnWriter.deny.includes('role_list'), 'no role_* in deny', spawnWriter.deny);
  const writerSpec = host.record.specs[0];
  eq('startContinuable spec.provider', writerSpec.provider, 'spawn');
  eq('startContinuable request.maxDepth', writerSpec.request.maxDepth, 1);
  eq('startContinuable request.parent is the calling agent', writerSpec.request.parent, host.topAgent);
  eq('startContinuable request.toolFilter.deny', writerSpec.request.toolFilter && writerSpec.request.toolFilter.deny, ['edit', 'subagent_fork', 'workflow', 'ralph']);
  assert('startContinuable request.persona carries card body', writerSpec.request.persona.includes('你是写手。'), 'persona contains "你是写手。"', writerSpec.request.persona.slice(0, 40));
  assert('startContinuable request.persona carries fixed tail', writerSpec.request.persona.includes(PERSONA_TAIL), 'persona contains PERSONA_TAIL', writerSpec.request.persona.slice(-80));
  assert('startContinuable prompt starts with the task', writerSpec.request.prompt[0].text.startsWith('写一段说明'), 'prompt starts with the task text', writerSpec.request.prompt[0].text.slice(0, 40));
  assert('startContinuable prompt carries the lead agent id', writerSpec.request.prompt[0].text.includes(host.topAgent.id), `prompt names ${host.topAgent.id}`, writerSpec.request.prompt[0].text.slice(-180));
  assert('startContinuable persona still carries no report hint', !writerSpec.request.persona.includes('回报地址'), 'persona is card body + fixed tail only', writerSpec.request.persona.slice(-80));
  assertSchemaResult('role_spawn writer value conforms to its output.schema', 'role_spawn', spawnWriter);

  const spawnReviewer = await defs.get('role_spawn').execute({ role: 'reviewer', name: 'alice', task: '看 diff' }, exec);
  assert('role_spawn reviewer ok', spawnReviewer.ok === true, true, spawnReviewer.ok);
  eq('role_spawn label 用卡的中文 name（子代理列表标题＝「工作区评审员:alice」）', spawnReviewer.label, '工作区评审员:alice');
  eq('role_spawn allow (card allow only)', spawnReviewer.allow, ['read']);
  const reviewerSpec = host.record.specs[1];
  eq('model routing via request.agentOptions', reviewerSpec.request.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' });
  eq('toolFilter.allow narrowed to card allow', reviewerSpec.request.toolFilter && reviewerSpec.request.toolFilter.allow, ['read']);
  eq('reviewer toolFilter deny = restrictable cascade only (subagent must NOT appear: it is not maskable)', reviewerSpec.request.toolFilter.deny, ['subagent_fork', 'workflow', 'ralph']);

  // ⑥' 执行期闸真装到成员 scope（2026-09-23 加）——这条覆盖 `restrict` 管不到的 own-scope 工具
  assert('role_spawn reports guardInstalled', spawnWriter.guardInstalled === true, true, spawnWriter.guardInstalled);
  eq('guard recorded on the member scope', host.record.childGuards.length, 1);
  const writerGuard = host.record.childGuards[0];
  assert('installed guard denies subagent (the own-scope leak)', typeof writerGuard({ name: 'subagent' }) === 'string', 'string (deny)', writerGuard({ name: 'subagent' }));
  assert('installed guard denies card deny (edit)', typeof writerGuard({ name: 'edit' }) === 'string', 'string (deny)', writerGuard({ name: 'edit' }));
  assert('installed guard allows read', writerGuard({ name: 'read' }) === undefined, undefined, writerGuard({ name: 'read' }));
  // 留痕必须落在**临时 DSH_HOME**（绝不许写进仓库）：放行一次 write → 审计文件里应出现该路径
  writerGuard({ name: 'write', arguments: '{"path":"E:/DSHOME/scratch-audit.md"}' });
  const auditPath = join(TMP_HOME, 'profiles', 'dshome', '.dsh-market', 'agent-roles-writes.jsonl');
  assert('audit file lands under the temp DSH_HOME (not the repo)', existsSync(auditPath), true, existsSync(auditPath));
  if (existsSync(auditPath)) {
    const auditText = readFileSync(auditPath, 'utf8');
    assert('audit file records the allowed write target', auditText.includes('scratch-audit.md') && auditText.includes('"kind":"pass"'), 'pass line with target', auditText.slice(-200));
    assert('audit file records the member label', auditText.includes('writer:writer') && !auditText.includes('role:writer:'), 'new-format label "writer:writer", no legacy "role:writer:"', auditText.slice(-200));
  }
  assert('reviewer spawn also reports guardInstalled (idempotent on the same mock child)', spawnReviewer.guardInstalled === true, true, spawnReviewer.guardInstalled);

  // ⑥''''' 路径闸（方案乙 · opt-in）+ own-scope 自检（③）
  const ws = CWD;
  assert('pathAllowed: empty whitelist = gate off', pathAllowed(`${ws}/a.md`, [], ws) === true, true, pathAllowed(`${ws}/a.md`, [], ws));
  assert('pathAllowed: file inside an allowed dir', pathAllowed(`${ws}/sub/a.md`, [ws], ws) === true, true, pathAllowed(`${ws}/sub/a.md`, [ws], ws));
  assert('pathAllowed: exact file allowed', pathAllowed(`${ws}/a.md`, [`${ws}/a.md`], ws) === true, true, pathAllowed(`${ws}/a.md`, [`${ws}/a.md`], ws));
  assert('pathAllowed: sibling path denied', pathAllowed(`${ws}/other/a.md`, [`${ws}/a.md`], ws) === false, false, pathAllowed(`${ws}/other/a.md`, [`${ws}/a.md`], ws));
  assert('pathAllowed: relative target resolved against cwd', pathAllowed('sub/b.md', ['sub'], ws) === true, true, pathAllowed('sub/b.md', ['sub'], ws));
  assert('pathAllowed: empty target fails closed', pathAllowed('', [ws], ws) === false, false, pathAllowed('', [ws], ws));
  // 2026-09-24 加（治真实绕过）：绝对路径里的 `..` **必须先被消解再判定**。原实现 `isAbsolute(raw) ? raw : resolve(...)`
  // 让绝对路径原样保留 `..`，而判定是字符串前缀匹配 ⇒ `…/ok/../bad/a.md` 会被判放行，写入层却消解成 `…/bad/a.md`
  // ⇒ 真机实测文件落到白名单外（证据：L3 `project.md` 该条 + `2026-09-24_dotdot-escape-evidence.txt`）。
  // 反证方式：把 `normalizePath` 改回 `isAbsolute(raw) ? raw : resolve(...)`，下面第 1、3 条必须变红（第 2 条是防过度拦截的正对照）。
  assert('pathAllowed: absolute `..` escape is denied (regression: was a real bypass)', pathAllowed(`${ws}/ok/../bad/a.md`, [`${ws}/ok`], ws) === false, false, pathAllowed(`${ws}/ok/../bad/a.md`, [`${ws}/ok`], ws));
  assert('pathAllowed: absolute `..` that stays inside is still allowed (no over-blocking)', pathAllowed(`${ws}/sub/../a.md`, [ws], ws) === true, true, pathAllowed(`${ws}/sub/../a.md`, [ws], ws));
  assert('pathAllowed: multi-level absolute `..` escape is denied', pathAllowed(`${ws}/ok/a/../../bad/a.md`, [`${ws}/ok`], ws) === false, false, pathAllowed(`${ws}/ok/a/../../bad/a.md`, [`${ws}/ok`], ws));
  assert('ownScopeTools: lists non-restrictable visible names', JSON.stringify(ownScopeTools({ visible: new Map([['subagent', {}], ['read', {}]]), restrictableNames: new Set(['read']) })) === '["subagent"]', '["subagent"]', ownScopeTools({ visible: new Map([['subagent', {}], ['read', {}]]), restrictableNames: new Set(['read']) }));
  assert('ownScopeTools: null when the view is unavailable', ownScopeTools(null) === null, null, ownScopeTools(null));

  {
    const seenPath = [];
    const scoped = buildMemberGuard({ allow: [], deny: [] }, { label: 'role:engineer:scoped', record: (line) => seenPath.push(line), writePaths: [`${ws}/ok`], cwd: ws });
    assert('path gate allows a write inside the scope', scoped({ name: 'write', arguments: JSON.stringify({ path: `${ws}/ok/a.md` }) }) === undefined, undefined, scoped({ name: 'write', arguments: JSON.stringify({ path: `${ws}/ok/a.md` }) }));
    const outside = scoped({ name: 'write', arguments: JSON.stringify({ path: `${ws}/bad/a.md` }) });
    assert('path gate denies a write outside the scope', typeof outside === 'string' && outside.includes('write_scope'), 'string mentioning write_scope', outside);
    assert('path gate records the denial as deny-path', seenPath.some((line) => line.includes('"kind":"deny-path"')), 'deny-path recorded', seenPath);
    assert('path gate does not restrict pwsh (honest boundary)', scoped({ name: 'pwsh', arguments: JSON.stringify({ command: 'Set-Content x' }) }) === undefined, undefined, scoped({ name: 'pwsh', arguments: JSON.stringify({ command: 'Set-Content x' }) }));
  }

  // 集成：起成员时「当轮 write_scope」优先；不给则如实标注 unbounded；own-scope 自检报出 subagent
  const spawnScoped = await defs.get('role_spawn').execute({ role: 'writer', name: 'scoped-one', write_scope: [`${ws}/ok`] }, exec);
  assert('role_spawn reports writeScope=declared when write_scope given', spawnScoped.ok === true && spawnScoped.writeScope === 'declared', 'declared', spawnScoped.writeScope);
  // 2026-09-26 改（治「缺省值静默生效」）：内联建卡**必须显式给工具面**，故这里把"全量面"**逐个列出来**——
  // 这正是错误文案要求的出路，也让这条用例从"靠默认值全量"变成"显式要全量"。
  // ⚠️ 只能列**调用者真能下发**的名字：`role_*`（八把，只在顶层 own-scope）与 `run_code`（保留名）列进去会被
  // `buildToolFilter` 判"不可解析名"而**响亮失败**——那正是下面 FULL_FACE 反例要钉住的行为。
  const FULL_FACE = [...VISIBLE, ...ROLE_TOOL_NAMES, 'run_code'];
  const spawnUnbounded = await defs.get('role_spawn').execute({ persona: '你是无范围探针。', name: 'unbounded-one', tools: { allow: [...VISIBLE] } }, exec);
  assert('role_spawn reports writeScope=unbounded when nothing declared', spawnUnbounded.ok === true && spawnUnbounded.writeScope === 'unbounded', 'unbounded', spawnUnbounded.writeScope);
  eq('显式逐个列出工具名 ⇒ allow 原样落地', spawnUnbounded.allow, [...VISIBLE]);
  const spawnFullFace = await defs.get('role_spawn').execute({ persona: '你是越面探针。', name: 'full-face', tools: { allow: FULL_FACE } }, exec);
  assert('把 role_*/run_code 也列进去 ⇒ 响亮失败（它们是"不可下发名"，不是全量面的一部分）', spawnFullFace.ok === false, false, spawnFullFace);
  assert('不可下发名的错误文案点出 role_list', /role_list/.test(spawnFullFace.error || ''), 'error 含 role_list', spawnFullFace.error);
  assert('role_spawn surfaces own-scope tools (subagent)', Array.isArray(spawnScoped.ownScopeTools) && spawnScoped.ownScopeTools.includes('subagent'), '["subagent"]', spawnScoped.ownScopeTools);

  // ⑥'' 挂起补装路：childId 还不在注册表 ⇒ 记 pending；`agent/created` 一到就补装（无竞态）
  host.record.nextChildId = 'ghost-child';
  const spawnGhost = await defs.get('role_spawn').execute({ persona: '你是幽灵探针，只回报工具面。', name: 'ghost-one', tools: { allow: ['read'] } }, exec);
  assert('spawn ok even when the child is not yet in the registry', spawnGhost.ok === true, true, spawnGhost.ok);
  assert('guard reports pending when the child is absent', spawnGhost.guardInstalled === false && /挂起|尚未进注册表/.test(spawnGhost.guardReason), 'pending reason', spawnGhost.guardReason);
  host.record.nextChildId = null;
  const createdHook = host.record.handlers.find((h) => h.ev === 'agent/created');
  assert('agent/created handler is subscribed', createdHook !== undefined, true, createdHook !== undefined);
  if (createdHook) {
    const ghostAgent = {
      id: 'ghost-child',
      session: { header: { id: 'ghost-child', delegationDepth: 1, cwd: CWD } },
      ctx: { tools: { register: () => () => {}, guard: (predicate) => { host.record.childGuards.push(predicate); return () => {}; } } },
    };
    createdHook.handler({ agent: ghostAgent });
    eq('pending guard installed on agent/created', host.record.childGuards.length, 2);
    const ghostGuard = host.record.childGuards[1];
    assert('ghost guard denies subagent (cascade is unconditional in the guard)', typeof ghostGuard({ name: 'subagent' }) === 'string', 'string (deny)', ghostGuard({ name: 'subagent' }));
  }

  // ── ⑥'''''' 工具面标注：治「缺省值静默生效」（2026-09-26，Lead 冻结规格） ────────────────
  // 缺陷真机读数（Lead 在 LianChaoGame 会话实测）：`role_spawn` 走内联建卡（persona+name）而**没给 tools**
  // 时返回值是 `allow: []`——看着像"什么都没给"，而成员实际拿到**调用者全量工具面**（成员回报的工具表＝
  // 完整 26 把，含 write/pwsh/subagent/send_message）。根因：`allow` 空且 `deny` 空 ⇒ `buildToolFilter`
  // 不产生 toolFilter ⇒ 子会话 `restrict` 不做任何裁剪。即「卡声明越少、成员权限越大」，与协议文案相反。
  // 对照组（显式给 allow 的成员回报里没有 send_message）证明**坏的只是"空 allow"这一格**，故本轮只治这一格。
  console.log('[6\'\'\'\'\'\'] toolFace — 内联建卡缺工具面响亮失败 + 未声明工具面响亮标注');
  const specsBeforeNoFace = host.record.specs.length;
  const spawnNoToolsArg = await defs.get('role_spawn').execute({ persona: '你是缺面探针甲。', name: 'no-face-a' }, exec);
  assert('① 内联建卡缺 tools ⇒ ok:false（响亮失败，不再静默全量）', spawnNoToolsArg.ok === false, false, spawnNoToolsArg);
  assert('① 错误文案点出「全量工具面」这层意思', /全量工具面/.test(spawnNoToolsArg.error || ''), 'error 含「全量工具面」', spawnNoToolsArg.error);
  assert('① 错误文案给出下一步（显式给 tools:{allow:[...]}）', /tools:\{allow:\[\.\.\.\]\}/.test(spawnNoToolsArg.error || ''), 'error 含「tools:{allow:[...]}」', spawnNoToolsArg.error);
  assert('① 错误文案给出出路（把工具名逐个列出来）', /逐个列出来/.test(spawnNoToolsArg.error || ''), 'error 含「逐个列出来」', spawnNoToolsArg.error);
  eq('① 拒绝理由是结构化 code（模型可直接分支）', spawnNoToolsArg.code, 'inline-tools-empty');
  assertSchemaResult('① 缺 tools 的返回值符合自己的 output.schema', 'role_spawn', spawnNoToolsArg);

  const spawnEmptyAllow = await defs.get('role_spawn').execute({ persona: '你是缺面探针乙。', name: 'no-face-b', tools: { allow: [] } }, exec);
  assert('② 内联建卡 allow:[] ⇒ ok:false（空列表＝不收窄，必须拒）', spawnEmptyAllow.ok === false, false, spawnEmptyAllow);
  assert('② 空 allow 的错误文案与缺 tools 同口径', /tools\.allow 为空/.test(spawnEmptyAllow.error || ''), 'error 含「tools.allow 为空」', spawnEmptyAllow.error);
  const spawnEmptyToolsObj = await defs.get('role_spawn').execute({ persona: '你是缺面探针丙。', name: 'no-face-c', tools: {} }, exec);
  assert('②b 内联建卡 tools:{} ⇒ 同样 ok:false', spawnEmptyToolsObj.ok === false, false, spawnEmptyToolsObj);
  assert('②c 三条失败路径都没起成员（specs 数不变）', host.record.specs.length === specsBeforeNoFace, specsBeforeNoFace, host.record.specs.length);
  assert('②d 失败路径没写卡（盘上无 no-face-a/b/c 卡文件）', !existsSync(join(WORKSPACE_DIR, 'no-face-a.md')) && !existsSync(join(WORKSPACE_DIR, 'no-face-b.md')), 'no inline card written', existsSync(join(WORKSPACE_DIR, 'no-face-a.md')));

  // ③ 卡**文件本身**没声明工具面 ⇒ 不拦（存量卡可能这么写），但返回值必须带 toolFace 标注
  //   ⚠️ 给这名成员**专用 childId**：归属表是 `childId → cardId`（后写赢），若沿用夹具默认的 'child-1'
  //   （已被 writer/reviewer 等成员占着），后续 spawn 会把它改指到别的卡 ⇒ 下面 role_send 的卡归属被污染。
  host.record.nextChildId = 'child-noface';
  const spawnNoFace = await defs.get('role_spawn').execute({ role: 'noface', name: '未声明面' }, exec);
  host.record.nextChildId = null;
  assert('③ 卡未声明工具面 ⇒ 不拦（照旧起成员）', spawnNoFace.ok === true, true, spawnNoFace);
  eq('③ 该成员拿到专用 childId（归属表不与他人串号）', spawnNoFace.childId, 'child-noface');
  eq('③ 返回值 toolFace = unrestricted', spawnNoFace.toolFace, 'unrestricted');
  assert('③ 返回值 toolFaceNote 说明「拿到调用者全量工具面」', /全量工具面/.test(spawnNoFace.toolFaceNote || ''), 'note 含「全量工具面」', spawnNoFace.toolFaceNote);
  eq('③ 对照：卡写了 allow ⇒ restricted（坏的只是"空 allow"这一格）', spawnReviewer.toolFace, 'restricted');
  eq('③ 对照：restricted 不带说明（别用噪声淹没 true）', spawnReviewer.toolFaceNote, '');
  eq('③ 对照：只声明 deny 的卡也是 unrestricted（面没收窄；级联闸照旧在 ↓ 见 role_spawn deny 断言）', spawnWriter.toolFace, 'unrestricted');
  assertSchemaResult('③ 未声明工具面的 spawn 返回值符合 schema', 'role_spawn', spawnNoFace);

  // ④ role_card_list：`allow: []` 不许再原样显示成空数组
  const cardListValue = await defs.get('role_card_list').execute({}, exec);
  assert('role_card_list ok', cardListValue.ok === true, true, cardListValue.ok);
  const nofaceRow = (cardListValue.cards || []).find((row) => row.id === 'noface');
  assert('role_card_list 里能看到 noface 卡', !!nofaceRow, 'row present', (cardListValue.cards || []).map((row) => row.id));
  eq('④ role_card_list 对未声明的卡标 unrestricted', nofaceRow && nofaceRow.toolFace, 'unrestricted');
  assert('④ role_card_list 的标注说明「该卡起的成员拿到调用者全量工具面」', /该卡未声明工具面/.test((nofaceRow && nofaceRow.toolFaceNote) || '') && /全量工具面/.test((nofaceRow && nofaceRow.toolFaceNote) || ''), 'note 含「该卡未声明工具面」+「全量工具面」', nofaceRow && nofaceRow.toolFaceNote);
  eq('④ 对照：声明了 allow 的卡在 role_card_list 里是 restricted', (cardListValue.cards || []).find((row) => row.id === 'reviewer').toolFace, 'restricted');
  eq('④ 对照：restricted 行不带说明', (cardListValue.cards || []).find((row) => row.id === 'reviewer').toolFaceNote, '');
  assertSchemaResult('④ role_card_list 返回值符合 schema', 'role_card_list', cardListValue);

  // ⑥''' 跨进程恢复（一）+（二）见下方（放在既有 role_send 断言**之后**：那几条按 `record.sends[0]`
  // 取数，先插新发送会把它们的下标顶掉 ⇒ 顺序也是断言的一部分，别随手挪）。


  const spawnDuplicate = await defs.get('role_spawn').execute({ role: 'reviewer', name: 'alice' }, exec);
  assert('duplicate member name -> ok:false', spawnDuplicate.ok === false, false, spawnDuplicate.ok);
  assertSchemaResult('role_spawn duplicate-name value conforms to its output.schema', 'role_spawn', spawnDuplicate);

  const spawnInline = await defs.get('role_spawn').execute({ persona: '你是临时工。', name: 'temp-one', save: true, scope: 'workspace', tools: { allow: ['read'] } }, exec);
  assert('inline card spawn ok', spawnInline.ok === true, true, spawnInline.ok);
  eq('inline card saved flag', spawnInline.saved, true);
  eq('inline card path', spawnInline.cardPath, join(WORKSPACE_DIR, 'temp-one.md'));
  assert('inline card file exists', existsSync(join(WORKSPACE_DIR, 'temp-one.md')), true, existsSync(join(WORKSPACE_DIR, 'temp-one.md')));
  const inlineReparsed = parseCard(readFileSync(join(WORKSPACE_DIR, 'temp-one.md'), 'utf8'), join(WORKSPACE_DIR, 'temp-one.md'));
  assert('inline card round-trips through parseCard', inlineReparsed.ok === true, true, inlineReparsed.ok ? true : inlineReparsed.reason);
  if (inlineReparsed.ok) {
    eq('inline card round-trip id', inlineReparsed.card.id, 'temp-one');
    eq('inline card round-trip body', inlineReparsed.card.body, '你是临时工。');
    eq('inline card round-trip tools.allow', inlineReparsed.card.tools.allow, ['read']);
  }
  const spawnInlineAgain = await defs.get('role_spawn').execute({ persona: '你是临时工。', name: 'temp-one', save: true, tools: { allow: ['read'] } }, exec);
  assert('existing card file -> refuse overwrite', spawnInlineAgain.ok === false && /拒绝覆盖/.test(spawnInlineAgain.error), 'ok:false + 拒绝覆盖', spawnInlineAgain);

  const sendUnknown = await defs.get('role_send').execute({ target: 'ghost', message: 'hi' }, exec);
  assert('role_send unknown target -> ok:false', sendUnknown.ok === false, false, sendUnknown.ok);
  assert('role_send unknown target lists members', (sendUnknown.members || []).some((row) => row.includes('alice')), 'members includes alice', sendUnknown.members);
  assertSchemaResult('role_send unknown-target value conforms to its output.schema', 'role_send', sendUnknown);

  const sendAlice = await defs.get('role_send').execute({ target: 'alice', message: '继续' }, exec);
  assert('role_send to name ok', sendAlice.ok === true, true, sendAlice.ok);
  eq('role_send resolves name -> childId', sendAlice.childId, 'child-1');
  eq('role_send messageId', sendAlice.messageId, 'msg-2');
  eq('sendMessage sender is the calling agent', host.record.sends[0] && host.record.sends[0].senderId, 'lead-session');
  eq('sendMessage target id', host.record.sends[0] && host.record.sends[0].targetId, 'child-1');
  eq('sendMessage text', host.record.sends[0] && host.record.sends[0].text, '继续');
  assertSchemaResult('role_send success value conforms to its output.schema', 'role_send', sendAlice);

  const sendByChildId = await defs.get('role_send').execute({ target: 'child-1', message: '按 id 投递' }, exec);
  assert('role_send by childId ok', sendByChildId.ok === true, true, sendByChildId.ok);

  // 2026-09-26 加（Lead 冻结规格第 4 条）：唤醒路径**同口径**标注工具面。
  // ⚠️ 寻址口径：`role_send` 只认**成员名 / childId / 卡中文名**（**不**认卡 id）——上面那几条"按卡 id 寻址"
  // 的用例之所以绿，是因为 `listChildren` 夹具里 reviewer 那张卡被认出后 `entryName===target` 走了兜底；
  // 本用例则必须用**成员名**寻址（用卡 id 会得到 ok:false，那是寻址口径、不是工具面缺陷）。
  const sendNoFace = await defs.get('role_send').execute({ target: '未声明面', message: '你是谁' }, exec);
  assert('role_send 唤醒未声明工具面的成员 ok（按成员名寻址）', sendNoFace.ok === true, true, sendNoFace);
  eq('role_send toolFace = unrestricted（卡未声明工具面）', sendNoFace.toolFace, 'unrestricted');
  assert('role_send toolFaceNote 说明成员拿到调用者全量工具面', /全量工具面/.test(sendNoFace.toolFaceNote || ''), 'note 含「全量工具面」', sendNoFace.toolFaceNote);
  eq('role_send 对照：受限成员（reviewer）toolFace = restricted', sendByChildId.toolFace, 'restricted');
  eq('role_send 对照：restricted 不带说明', sendByChildId.toolFaceNote, '');
  assertSchemaResult('role_send 未声明工具面的返回值符合 schema', 'role_send', sendNoFace);
  // 反例：卡被删（跨重启后卡不在卡池）⇒ 认人拿不到卡 ⇒ 同样是 unrestricted（诚实侧），且文案与"卡未声明"可区分
  const savedNoface = readFileSync(join(WORKSPACE_DIR, 'noface.md'), 'utf8');
  rmSync(join(WORKSPACE_DIR, 'noface.md'), { force: true });
  const sendCardGone = await defs.get('role_send').execute({ target: '未声明面', message: '卡没了还认得我吗' }, exec);
  assert('反例：卡被删后 role_send 仍认得成员（归属表/成员名认人）', sendCardGone.ok === true, true, sendCardGone);
  eq('反例：拿不到卡 ⇒ toolFace 也是 unrestricted（面确实未收窄）', sendCardGone.toolFace, 'unrestricted');
  assert('反例：拿不到卡的说明与「卡未声明工具面」可区分', /拿不到该成员的角色卡/.test(sendCardGone.toolFaceNote || ''), 'note 含「拿不到该成员的角色卡」', sendCardGone.toolFaceNote);
  writeFileSync(join(WORKSPACE_DIR, 'noface.md'), savedNoface, 'utf8');   // 复还夹具（后续断言仍要看这张卡）

  // ⑥''' 跨进程恢复（一）：`role_send` 冷唤醒时补装——内存映射已空，label 从 listChildren 认回来
  // （`guard` 不在 `subagent/descriptor` 里 ⇒ 重启后老成员自己拿不回它，必须由这两条路补）
  host.record.children = [{ kind: 'child', id: 'child-9', activity: 'ready', hasChildren: false, mode: 'continuable', label: 'role:reviewer:bob' }];
  const coldSend = await defs.get('role_send').execute({ target: 'bob', message: '唤醒一下' }, exec);
  assert('cold role_send ok', coldSend.ok === true, true, coldSend.ok);
  assert('cold role_send installs the guard', coldSend.guardInstalled === true, true, coldSend.guardInstalled);
  eq('resume guard recorded on the member scope', host.record.childGuards.length, 3);
  const resumeGuard = host.record.childGuards[2];
  assert('resume guard enforces the card allow list (write denied)', typeof resumeGuard({ name: 'write' }) === 'string', 'string (deny)', resumeGuard({ name: 'write' }));
  assert('resume guard allows read', resumeGuard({ name: 'read' }) === undefined, undefined, resumeGuard({ name: 'read' }));

  // ⑥'''' 跨进程恢复（二）：不经过 role_send 的那条路 —— `agent/created` 异步补装
  host.record.children = [{ kind: 'child', id: 'child-42', activity: 'ready', hasChildren: false, mode: 'continuable', label: 'role:reviewer:eve' }];
  const lateAgent = {
    id: 'child-42',
    session: { header: { id: 'child-42', delegationDepth: 1, cwd: CWD, parentSession: 'lead-session' } },
    ctx: { tools: { register: () => () => {}, guard: (predicate) => { host.record.childGuards.push(predicate); return () => {}; } } },
  };
  if (createdHook) {
    createdHook.handler({ agent: lateAgent });
    await new Promise((resolve) => setTimeout(resolve, 25));
    eq('agent/created async path installs the guard', host.record.childGuards.length, 4);
    const lateGuard = host.record.childGuards[3];
    assert('late guard enforces the card allow list (write denied)', typeof lateGuard({ name: 'write' }) === 'string', 'string (deny)', lateGuard({ name: 'write' }));
    assert('late guard denies subagent (cascade)', typeof lateGuard({ name: 'subagent' }) === 'string', 'string (deny)', lateGuard({ name: 'subagent' }));
  }
  host.record.children = null;

  // ⑥''''' 认人顺序（跨进程恢复的核心，**fail-closed**）：① 归属表 childId→cardId → ② label 卡中文名唯一匹配 → ③ 不认 ⇒ 不装闸
  //   为什么顺序是这样：闸装在 agent scope 上、**不在** descriptor 里 ⇒ 重启后成员拿不回它，只能"认人"补装；
  //   而**认错人 = 按错的卡装闸**（比不装更坏），所以认不出就不装；label 会改名/重名/自由文本，
  //   只有 childId→cardId 是确定的 ⇒ 归属表优先。
  const countBefore = host.record.childGuards.length;
  const memberMapPath = join(TMP_HOME, 'profiles', 'dshome', '.dsh-market', 'agent-roles-members.jsonl');
  assert('成员归属表落在临时 DSH_HOME（append-only 的 childId→cardId）', existsSync(memberMapPath), true, existsSync(memberMapPath));
  if (existsSync(memberMapPath)) {
    const mapText = readFileSync(memberMapPath, 'utf8');
    assert('起成员时记下 childId→cardId（诊断 marker 滚掉也不丢）', mapText.includes('"childId":"child-1"') && mapText.includes('"cardId":"writer"'), 'childId=child-1 + cardId=writer', mapText.split('\n').filter(Boolean).slice(-2));
  }
  const markerNow = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
  const lastSpawnLine = markerNow.split('\n').filter((line) => line.startsWith('spawn:')).slice(-1)[0] || '';
  assert('spawn marker 显式写 cardId（认人不再只靠 label 解析）', /^spawn: \S+ card=\S+ name=\S+/.test(lastSpawnLine), 'spawn: <childId> card=<id> name=<name>', lastSpawnLine);

  // ③ 反例（必须**不装闸**）：自由文本 label + 卡名不在已知卡里 + 归属表里没有它
  host.record.children = [{ kind: 'child', id: 'child-88', activity: 'ready', hasChildren: false, mode: 'continuable', label: '别的什么:frank' }];
  const foreignAgent = {
    id: 'child-88',
    session: { header: { id: 'child-88', delegationDepth: 1, cwd: CWD, parentSession: 'lead-session' } },
    ctx: { tools: { register: () => () => {}, guard: (predicate) => { host.record.childGuards.push(predicate); return () => {}; } } },
  };
  if (createdHook) {
    createdHook.handler({ agent: foreignAgent });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  eq('③ 自由文本 label（含冒号）⇒ 不认 ⇒ 不补闸（官方 subagent 那类）', host.record.childGuards.length, countBefore);

  // ② 正例：新格式 label，左段唯一命中已知卡的中文名 ⇒ 认人 + 按该卡补闸
  host.record.children = [{ kind: 'child', id: 'child-77', activity: 'ready', hasChildren: false, mode: 'continuable', label: '工作区评审员:zoe' }];
  const newLabelAgent = {
    id: 'child-77',
    session: { header: { id: 'child-77', delegationDepth: 1, cwd: CWD, parentSession: 'lead-session' } },
    ctx: { tools: { register: () => () => {}, guard: (predicate) => { host.record.childGuards.push(predicate); return () => {}; } } },
  };
  if (createdHook) {
    createdHook.handler({ agent: newLabelAgent });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  eq('② 新格式 label（卡中文名唯一命中）⇒ 认人 + 补闸', host.record.childGuards.length, countBefore + 1);
  const newLabelGuard = host.record.childGuards[countBefore];
  assert('② 认回的成员装的是该卡的闸（reviewer allow=[read] ⇒ write 被拒）', !!newLabelGuard && typeof newLabelGuard({ name: 'write' }) === 'string', 'string (deny)', newLabelGuard ? newLabelGuard({ name: 'write' }) : '(没有补闸)');
  assert('② 认回的成员放行卡内 allow 的工具（read）', !!newLabelGuard && newLabelGuard({ name: 'read' }) === undefined, undefined, newLabelGuard ? newLabelGuard({ name: 'read' }) : '(没有补闸)');

  // ① 正例：**同一代码路径、同一种自由文本 label**，唯一差别＝归属表里有 child-55 ⇒ 只有 ① 能解释它被认出来
  host.record.children = [{ kind: 'child', id: 'child-55', activity: 'ready', hasChildren: false, mode: 'continuable', label: '别的什么:自由文本' }];
  const mapOnlyAgent = {
    id: 'child-55',
    session: { header: { id: 'child-55', delegationDepth: 1, cwd: CWD, parentSession: 'lead-session' } },
    ctx: { tools: { register: () => () => {}, guard: (predicate) => { host.record.childGuards.push(predicate); return () => {}; } } },
  };
  if (createdHook) {
    createdHook.handler({ agent: mapOnlyAgent });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  eq('① 归属表认人（label 自由文本也能补闸）', host.record.childGuards.length, countBefore + 2);
  const mapOnlyGuard = host.record.childGuards[countBefore + 1];
  assert('① 归属表认回的卡是 reviewer（write 拒 / read 放行）', !!mapOnlyGuard && typeof mapOnlyGuard({ name: 'write' }) === 'string' && mapOnlyGuard({ name: 'read' }) === undefined, 'reviewer 卡的闸', mapOnlyGuard ? { write: mapOnlyGuard({ name: 'write' }), read: mapOnlyGuard({ name: 'read' }) } : '(没有补闸)');

  // 成员寻址（新格式 label）：name / 卡 id / 卡中文名 三条路都要能定位
  host.record.children = [{ kind: 'child', id: 'child-9', activity: 'ready', hasChildren: false, mode: 'continuable', label: '工作区评审员:bob2' }];
  const sendNewFmt = await defs.get('role_send').execute({ target: 'bob2', message: '新格式寻址' }, exec);
  assert('新格式 label 的成员按 name 寻址', sendNewFmt.ok === true && sendNewFmt.childId === 'child-9', 'child-9', sendNewFmt.ok ? sendNewFmt.childId : sendNewFmt.error);
  const sendByCardName = await defs.get('role_send').execute({ target: '工作区评审员', message: '按卡中文名寻址' }, exec);
  assert('按卡中文名寻址（新兜底）', sendByCardName.ok === true && sendByCardName.childId === 'child-9', 'child-9', sendByCardName.ok ? sendByCardName.childId : sendByCardName.error);
  const sendByCardId = await defs.get('role_send').execute({ target: 'reviewer', message: '按卡 id 寻址' }, exec);
  assert('按卡 id 寻址（旧 roleId 兜底的等价物）', sendByCardId.ok === true && sendByCardId.childId === 'child-9', 'child-9', sendByCardId.ok ? sendByCardId.childId : sendByCardId.error);
  host.record.children = [{ kind: 'child', id: 'child-9', activity: 'ready', hasChildren: false, mode: 'continuable', label: '同事:张三' }];
  const sendForeignName = await defs.get('role_send').execute({ target: '张三', message: '不该认出' }, exec);
  assert('反例：自由文本 label 的成员不进成员寻址', sendForeignName.ok === false, false, sendForeignName.ok ? sendForeignName.childId : sendForeignName.error);
  host.record.children = null;

  // ── ⑦ 纯函数：normalize / serialize ────────────────────────────────────────
  console.log('[7] normalizeTools / normalizeModel / serializeCard');
  eq('normalizeTools array shorthand -> allow', normalizeTools(['read', 'grep'], []), { allow: ['read', 'grep'], deny: [], warnings: [] });
  eq('normalizeTools object', normalizeTools({ allow: ['read'], deny: ['write'] }, []), { allow: ['read'], deny: ['write'], warnings: [] });
  eq('normalizeModel scalar', normalizeModel('deepseek-chat', []), { model: 'deepseek-chat' });
  eq('normalizeModel map keeps known keys', normalizeModel({ provider: 'deepseek', model: 'x', bogus: 1 }, []), { provider: 'deepseek', model: 'x' });
  const serialized = serializeCard({ id: 'round-trip', name: 'round-trip', persona: '正文。', model: { model: 'deepseek-chat' }, tools: { allow: ['read'], deny: ['write'] } });
  const serializedBack = parseCard(serialized, 'round-trip.md');
  assert('serializeCard -> parseCard round-trip', serializedBack.ok === true, true, serializedBack.ok ? true : serializedBack.reason);
  if (serializedBack.ok) {
    eq('serialize round-trip tools', serializedBack.card.tools, { allow: ['read'], deny: ['write'] });
    eq('serialize round-trip model', serializedBack.card.model, { model: 'deepseek-chat' });
    eq('serialize round-trip body', serializedBack.card.body, '正文。');
  }
}

try {
  await main();
} catch (error) {
  failures.push('unhandled error');
  console.log('  FAIL unhandled error in verify script');
  console.log(`       expected: no throw`);
  console.log(`       actual:   ${error && error.stack ? error.stack : String(error)}`);
} finally {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME;
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
}

const total = pass + failures.length;
if (failures.length === 0) {
  console.log(`PASS ${pass}/${total}`);
  process.exit(0);
} else {
  console.log('FAIL');
  for (const label of failures) console.log(`  - ${label}`);
  console.log(`FAIL ${failures.length}/${total} assertion(s)`);
  process.exit(1);
}
