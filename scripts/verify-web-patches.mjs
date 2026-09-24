#!/usr/bin/env node
// scripts/verify-web-patches.mjs — 门禁：Web 产物补丁**必须还在**（2026-09-18 加；2026-09-24 扩第三块）
//
// 为什么需要它（一条真实缺口）：`scripts/patch-web-assets.mjs` 的三块补丁只改 **node_modules /
// payload 产物**（不在 git 里）——① `vendor-*.js` 的 `singleTilde→false`（单个 `~` 不再变删除线）
// ② 权限档位图标表补 `mind-guard` 项（盾牌+锁）③ 右栏宽度跨刷新保持（初始化读 localStorage +
// 拖拽写回）`pnpm install` / 升级上游会把它们**抹掉**，
// 而首版收工时它**不在任何链上** ⇒ 补丁可以**静默消失**且没有任何门禁会喊（同 2026-09-11
// 「门禁不在链上 = 纸面门禁」那一课）。
//
// 职责边界：本脚本是 `patch-web-assets.mjs --verify-only` 的**薄包装**——补丁的判据（锚点形态、
// 条目内容、落点 roots）只有**一份真源**，就在那个脚本里；这里只负责把它变成链上一个可执行门禁，
// 并让 `gate-ledger` 扫得到（它按 `scripts/verify-*.mjs` 收集行为门禁）。
//
// 可执行反例（必须能红）：`pnpm install` 之后直接跑本脚本 ⇒ 报未打/落后 + **exit 1**；
//   跑 `node scripts/patch-web-assets.mjs` 复绿（这也是唯一的修复动作）。
//
// 用法：node scripts/verify-web-patches.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const patcher = join(here, 'patch-web-assets.mjs');

const r = spawnSync(process.execPath, [patcher, '--verify-only'], { cwd: root, encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.error) {
  console.error(`[verify-web-patches] ❌ 调不起补丁脚本：${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error('[verify-web-patches] ❌ Web 产物补丁缺失或版本落后（单个 `~` 会被渲染成删除线 / 权限图标缺失 / 右栏拖好的宽度会回落 45%）');
  console.error('[verify-web-patches]    修复：node scripts/patch-web-assets.mjs   （`stage-payload` 也会自动打）');
  process.exit(1);
}
console.log('[verify-web-patches] ✅ Web 产物补丁在位（singleTilde + 权限图标 mind-guard + 右栏宽度保持）');
