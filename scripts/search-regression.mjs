// scripts/search-regression.mjs — 检索回归体温计（真源：/api/mind/search）
//
// 读心检索回归集（真实口语问句 → 期望落点记忆文件），逐个 call 真实 /api/mind/search 端点，
// 看「期望文件是否出现在 topN 命中里」——召回调参有没有越调越差，靠这个体温计。
//
// 用途：改 tokenize/jaccard/searchMind 排序前先跑记基线；改完再跑，命中率掉了=越调越差，回滚。
// 真源约束：只调 /api/mind/search（唯一权威实现），不在此重写 tokenize/jaccard（避免双头漂移，F3）。
//
// 用法：node scripts/search-regression.mjs [setPath] [--base http://...] [--topN N]
//   环境变量：DSHOME_API（默认 http://127.0.0.1:3099）
//
// 退出码：0=全部命中；1=有未命中；2=后端不可达/集文件缺失（体温计没跑成，别当"全过"）。

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const base = process.env.DSHOME_API || 'http://127.0.0.1:3099';

// 参数解析（setPath / --base / --topN）
let setArg = null;
let topNArg = null;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--base=')) topNArg = a; // keep simple; --base handled below
  if (a === '--base') continue;
  if (a.startsWith('--topN=')) topNArg = a;
  if (!a.startsWith('--') && setArg === null) setArg = a;
}
let baseUrl = base;
const baseIdx = process.argv.indexOf('--base');
if (baseIdx >= 0 && process.argv[baseIdx + 1]) baseUrl = process.argv[baseIdx + 1];

const setPath = setArg ? resolve(repoRoot, setArg) : join(repoRoot, 'mind-private', 'tasks', 'regression', 'search-regression.json');

if (!existsSync(setPath)) {
  console.error(`[search-regression] ❌ 集文件缺失: ${setPath}`);
  process.exit(2);
}
const set = JSON.parse(readFileSync(setPath, 'utf8'));
const topN = topNArg?.match(/--topN=(\d+)/)?.[1] ? Number(topNArg.match(/--topN=(\d+)/)[1]) : (set.topN || 6);
const items = set.items || [];

console.log(`[search-regression] 回归集 ${items.length} 条 · base=${baseUrl} · topN=${topN}`);

let hits = 0, misses = 0, backendErr = null;
const detail = [];
for (const it of items) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/mind/search?q=${encodeURIComponent(it.q)}`);
  } catch (e) {
    backendErr = `network: ${e.message}`;
    break;
  }
  if (!res.ok) { backendErr = `HTTP ${res.status}`; break; }
  let json;
  try { json = await res.json(); } catch { backendErr = 'invalid json'; break; }
  const hs = (json.hits || []).slice(0, topN);
  const matched = hs.some((h) => h.file && (h.file.includes(it.expect) || it.expect.includes(h.file)));
  if (matched) hits++; else misses++;
  const top = hs[0];
  detail.push({
    id: it.id, q: it.q, expect: it.expect, ok: matched,
    topFile: top ? top.file : '(空)', topScore: top ? top.score : null,
  });
}

if (backendErr) {
  console.error(`[search-regression] ❌ 后端不可达（${backendErr}）——体温计没跑成，请先启动 DSHOME 后端（/api/mind/search 需运行中）；不要当"全过"。`);
  console.error(`  提示：3099 若是 DSHOME GUI 而非后端，用 --base 指到含 /api/mind 的地址。`);
  process.exit(2);
}

console.log(`\n[search-regression] 结果：命中 ${hits}/${items.length} 未命中 ${misses}`);
for (const d of detail) {
  console.log(`  ${d.ok ? '✅' : '❌'} ${d.id}「${d.q}」→ 期望 ${d.expect}`);
  if (!d.ok) console.log(`        top1=${d.topFile} (score=${d.topScore})`);
}
const rate = Math.round((hits / items.length) * 100);
console.log(`\n[search-regression] 命中率 ${rate}%`);
process.exit(misses === 0 ? 0 : 1);
