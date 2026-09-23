#!/usr/bin/env node
// scripts/verify-agent-roles.mjs — dshome/agent-roles 的真断言自测（W1）。
//
// 做什么：用**临时目录**造角色卡与宿主，覆盖规格「验收」里的 9 类反例：
//   ① 工作区覆盖私密 ② 缺 id ③ 坏 frontmatter ④ 未知 role ⑤ 卡里 allow/deny 含不可解析名（响亮失败）
//   ⑥ 固定级联 deny 按可见性过滤 ⑦ role_* 不进 filter ⑧ `_` 前缀跳过 ⑨ maxDepth 传 1
// 外加：frontmatter 子集解析（注释/空行/内联列表/嵌套 map/CRLF）、正文为空、无 frontmatter、
//   persona 组装、`role:<id>:<name>` label、以及**挂载面 + 三把工具真跑**（mock host，临时 DSH_HOME）。
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
  describeToolTarget,
  discoverCards,
  MEMBER_MAX_DEPTH,
  normalizeModel,
  normalizeTools,
  parseCard,
  parseRoleLabel,
  PERSONA_TAIL,
  PRIVATE_CARD_SEGMENTS,
  renderPolicyText,
  reportHint,
  ROLE_TOOL_NAMES,
  selectCard,
  serializeCard,
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
  const ctx = {
    logger: () => ({ info: () => {}, warn: (message) => record.warns.push(String(message)) }),
    on: (ev, handler) => { record.handlers.push({ ev, handler }); return () => {}; },
    effect: (factory) => { record.effectDispose = factory(); return () => {}; },
    tools: {
      view: () => ({ visible: new Map(), restrictableNames: new Set(VISIBLE) }),
      schemas: () => [],
      register: () => () => {},
      get: () => undefined,
    },
    agents: { list: () => [topAgent, childAgent, guardChildAgent, resumeChildAgent] },
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

  const nofm = parseCard('没有 frontmatter', 'nofm.md');
  assert('missing frontmatter -> ok:false', nofm.ok === false, false, nofm.ok);
  assert('missing frontmatter reason names frontmatter', nofm.ok === false && /frontmatter/.test(nofm.reason), 'reason mentions "frontmatter"', nofm.ok ? '(parsed)' : nofm.reason);

  // ── ② discoverCards：覆盖 / 缺 id / 坏卡 / `_` 跳过 ────────────────────────
  console.log('[2] discoverCards — 工作区覆盖私密、缺 id、坏 frontmatter、`_` 前缀');
  const discovery = discoverCards({ privateDir: PRIVATE_DIR, workspaceDir: WORKSPACE_DIR });
  const ids = discovery.cards.map((card) => card.id);
  eq('discovered card ids (sorted; _template.md skipped, notes.txt ignored)', ids, ['bad-tools', 'reviewer', 'writer']);

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
  assert('unknown role lists available ids', ghost.ok === false && ['bad-tools', 'reviewer', 'writer'].every((id) => ghost.ids.includes(id)), ['bad-tools', 'reviewer', 'writer'], ghost.ok ? [] : ghost.ids);
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

  eq('parseRoleLabel splits role and name', parseRoleLabel('role:reviewer:alice'), { roleId: 'reviewer', name: 'alice' });
  eq('parseRoleLabel rejects foreign labels', parseRoleLabel('teammate:alice'), null);

  const fakeParent = { id: 'lead-session' };
  const spec = buildStartSpec({ parent: fakeParent, card: picked.ok ? picked.card : { id: 'writer', body: '你是写手。' }, name: 'alice', task: '看这个 diff' });
  eq('start spec provider', spec.provider, 'spawn');
  eq('start spec label', spec.label, 'role:writer:alice');
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

  // ── ⑥ 挂载面 + 三把工具真跑（临时 DSH_HOME / mock host） ───────────────────
  console.log('[6] apply — 顶层 scope 安装 + 三把工具真跑（mock host）');
  process.env.DSH_HOME = TMP_HOME;
  const host = makeHost();
  apply(host.ctx);
  const defs = new Map(host.record.registered.map((definition) => [definition.name, definition]));

  eq('exactly three tools registered', host.record.registered.map((definition) => definition.name), ['role_list', 'role_spawn', 'role_send']);
  eq('one policy section registered', host.record.sections.map((section) => section.name), ['agent-roles:policy']);
  eq('policy section order name', host.record.sectionOrderName, 'TEAM_POLICY');
  eq('policy section sits at TEAM_POLICY order', host.record.sections[0] && host.record.sections[0].order, 600);
  assert('policy text names all three tools', ROLE_TOOL_NAMES.every((toolName) => host.record.sections[0].text().includes(toolName)), 'policy text mentions role_list/role_spawn/role_send', host.record.sections[0].text().slice(0, 120));
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
  eq('role_list roles', (listValue.roles || []).map((row) => row.id), ['bad-tools', 'reviewer', 'writer']);
  eq('role_list reviewer source', (listValue.roles || []).find((row) => row.id === 'reviewer').source, 'workspace');
  eq('role_list reviewer model', (listValue.roles || []).find((row) => row.id === 'reviewer').model, 'deepseek-chat');
  eq('role_list reviewer tools.allow', (listValue.roles || []).find((row) => row.id === 'reviewer').tools.allow, ['read']);
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
  eq('role_spawn label', spawnWriter.label, 'role:writer:writer');
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
    assert('audit file records the member label', auditText.includes('role:writer:'), 'label prefix present', auditText.slice(-200));
  }
  assert('reviewer spawn also reports guardInstalled (idempotent on the same mock child)', spawnReviewer.guardInstalled === true, true, spawnReviewer.guardInstalled);

  // ⑥'' 挂起补装路：childId 还不在注册表 ⇒ 记 pending；`agent/created` 一到就补装（无竞态）
  host.record.nextChildId = 'ghost-child';
  const spawnGhost = await defs.get('role_spawn').execute({ persona: '你是幽灵探针，只回报工具面。', name: 'ghost-one' }, exec);
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
  const spawnInlineAgain = await defs.get('role_spawn').execute({ persona: '你是临时工。', name: 'temp-one', save: true }, exec);
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
