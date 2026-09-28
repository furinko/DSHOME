#!/usr/bin/env node
// scripts/verify-mind-graph-trash-snapshots.mjs — 心智图谱「TRASH 归档快照不出图」门禁
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// 病史（2026-09-26）：主人报「心智面板加载慢」。`buildGraph()` 走 `mind\` + `mind-private\` 全库 `.md`，
// 而 `mind-private\TRASH\` 里堆着**同一份文档的历史快照副本**（文件名带 `__` 归档戳，如
// `2026-09-11T21-34-18__2026-09-05T23-46-59_AGENTS.md`）——它们不是活内容，进图谱只会：
//   ① 造出假节点（同名卡占满 label 去重组，历史版本各占一张卡）；
//   ② 造出假边（快照里的 `related:` 指向活文件 ⇒ 连出来的全是「副本↔活文件」的线）。
// 活进程实测（改动前 `GET /api/mind/graph`）：320 节点 / 131 边，其中 **TRASH 层 232 个（72%）**，
// 响应体 135KB，后端 199~266ms。离线基准（与后端同语义）：320 节点 / 读 4.36MB / 47ms
// ⇒ 排除快照后 **91 节点 / 0.86MB / 10ms**（`mind-private\TRASH\` 234 个 `.md` 里 229 个是这种副本）。
// 过滤链改在 `packages/dshome-mind/lib/index.cjs` 的 `buildGraph()`（与既有 `tasks/evolution/snapshots/`
// 排除同族，同处一个 `.filter()`），本门禁把那条不变式钉住。
//
// ── 判据（全部基于**真加载**后的真读数，不做 grep 文本断言）──────────────────
// ★ 口径（2026-09-27 写死）：**真树读数一律 `[info]`；凡"必须成立"的不变式都由夹具臂承担**（自造输入、
//   环境无关）。**不要再拿真实环境的数据量当判据阈值**——`trash-sweep`/`snap-prune` 一动、主人手动
//   多扔几个回收件，阈值就假红（同族的坑本文件已踩过三次：输入门槛、`≤ 6`、`trashKept >= 1`）。
// A 臂（当前工作区 lib）：
//   1. 模块真导出 `buildGraph`（导不出＝输入缺失，响亮 FAIL）；节点数 > 0（0＝响亮 FAIL，不许静默绿）。
//   2. 图上**没有任何** `TRASH/…` 且 basename 含 `__` 的节点（快照副本已出图）。
//   3. **节点总数 == 本门禁独立 walk 磁盘算出的期望值**（2026-09-27 补强：替换原来的宽区间 [82,100]）。
//      期望 = 磁盘内容 .md − `tasks/evolution/snapshots/` − `TRASH/` 下 basename 含 `__` 的副本，由本脚本
//      **自己那套 walk + 排除规则**算出（不 require 被测模块的任何内部函数）⇒ 判据是「两份独立实现
//      交叉验证」而非自证：被测 lib 的过滤链过排（连带整层）/少排（漏嵌套）/漏加都精确变红。
//      ⚠️ 期望值另配一条前置断言：两次独立 walk 读数必须一致（树若在门禁跑动期间被别的进程改动，
//      期望值不可信 ⇒ 响亮 FAIL，不拿"可能过期"的数字判被测实现）。
//   4. 既有两条排除语义未破：`tasks/evolution/snapshots/` 节点数 == 0；切项目（`buildGraph('某项目')`）
//      仍只留当前项目记忆（L3/projects 节点 == 0、底座 L0 仍在）。
//   5. **夹具臂**（2026-09-27 加，**不依赖真树样本**）：临时 `DSH_HOME` 夹具里自造 2 个 `__` 快照 +
//      1 个非快照回收件 ⇒ 断言快照不进图（0）/ 回收件仍在图（1）/ 夹具节点数 == 夹具磁盘独立期望。
//      为什么必须有它：真树 TRASH 被 `trash-sweep`/`snap-prune` 清空后，"图上没有快照节点"会变成
//      **恒真**（没有样本可漏，断言自动绿）——夹具把同一不变式钉在"可判"的样本上。
//      ⇒ **"只排副本、不排整层"的判别力全在这里**；真树只打读数（见下门槛段与 A 臂的 `[info] TRASH 读数`）。
// 输入门槛（2026-09-27 拆，消除环境敏感假红）：`全库 .md < 50` ⇒ 照旧响亮 FAIL（真·输入缺失：走错根 /
//      树被清空）；`TRASH 快照数` **不再是本门禁的成立前提** ⇒ 为 0 时打
//      `[info] TRASH 已无归档快照…判别力降级`、非 0 但 < 50 时打 `[info] TRASH 快照样本偏少…判别力下降`，
//      **都不判失败**（回收站被清空是环境变化，不是规则退化；判别力由夹具臂兜住）。
// B 臂（`git show <rev>` 的**改动前**版本，临时副本真加载）：**2026-09-27 起降级为信息臂**（不再产生
//   失败）。原判据「HEAD 确实是改动前版本」只在"改动尚未提交"时成立；改动一进 HEAD，旧版永远取不到
//   ⇒ 那条守卫必然恒 FAIL——正是本仓最忌讳的"假红/定时炸弹"（判据自我失效）。现在：取不到 / HEAD
//   已含过滤行 ⇒ 打 `[info] 跳过旧版对照`；能取到 ⇒ 照旧真加载并打印对照读数（节点/边/TRASH/快照数/
//   前后差值），但**只作信息**，不判 FAIL。主判据由 A 臂「独立 walk 精确等值」+ 变异反例承担。
//
// ── 反证（**应当变红**；已实测，读数见下）────────────────────────────────────
// ① 变异（**在临时副本上做，真仓库零触碰**）：把当前 lib 复制到 `%TEMP%\mind-graph-mutant\`
//    （`index.cjs` + `cron.cjs` + `cron-recipes.cjs` + `node_modules` junction），删掉那一行
//    `if (f.rel.startsWith('TRASH/') && path.basename(f.rel).includes('__')) return false;`，
//    然后 `DSH_MIND_GRAPH_LIB=%TEMP%\mind-graph-mutant\index.cjs node scripts/verify-mind-graph-trash-snapshots.mjs`
//    ⇒ 必须 FAIL（2026-09-27 实测：A 臂交叉验证「实际 320 ≠ 独立 walk 期望 91」+「快照节点 229 ≠ 0」
//    +「TRASH 层 232 > 6」三条同时红）。**B 臂降级成信息臂之后这条反例仍然红**——判别力已由 A 臂的
//    独立 walk 精确等值接管，不依赖 git 旧版对照（不依赖那条会随提交自我失效的守卫）。
// ② 对照臂自证**已降级为信息臂**（2026-09-27）：HEAD 已含过滤行 / 取不到旧版时只打 `[info] 跳过旧版
//    对照`，不再响亮 FAIL——否则本次改动一提交，这门禁就永久恒红（假红/定时炸弹）。想拿旧版读数时用
//    `DSH_MIND_GRAPH_BASELINE_REV=<提交前的 rev>` 指到改动前那一刻，读数会照旧打印（仍不判 FAIL）。
//
// ── 已知联动（2026-09-27 已解决）────────────────────────────────────────────
// `scripts/verify-mind-panel-labels.mjs` 的夹具里那两个 TRASH 快照文件，原先断言其中一张**必须进图**
// ⇒ 与本次排除冲突（改动后该门禁 FAIL 1/17：`actual []`）。同日已按产品语义改口径：断言「快照不进图」
// + 新增非快照 TRASH 回收件断言「仍在图 且 卡名 == 整条 basename」（那是那个门禁的 write_scope）。
//
// ── 环境变量（都是测试口，正常跑不用设）─────────────────────────────────────
//   DSH_MIND_GRAPH_LIB          被测 lib 的绝对路径（默认＝仓库内 `packages/dshome-mind/lib/index.cjs`）
//   DSH_MIND_GRAPH_BASELINE_REV 对照臂的 git rev（默认 `HEAD`）
//
// 用法：`<node> scripts/verify-mind-graph-trash-snapshots.mjs`；全绿 `PASS n/n` 退出 0，否则 `FAIL` 明细退出 1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const ENTRY_REL = 'packages/dshome-mind/lib/index.cjs';
const SNAP_FILTER_SRC = "if (f.rel.startsWith('TRASH/') && path.basename(f.rel).includes('__')) return false;";

let pass = 0;
const failures = [];
function assert(label, condition, expected, actual) {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL ${label}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
  console.log(`       actual:   ${JSON.stringify(actual)}`);
}
/** 快照副本判据（与后端过滤行**同一口径**：rel 以 `TRASH/` 开头 + **路径任一段**含 `__` 归档戳）。
 *  2026-09-28 口径同步：原为 `path.basename(rel).includes('__')` ⇒ 只认**文件级**戳，漏掉**目录级**
 *  归档（`TRASH/<戳>__<目录名>/…` 里文件 basename 干净）——实测 14 个节点漏进图、期望值虚高 14。
 *  戳落在哪一段不拘：文件级与目录级是**同义形态**。 */
const isSnapshotCopy = (rel) => rel.startsWith('TRASH/') && rel.split('/').some((s) => s.includes('__'));

console.log('[verify-mind-graph-trash-snapshots] TRASH 归档快照不出图');

// ── 磁盘真值（镜像 `walkContentMd` 的排除口径：隐藏项 / 非 .md / README / _index / .gitkeep）──
function walkContentMd(dir, rel, out) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const relName = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkContentMd(path.join(dir, e.name), relName, out);
    else if (e.isFile() && e.name.endsWith('.md')
      && e.name !== 'README.md' && e.name !== '_index.md' && e.name !== '.gitkeep') out.push(relName);
  }
}
/** 两个 zone 根各 walk 一遍（**本脚本自己的实现**；不借用被测模块的任何内部函数）。 */
function walkContentMdAll() {
  const out = [];
  walkContentMd(path.join(repoRoot, 'mind'), '', out);
  walkContentMd(path.join(repoRoot, 'mind-private'), '', out);
  return out;
}
/** 独立期望节点数：镜像 `buildGraph('')` 的**过滤链口径**（不是实现）——排 `tasks/evolution/snapshots/`
 *  与 `TRASH/` 下**路径任一段**含 `__` 的归档副本（文件级 / 目录级同义，2026-09-28 口径同步）；
 *  其余全留。被测 lib 少排/过排都躲不过等值断言。 */
const expectedNodeCount = (rels) => rels.filter((r) => !r.startsWith('tasks/evolution/snapshots/') && !isSnapshotCopy(r)).length;
const disk = walkContentMdAll();
const diskTrash = disk.filter((r) => r.startsWith('TRASH/'));
const diskTrashSnapshots = diskTrash.filter(isSnapshotCopy);
const diskTrashKept = diskTrash.filter((r) => !isSnapshotCopy(r));
console.log(`  [info] 磁盘真值：全库 .md ${disk.length} · TRASH ${diskTrash.length}`
  + `（快照副本 ${diskTrashSnapshots.length} / 真回收件 ${diskTrashKept.length}）`);
if (disk.length < 50) {
  // **只**认"真·输入缺失"（走错根 / 树被清空）⇒ 响亮失败，不让下面的期望值在空数据上假装成立。
  console.log(`  FAIL 磁盘真值读不出（repoRoot=${repoRoot}；全库 ${disk.length} < 50）`);
  failures.push('磁盘真值');
  console.log(`FAIL ${failures.length}/${pass + failures.length} assertion(s)`);
  process.exit(1);
}
// TRASH 快照数**不是**本门禁的成立前提（2026-09-27 拆，消除环境敏感假红面）：`scripts/trash-sweep.mjs`
// 会按三档排空回收站、快照裁剪（`snap-prune`）会裁掉旧快照 —— 主人清过之后"快照样本为 0/变少"是
// **环境变了**，不是"规则退化了"。拿它判 FAIL 会让门禁在正常维护后假红，且没人分得清是门禁错还是
// 产品错。故：样本面缩水只降判别力 ⇒ 用 `[info]` 如实标注，不判失败；同一不变式改由下面的
// **夹具臂**兜住（临时 DSH_HOME，不依赖真树样本）。
if (diskTrashSnapshots.length === 0) {
  console.log('  [info] TRASH 已无归档快照（可能被 trash-sweep/snap-prune 清过）——本门禁的样本面为空，判别力降级');
} else if (diskTrashSnapshots.length < 50) {
  console.log(`  [info] TRASH 快照样本偏少（${diskTrashSnapshots.length} 个 < 50），判别力下降`);
}

/** 真加载一个 lib 并跑 `buildGraph('')`；require 路径与树都由参数显式给，避免"读到别棵树"。 */
function probeLib(libPath) {
  const req = createRequire(import.meta.url);
  const resolved = req.resolve(libPath);
  delete req.cache[resolved]; // 两棵树共用同一份进程级 CJS 缓存 ⇒ 必须先清，否则 B 臂拿到 A 臂的模块
  const mod = req(resolved);
  if (typeof mod.buildGraph !== 'function') return { mod, graph: null };
  return { mod, graph: mod.buildGraph('') };
}
function summary(graph) {
  const byLayer = {};
  for (const n of graph.nodes) byLayer[n.layer] = (byLayer[n.layer] || 0) + 1;
  const trash = graph.nodes.filter((n) => n.rel.startsWith('TRASH/'));
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byLayer,
    trash: trash.length,
    trashSnapshots: trash.filter((n) => isSnapshotCopy(n.rel)).length,
    trashKept: trash.filter((n) => !isSnapshotCopy(n.rel)).length,
    evoSnapshots: graph.nodes.filter((n) => n.rel.startsWith('tasks/evolution/snapshots/')).length,
  };
}

// `repoRoot()` 是**调用期**读 `DSH_HOME`、且 DSH_HOME 优先 ⇒ 两臂都钉在真仓库根，读的才是同一棵树。
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = repoRoot;
const tmps = [];
try {
  // ── A 臂：当前工作区 lib ────────────────────────────────────────────────────
  const libPath = process.env.DSH_MIND_GRAPH_LIB
    ? path.resolve(process.env.DSH_MIND_GRAPH_LIB)
    : path.join(repoRoot, ENTRY_REL.split('/').join(path.sep));
  console.log(`  [info] A 臂被测 lib：${libPath}${process.env.DSH_MIND_GRAPH_LIB ? '（env DSH_MIND_GRAPH_LIB 覆盖）' : ''}`);
  assert('A 臂：lib 文件存在（不存在＝输入缺失，响亮失败）', fs.existsSync(libPath), '文件存在', libPath);
  const a = fs.existsSync(libPath) ? probeLib(libPath) : { mod: null, graph: null };
  assert('A 臂：真加载后导出 buildGraph（导不出＝门禁无从判，响亮失败）',
    typeof a.mod?.buildGraph === 'function', 'function', typeof a.mod?.buildGraph);
  if (!a.graph) {
    console.log('  FAIL A 臂：buildGraph 拿不到 ⇒ 门禁不成立（不许退化成 grep 文本断言）');
    failures.push('A 臂 buildGraph');
  } else {
    const s = summary(a.graph);
    console.log(`  [info] A 臂读数：${s.nodes} 节点 / ${s.edges} 边；分层 ${JSON.stringify(s.byLayer)}`
      + `；TRASH ${s.trash}（快照 ${s.trashSnapshots} / 回收件 ${s.trashKept}）`);
    assert('A 臂：节点数 > 0（0＝真加载走偏，响亮失败，不许静默绿）', s.nodes > 0, '> 0', s.nodes);
    assert('A 臂：图上没有 TRASH 快照副本节点（`__` 归档戳）', s.trashSnapshots === 0, '0 个',
      s.trashSnapshots);
    // 2026-09-27 这两条**降级为 `[info]`**（Lead 拍板，与上面输入门槛同一个病根）：它们拿**真实环境的
    // 数据量**当判据阈值 ⇒ 主人哪天用 `trash-sweep` 清空回收站、或手动往 TRASH 扔 7 个非快照件，
    // 就**假红**（环境变了，不是规则退化了）。而它们本来要拦的"快照副本回归图上"已由三重判据覆盖：
    // 「节点总数 == 独立 walk 期望」+「图上没有快照节点」+**夹具臂**（夹具自造 1 个非快照回收件并断言
    // 它必须在图、自造 2 个 `__` 快照并断言必须不在图 ⇒ "只排副本、不排整层"已是**环境无关**的判据）。
    console.log(`  [info] 真树 TRASH 读数：层节点 ${s.trash}（快照 ${s.trashSnapshots} / 真回收件 ${s.trashKept}）`
      + `；磁盘真值：快照 ${diskTrashSnapshots.length} / 真回收件 ${diskTrashKept.length}`
      + `（本条只作读数：回收站被清空或手动多扔几件都属环境变化，不判失败）`);
    // 独立 walk（第二遍）+ 独立期望：**两份独立实现交叉验证**（本脚本自己 walk 磁盘、自己套排除规则，
    // 不 require 被测模块的内部函数）⇒ `buildGraph()` 的过滤链过排/少排/漏加都会精确变红。
    const diskAfter = walkContentMdAll();
    const expected = expectedNodeCount(disk);
    const expectedAfter = expectedNodeCount(diskAfter);
    console.log(`  [info] 独立 walk 期望节点数：${expected}（第二遍 ${expectedAfter}；磁盘内容 .md ${disk.length} → ${diskAfter.length}）`);
    assert('A 臂：两次独立 walk 期望一致（树在门禁跑动期间没变 ⇒ 期望值可信，不用过期数字判实现）',
      expectedAfter === expected, expected, expectedAfter);
    assert('A 臂：节点总数 == 独立 walk 磁盘算出的期望值（交叉验证；过排/少排/漏加都精确红）',
      s.nodes === expected, expected, s.nodes);
    assert('A 臂：既有排除「tasks/evolution/snapshots/」未被破坏', s.evoSnapshots === 0, '0 个',
      s.evoSnapshots);
    // 既有第二条排除（项目态隔离）回归：切项目仍只留当前项目记忆、底座原样在场。
    const scopedGraph = a.mod.buildGraph('__不存在的项目__');
    const scoped = summary(scopedGraph);
    const projNodes = scopedGraph.nodes.filter((n) => n.rel.startsWith('L3/projects/')).length;
    assert('A 臂：既有排除「别家项目的 L3 记忆」未被破坏（切项目后 L3/projects 节点 == 0）',
      projNodes === 0, '0 个', projNodes);
    assert('A 臂：切项目后底座仍在（L0 层节点 ≥ 1）', (scoped.byLayer.L0 || 0) >= 1, '≥ 1',
      scoped.byLayer.L0 || 0);

    // ── 夹具臂（2026-09-27 加，**不依赖真树样本**）──────────────────────────────
    // 为什么必须有它：真树 TRASH 被 `trash-sweep`/`snap-prune` 清空后，"图上没有快照节点"这条断言
    // 会**变成恒真**（没有样本可漏 ⇒ 断言自动绿）。所以用临时 `DSH_HOME` 夹具（照
    // `verify-mind-panel-labels.mjs` 的手法）**自己造 2 个 `__` 快照 + 1 个非快照回收件**，
    // 把同一不变式钉在"可判"的样本上；夹具放 `$env:TEMP`，真仓库零触碰。
    {
      const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-graph-fixture-'));
      tmps.push(fx);
      const w = (rel, text) => {
        const full = path.join(fx, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, 'utf8');
      };
      // 夹具必须能**独立加载被测 lib**：`index.cjs` 顶层 require `<DSH_HOME>/scripts/mind-search-lib.cjs`
      // （只依赖 node 内建；不整目录 cpSync `scripts/`——那里随时有别的进程写的 `.tmpdir`）。
      fs.mkdirSync(path.join(fx, 'scripts'), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, 'scripts', 'mind-search-lib.cjs'), path.join(fx, 'scripts', 'mind-search-lib.cjs'));
      w('mind/L0/夹具底座.md', '# 夹具底座\n');
      w('mind-private/TRASH/2026-01-01T00-00-00__2026-01-01T00-00-00_夹具快照甲.md', '# 快照甲\n');
      w('mind-private/TRASH/2026-01-02T00-00-00__2026-01-01T00-00-00_夹具快照乙.md', '# 快照乙\n');
      w('mind-private/TRASH/夹具真回收件.md', '# 回收件\n');
      const fxDisk = [];
      walkContentMd(path.join(fx, 'mind'), '', fxDisk);
      walkContentMd(path.join(fx, 'mind-private'), '', fxDisk);
      const fxSnaps = fxDisk.filter(isSnapshotCopy).length;
      const fxKept = fxDisk.filter((r) => r.startsWith('TRASH/') && !isSnapshotCopy(r)).length;
      const fxExpect = expectedNodeCount(fxDisk);
      const fxPrevHome = process.env.DSH_HOME;
      process.env.DSH_HOME = fx; // 被测 lib 的 `repoRoot()` 是**调用期**读 env ⇒ 夹具期必须钉住它
      let fxGraph = null;
      try { fxGraph = probeLib(libPath).graph; }
      finally { if (fxPrevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = fxPrevHome; }
      assert('夹具臂：夹具磁盘确有 2 个 `__` 快照 + 1 个非快照回收件（输入自检，防夹具自己空转）',
        fxSnaps === 2 && fxKept === 1, '快照 2 / 回收件 1', { snaps: fxSnaps, kept: fxKept });
      if (!fxGraph) {
        console.log('  FAIL 夹具臂：真加载拿不到 buildGraph ⇒ 夹具臂不成立（不许退化成 grep 文本断言）');
        failures.push('夹具臂 buildGraph');
      } else {
        const f = summary(fxGraph);
        console.log(`  [info] 夹具臂读数：${f.nodes} 节点；TRASH 快照 ${f.trashSnapshots} / 回收件 ${f.trashKept}`
          + `（夹具磁盘独立期望 ${fxExpect} 节点）`);
        assert('夹具臂：`__` 快照不进图（不依赖真树样本 ⇒ TRASH 被清空时本门禁仍具判别力）',
          f.trashSnapshots === 0, '0 个', f.trashSnapshots);
        assert('夹具臂：非快照 TRASH 回收件仍在图（只排副本、不排整层）', f.trashKept === 1, '1 个', f.trashKept);
        assert('夹具臂：节点数 == 夹具磁盘独立 walk 期望（交叉验证在夹具上同样成立）',
          f.nodes === fxExpect, fxExpect, f.nodes);
      }
    }

    // ── B 臂（**信息臂**，2026-09-27 起不再产生失败）──────────────────────────
    // 原判据「HEAD 确实是改动前版本」只在改动尚未提交时成立；改动一进 HEAD，旧版永远取不到 ⇒ 那条守卫
    // 必然恒 FAIL（判据自我失效＝假红/定时炸弹）。故降级：取不到 / HEAD 已含过滤行 ⇒ `[info]` 跳过；
    // 能取到（例如用 DSH_MIND_GRAPH_BASELINE_REV 指到提交前的 rev）⇒ 照旧真加载并打印对照读数。
    const rev = process.env.DSH_MIND_GRAPH_BASELINE_REV || 'HEAD';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-graph-baseline-'));
    tmps.push(tmp);
    const libDir = path.dirname(libPath);
    const origPath = path.join(tmp, 'index.cjs');
    // 取 blob 用 **stdio 重定向到 fd**（不走管道：捕获式 stdio 在受限沙箱里会 EPERM），字节级保真
    // （CRLF 化会让 `^---\n` 这类 frontmatter 正则失效 ⇒ 对照臂读数假偏）。
    const fd = fs.openSync(origPath, 'w');
    let gitStatus;
    try {
      gitStatus = spawnSync('git', ['-C', repoRoot, 'cat-file', 'blob', `${rev}:${ENTRY_REL}`],
        { stdio: ['ignore', fd, 'inherit'] }).status;
    } finally { fs.closeSync(fd); }
    const origSrc = fs.existsSync(origPath) ? fs.readFileSync(origPath, 'utf8') : '';
    if (gitStatus !== 0 || !origSrc.includes('function buildGraph')) {
      console.log(`  [info] 跳过旧版对照（git cat-file blob ${rev}:${ENTRY_REL} 取不到：status ${gitStatus}、${origSrc.length} 字节）`
        + '——本臂为信息臂，不算失败');
    } else if (origSrc.includes(SNAP_FILTER_SRC)) {
      console.log('  [info] 跳过旧版对照（HEAD 已含本次改动）');
    } else {
      // 相对 require：把 `cron.cjs` / `cron-recipes.cjs` 一并搬到副本旁；`croner` 靠 node_modules 目录。
      for (const dep of ['cron.cjs', 'cron-recipes.cjs']) {
        fs.copyFileSync(path.join(libDir, dep), path.join(tmp, dep));
      }
      const nmSrc = path.join(repoRoot, 'node_modules');
      try { fs.symlinkSync(nmSrc, path.join(tmp, 'node_modules'), 'junction'); }
      catch { for (const pkg of ['croner', '@deepseek-ai']) { try { fs.cpSync(path.join(nmSrc, pkg), path.join(tmp, 'node_modules', pkg), { recursive: true }); } catch { /* 由真加载自己响亮失败 */ } } }
      const b = probeLib(origPath);
      if (typeof b.mod?.buildGraph !== 'function' || !b.graph) {
        console.log(`  [info] 旧版对照（${rev}）：真加载拿不到 buildGraph ⇒ 信息缺失，不算失败`);
      } else {
        const o = summary(b.graph);
        console.log(`  [info] B 臂读数（${rev}，改动前）：${o.nodes} 节点 / ${o.edges} 边；分层 ${JSON.stringify(o.byLayer)}`
          + `；TRASH ${o.trash}（快照 ${o.trashSnapshots} / 回收件 ${o.trashKept}）`);
        console.log(`  [info] 前后对照：${o.nodes} → ${s.nodes} 节点（差 ${o.nodes - s.nodes}）`
          + `；磁盘快照副本 ${diskTrashSnapshots.length}；边 ${o.edges} → ${s.edges}`);
        console.log(`  [info] 数学校验（信息口径，不判 FAIL）：差值 ${o.nodes - s.nodes}`
          + ` ${o.nodes - s.nodes === diskTrashSnapshots.length ? '==' : '!='} 磁盘快照副本数 ${diskTrashSnapshots.length}`);
      }
    }
  }
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  for (const t of tmps) {
    // 先 unlink 掉 node_modules junction（只摘链接、不碰真仓库的 node_modules），再删临时目录
    try { fs.unlinkSync(path.join(t, 'node_modules')); } catch { /* 没建起来就跳过 */ }
    try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

console.log(failures.length === 0 ? `PASS ${pass}/${pass}` : `FAIL ${failures.length}/${pass + failures.length} assertion(s)`);
process.exit(failures.length === 0 ? 0 : 1);
