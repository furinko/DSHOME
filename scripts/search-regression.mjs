// scripts/search-regression.mjs — 检索回归体温计（离线，用真实 searchL3 单一真源）
//
// 读心检索回归集（真实口语问句 → 期望落点记忆文件），逐个用【真实 searchL3】跑（离线，不走 HTTP/鉴权），
// 看「期望文件是否出现在 topN 命中里」——召回调参有没有越调越差，靠这个体温计。
//
// 单一真源约束：直接 require scripts/mind-search-lib.cjs 的 searchL3/listL3Files
//   （与 index.cjs 的 searchMind 用同一实现——F3），不在本脚本重写 tokenize/jaccard（避免双头漂移）。无网络、无鉴权。
//
// 用法：node scripts/search-regression.mjs [setPath] [--topN N]
// 退出码：0=全命中；1=有未命中（越调越差信号）；2=集文件缺失（没跑成）。

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { searchL3, listAllMemories } = require(join(dirname(fileURLToPath(import.meta.url)), 'mind-search-lib.cjs'));

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));

// 参数解析：setPath / --topN N
let setArg = null, topN = null;
for (const a of process.argv.slice(2)) {
  if (a === '--topN') continue;
  if (a.startsWith('--topN=')) topN = Number(a.split('=')[1]);
  else if (!a.startsWith('--') && setArg === null) setArg = a;
}
const setPath = setArg ? resolve(repoRoot, setArg) : join(repoRoot, 'mind-private', 'tasks', 'regression', 'search-regression.json');
if (!existsSync(setPath)) {
  console.error(`[search-regression] ❌ 集文件缺失: ${setPath}`);
  process.exit(2);
}
const set = JSON.parse(readFileSync(setPath, 'utf8'));
const limit = topN ?? (set.topN || 6);
const items = set.items || [];

// ── 精度基线（2026-09-12 加，待办「检索**精度无声退化**」）──────────────────────
// 起因：脚本原来的精度行把数字**硬编码**在注释里（「top1 由 5/10 → 7/10」），而 2026-09-12 实测是
//   **5/10** —— 硬编码数字**必然过期**（语料每次增文件，排序格局就变），且该行**只报不拦**
//   （原作者理由：「同一问题可能有多个合理答案，硬判会造恒亮灯」）。
// 但「**绝对**阈值会恒亮」不等于「不能有门禁」：**相对基线**不会恒亮 ——
//   「退化 = 比自己以前差」是客观事实，且基线可随改善显式更新（`--update-baseline`）。
// 语料条数或回归条数变了 ⇒ 基线**不可比**（提示重建，2026-09-16 起 exit 2：不算退化，但不可静默）。
//
// 🔴 2026-09-16（方案稿 P0-3 选项 1）：基线**移入公开受管区** `scripts/regression-baseline.json`。
//   起因：原路径在 `mind-private/**` 下，被 `.gitignore:42` 忽略 ⇒ 基线**只存在于本机** ⇒
//   换机/CI/新克隆永远是"首次无基线" ⇒ 门禁**静默放行一切**（修好的闸门等于白修）。
//   判据：基线里只有计数（无隐私内容），**可复现的判据必须随仓库走**，与他人可复核。
//   代价（特性非缺陷）：语料增减后基线不可比 → exit 2 → 需显式 `--update-baseline` 并提交，
//   逼人确认"新数字是真变好还是被语料撑大的"。
const BASELINE = join(repoRoot, 'scripts', 'regression-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');
let base = null;
try { base = JSON.parse(readFileSync(BASELINE, 'utf8')); } catch { /* 首次：无基线 */ }
// 记忆层重构（2026-09-09）：回归集横跨 DSHOME/通用/其它项目 → 全库候选（common + 全部项目，等价旧 L3/index 行为）
const files = listAllMemories(join(repoRoot, 'mind-private', 'L3'));

console.log(`[search-regression] 回归集 ${items.length} 条 · topN=${limit} · 语料文件 ${files.length} 个（离线 searchL3 单一真源）`);

let hits = 0, misses = 0, top1off = 0;
const detail = [];
for (const it of items) {
  const hs = searchL3(it.q, files, limit);
  // 2026-09-11 修（第四轮盲评 · C2）：原来是**双向子串** `h.file.includes(expect) || expect.includes(h.file)`
  // → 期望串是短词时，任何"名字里含该串"的错文件也算命中（**假命中**，命中率虚高）。
  // 改为**单向**：期望串必须是命中文件路径的一部分（路径分隔符归一后再比）。
  const normRel = (s) => String(s).replace(/\\/g, '/');
  const matched = hs.some((h) => h.file && normRel(h.file).includes(normRel(it.expect)));
  const top = hs[0];
  // 2026-09-11 补（检索修复 C 的实验疏漏）：只判"进没进 topN"是**只有召回、没有精度**的体温计——
  // 实测 R03/R09 修好后目标文档确实进了 topN，但 top1 仍是无关文档，而旧判据照样打 ✅。
  // 这里把 top1 是否正确**记为信息行**（不升门禁：同一问题可能有多个合理答案，硬判会造恒亮灯）。
  // 注：`top` 必须先声明再被引用——首版把它写在下面，`node --check` 过了但真跑抛 TDZ
  // `Cannot access 'top' before initialization`（语法检查查不出"东西不存在/未初始化"，同 mind-inject 那例）。
  const top1ok = !!(matched && top && top.file && normRel(top.file).includes(normRel(it.expect)));
  // 锚点存在性（2026-09-16 加）：**旧用例的期望文件是否还在候选库里** ——
  //   用来把"语料变动"分成"日常增量"（锚点仍在 ⇒ 放行）与"真损失"（锚点被删/改名 ⇒ 拦）。
  //   判据同 matched：期望串须是候选路径的一部分（单向，防短词假命中）。
  //   ⚠️ 2026-09-17 修：`files` 是 `{full, rel}` **对象数组**（见 mind-search-lib `listAllMemories`），
  //      故必须取 `f.rel`——写成 `normRel(f)` 会得到 `[object Object]`，**锚点全部误判为丢失**（实测 20/20 假红）。
  const anchorExists = files.some((f) => normRel(f.rel).includes(normRel(it.expect)));
  if (matched) hits++; else misses++;
  if (matched && !top1ok) top1off++;
  detail.push({ id: it.id, q: it.q, expect: it.expect, ok: matched, top1ok, anchorExists, topFile: top ? top.file : '(空)', topScore: top ? top.score : null });
}

console.log(`\n[search-regression] 结果：召回命中 ${hits}/${items.length}（未命中 ${misses}）· 精度 top1 正确 ${items.length - top1off}/${items.length}`);
for (const d of detail) {
  console.log(`  ${d.ok ? '✅' : '❌'} ${d.id}「${d.q}」→ 期望 ${d.expect}  ${d.top1ok ? 'top1✅' : 'top1❌'}`);
  // 2026-09-12：明细**常打**（原来只在「未命中」时才打 top1）—— 否则"top1 错了 5 条"在输出里**看不见**，
  // 而那正是精度退化的形态（召回全绿 + 精度悄悄掉）。
  if (!d.ok || !d.top1ok) console.log(`        top1=${d.topFile} (score=${d.topScore})`);
}
console.log(`[search-regression] 召回率 ${Math.round((hits / items.length) * 100)}%`);

// ── 基线对比：**退化即 exit 1**（2026-09-12 加）───────────────────────────────
// ⚠️ 原注释里的「top1 由 5/10 → 7/10」是**硬编码声称**，2026-09-12 实测为 **5/10** —— 已被本次移除，
//    数字改由 `baseline.json` **机器记录**（硬编码必然过期）。
const top1okNow = items.length - top1off;
let regressed = false;
// 2026-09-16（P0-1）：「基线在但不可比」必须与「首次无基线」区分开 —— 前者意味着基线**事实上失效**
//   （语料/条数变了，比对条件不成立），若静默放行，等于"基线悄悄没了也没人知道"；后者是首次，天然放行。
let baselineComparable = false;
let baselineWasMissing = !base;
// 增量放行标记（2026-09-16）：只有"文件数增加 + 条数不变 + 锚点全在"这一种情形可用（见下方 incremental 分支）。
let incrementalPass = false;
if (base) {
  baselineComparable = base.corpusFiles === files.length && base.items === items.length;
  // 锚点存在性统计：判断"语料变动"是日常增量（锚点仍在 ⇒ 放行）还是真损失（锚点被删/改名 ⇒ 拦）。
  const anchorMissing = detail.filter((d) => !d.anchorExists);
  const beforeCmp = base.corpusFiles === files.length;
  const incremental = files.length > base.corpusFiles && anchorMissing.length === 0;
  // 🔴 2026-09-16 改（用户：记忆文件增删很频繁——原"文件数一变就 exit 2"会把闸门变成天天堵门）：
  //   把「条件变了」拆成两类，止损在**真损失**上：
  //     ① **增量**（files.length 增加 且 无锚点文件丢失）→ **不拦**：新增记忆文件是日常操作，
  //        旧查询的锚点仍在库、只是排序可能被挤动；此时精确旧数字只能当**参考**，不能当门禁。
  //     ② **真损失**（锚点文件已不存在 = 被删/改名）→ **拦**（exit 2）：那是"召不回来"的实证，必须处理。
  //   代价（如实写明）：增量场景是**放行**，若新增文件把某条锚点挤下 topN，本判据**看不见**（已知盲区）。
  const comparableNow = beforeCmp;
  if (beforeCmp && base.items === items.length) {
    if (hits < base.hits) {
      console.error(`[search-regression] ❌ **召回退化**：基线 ${base.hits}/${base.items} → 现 ${hits}/${items.length}`);
      regressed = true;
    }
    if (top1okNow < base.top1ok) {
      console.error(`[search-regression] ❌ **精度退化**：基线 top1 正确 ${base.top1ok}/${base.items} → 现 ${top1okNow}/${items.length}`);
      regressed = true;
    }
    if (!regressed) console.log(`[search-regression] ✅ 不劣于基线（召回 ${hits}≥${base.hits} · 精度 ${top1okNow}≥${base.top1ok}，基线 ${base.updatedAt}）`);
  } else if (base.items !== items.length) {
    baselineComparable = false;
    console.error(`[search-regression] ❌ **回归集条数变了**（基线 ${base.items} → 现 ${items.length}）：判据本身变了 ⇒ 必须重建基线。`
      + '已记录本次数字，跑 `--update-baseline` 重建后提交。');
  } else if (anchorMissing.length) {
    baselineComparable = false;
    console.error(`[search-regression] ❌ **锚点丢失**（${anchorMissing.length} 条）：期望文件在库中已不存在（被删/改名）⇒ 这些用例**召不回来**了；`
      + `${anchorMissing.slice(0, 3).map((d) => d.expect).join(' / ')}${anchorMissing.length > 3 ? ' …' : ''}`
      + ' 修复目标文件、或按新意图改回归集后重建基线。');
  } else if (incremental) {
    // 日常增量：**不拦**（用户 2026-09-16：记忆文件增删很频繁，原"一变就 exit 2"会把闸门变成天天堵门）。
    incrementalPass = true;
    console.log(`[search-regression] ℹ️ 语料**增量**（基线 ${base.corpusFiles} → 现 ${files.length} 个文件），锚点仍在 ⇒ 精确比对跳过、**不拦**；`
      + `本次参考值：召回 ${hits}/${items.length} · 精度 ${top1okNow}/${items.length}。`
      + '若明显偏低，请人工确认后 `--update-baseline` 重建参考线。');
  } else {
    baselineComparable = false;
    console.error(`[search-regression] ❌ **语料减少**（基线 ${base.corpusFiles} → 现 ${files.length}）：删除/改名记忆文件是**真损失**风险 ⇒ `
      + '先确认被删内容已归档（TRASH），再 `--update-baseline` 重建并提交。');
  }
} else {
  console.log('[search-regression] ℹ️ **无基线**（首次）——确认本次数字可信后跑 `--update-baseline` 建立，此后**退化即拦**。');
}
// 写基线：**只有一条路径**（2026-09-17 三修）
//   `--update-baseline`（人工显式）→ 整条重建：数字、条数、语料数全部按本次结果重写。
//
// ⚠️ 2026-09-17 删掉了"增量时自动推进 corpusFiles"（09-16 二修的产物）：实测**它会制造新的堵门** ——
//   新增文件把基线推到 61 后，再删掉一个文件（字面上仍是"净增"或"回到原状"）就被判成"语料减少"⇒ exit 2。
//   正确做法是**基线永不自动改**：`corpusFiles` 是"上次人工确认时的参考面"，语义只增不减由判据保证 ——
//   现值 > 基线 ⇒ 增量放行；现值 == 基线 ⇒ 精确比对；现值 < 基线 ⇒ 拦（须人工重建）。
//   代价（如实写明）：长期只增不减且不跑 `--update-baseline` 时，基线数字会**一直落后**于真实语料数，
//   精确比对长期不触发（锚点丢失仍逐条拦、退化靠人工看参考值）。属**已知盲区**，需要时手动重建。
const BASE_NOTE = '召回/精度基线（2026-09-17 判据三修）。**0**=不劣于基线 / 首次无基线 / **语料增量**（文件数 > 基线且条数不变、锚点全在 ⇒ 日常增删不堵门）；**1**=真退化（召回或 top1 低于基线）；**2**=条件变了需重建（回归集条数变 / **锚点文件丢失** / **语料减少** = 现值低于基线）。基线**只由 `--update-baseline` 改写**，不自动推进。';
if (updateBaseline && NO_SIDE_EFFECT) {
  console.log('[search-regression] 🔇 无副作用模式：跳过基线落盘（如需重建请去掉 HINDSIGHT_NO_METRICS/CI 后手工跑）。');
} else if (updateBaseline) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    note: BASE_NOTE,
    corpusFiles: files.length, items: items.length, topN: limit,
    hits, misses, top1ok: top1okNow,
  }, null, 2) + '\n');
  console.log(`  📌 基线已写入 ${BASELINE}（整条重建：hits=${hits} top1ok=${top1okNow} corpus=${files.length}）`);
}

// 救 search-hit 信号（2026-09-07）：回归命中 = 真实"检索命中"事件 → bump search-hit。
// 不进 tokenize/Jaccard（已知 bigram 词面盲区，K3 已否决上 embedding）；命中率当作"体温计基线"，低于历史即越调越差。
// 每次命中 bump 一次，让 search-hit 反映召回量，而非恒为 0。
//
// 🛑 2026-09-17（挂 pre-commit 前置）：**无副作用模式** —— `HINDSIGHT_NO_METRICS=1`（或 `CI` 环境）时
//   本脚本**只读、不写任何东西**（不 bump、不落基线、不写 changelog）。
//   起因：它原先在 `.git/hooks/pre-commit` 的「工具脚本真跑冒烟」白名单里，**每次提交都白跑一遍并 +9**，
//   把 `metrics.json` 的 `search-hit` 从"召回量信号"变成"提交次数×9"（实测已累积 343）——**门禁污染被测对象**。
//   挂成显式门禁后，`: run` 会显式带这个变量；开发者手工跑（无该变量）时行为不变，仍会累积信号。
const NO_SIDE_EFFECT = process.env.HINDSIGHT_NO_METRICS === '1' || !!process.env.CI;
const evoLog = join(dirname(fileURLToPath(import.meta.url)), 'evolve-log.mjs');
const METRICS_FILE = join(repoRoot, 'mind-private', 'tasks', 'evolution', 'metrics.json');
if (NO_SIDE_EFFECT) {
  console.log('[search-regression] 🔇 无副作用模式（HINDSIGHT_NO_METRICS/CI）：跳过 metrics bump 与 changelog 写入。');
} else if (hits > 0) {
  try {
    // 基线时机修复（2026-09-08）：log 先于 bump——只在 search-hit 首次从 0 起步时自动写 log（基线=跑前 0），
    // 避免"先 bump 后手动 log"把基线记成改后值 → effect auto 假阴性（0→N 真实增益不可见，曾误判"无效"）。
    // 后续运行仅 bump 累积（before>0 不 log，不刷 changelog）。
    let before = 0;
    try {
      const m = JSON.parse(readFileSync(METRICS_FILE, 'utf8'));
      before = (m.metrics && m.metrics['search-hit']) || 0;
    } catch {}
    if (before === 0) {
      execFileSync(process.execPath, [evoLog, 'log',
        `search-hit|检索回归体温计|救 search-hit:回归命中首次驱动信号(0→${hits}),让指标有真实来源;log 先于 bump 记基线|search-regression 跑完按命中数 bump`],
        { cwd: repoRoot, stdio: 'ignore' });
    }
    for (let i = 0; i < hits; i++) execFileSync(process.execPath, [evoLog, 'bump', 'search-hit'], { cwd: repoRoot, stdio: 'ignore' });
    console.log(`[search-regression] 已 bump search-hit ×${hits}（命中 ${hits} 条 → 信号 +${hits}）`);
  } catch (e) {
    console.warn('[search-regression] bump search-hit 失败（不影响回归判定）:', e.message);
  }
}

// 退出码（2026-09-16 · P0-1 修）：判据从「**misses === 0 且不劣**」改为「**只看是否劣于基线**」。
//
// ⚠️ 旧判据的病根：`misses === 0` 是**零容忍**（要求 20/20 全命中），它把基线机制整个压掉了 ——
//    实测「基线 9/20、现 9/20、top1 15≥15」时输出 `✅ 不劣于基线`，却仍 `exit 1` ⇒ **该绿回红**，
//    挂进 pre-commit 会恒红、挂不进链；而基线的全部意义就是"**不劣于自己以前即可**"。
// 现判据（**分类拦截**，2026-09-16 二修：用户指出"记忆增删很频繁"，原"文件数一变即 exit 2"会天天堵门）：
//   0 = 不劣于基线 · 或**首次无基线**（信息放行）· 或**语料增量**（文件数增加 + 条数不变 + 锚点全在 ⇒ 日常增删不堵门）
//   1 = **真退化**（召回或 top1 低于基线）
//   2 = **条件变了需重建**（回归集条数变 / **锚点文件丢失** = 期望文件被删改名 / 语料减少）
// 代价（如实写明）：增量场景**放行**，若新增文件把某锚点挤下 topN，本判据**看不见**（属已知盲区，靠人工看参考值）。
// `misses`/`top1off` 不参与拦截 —— 它们是**信息行**（同一问题可能有多个合理答案，硬判会造恒亮灯，此原则见文件头基线段）。
const exitCode = regressed ? 1
  : (baselineWasMissing || baselineComparable || incrementalPass ? 0 : 2);
process.exit(exitCode);
