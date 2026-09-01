#!/usr/bin/env node
// DSHOME 开发循环（Phase 1）：启动 `dsh --profile dshome`，headless 浏览器验证。
// 用法：node scripts/dev.mjs [--port <port>]
// 默认端口 3099（DSHOME 专属；与官方 web 3080 错开；旧基线 3081 已弃，2026-09-01 对齐）。
import { spawn } from 'node:child_process';

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '3099';

const child = spawn('dsh', ['--profile', 'dshome', '--no-open', '--port', port], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});