// scripts/install-electron.mjs — 下载 Electron 二进制 + 打 DSHOME 图标补丁。
// pnpm 默认跳过包的 postinstall，electron 的二进制不会被下载，
// 需手动跑一次（或用 ELECTRON_MIRROR 走镜像加速）。用法：node scripts/install-electron.mjs
//
// 为什么紧跟图标补丁：Windows 任务栏按钮图标取「进程 exe 内嵌图标」（BrowserWindow.icon 无效），
// 原封 electron.exe 带的是 Electron 原子图标 → 每次（重）装 electron 后都要重打 DSHOME 图标。
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
};

const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env,
});

if (result.status !== 0) {
  console.error('[install-electron] electron binary download FAILED');
  process.exit(result.status ?? 1);
}
console.log('[install-electron] electron binary ready.');

// ---- DSHOME 图标补丁（Windows）---------------------------------------------
if (process.platform !== 'win32') {
  console.log('[install-electron] 非 Windows：跳过 electron.exe 图标补丁');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const patcher = join(here, 'patch-electron-icon.mjs');
const patched = spawnSync(process.execPath, [patcher], { stdio: 'inherit', cwd: process.cwd() });
// 幂等自检：补丁器写完会自己复核（见 ps1 的 post 校验），这里再读一遍磁盘确认"exe 真带 DSHOME 图标"。
// 为什么要在 setup 链里硬失败（2026-09-12）：clone 出来的机器 node_modules 不跟踪 ⇒ 必然重下原版
// electron.exe；补丁一旦没跑/跑一半，任务栏就会一直显示 Electron 原子图标，而此前这里只 WARN、
// 退出码仍是 0 ⇒ setup-dev.cmd 照样报"环境就绪"，问题要等使用者自己发现。改为失败即 exit 1。
const verify = patched.status === 0
  ? spawnSync(process.execPath, [patcher, '--verify-only', '--quiet'], { stdio: 'inherit', cwd: process.cwd() })
  : { status: patched.status ?? 1 };

// 清掉「正在运行的 exe 锁住 → 换名规避」留下的旧二进制（best-effort；运行中的进程仍映射它时删不掉）
const stale = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe.pre-icon-replacement');
if (existsSync(stale)) {
  try {
    rmSync(stale, { force: true });
    console.log('[install-electron] removed displaced exe: ' + stale);
  } catch {
    console.log('[install-electron] displaced exe still locked (clean after closing DSHOME): ' + stale);
  }
}

if (patched.status !== 0 || verify.status !== 0) {
  console.error('[install-electron] FAIL: electron.exe 图标补丁失败/未生效——任务栏会显示 Electron 图标。');
  console.error('[install-electron] 先关掉 DSHOME（它锁着 dist\\electron.exe）再重跑：node scripts/install-electron.mjs');
  console.error('[install-electron] 仅补图标：pnpm run patch:icon   ／ 只体检：node scripts/patch-electron-icon.mjs --verify-only');
  process.exit(1);
}
console.log('[install-electron] DSHOME 图标已内置并由磁盘复核通过。');
