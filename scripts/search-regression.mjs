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
process.exit(misses === 0 ? 0 : 1);
