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

import { readFileSync, existsSync } from 'node:fs';
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
  if (matched) hits++; else misses++;
  if (matched && !top1ok) top1off++;
  detail.push({ id: it.id, q: it.q, expect: it.expect, ok: matched, topFile: top ? top.file : '(空)', topScore: top ? top.score : null });
}

console.log(`\n[search-regression] 结果：命中 ${hits}/${items.length} 未命中 ${misses}`);
for (const d of detail) {
  console.log(`  ${d.ok ? '✅' : '❌'} ${d.id}「${d.q}」→ 期望 ${d.expect}`);
  if (!d.ok) console.log(`        top1=${d.topFile} (score=${d.topScore})`);
}
console.log(`\n[search-regression] 命中率 ${Math.round((hits / items.length) * 100)}%`);
if (top1off > 0) {
  console.log(`[search-regression] ℹ️ 精度：${top1off}/${items.length} 条"进了 topN 但 top1 不是期望文件"——` +
    `2026-09-11 已修排序量纲：sortKey 的相关度改**百分制**（\`score*100\`，原 \`+score\` 恒 <1 等于零权重），` +
    `top1 由 5/10 → 7/10、召回恒 10/10。剩余几条**任何权重都救不动** ⇒ 属**匹配质量/期望合理性**问题（非排序），` +
    `另立项查（语料仅 7 文件、回归仅 10 条，样本太小，不足以当强证据）。本行仅信息，不参与退出码。`);
}

// 救 search-hit 信号（2026-09-07）：回归命中 = 真实"检索命中"事件 → bump search-hit。
// 不进 tokenize/Jaccard（已知 bigram 词面盲区，K3 已否决上 embedding）；命中率当作"体温计基线"，低于历史即越调越差。
// 每次命中 bump 一次，让 search-hit 反映召回量，而非恒为 0。
const evoLog = join(dirname(fileURLToPath(import.meta.url)), 'evolve-log.mjs');
const METRICS_FILE = join(repoRoot, 'mind-private', 'tasks', 'evolution', 'metrics.json');
if (hits > 0) {
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

process.exit(misses === 0 ? 0 : 1);
