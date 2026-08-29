#!/usr/bin/env node
// DSHOME 开发循环（Phase 1）：启动 `dsh --profile dshome`，headless 浏览器验证。
// 用法：node scripts/dev.mjs [--port <port>]
// 默认端口 3081，与现有 web profile（43120）并存互不干扰。
import { spawn } from 'node:child_process';

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '3081';

const child = spawn('dsh', ['--profile', 'dshome', '--no-open', '--port', port], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});