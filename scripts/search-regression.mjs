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
const { searchL3, listL3Files } = require(join(dirname(fileURLToPath(import.meta.url)), 'mind-search-lib.cjs'));

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
const files = listL3Files(join(repoRoot, 'mind-private', 'L3', 'index'));

console.log(`[search-regression] 回归集 ${items.length} 条 · topN=${limit} · 语料文件 ${files.length} 个（离线 searchL3 单一真源）`);

let hits = 0, misses = 0;
const detail = [];
for (const it of items) {
  const hs = searchL3(it.q, files, limit);
  const matched = hs.some((h) => h.file && (h.file.includes(it.expect) || it.expect.includes(h.file)));
  if (matched) hits++; else misses++;
  const top = hs[0];
  detail.push({ id: it.id, q: it.q, expect: it.expect, ok: matched, topFile: top ? top.file : '(空)', topScore: top ? top.score : null });
}

console.log(`\n[search-regression] 结果：命中 ${hits}/${items.length} 未命中 ${misses}`);
for (const d of detail) {
  console.log(`  ${d.ok ? '✅' : '❌'} ${d.id}「${d.q}」→ 期望 ${d.expect}`);
  if (!d.ok) console.log(`        top1=${d.topFile} (score=${d.topScore})`);
}
console.log(`\n[search-regression] 命中率 ${Math.round((hits / items.length) * 100)}%`);

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
