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
// 3. 夹具 **L3 记忆 / 项目记忆 / TRASH 真回收件的卡名 == 文件名规则算出的值**（等值断言 ⇒ 改回
//    "正文标题/主题目录名"的旧规则时数值立刻不符，必红）。
// 3b. 图层面口径随产品语义（2026-09-27）更新：`TRASH/` 下 basename 带 `__` 归档戳的快照副本**不进
//    图谱**（`buildGraph()` 过滤链新增一行，与 `tasks/evolution/snapshots/` 同族；实测 320→91 节点）。
//    ⇒ 夹具里那两个快照文件改为断言「图谱里取不到节点」，并**另加一个非快照 TRASH 回收件**断言
//    「仍在图 且 卡名 == 整条 basename」——原「TRASH 卡名规则」的覆盖不因语义改动而丢。
// 3c. 归档戳的**同义形态**（2026-09-28 加）：文件级 `TRASH/<戳>__<原名>.md` 与目录级
//    `TRASH/<戳>__<目录名>/…` 用的是同一套归档命名法（戳落在 basename 还是目录段而已）——旧判据
//    只看 basename ⇒ 目录级副本整棵进图（2026-09-28 真树实测：14 个 basename 干净的副本混在 TRASH 层，
//    并造出 4 组「活档 ↔ 目录级副本」重名组）。⇒ 夹具专造这一对「目录级戳目录里的文件 + 同名活档」，
//    断言**副本不进图 / 活档仍在图 / 重名组为 0**；旧判据下这一臂必红（`--self-test` 的 M4 机器化之）。
//    ⚠️ 与 3b 合起来钉住"只排副本、不排整层"：目录级戳排掉、无戳真回收件照常进图，两边都不许松。
// 4. 夹具 **L0/L1/L2/角色卡 == 原 frontmatter name**（改动不得波及不重名的层）。
// 5. 夹具 + **真实仓库树**：重名卡组数为 0（活数据回归）。
// 6. 真树：搜索面仍以 `rel` 带主题目录（不能为改卡名把主题分组吃掉）。
// 7. 面板客户端：`filterSnapshotLayer` 有导出 + 「隐藏快照」开关四处接线齐全、**默认关**（只断接线，不假装验过渲染）。
//
// ── 反证（**应当变红**）────────────────────────────────────────────────────
// 内建 `--self-test`（**迭代式**）：驱动器把被测模块复制进临时夹具，再 spawn **副本门禁自己**
// （`--expect-mutant`）⇒ 副本读变异计划、把变异行插进自己那棵树的被测模块后正常跑判据。变异锚点两类：
// `fileNameStem` 里的活档 return（M1~M3）、TRASH 过滤行本身（M4，计划里用 `anchor: 'filter'` 指定）。
// 要求 **退出 1 且失败断言名恰好命中预期**（"随便红了就行"不算，`status` 与 `FAIL 行`同判）：
//   M1 活档卡名不擦日期（还原"文件名裸用"）      ⇒ 「夹具：L3 记忆卡名 == 文件名（非主题名）」变红
//   M2 卡名恒等主题目录名（还原 L3 旧规则）        ⇒ 「夹具：L3 记忆卡名 == 文件名（非主题名）」变红
//   M3 卡名恒等正文标题（旧规则的正文半边）        ⇒ 「夹具：重名组 = 0」变红
//   M4 TRASH 过滤只看 basename（还原目录级副本漏网）⇒ 「夹具：TRASH 目录级归档戳目录里的文件不进图」变红
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
  // ③ TRASH：同一份文档的两次快照（正文标题相同 ⇒ 旧规则下 100% 撞名）。
  //    ⚠️ 产品语义 2026-09-27：这两张（basename 带 `__` 归档戳）**不再进图谱** ⇒ 下文图层面断言
  //    改为「图上取不到节点」。保留它们是为了让"过滤真的生效"这条判据有夹具可判。
  w('mind-private/TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md', '---\nname: Learn.md — 痕迹库\n---\n');
  w('mind-private/TRASH/2026-09-11T10-00-00__2026-09-05T08-00-00_Learn.md', '---\nname: Learn.md — 痕迹库\n---\n');
  // ③b TRASH 下的**真回收件**（basename 不含 `__`）：只排副本、不排整层 ⇒ 它必须照旧进图。
  //     正文标题故意与文件名不同 ⇒ 卡名规则一旦退回"正文标题/主题目录名"，下面的等值断言立刻红。
  w('mind-private/TRASH/2026-09-12_退役记录_回收件.md', '# 退役记录：正文标题\n');
  // ③c TRASH **目录级**归档戳（2026-09-28 加，**同义形态**）：`TRASH/<戳>__<归档目录>/…` 里的文件
  //     basename **干干净净**（一个 `__` 都没有）——旧判据只看 `path.basename` ⇒ 整目录副本照旧进图，
  //     与活档撞成重名组（真树形态：`L3/common/<主题>/<文件>` ↔ `TRASH/<戳>__<归档目录>/知识/<主题>/<文件>`，
  //     父目录名与区名都相同 ⇒ 兜底去重贴的 ` · <父目录> · <区名>` 一模一样，**糊不开**）。
  //     ⚠️ 这一对就是把 A（TRASH 过滤改看 rel 任一段）退化成旧判据时**必须变红**的那一臂：夹具臂
  //     「目录级归档戳目录里的文件不进图」+「重名组 = 0」同时红（反证见 `--self-test` 的 M4）。
  w('mind-private/L3/common/某主题/SKILL.md', '---\ntopic: 某主题\n---\n# 活档：正文标题\n');
  w('mind-private/TRASH/2026-09-14T10-00-00__某归档目录/知识/某主题/SKILL.md', '---\ntopic: 某主题\n---\n# 活档：正文标题\n');
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
// 第二类锚点（2026-09-28 加）：**TRASH 过滤行本身**——它不在 `fileNameStem` 里，故计划用 `anchor: 'filter'`
// 显式指定，走的仍是同一套「副本自证」机制（M4 用它把判据还原成"只看 basename"）。锚点写死成被测行原文
// ⇒ 那行被改写时子进程**响亮抛错**（不静默退化成"变异没注入也照样绿"）。
const FILTER_ANCHOR = "if (f.rel.startsWith('TRASH/') && f.rel.split('/').some((s) => s.includes('__'))) return false;";
if (process.argv.includes('--expect-mutant')) {
  const plan = JSON.parse(fs.readFileSync(SELF_TEST_PLAN, 'utf8'));
  const entryPath = path.join(repoRoot, entryRel);
  const src = fs.readFileSync(entryPath, 'utf8');
  let replaced;
  if (plan.anchor === 'filter') {
    if (!src.includes(FILTER_ANCHOR)) throw new Error(`反证锚点不存在（TRASH 过滤行被改写？）：${FILTER_ANCHOR}`);
    replaced = src.replace(FILTER_ANCHOR, plan.mutantLine);
  } else {
    if (!MUTANT_ANCHOR.test(src)) throw new Error(`反证锚点不存在（改坏了 fileNameStem？）：${MUTANT_ANCHOR}`);
    replaced = src.replace(MUTANT_ANCHOR, `${plan.mutantLine}\n  return base;`);
  }
  fs.writeFileSync(entryPath, replaced, 'utf8');
  console.log(`  [self-test] 变异已注入：${plan.name}（子进程自证：必须红在「${plan.expectFail}」）`);
}

// ── 夹具（临时 DSH_HOME，真仓库零触碰）─────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-label-gate-'));
// ⚠️ 夹具期必须把 `DSH_HOME` **钉在夹具根**（2026-09-27 每日自维护修假红）：
//   被测模块的 `repoRoot()` 是**调用期**读 `process.env.DSH_HOME`，而 `loadEntry()` 的 `finally`
//   只保证"加载期"指向夹具、返回时就把 env 还原了 ⇒ 还原后 `buildGraph()` 落到真 `DSH_HOME`
//   （那个根下有 `mind/`）⇒ 夹具断言全空、真仓库的卡混进来（实测：`DSH_HOME=E:\DSHOME` 下跑 =
//   FAIL 8/17；清空 `DSH_HOME` 跑 = PASS 17/17）。env 的作用域＝**整个夹具块**（加载 + 断言都在这段里）。
const fixturePrevHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmp;
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
    // 图层面口径（2026-09-27 产品语义改动）：TRASH 下 basename 带 `__` 归档戳的快照副本**不进图谱**
    // ⇒ 旧断言「TRASH 卡名 == 快照文件名」已过时（快照不在图上，`labelOf` 取到空）。拆成两条：
    //   ① 快照在图上取不到节点（图层面过滤真的生效，而不是"名字恰好变了"）；
    //   ② 非快照的真回收件仍在图、卡名 == 整条 basename（原「TRASH 卡名规则」的覆盖不丢）。
    const snapAbsent = labelOf('TRASH/2026-09-10T10-00-00__2026-09-05T08-00-00_Learn.md');
    assert('夹具：TRASH 归档快照不进图（图谱层面过滤生效）',
      Array.isArray(snapAbsent) && snapAbsent.length === 0, '[]（该路径在图谱里取不到节点）', snapAbsent);
    const keptTrash = one('TRASH/2026-09-12_退役记录_回收件.md').map((n) => n.label);
    assert('夹具：非快照 TRASH 回收件仍在图，卡名 == 整条 basename',
      keptTrash.length === 1 && keptTrash[0] === '2026-09-12_退役记录_回收件',
      '1 张卡且卡名 2026-09-12_退役记录_回收件', keptTrash);
    // ③c TRASH **目录级**归档戳（2026-09-28 加）：归档戳是"文件级 / 目录级"**同义形态**，判据必须看
    // rel 的任一段 —— 只看 basename 时这对夹具立刻红（副本进图 ⇒ labelOf 取到 1 张卡；且与活档撞名）。
    const dirSnap = labelOf('TRASH/2026-09-14T10-00-00__某归档目录/知识/某主题/SKILL.md');
    assert('夹具：TRASH 目录级归档戳目录里的文件不进图（basename 干净也照样排）',
      Array.isArray(dirSnap) && dirSnap.length === 0, '[]（该路径在图谱里取不到节点）', dirSnap);
    assert('夹具：目录级副本对应的活档仍在图、卡名 == 文件名（只排副本，不排活档）',
      labelOf('L3/common/某主题/SKILL.md') === 'SKILL', 'SKILL', labelOf('L3/common/某主题/SKILL.md'));
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
  if (fixturePrevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = fixturePrevHome;
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
    // 2026-09-27 诚实化（Lead 拍板）：原来那条 `assert(suffixed.length <= 40)` 是**恒绿假绿** —— 实测真树
    // 只有 5 张（L3H 2 + L3P 3，全是「文件名本身就重名」的合法兜底），把卡名规则**模拟退化回旧口径**
    // （L3 取主题目录名 / TRASH 取正文标题）后也只到 **28 张**：上限 40 **永远够**，它从建立起就没在真树上
    // 红过（建起时注释写的"本机基线 29"本就在 40 内侧）。保留一条恒绿断言而不标注＝本仓最忌讳的那种假绿
    // ⇒ 降级为 `[info]`（**不删**：读数仍要可见）。
    // ⚠️ 不压上限（真树正常增长会假红）、不改成"与旧规则对照差值"口径（收益小、引入新失效面）。
    // 本不变式（同主题多篇 / 同文档多份不得撞在同一卡名上）的**判别力由夹具 M3（重名组 = 0）承担**。
    const suffixed = g.nodes.filter((n) => (n.layer === 'L3I' || n.layer === 'L3P' || n.layer === 'L3H' || n.layer === 'TR')
      && n.label.includes(' · '));
    console.log(`  [info] 真树 L3/TRASH 兜底后缀卡：${suffixed.length} 张`
      + `（本条恒绿、不具判别力（2026-09-27 实测：真树 5 / 卡名规则退化后 28，上限 40 永远够）；`
      + `该不变式的判别力由夹具 M3（重名组 = 0）承担）`
      + (suffixed.length ? `，样本 ${JSON.stringify(suffixed.slice(0, 3).map((n) => n.label))}` : ''));
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
    // M4（2026-09-28 加）：把 TRASH 过滤判据还原成**只看 basename**、并保留归档戳的旧口径 ⇒ 目录级戳
    // 目录里的副本整棵回到图上，与活档撞名。这正是 A 修掉的那个缺陷，夹具 ③c 就是为它造的。
    { name: 'M4 TRASH 过滤只看 basename（还原目录级副本漏网）', anchor: 'filter',
      mutantLine: "    if (f.rel.startsWith('TRASH/') && path.basename(f.rel).includes('__')) return false;",
      expectFail: '夹具：TRASH 目录级归档戳目录里的文件不进图（basename 干净也照样排）' },
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
