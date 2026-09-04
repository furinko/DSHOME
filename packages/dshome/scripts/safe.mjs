#!/usr/bin/env node
// DSHOME 恢复模式（Phase 1+）：用 --patch 覆盖层临时禁用全部自有插件启动，
// 判定崩溃来源（设计见历史文档 §13.5 L2 / §9.1 铁律，已归档）。不改任何配置、不删代码。
// 用法：node scripts/safe.mjs [--port <port>]
//
// v2（2026-09-05）：自有插件清单改为【从 cordis.patch.yml 动态解析】，不再手维护——
// 静态清单曾漏掉 mind 系插件（mind/mind-inject/mind-guard/mind-recall），
// 导致崩溃源是 mind 插件时安全模式兜不住（形同虚设）。现以 cordis.patch.yml 为准，
// 新增插件自动纳入；dshome- 前缀天然排除官方覆盖行（web-runtime/webserver 等）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '3099';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/** 从 cordis.patch.yml 动态解析全部自有插件 id（dshome- 前缀；含 disabled 行如 dshome-desktop）。 */
function ownPluginIds() {
  const patchFile = join(repoRoot, 'packages', 'dshome', 'cordis.patch.yml');
  if (!existsSync(patchFile)) {
    console.error('[safe] 找不到 cordis.patch.yml:', patchFile);
    process.exit(1);
  }
  const text = readFileSync(patchFile, 'utf8');
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*- id:\s*(dshome[\w-]+)\s*$/.exec(line.trim());
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  if (!ids.length) {
    console.error('[safe] cordis.patch.yml 未解析到任何 dshome 插件 id——请检查 patch 格式');
    process.exit(1);
  }
  return ids;
}

const ids = ownPluginIds();
const dir = mkdtempSync(join(tmpdir(), 'dshome-safe-'));
const overlay = join(dir, 'safe.yml');
const rows = [
  '# DSHOME safe-mode overlay: disable every own plugin row.',
  ...ids.map((id) => `- id: ${id}\n  disabled: true`),
  '',
];
writeFileSync(overlay, rows.join('\n'), 'utf8');
console.log(`[safe] 动态解析到 ${ids.length} 个自有插件: ${ids.join(', ')}`);

// 用当前 node + 仓库内 dsh bin.js 直跑，不依赖 PATH 里的 dsh 命令。
const dshBin = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const child = spawn(process.execPath, [dshBin, '--profile', 'dshome', '--patch', overlay, '--no-open', '--port', port], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
