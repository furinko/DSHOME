#!/usr/bin/env node
// scripts/verify-shell-readiness.mjs — 外壳「后端就绪判据」回归验证（2026-09-17 建）
//
// ── 为什么需要它（真实事故，主人报障）────────────────────────────────────────
// 「每次开电脑第一次打开 DSHOME：后端连很久，而且首屏什么工作区都没有，刷新一下才好。」
// 根因 = 壳的在线判据（裸 URL 返回 200）比后端的真实就绪点（stdout `dsh web:` 行，
// 打印于 loader.await() 之后）早 1.5~2.4s（冷启动更久）→ 首屏落在半就绪 host 上：
// 浏览器插件花名册 `window.__DSH_BOOT__` 按「请求那一刻已建 fiber 的行」现渲染，
// 早到的首屏必然缺插件；半就绪 host 还会让工作区那条 follow 流**终局失败且不重建**。
// 判据本体抽成纯函数 `packages/dshome/shell-app/readiness.cjs`，本脚本锁住它 + 锁住
// main.cjs 的接线（防「脚本绿、主进程没接上」这种假绿）。
//
// ── 断言什么 ────────────────────────────────────────────────────────────────
//   R1-R7 判据表：探活不通 / 外部后端 / 半就绪等待 / 兜底超时 / URL 行到达 / 边界值
//   R8    迟到补重载：只在「兜底上线过」且「本进程还没补过」时为真
//   R9    接线面：main.cjs 必须引用 readiness 并传 ready 种类；旧的一行判据不得残留
//   R10   ready 取值白名单（新增分支忘了归类会当场红）
// 退出码：0 = 全通过；1 = 有断言失败。
//
// 用法：node scripts/verify-shell-readiness.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shellDir = join(repoRoot, 'packages', 'dshome', 'shell-app');
const r = require(join(shellDir, 'readiness.cjs'));

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`ok  ${name}`); return true; }
  failed += 1;
  console.error(`FAIL ${name}${extra ? '  → ' + extra : ''}`);
  return false;
}
const FB = r.DEFAULT_FALLBACK_MS;
const decide = (o) => r.decideOnline({
  probeUp: false, ownsBackend: false, hasAuthUrl: false, probeUpSince: null, now: 1_000_000, ...o,
});

// ── R1-R7. 判据表 ───────────────────────────────────────────────────────────
check('R1 探活不通 → 一律不上线（旧信号不能当在线）',
  decide({ probeUp: false, ownsBackend: true, hasAuthUrl: true }).online === false);

check('R2 外部/孤儿后端（壳没 spawn 过）→ 探活 200 即在线（反例：不能因为拿不到 URL 行就永远停在离线页）', (() => {
  const d = decide({ probeUp: true, ownsBackend: false, hasAuthUrl: false });
  return d.online === true && d.ready === 'probe';
})());

check('R3 壳自拉后端 + 探活 200 但还没 `dsh web:` 行 → 必须继续等（本次事故的修复点）', (() => {
  const d = decide({ probeUp: true, ownsBackend: true, hasAuthUrl: false, probeUpSince: 1_000_000 });
  return d.online === false && d.ready === 'waiting-tree';
})());

check('R4 等满兜底上限仍没有那行 → 退回历史行为上线（反例：上游改格式也不能把壳卡死在离线页）', (() => {
  const d = decide({ probeUp: true, ownsBackend: true, hasAuthUrl: false, probeUpSince: 1_000_000 - FB, now: 1_000_000 });
  return d.online === true && d.ready === 'fallback-timeout';
})());

check('R5 拿到 `dsh web:` 行 → 立即在线且 ready=auth-url',
  (() => { const d = decide({ probeUp: true, ownsBackend: true, hasAuthUrl: true }); return d.online && d.ready === 'auth-url'; })());

check('R6 边界：差 1ms 不到上限 → 仍等 / 恰好到上限 → 上线', (() => {
  const early = decide({ probeUp: true, ownsBackend: true, hasAuthUrl: false, probeUpSince: 1_000_000 - FB + 1, now: 1_000_000 });
  const exact = decide({ probeUp: true, ownsBackend: true, hasAuthUrl: false, probeUpSince: 1_000_000 - FB, now: 1_000_000 });
  return early.online === false && exact.online === true;
})());

check('R7 兜底/等待都不影响「探活失败即离线」的优先级',
  decide({ probeUp: false, ownsBackend: true, hasAuthUrl: false, probeUpSince: 0 }).ready === 'not-up');

check('R7b 默认兜底上限 = 20s（改大改小都要在这里留痕）', FB === 20000, String(FB));

// ── R8. 迟到补重载 ──────────────────────────────────────────────────────────
check('R8 只有「兜底上线过 + 本进程没补过」才补重载（auth-url 上线/离线/已补过都为假）',
  r.shouldReloadOnAuthUrl({ isOnline: true, readyKind: 'fallback-timeout', reloaded: false }) === true
  && r.shouldReloadOnAuthUrl({ isOnline: true, readyKind: 'fallback-timeout', reloaded: true }) === false
  && r.shouldReloadOnAuthUrl({ isOnline: true, readyKind: 'auth-url', reloaded: false }) === false
  && r.shouldReloadOnAuthUrl({ isOnline: false, readyKind: 'fallback-timeout', reloaded: false }) === false);

// ── R9. 接线面（防假绿：脚本全过但 main.cjs 没接上）────────────────────────────
const mainSrc = readFileSync(join(shellDir, 'main.cjs'), 'utf8');
check('R9a main.cjs 引用了 readiness.cjs', /require\(['"]\.\/readiness\.cjs['"]\)/.test(mainSrc));
check('R9b main.cjs 在轮询里用 decideOnline 判据', mainSrc.includes('readiness.decideOnline('));
check('R9c main.cjs 在线时把 ready 种类传进 applyBackendState', mainSrc.includes("applyBackendState(true, 'auth-url')"));
check('R9d main.cjs 有「外部后端」判据 spawnsBackend()', mainSrc.includes('spawnsBackend()'));
check('R9e main.cjs 有迟到补重载分支', mainSrc.includes('shouldReloadOnAuthUrl(') && mainSrc.includes('reloadForAuthUrl'));
check('R9f 旧的一行判据已清除（否则修复没生效）',
  !/if \(await isBackendUp\(\)\) await applyBackendState\(true\);/.test(mainSrc));

// ── R10. ready 取值白名单 ───────────────────────────────────────────────────
const READY = new Set(['not-up', 'probe', 'waiting-tree', 'auth-url', 'fallback-timeout']);
const seen = [
  decide({ probeUp: false }).ready,
  decide({ probeUp: true }).ready,
  decide({ probeUp: true, ownsBackend: true }).ready,
  decide({ probeUp: true, ownsBackend: true, hasAuthUrl: true }).ready,
  decide({ probeUp: true, ownsBackend: true, probeUpSince: 1_000_000 - FB }).ready,
];
check('R10 判据返回的 ready 全在白名单内（新增分支记得归类）',
  seen.every((k) => READY.has(k)), seen.join(','));

console.log(failed
  ? `\nverify-shell-readiness: ${failed} 项失败`
  : '\nverify-shell-readiness: 全部通过（判据 8 项 + 接线 6 项；就绪信号 = 后端自报 `dsh web:` 行，兜底 20s）');
process.exit(failed ? 1 : 0);
