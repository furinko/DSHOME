'use strict';
// DSHOME shell「后端就绪」判据 —— 纯函数，可脱离 Electron 用 node 直接回归
// （回归脚本：scripts/verify-shell-readiness.mjs；调用方：shell-app/main.cjs）
//
// ── 为什么需要它（2026-09-17 实测事故）────────────────────────────────────────
// 主人报「每次开电脑第一次打开 DSHOME，后端连很久，而且首屏什么工作区都没有，刷新一下才好」。
// 根因是壳的在线判据与后端的真实就绪点错位：
//   · dsh 0.1.5 起 `/` 有一次性 token 鉴权，但会换成**持久 cookie**（默认 30 天，
//     dsh-client-connection/lib/index.js:740）。cookie 一旦存在，**裸 URL 早就 200**。
//   · 而 `@deepseek-ai/dsh-host-frontend-static` 的 inject 只有 [webServer, connection]，
//     它一挂上 `/` 就能服务 —— 此时 dsh 插件树**远未挂完**：web-app 层里 connection 之后
//     还有 44 行（含 ui-sidebar / ui-conversation / ui-workspace），profile 自有插件更晚。
//   · 首屏的浏览器插件花名册 `window.__DSH_BOOT__` 是**按请求那一刻已建 fiber 的行**注入的
//     （dsh-client-modules/lib/index.js:775-781 跳过 fiber 未建的行；index 每请求现渲染），
//     所以早到的首屏必然缺插件；此外半就绪 host 会让工作区那条 follow 流**终局失败且不重建**
//     （dsh-api-workspace-controller 客户端 model：初值 items=[]，只有流能填）。
//   · 后端自己的就绪信号是 stdout 那行 `dsh web: <带 token URL>`：它打印在
//     `loader.await()`（整棵树挂完）之后（dsh-web-app/lib/index.js:212-216）—— 日志实测
//     首次 200 比这行早 1.5~2.4s，冷启动时窗口更大。
// 结论：外壳自己拉起后端时，**必须等到 `dsh web:` 行才算在线**；同时保留一条兜底，
// 万一上游改了那行的格式也不会让壳永远停在离线页。
//
// ── 判据 ────────────────────────────────────────────────────────────────────
//   ownsBackend=false（后端由外部拉起，壳只是 UI 客户端）→ 永远拿不到 URL 行，
//     保持历史行为：探活 2xx 即在线（probe）。
//   ownsBackend=true → 必须 hasAuthUrl（auth-url）；探活首次成功起算等满 fallbackMs
//     仍未拿到 URL 行 → 退回历史行为（fallback-timeout），并在 URL 行迟到时补一次重载。

/** 兜底等待上限：探活成功后仍没等到 `dsh web:` 行的最长容忍时间（ms）。 */
const DEFAULT_FALLBACK_MS = 20000;

/**
 * 判定当前是否可以把窗口切到在线页。
 * @param {object} input - 判据输入。
 * @param {boolean} input.probeUp - 本次探活是否返回 2xx。
 * @param {boolean} input.ownsBackend - 壳自己负责拉起后端（能拿到 `dsh web:` 行）。
 * @param {boolean} input.hasAuthUrl - 是否已捕获后端自报的 `dsh web:` 行。
 * @param {number|null} input.probeUpSince - 探活**连续**成功的起始时刻（ms）；未成功传 null。
 * @param {number} input.now - 当前时刻（ms）。
 * @param {number} [input.fallbackMs] - 兜底上限，默认 {@link DEFAULT_FALLBACK_MS}。
 * @returns {{online: boolean, ready: 'probe'|'auth-url'|'fallback-timeout'|'waiting-tree'|'not-up'}}
 */
function decideOnline(input) {
  const { probeUp, ownsBackend, hasAuthUrl, probeUpSince, now } = input;
  const fallbackMs = input.fallbackMs === undefined ? DEFAULT_FALLBACK_MS : input.fallbackMs;
  if (!probeUp) return { online: false, ready: 'not-up' };
  if (!ownsBackend) return { online: true, ready: 'probe' };
  if (hasAuthUrl) return { online: true, ready: 'auth-url' };
  const waitedMs = typeof probeUpSince === 'number' ? now - probeUpSince : 0;
  if (waitedMs >= fallbackMs) return { online: true, ready: 'fallback-timeout' };
  return { online: false, ready: 'waiting-tree' };
}

/**
 * URL 行迟到时是否要补一次重载：只有「已靠兜底上线过」这一次需要，
 * 且每个后端进程只补一次（防同一个 token 反复重载）。
 * @param {object} input - 状态输入。
 * @param {boolean} input.isOnline - 窗口当前是否已在线。
 * @param {string|null} input.readyKind - 当前在线是靠哪种判据上来的。
 * @param {boolean} input.reloaded - 本后端进程是否已补过重载。
 * @returns {boolean} 是否应重载。
 */
function shouldReloadOnAuthUrl(input) {
  return input.isOnline === true && input.readyKind === 'fallback-timeout' && input.reloaded !== true;
}

module.exports = { DEFAULT_FALLBACK_MS, decideOnline, shouldReloadOnAuthUrl };
