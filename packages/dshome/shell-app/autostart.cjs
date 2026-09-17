'use strict';
// DSHOME shell「开机自启」登记参数 —— 纯函数，可脱离 Electron 用 node 直接回归
// （回归脚本：scripts/verify-shell-autostart.mjs；调用方：shell-app/main.cjs）
//
// ── 为什么需要它（2026-09-17 实测事故）────────────────────────────────────────
// 托盘开关原来只调 `app.setLoginItemSettings({ openAtLogin: next })`。Electron 的默认行为是
// 登记 `process.execPath`（**且 args 为空**），而 DSHOME 的外壳进程在 dev 与装机版里都是
// `node_modules\electron\dist\electron.exe`（装机版的 DSHOME.exe 只是启动器模具，
// process.execPath 仍是 electron.exe）⇒ 盘上实测：
//     值名 `electron.app.Electron`（Electron 的默认 AUMID —— 主人看到的"electron"）
//     值   `"...\node_modules\electron\dist\electron.exe"` —— **没有 app 参数**
// 于是登录时执行的是 electron.exe 空参 ⇒ 走 Electron 自带的 `resources\default_app.asar`
// （Electron 欢迎页），**DSHOME 根本不会启动**——"开了自启反而起不来"，且完全静默。
//
// ── 正确命令 ────────────────────────────────────────────────────────────────
//   dev / 兜底：`<electron.exe> "<shell-app 目录>"`（与 `开发启动.cmd` 同一条命令）
//   安装版    ：`<install>\DSHOME.exe`（走 exe 身份，名字与图标都是 DSHOME）
//   args 里的路径**含空格时必须加引号**（Electron 文档要求：不 quote 会被 cmd 拆段；本模块按需加）。
//   ⚠️ 注册表**值名**由 Electron 自己的应用身份决定（实测 `electron.app.Electron`，与 path 无关），
//     无法自定义 ⇒ 修好后的登记会**覆盖同名坏值**；想让它显示 DSHOME 得动 app.setName/AUMID，
//     而那会牵动 userData 路径（日志/状态/浏览器 cookie 搬家），属另一件事。

const { join } = require('node:path');

/** 装机版启动器 exe 名（安装器 `[Icons]`/`[Run]` 用的就是它）。 */
const APP_LAUNCHER_EXE = 'DSHOME.exe';

/** 路径含空格时包一层双引号；已带引号的**不再重复包**（防 `""x""` 这种坏命令）。 */
function quoteArg(value) {
  const text = String(value ?? '');
  if (text === '') return '""';
  if (text.startsWith('"') && text.endsWith('"')) return text;
  return /\s/.test(text) ? `"${text}"` : text;
}

/**
 * 组装 setLoginItemSettings 用的 path/args。纯函数：所有外部事实由调用方注入。
 * @param {object} input - 输入事实。
 * @param {string|null} [input.specKind] - `'install'` = 安装布局；其余/空 = dev 或未知。
 * @param {string} [input.instDir] - 安装根目录（`specKind==='install'` 时有效）。
 * @param {(p:string)=>boolean} [input.exeExists] - 判定 exe 是否存在（注入以便单测）。
 * @param {string} [input.execPath] - `process.execPath`（外壳跑的 electron.exe）。
 * @param {string} [input.appDir] - shell-app 目录（= main.cjs 的 `__dirname`，即 app 参数）。
 * @returns {{path: string, args: string[]}} 登记参数。
 */
function loginItemOptions(input) {
  const specKind = input?.specKind ?? null;
  const instDir = input?.instDir ?? '';
  const exeExists = typeof input?.exeExists === 'function' ? input.exeExists : () => false;
  const execPath = input?.execPath ?? '';
  const appDir = input?.appDir ?? '';
  if (specKind === 'install' && instDir) {
    const exe = join(instDir, APP_LAUNCHER_EXE);
    // 🔴 只登记**真实存在**的 exe：登记一个不存在的路径只是换一种静默失败（登录时什么都不发生）。
    if (exeExists(exe)) return { path: exe, args: [] };
  }
  return { path: execPath, args: [quoteArg(appDir)] };
}

/** 人类可读的命令行（日志与失败弹窗用）。 */
function commandLine(options) {
  const args = Array.isArray(options?.args) ? options.args : [];
  return [quoteArg(options?.path ?? ''), ...args].join(' ').trim();
}

module.exports = { APP_LAUNCHER_EXE, quoteArg, loginItemOptions, commandLine };
