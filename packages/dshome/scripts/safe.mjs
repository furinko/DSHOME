#!/usr/bin/env node
// DSHOME 恢复模式（Phase 1+）：用 --patch 覆盖层临时禁用全部自有插件启动，
// 判定崩溃来源（DSHOME-DESIGN.md §13.5 L2 / §9.1 铁律）。不改任何配置、不删代码。
// 用法：node scripts/safe.mjs [--port <port>]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '3081';

// 自有插件全清单（与 dshome 包 cordis.patch.yml 的 insert 行一一对应）
const OWN_PLUGIN_IDS = [
  'dshome-core',
  'dshome-shell',
  'dshome-theme',
  'dshome-palette',
  'dshome-notify',
  'dshome-plugin-manager',
  'dshome-desktop',
];

const dir = mkdtempSync(join(tmpdir(), 'dshome-safe-'));
const overlay = join(dir, 'safe.yml');
const rows = [
  '# DSHOME safe-mode overlay: disable every own plugin row.',
  ...OWN_PLUGIN_IDS.map((id) => `- id: ${id}\n  disabled: true`),
  '',
];
writeFileSync(overlay, rows.join('\n'), 'utf8');

const child = spawn('dsh', ['--profile', 'dshome', '--patch', overlay, '--no-open', '--port', port], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
