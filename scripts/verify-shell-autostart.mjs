#!/usr/bin/env node
// scripts/verify-shell-autostart.mjs — 外壳「开机自启」登记参数回归验证（2026-09-17 建）
//
// ── 为什么需要它（真实事故，主人报障）────────────────────────────────────────
// 主人问「为什么开了自启，起的是 electron 而不是 DSHOME」。盘上实测：
//   HKCU\...\Run 值名 `electron.app.Electron`，值只有 `"...\electron\dist\electron.exe"`。
// 根因＝托盘开关只调 `app.setLoginItemSettings({ openAtLogin })`，Electron 默认登记
// `process.execPath` **且 args 为空** ⇒ 登录时跑 `electron.exe` 空参 = Electron 自带的
// `resources\default_app.asar`（欢迎页），**DSHOME 起不来且完全静默**。
// 判据本体抽成纯函数 `packages/dshome/shell-app/autostart.cjs`；本脚本既锁它、也锁
// main.cjs 的接线（防"脚本绿、主进程没接上"的假绿）。
//
// ── 断言什么 ────────────────────────────────────────────────────────────────
//   A1-A6 判据表：dev 口径 / 安装版口径 / exe 不存在退回 / 含空格必须引号 / 已引号不重复包 / 可读命令
//   W1-W8 接线面：set 与 get 必须带**同一组** path/args；读回自检存在；旧写法不得残留；启动自愈已挂
// 退出码：0 = 全通过；1 = 有断言失败。
//
// 用法：node scripts/verify-shell-autostart.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shellDir = join(repoRoot, 'packages', 'dshome', 'shell-app');
const a = require(join(shellDir, 'autostart.cjs'));

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`ok  ${name}`); return true; }
  failed += 1;
  console.error(`FAIL ${name}${extra ? '  → ' + extra : ''}`);
  return false;
}

const EXEC = 'E:\\DSHOME\\node_modules\\electron\\dist\\electron.exe';
const APPDIR = 'E:\\DSHOME\\packages\\dshome\\shell-app';
const mk = (o) => a.loginItemOptions({ specKind: null, instDir: '', exeExists: () => false, execPath: EXEC, appDir: APPDIR, ...o });

// ── A. 判据表 ───────────────────────────────────────────────────────────────
check('A1 dev：登记 electron.exe + shell-app 目录（与 开发启动.cmd 同一条命令）', (() => {
  const r = mk({});
  return r.path === EXEC && r.args.length === 1 && r.args[0] === APPDIR;
})());

check('A2 安装版：DSHOME.exe 存在时走 exe 身份（名字/图标才是 DSHOME）', (() => {
  const inst = 'C:\\Program Files\\DSHOME';
  const r = mk({ specKind: 'install', instDir: inst, exeExists: () => true });
  return r.path === join(inst, a.APP_LAUNCHER_EXE) && r.args.length === 0;
})());

check('A3 反例·安装版但没有 DSHOME.exe ⇒ 退回 electron+appDir（绝不登记不存在的 exe）', (() => {
  const r = mk({ specKind: 'install', instDir: 'C:\\Program Files\\DSHOME', exeExists: () => false });
  return r.path === EXEC && r.args[0] === APPDIR;
})());

check('A4 反例·含空格的 app 目录必须加引号（不加会被 cmd 拆成两段 ⇒ 起不来）', (() => {
  const spaced = 'C:\\Program Files\\DSHOME\\src\\packages\\dshome\\shell-app';
  const r = mk({ appDir: spaced });
  return r.args[0] === `"${spaced}"` && r.args[0].startsWith('"') && r.args[0].endsWith('"');
})());

check('A5 反例·已带引号的路径不得重复包（`""x""` 是坏命令）', (() => {
  const already = '"C:\\Program Files\\DSHOME\\shell-app"';
  return mk({ appDir: already }).args[0] === already;
})());

check('A6 commandLine 可读且含 exe 与 app 两段', (() => {
  const cmd = a.commandLine(mk({}));
  return cmd.includes('electron.exe') && cmd.includes('shell-app');
})());

check('A7 数据面·真实 shell-app 目录能拼出可用命令', (() => {
  const r = a.loginItemOptions({
    specKind: null, instDir: '', exeExists: () => false,
    execPath: process.execPath, appDir: shellDir,
  });
  return existsSync(shellDir) && r.path === process.execPath && String(r.args[0]).includes('shell-app');
})());

// ── W. 接线面（防假绿：脚本全过但 main.cjs 没接上）────────────────────────────
const mainSrc = readFileSync(join(shellDir, 'main.cjs'), 'utf8');
check('W1 main.cjs 引用了 autostart.cjs', /require\(['"]\.\/autostart\.cjs['"]\)/.test(mainSrc));
check('W2 set 时带上 path/args（本次事故的修点）',
  mainSrc.includes('setLoginItemSettings({ openAtLogin: next, path: opts.path, args: opts.args })'));
check('W3 get 时用**同一组** path/args（否则托盘永远显示 ✗）',
  mainSrc.includes('getLoginItemSettings({ path: opts.path, args: opts.args })'));
check('W4 有读回自检分支（登记后必须读回，不许只"相信"）', mainSrc.includes("autoStart: 'verify-failed'"));
check('W5 托盘状态走 loginItemEnabled() 而非裸 get', mainSrc.includes('const openAtLogin = loginItemEnabled();'));
check('W6 反例·旧的裸写法已清除（残留即修复没生效）',
  !/setLoginItemSettings\(\{ openAtLogin: next \}\);/.test(mainSrc));
check('W7 启动自愈已挂（老坏值不该等到用户手点才消）',
  mainSrc.includes('migrateLegacyLoginItem()') && mainSrc.includes("autoStart: 'legacy-migrated'"));
check('W8 自愈里的重登也带 path/args',
  mainSrc.includes('setLoginItemSettings({ openAtLogin: true, path: opts.path, args: opts.args })'));

console.log(failed
  ? `\nverify-shell-autostart: ${failed} 项失败`
  : '\nverify-shell-autostart: 全部通过（判据 7 项 + 接线 8 项；登记口径 = dev/兜底 electron.exe+appDir，安装版 DSHOME.exe）');
process.exit(failed ? 1 : 0);
