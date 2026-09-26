#!/usr/bin/env node
// scripts/verify-mind-panel-labels.mjs — 心智面板「卡名可区分性」门禁
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// 2026-09-26 主人反馈：「记忆面板中卡片的名字辨识度太低」。取证结论＝**同层多张卡同名**：
// 活进程 `/api/mind/graph` 实测 **292 节点里 237 个（81%）落在重名组**（49 组）——L3 记忆 4 张
// 全叫「方法论」、项目记忆 5 张全叫「dshome-mind」4 张全叫「外部参考」、TRASH 213 节点里 185
// 重名（快照沿用原文标题）。根因＝`buildGraph()` 的卡名取自**正文标题/主题目录名**，而
// 「同一主题的多篇记忆」与「同一文档的多次快照」这两类文件天然会撞名。
// 修法（同日）＝L3 记忆与 TRASH 改取**文件名**（作者自起的一句话标题）+ 撞名兜底追加目录/区名。
//
// ── 判据（每条都钉"具体值"，不只钉"数量为 0"）──────────────────────────────
// 只判"重名组 = 0"是**假绿面**：兜底去重能把任何撞名糊成不同名字，判据照样绿。故本门禁改钉：
// 1. 模块**真导出** `buildGraph` / `fileNameStem`（导不出＝输入缺失，响亮失败）。
// 2. `fileNameStem`：活档擦 `YYYY-MM-DD_` 前缀；TRASH 快照保留整条 basename。
// 3. 夹具 **L3 记忆 / 项目记忆 / TRASH 的卡名 == 文件名规则算出的值**（等值断言 ⇒ 改回
//    "正文标题/主题目录名"的旧规则时数值立刻不符，必红）。
// 4. 夹具 **L0/L1/L2/角色卡 == 原 frontmatter name**（改动不得波及不重名的层）。
// 5. 夹具 + **真实仓库树**：重名卡组数为 0（活数据回归）。
// 6. 真树：搜索面仍以 `rel` 带主题目录（不能为改卡名把主题分组吃掉）。
// 7. 面板客户端：`filterSnapshotLayer` 有导出 + 「隐藏快照」开关四处接线齐全、**默认关**（只断接线，不假装验过渲染）。
//
// ── 反证（**应当变红**）────────────────────────────────────────────────────
// 内建 `--self-test`（**迭代式**）：驱动器把被测模块复制进临时夹具，再 spawn **副本门禁自己**
// （`--expect-mutant`）⇒ 副本读变异计划、把变异行插进自己那棵树的 `fileNameStem` 后正常跑判据。
// 要求 **退出 1 且失败断言名恰好命中预期**（"随便红了就行"不算，`status` 与 `FAIL 行`同判）：
//   M1 活档卡名不擦日期（还原"文件名裸用"）      ⇒ 「夹具：L3 记忆卡名 == 文件名（非主题名）」变红
//   M2 卡名恒等主题目录名（还原 L3 旧规则）        ⇒ 「夹具：L3 记忆卡名 == 文件名（非主题名）」变红
//   M3 卡名恒等正文标题（旧规则的正文半边）        ⇒ 「夹具：重名组 = 0」变红
// 反证与判据共用同一段代码、单一来源 ⇒ 不存在"另一份会过期的断言表"。真仓库零触碰。
// 跑法：`node scripts/verify-mind-panel-labels.mjs --self-test`
//
// 用法：无参＝只跑判据（全绿 `PASS n/n` 退出 0 / 否则 FAIL 退出 1）；`--self-test`＝判据 + 反证。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 仓库根＝DSH_HOME 优先；否则从本文件位置推。⚠️ 自测时本文件被复制到临时夹具里跑（夹具没有
// `scripts/mind-search-lib.cjs`）⇒ **不能只用 `resolve(here,'..')`**：那会把 repoRoot 指到系统的
// %TEMP% 根上（实测症状＝子进程找不到变异计划而崩）。故按"哪棵树真的有 scripts/ 就认哪棵"判定。
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_MARKER = path.join('scripts', 'mind-search-lib.cjs');
let repoRoot = process.env.DSH_HOME || path.resolve(here, '..');
if (!fs.existsSync(path.join(repoRoot, ROOT_MARKER)) && fs.existsSync(path.join(here, ROOT_MARKER))) repoRoot = here;
const entryRel = path.join('packages', 'dshome-mind', 'lib', 'index.cjs');
const selfTest = process.argv.includes('--self-test');

let pass = 0;
const failures = [];
function assert(label, condition, expected, actual) {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL ${label}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
  console.log(`       actual:   ${JSON.stringify(actual)}`);
}
/** 重名读数：[{label, count, where[]}]，按 count 降序。 */
function dupLabels(graph) {
  const groups = new Map();
  for (const n of graph.nodes) {
    if (!groups.has(n.label)) groups.set(n.label, []);
    groups.get(n.label).push(`${n.zone}:${n.rel}`);
  }
  return [...groups.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([label, v]) => ({ label, count: v.length, where: v }))
    .sort((a, b) => b.count - a.count);
}
/** 临时根下挂 node_modules：只为让副本里的 `croner` 能解析（不复制依赖树）。 */
function linkNodeModules(root) {
  const target = path.join(root, 'node_modules');
  if (fs.existsSync(target)) return;
  const sources = [path.join(repoRoot, 'node_modules'), path.resolve(here, '..', 'node_modules')];
  const src = sources.find((p) => fs.existsSync(path.join(p, 'croner'))) || sources[0];
  try {
    fs.symlinkSync(src, target, 'junction');
  } catch {
    // junction 不可用（权限/跨卷）⇒ 退化为只搬被测模块真正 require 的那一个包
    try { fs.cpSync(path.join(src, 'croner'), path.join(target, 'croner'), { recursive: true }); }
    catch { /* 由被测模块自己响亮失败，不静默 */ }
  }
}
/** 只读载入被测模块（DSH_HOME 决定它读哪棵树）。root 参数化 ⇒ 反证可指向临时副本。
 *  ⚠️ 必须**用完还原 `process.env.DSH_HOME`**：本门禁开局就用它算 `repoRoot`，而它会被本函数改掉
 *  （实测 2026-09-26：不还原时反证子进程的 `repoRoot` 变成父进程的夹具目录 ⇒ 找不到变异计划而崩）。 */
function loadEntry(root) {
  const prevHome = process.env.DSH_HOME;
  const prevRoot = repoRoot;
  process.env.DSH_HOME = root;
  repoRoot = root; // 夹具/副本树：后续 makeFixture / 变异计划都按它解析
  try {
    const req = createRequire(import.meta.url);
    const modPath = req.resolve(path.join(root, entryRel));
    delete req.cache[modPath]; // 两棵树要用同一份模块重跑：清 CJS 缓存（require.cache 是进程级单例）
    return req(modPath);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    repoRoot = prevRoot;
  }
}
/** 找 `mind-search-lib.cjs` 真源：自测时本门禁从**临时根**运行（那里没有 scripts/）⇒ 退回本文件旁那一份。 */
function pickScriptsSource() {
  const candidates = [path.join(repoRoot, 'scripts', 'mind-search-lib.cjs'), path.join(here, 'mind-search-lib.cjs')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`找不到 mind-search-lib.cjs（找过：${candidates.join(' / ')}）`);
}
/** 找被测模块所在的 `lib` 真源（同样为自测从临时根运行兜底）。 */
function pickLibSource() {
  const candidates = [path.join(repoRoot, 'packages', 'dshome-mind', 'lib'), path.resolve(here, '..', 'packages', 'dshome-mind', 'lib')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`找不到 dshome-mind/lib（找过：${candidates.join(' / ')}）`);
}
/** 造夹具：返回临时 DSH_HOME（调用方负责删）。被测模块也要在夹具里——否则它读的还是真仓库。 */
function makeFixture(root) {
  // ⚠️ 只搬被测模块真正需要的两样：`index.cjs` 顶层会 require `<DSH_HOME>/scripts/mind-search-lib.cjs`
  // （它只依赖 node 内建）。**不要整目录 cpSync `scripts/`**——那个目录里随时有别的进程写的
  // `*.tmpdir`（实测 2026-09-26：`.role-card-audit.mjs.<pid>.<uuid>.tmpdir` 被占用 ⇒ EPIPE 假红）。
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(pickScriptsSource(), path.join(root, 'scripts', 'mind-search-lib.cjs'));
  fs.mkdirSync(path.join(root, 'packages', 'dshome-mind'), { recursive: true });
  fs.cpSync(pickLibSource(), path.join(root, 'packages', 'dshome-mind', 'lib'), { recursive: true });
  linkNodeModules(root);
  return root;
}
/** 落夹具的业务文件（同主题两篇 / 项目记忆两篇 / TRASH 两次快照 / 跨区同 rel / 角色卡 / L1）。 */
function addFixtureFiles(root) {
  const w = (rel, text) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  };
  // ① 同主题两篇（旧规则下都叫「某主题」——正是主人看到的「方法论 x4」形态）
  w('mind-private/L3/common/某主题/2026-09-01_甲篇_判别依据.md', '---\ntopic: 某主题\n---\n# 甲篇：正文标题\n');
  w('mind-private/L3/common/某主题/2026-09-02_乙篇_反例设计.md', '---\ntopic: 某主题\n---\n# 乙篇：正文标题\n');
  // ② 项目记忆两篇（旧规则下都叫「外部参考」）
  w('mind-private/L3/projects/某项目/知识/外部参考/2026-09-03_丙篇_第三方审计.md', '# 丙篇\n');
  w('mind-private/L3/projects/某项目/知识/外部参考/2026-09-04_丁篇_退役记录.md', '# 丁篇\n');
  // ③ TRASH：同一份文档的两次快照（正文标题相同 ⇒ 旧规则下 100% 撞名）
  w('mind-private/TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md', '---\nname: Learn.md — 痕迹库\n---\n');
  w('mind-private/TRASH/2026-09-11T10-00-00__2026-09-05T08-00-00_Learn.md', '---\nname: Learn.md — 痕迹库\n---\n');
  // ④ 跨区同 rel（出厂 + 私有各一份，正是本机 L1/Learn.md、L1/Dream.md 的形态；区后缀必须生效）
  w('mind/L3/common/某主题/2026-09-06_戊篇_出厂版.md', '---\nname: 同 rel 出厂档\n---\n');
  w('mind-private/L3/common/某主题/2026-09-06_戊篇_出厂版.md', '---\nname: 同 rel 出厂档\n---\n');
  // ⑤ 角色卡与 L1：frontmatter name 必须原样保留（改动不许波及它们）
  w('mind-private/L2/agents/card-a.md', '---\nid: card-a\nname: 记忆整理员\ntools:\n  allow: [read]\n---\n正文\n');
  w('mind-private/L1/某规则.md', '---\nname: 某规则 — 自带名\n---\n');
}

console.log('[verify-mind-panel-labels] 面板卡名可区分性');

// 面板客户端（`packages/dshome-mind/lib/client.js`）：它不在 DSH_HOME 下（web 半区由 profile 装配），
// 故按**本文件位置**定位；副本里跑时按 `here` 兜底。用于断言「隐藏快照」开关真的接着（§ 判据 5 的延伸）。
function pickClientPath() {
  const c = [path.join(repoRoot, 'packages', 'dshome-mind', 'lib', 'client.js'), path.resolve(here, '..', 'packages', 'dshome-mind', 'lib', 'client.js')];
  return c.find((p) => fs.existsSync(p)) || null;
}

// 反证钩子（迭代式自测用）：`--expect-mutant` 时读 `tests/self-test-mutation.json`，把变异行**插进
// 被测模块副本的 `fileNameStem` 函数体**（必须插在 `return` 之前，行为才真的变）。变异只落在临时副本，
// 真仓库由驱动器保证零触碰。
const SELF_TEST_PLAN = path.join(repoRoot, 'tests', 'self-test-mutation.json');
// 变异锚点＝`fileNameStem` 里那条**活档** return。插入点必须让变异**在 return 之前**执行才有行为；
// （实测 2026-09-26：把变异行插在文件末尾是**死代码**——子进程照样全绿，"变异"成了摆设。）
const MUTANT_ANCHOR = /return base\.replace\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}_\/, ''\);/;
if (process.argv.includes('--expect-mutant')) {
  const plan = JSON.parse(fs.readFileSync(SELF_TEST_PLAN, 'utf8'));
  const src = fs.readFileSync(path.join(repoRoot, entryRel), 'utf8');
  if (!MUTANT_ANCHOR.test(src)) throw new Error(`反证锚点不存在（改坏了 fileNameStem？）：${MUTANT_ANCHOR}`);
  const replaced = src.replace(MUTANT_ANCHOR, `${plan.mutantLine}\n  return base;`);
  fs.writeFileSync(path.join(repoRoot, entryRel), replaced, 'utf8');
  console.log(`  [self-test] 变异已注入：${plan.name}（子进程自证：必须红在「${plan.expectFail}」）`);
}

// ── 夹具（临时 DSH_HOME，真仓库零触碰）─────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-label-gate-'));
try {
  makeFixture(tmp);
  addFixtureFiles(tmp);
  const mod = loadEntry(tmp);
  assert('模块导出 buildGraph（导不出＝门禁无从判，响亮失败）', typeof mod.buildGraph === 'function', 'function', typeof mod.buildGraph);
  assert('模块导出 fileNameStem', typeof mod.fileNameStem === 'function', 'function', typeof mod.fileNameStem);

  if (typeof mod.fileNameStem === 'function') {
    assert('活档卡名擦掉日期前缀', mod.fileNameStem('L3/common/某主题/2026-09-01_甲篇_判别依据.md') === '甲篇_判别依据',
      '甲篇_判别依据', mod.fileNameStem('L3/common/某主题/2026-09-01_甲篇_判别依据.md'));
    assert('TRASH 卡名保留整条快照名（快照靠它区分）',
      mod.fileNameStem('TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md') === '2026-09-10T10-00-00__2026-09-05T08-00-00_Learn',
      '整条 basename', mod.fileNameStem('TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md'));
  }

  if (typeof mod.buildGraph === 'function') {
    const g = mod.buildGraph('');
    const one = (rel) => g.nodes.filter((n) => n.rel === rel);
    const labelOf = (rel) => { const l = one(rel); return l.length === 1 ? l[0].label : l.map((n) => `${n.zone}:${n.label}`); };
    assert('夹具：重名组 = 0（含 TRASH 与跨区同 rel）', dupLabels(g).length === 0, '[]',
      dupLabels(g).map((d) => `${d.label} x${d.count}`));
    // 等值断言（关键）：卡名必须**恰好等于**文件名规则算出的值——"兜底把撞名糊开"过不了这一关
    assert('夹具：L3 记忆卡名 == 文件名（非主题名）', labelOf('L3/common/某主题/2026-09-01_甲篇_判别依据.md') === '甲篇_判别依据',
      '甲篇_判别依据', labelOf('L3/common/某主题/2026-09-01_甲篇_判别依据.md'));
    assert('夹具：L3 记忆第二篇同规则', labelOf('L3/common/某主题/2026-09-02_乙篇_反例设计.md') === '乙篇_反例设计',
      '乙篇_反例设计', labelOf('L3/common/某主题/2026-09-02_乙篇_反例设计.md'));
    assert('夹具：项目记忆卡名 == 文件名（非主题目录名）', labelOf('L3/projects/某项目/知识/外部参考/2026-09-03_丙篇_第三方审计.md') === '丙篇_第三方审计',
      '丙篇_第三方审计', labelOf('L3/projects/某项目/知识/外部参考/2026-09-03_丙篇_第三方审计.md'));
    assert('夹具：TRASH 卡名 == 快照文件名', labelOf('TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md') === '2026-09-10T10-00-00__2026-09-05T08-00-00_Learn',
      '2026-09-10T10-00-00__2026-09-05T08-00-00_Learn', labelOf('TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md'));
    assert('夹具：L1 卡名 == frontmatter name（不波及自带名的层）', labelOf('L1/某规则.md') === '某规则 — 自带名',
      '某规则 — 自带名', labelOf('L1/某规则.md'));
    const cards = g.nodes.filter((n) => n.rel.startsWith('L2/agents/'));
    assert('夹具：角色卡沿用 frontmatter name', cards.length === 1 && cards[0].label === '记忆整理员', '记忆整理员', cards.map((n) => n.label));
    const sameRel = one('L3/common/某主题/2026-09-06_戊篇_出厂版.md');
    assert('夹具：跨区同 rel 两张卡各自可区分（区后缀生效）',
      sameRel.length === 2 && new Set(sameRel.map((n) => n.label)).size === 2,
      '2 张卡 2 个不同卡名', sameRel.map((n) => `${n.zone}:${n.label}`));
    assert('夹具：搜索面仍带主题目录（rel 未被子名规则吃掉）',
      g.nodes.some((n) => n.rel.includes('L3/common/某主题/')), true, g.nodes.map((n) => n.rel).slice(0, 3));
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
}

// ── 真实仓库树（只读；活数据回归读数）──────────────────────────────────────
{
  const real = loadEntry(repoRoot);
  if (typeof real.buildGraph === 'function') {
    const g = real.buildGraph('');
    const dups = dupLabels(g);
    const byLayer = {};
    for (const n of g.nodes) byLayer[n.layer] = (byLayer[n.layer] || 0) + 1;
    console.log(`  [info] 真树读数：${g.nodes.length} 节点 / ${g.edges.length} 边；分层 ${JSON.stringify(byLayer)}`);
    console.log(`  [info] 真树重名组：${dups.length}（修复前实测 49 组 / 237 节点）`);
    assert('真树：重名卡组数为 0（活数据回归——改回旧规则这里立刻变红）', dups.length === 0, '0 组',
      dups.slice(0, 8).map((d) => `${d.label} x${d.count}: ${d.where.slice(0, 3).join(' | ')}`));
    // 兜底后缀只在"真撞名"时才该出现：本机实测 29 张（L3 历史 2 + 项目档 2 + `.agent-snapshot`
    // 重名快照 25），全是**文件名确实重名**的合法兜底。**上限 40** 留余量：规则一旦退化回
    // "正文标题/主题名"，后缀会成百上千地冒出来（旧规则实测 237 节点重名）⇒ 这里必红。
    const suffixed = g.nodes.filter((n) => (n.layer === 'L3I' || n.layer === 'L3P' || n.layer === 'L3H' || n.layer === 'TR')
      && n.label.includes(' · '));
    assert('真树：L3/TRASH 的兜底后缀卡数 ≤ 40（本机基线 29；规则退化时会成百上千地冒出来）', suffixed.length <= 40, '≤ 40 张',
      { count: suffixed.length, sample: suffixed.slice(0, 3).map((n) => n.label) });
  }
}

// ── 面板客户端（`packages/dshome-mind/lib/client.js`）：仅保留一条**通用**体检 ────────
// 病史：2026-09-26 曾加过「隐藏快照」开关（按钮 + filterSnapshotLayer + 工具栏重排），主人实测
// 仍会"丢渲染" ⇒ **整条撤掉**（本条注释只作留痕，别再照抄那套结构）。余下只查一件事：
// 客户端文件还在、且导出面没被改坏（find 得到 `module.exports`，别把插件体改没了）。
{
  const clientPath = pickClientPath();
  assert('能找到面板客户端 client.js（找不到＝输入缺失，响亮失败）', !!clientPath, '存在', clientPath);
  if (clientPath) {
    const src = fs.readFileSync(clientPath, 'utf8');
    assert('client.js 仍是合法插件体（导出 name/inject/apply）', /module\.exports = \{ name: "dshome-mind", inject, apply \}/.test(src), '导出面完整', '导出面被改坏');
  }
}

console.log(failures.length === 0 ? `PASS ${pass}/${pass}` : `FAIL ${failures.length}/${pass + failures.length} assertion(s)`);

// ── 反证（机器化 · 迭代式）：变异只落临时副本 ⇒ 让**副本门禁自己**跑一遍 ──────────
// 驱动器：① 把被测模块整份复制到临时夹具（`makeFixture`）；② 写变异计划；③ spawn 副本脚本并带
// `--expect-mutant`（副本读计划、把变异行插进自己那棵树的 `fileNameStem`）；④ 要求退出 1 且
// 失败断言恰好是计划里的那条。真实仓库零触碰（只在副本里动）。
if (selfTest) {
  console.log('\n[self-test] 反证：副本注入变异 ⇒ 门禁必须红在预期断言上');
  const MUTANTS = [
    { name: 'M1 活档卡名不再擦日期（还原"文件名裸用"）',
      mutantLine: '  return base;', expectFail: '夹具：L3 记忆卡名 == 文件名（非主题名）' },
    { name: 'M2 卡名恒等主题目录名（还原 L3 旧规则）',
      mutantLine: "  if (String(rel || '').split('/')[0] === 'L3' || String(rel || '').startsWith('TRASH/')) return '主题名回潮';",
      expectFail: '夹具：L3 记忆卡名 == 文件名（非主题名）' },
    { name: 'M3 卡名恒等正文标题（旧规则的正文半边）',
      mutantLine: "  return '正文标题回潮';", expectFail: '夹具：重名组 = 0' },
  ];
  for (const m of MUTANTS) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-label-mut-'));
    try {
      makeFixture(sandbox); // 只复制被测模块 + 搜依赖（不复制门禁自己 ⇒ 无自引用陷阱）
      fs.mkdirSync(path.join(sandbox, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(sandbox, 'tests', 'self-test-mutation.json'), JSON.stringify(m, null, 2), 'utf8');
      const gateInSandbox = path.join(sandbox, 'gate.mjs');
      fs.copyFileSync(fileURLToPath(import.meta.url), gateInSandbox);
      const env = { ...process.env };
      delete env.DSH_HOME; // 父进程把 DSH_HOME 指向夹具了；子进程必须自己按路径推断
      const r = spawnSync(process.execPath, [gateInSandbox, '--expect-mutant'], { encoding: 'utf8', env });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert(`反证「${m.name}」：副本门禁退出 1 且红在「${m.expectFail}」`,
        r.status === 1 && out.includes(`FAIL ${m.expectFail}`),
        '退出 1 且命中预期 FAIL 行', { status: r.status, tail: out.trim().split('\n').slice(-3) });
    } finally {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  console.log(failures.length === 0 ? `SELF-TEST PASS ${pass}/${pass}` : `SELF-TEST FAIL ${failures.length}/${pass + failures.length}`);
}

process.exit(failures.length === 0 ? 0 : 1);
