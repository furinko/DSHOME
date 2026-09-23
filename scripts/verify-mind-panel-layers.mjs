#!/usr/bin/env node
// scripts/verify-mind-panel-layers.mjs — 心智面板「层带登记一致性」门禁
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// 面板的层带由**两份登记**共同决定：
//   · 后端 `packages/dshome-mind/lib/index.cjs` 的 `LAYER_MAP`：按文件路径给节点打层 id；
//   · 客户端 `packages/dshome-mind/lib/client.js` 的 `LAYER_ORDER`：决定这些层画在哪一栏。
// **客户端漏登记 = layoutGraph 不给该层排位置 = 节点循环读 `p.x` 抛 TypeError = 整块图谱白屏**
// （2026-09-16 实录：`mind-private\backup\web-assets\PATCH-NOTES.md` 落 `OT` 层而客户端未登记，
//  于是"非标路径"一出现，面板整块白；当日后端注释里留了这段病史）。
// 2026-09-23 加「角色卡」层（`L2/agents/`）时，只改后端就会再犯一次 —— 故把这条不变式钉成门禁。
//
// ── 判据 ────────────────────────────────────────────────────────────────────
// 1. 两侧都能解析出非空 id 列表（解析不到 = 输入缺失，响亮失败，不许静默绿）。
// 2. 客户端登记了兜底层 `OT`（后端对非标路径恒可能产出它）。
// 3. `后端可能产出的每个 id ⊆ 客户端已登记`（这就是"白屏"的充要条件）。
// 4. 反向（客户端 ⊆ 后端）只作**信息行**：多登记的层是死层，不白屏、不拦提交。
//
// ── 反证（**应当变红**；2026-09-23 隔离副本实测，由提交方补记）────────────────
//   做法：把本脚本 + `packages/dshome-mind/lib/{client.js,index.cjs}` 复制到临时目录
//   （副本脚本的 repoRoot 自成一体），在**副本** client.js 里把 `{ id: "OT"` 改成 `{ id: "OTX"`
//   —— 即模拟"客户端漏登记兜底层"这一 2026-09-16 白屏的形态。
//   实测：原样副本 `PASS 6/6` 退出 0 → 变异后 **`FAIL 1/6` 退出 1**（红在断言
//   「客户端登记了兜底层 OT」，并另打 `[info] 死层 OTX`）；副本还原即复绿。
//   全程只碰副本，真仓库零触碰 ⇒ **本门禁不是恒绿测试**，反例按上面两步可复现。
//
// 用法：`<node> scripts/verify-mind-panel-layers.mjs`；全绿打印 `PASS n/n` 退出 0，否则 `FAIL` 明细退出 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const backendPath = path.join(repoRoot, 'packages', 'dshome-mind', 'lib', 'index.cjs');
const clientPath = path.join(repoRoot, 'packages', 'dshome-mind', 'lib', 'client.js');

let pass = 0;
const failures = [];
function assert(label, condition, expected, actual) {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL ${label}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
  console.log(`       actual:   ${JSON.stringify(actual)}`);
}

/** 取 [start, end) 之间所有 `{ id: 'X' }` / `{ id: "X" }` 的 id。 */
function idsBetween(text, startToken, endToken, quote) {
  const start = text.indexOf(startToken);
  const end = text.indexOf(endToken);
  if (start < 0 || end < 0 || end <= start) return null;
  const body = text.slice(start, end);
  const re = new RegExp(`\\{\\s*id:\\s*${quote}([A-Za-z0-9_]+)${quote}`, 'g');
  return [...body.matchAll(re)].map((m) => m[1]);
}

console.log('[verify-mind-panel-layers] 面板层带登记一致性');
const backendSrc = fs.readFileSync(backendPath, 'utf8');
const clientSrc = fs.readFileSync(clientPath, 'utf8');

const backendIds = idsBetween(backendSrc, 'const LAYER_MAP', 'function layerOf', "'");
const clientIds = idsBetween(clientSrc, 'var LAYER_ORDER', 'var CANVAS_W', '"');

assert('后端 LAYER_MAP 可解析且非空', Array.isArray(backendIds) && backendIds.length > 0, '非空 id 列表', backendIds);
assert('客户端 LAYER_ORDER 可解析且非空', Array.isArray(clientIds) && clientIds.length > 0, '非空 id 列表', clientIds);
if (Array.isArray(backendIds) && Array.isArray(clientIds)) {
  const clientSet = new Set(clientIds);
  assert('客户端登记了兜底层 OT（后端对非标路径恒可能产出）', clientSet.has('OT'), 'OT 已登记', clientIds);
  const missing = backendIds.filter((id) => !clientSet.has(id));
  assert('后端可能产出的每个层 id 都已登记在客户端（否则整块图谱白屏）', missing.length === 0, '[]', missing);
  const backendSet = new Set(backendIds);
  const extra = clientIds.filter((id) => !backendSet.has(id) && id !== 'OT');
  if (extra.length > 0) console.log(`  [info] 客户端多登记（死层，不白屏、不拦提交）：${extra.join(', ')}`);
}

if (typeof backendIds?.includes === 'function') {
  assert('后端登记了「角色卡」层 AG（2026-09-23 加的 L2/agents 档）', backendIds.includes('AG'), '包含 AG', backendIds);
  assert('客户端同步登记了「角色卡」层 AG', Array.isArray(clientIds) && clientIds.includes('AG'), '包含 AG', clientIds);
}

console.log(failures.length === 0 ? `PASS ${pass}/${pass}` : `FAIL ${failures.length}/${pass + failures.length} assertion(s)`);
process.exit(failures.length === 0 ? 0 : 1);
