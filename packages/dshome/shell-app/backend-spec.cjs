'use strict';
// DSHOME shell「后端规格」dev 兜底 —— 纯函数，可脱离 Electron 用 node 直接回归
// （回归脚本：scripts/verify-shell-autostart.mjs 的 B 段；调用方：shell-app/main.cjs）
//
// ── 为什么需要（2026-09-18 实测事故，主人报障）──────────────────────────────
// 「开机自启是 DSHOME 了，但是后端连不上，需要关托盘重新启动」。
// `DSHOME_BACKEND_CMD` **只由 `开发启动.cmd` 设置**；而开机自启登记的是
// `electron.exe "<shell-app>"`（Run 项没有环境变量）⇒ 壳的 `resolveBackendSpec()` 返回 null
// ⇒ 本该"守护后端"的壳只当 UI 客户端，**一个后端都不拉**。日志实证：
//   `2026-09-18T00:58:26Z loadInitial` → 一连串 `ERR_CONNECTION_REFUSED`
//   `2026-09-18T01:04:42Z {"backend":"no-spec"}`（托盘「重启后端」也只打这行）
//   `2026-09-18T01:09:39Z backend start → spawn → 15s boot-ok → online`（改用启动器重开才行）
// ⇒ 上一处自启修复只走完一半：确实起了 DSHOME（不再是裸 Electron），但**起的那个 DSHOME 找不到后端**。
//
// ── 兜底口径（与 `开发启动.cmd` 等价）──────────────────────────────────────
//   仓库根 = shell-app 上溯三级；node = setup-dev 装的 dev 运行时（否则退回 PATH 上的 node）；
//   CLI = <repo>/node_modules/@deepseek-ai/dsh/lib/bin.js（**存在才认**，避免认错目录乱起后端）。
//   ⚠️ 调用方还必须把 spawn 的 **cwd 设为仓库根**：登录启动时进程 cwd 是系统目录，而后端的
//   `process.cwd()` 决定 workspaceRoot 与**记忆的项目 key（= cwd 目录名）**——cwd 错 = 项目隔离错。

const { join } = require('node:path');

/**
 * dev 兜底规格。所有外部事实由调用方注入（纯函数）。
 * @param {object} input - 输入事实。
 * @param {string} input.repoDir - 仓库根（shell-app 上溯三级）。
 * @param {number} [input.port] - 后端端口。
 * @param {string} [input.localAppData] - `%LOCALAPPDATA%`（找 setup-dev 装的 node）。
 * @param {(p:string)=>boolean} [input.fileExists] - 判定路径存在（注入以便单测）。
 * @returns {{kind:'cmd', cmd:string, cwd:string}|null} 规格；认不出 CLI 时 null（不许硬编命令）。
 */
function devBackendSpec(input) {
  const repoDir = input?.repoDir ?? '';
  const port = input?.port ?? 3099;
  const localAppData = input?.localAppData ?? '';
  const fileExists = typeof input?.fileExists === 'function' ? input.fileExists : () => false;
  if (!repoDir) return null;
  const cliBin = join(repoDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  // 🔴 反例（写不出反例＝没验过）：CLI 不存在时必须返回 null，**不许**硬编一条命令去起一个
  //    不存在的后端（那只是把"没规格"换成"起不来还反复重启"）。
  if (!fileExists(cliBin)) return null;
  const devNode = localAppData ? join(localAppData, 'dshome-dev', 'node', 'node.exe') : '';
  const nodeExe = devNode && fileExists(devNode) ? devNode : 'node';
  return {
    kind: 'cmd',
    cmd: `"${nodeExe}" "${cliBin}" --profile dshome --no-open --port ${port}`,
    cwd: repoDir,
  };
}

/**
 * 自启壳给后端进程的环境（纯函数，可脱离 Electron 直接回归）。
 *
 * ── 为什么必须有它（2026-09-21 实测事故，主人报障「开机自启报错，手动启动没问题」）──
 * 注册表 `…\Run` 项拉起壳时**不带任何环境变量**；而 `DSH_HOME` 决定 `resolveDshHome()`
 * 的落点（`@deepseek-ai/dsh-home-paths` 优先级：显式配置 > `$DSH_HOME` > `~/.dsh`）
 * ⇒ 缺它时后端去 `~\.dsh\profiles\dshome` 找 profile，**那里没有** ⇒ 后端连崩三次 →
 * fail-loud 弹窗「DSHOME 后端异常退出」，主人只能用 `开发启动.cmd` 手动重开（那条链设了 DSH_HOME）。
 * 盘上实证：清空 DSH_HOME + cwd=仓库根跑 CLI ⇒ **逐字复现**同一句
 *   `Error: dsh: profile "dshome" does not exist; create it with 'dsh plugin --profile dshome add <package>'`；
 * 给上 DSH_HOME 后 profile 目录 `E:\DSHOME\profiles\dshome` 存在。
 * 安装版分支（main.cjs `resolveBackendSpec`）本来就有同款注入（`DSH_HOME: instDir`）——dev 兜底漏了。
 * 口径与 `开发启动.cmd` 第 6 行 `set "DSH_HOME=%~dp0"` 等价。
 * @param {Record<string, string|undefined>} processEnv - 壳自己的环境（登录自启时缺 DSH_HOME）。
 * @param {string} repoDir - 仓库根；本 dev 布局下它就是 `DSH_HOME`。
 * @returns {Record<string, string|undefined>} 后端 spawn 用的环境对象。
 */
function devBackendEnv(processEnv, repoDir) {
  // 壳自己的环境必须**原样带过去**（PATH / DSHOME_NOTIFY_PORT 等），只覆盖 DSH_HOME 一个键。
  return { ...(processEnv ?? {}), DSH_HOME: repoDir };
}

module.exports = { devBackendSpec, devBackendEnv };
