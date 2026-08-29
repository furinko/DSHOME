// scripts/install-electron.mjs — 下载 Electron 二进制。
// pnpm 默认跳过包的 postinstall，electron 的二进制不会被下载，
// 需手动跑一次（或用 ELECTRON_MIRROR 走镜像加速）。用法：node scripts/install-electron.mjs
import { spawnSync } from 'node:child_process';

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
