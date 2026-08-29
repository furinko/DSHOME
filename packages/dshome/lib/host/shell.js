// dshome/shell — DSHOME 薄壳 host 插件（Phase 2）。
//
// 职责：后端就绪后 spawn Electron 窗口应用（shell-app），并维持与壳的
// 生命周期关系（壳关 = 后端退出时随关；后端被杀 = 壳自动切离线页）。
//
// 护栏（DSHOME-DESIGN.md §13.5）：全程 try/catch，electron 缺装/启动失败
// 只记日志，绝不阻断 profile 启动。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (row: `name: dshome/shell`). */
export const name = 'dshome-shell';

/** 官方 webserver 默认端口 3080；DSHOME 用专属默认 3081（补丁 webserver 行兜底一致）。 */
const DEFAULT_PORT = 3081;
/** 本地通知监听端口（壳内 POST /notify；0 = 关闭）。 */
const NOTIFY_PORT = Number(process.env.DSHOME_NOTIFY_PORT || 32123);

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_APP_DIR = path.resolve(HERE, '../../shell-app');

let child = null;
let started = false;

function backendUrl(ctx) {
  // 按官方 localWebUrl 的思路：webServer 服务持有真实绑定端口
  // （默认 3080 / --port N / --port 0 由系统分配都能答对）。
  const port = (() => {
    try {
      const ws = ctx.get?.('webServer');
      if (ws && typeof ws.port === 'number' && ws.port > 0) return ws.port;
    } catch { /* fall through */ }
    try {
      const ws2 = ctx.get?.('webStartup');
      if (ws2 && typeof ws2.port === 'number' && ws2.port > 0) return ws2.port;
    } catch { /* fall through */ }
    return DEFAULT_PORT;
  })();
  return `http://127.0.0.1:${port}`;
}

function electronPath() {
  try {
    // electron 是 dshome 包的本地依赖（E:\DSH\dshome\node_modules）；
    // 该包 main 导出 ELECTRON 可执行文件的路径字符串。
    return require('electron');
  } catch (error) {
    throw new Error(`dshome/shell: electron is not installed in the dshome package (npm i -D electron in E:\\DSH\\dshome): ${String(error)}`);
  }
}

function spawnShell(url) {
  if (started) return;
  try {
    const electronBin = electronPath();
    const env = {
      ...process.env,
      DSHOME_URL: url,
      DSHOME_NOTIFY_PORT: String(NOTIFY_PORT),
      // 供壳在"退出"时一并结束后端进程
      DSHOME_BACKEND_PID: String(process.pid),
    };
    // dsh.cmd 封装会把 ELECTRON_RUN_AS_NODE 带入环境；GUI 模式下必须清除，
    // 否则 Electron 会以 node 模式运行而不是开窗口。
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(electronBin, [SHELL_APP_DIR], {
      env,
      stdio: 'ignore',
      windowsHide: false,
      // detached: 独立进程组——后端进程退出/被杀时窗口不随之消亡，
      // 由壳自身按活性监测切换到离线页并等待后端恢复。
      detached: true,
    });
    child.unref();
    started = true;
    child.on('error', (error) => {
      started = false;
      ctxLogger?.warn('dshome/shell: electron spawn failed: %O', error);
    });
    child.on('exit', () => { started = false; });
  } catch (error) {
    ctxLogger?.warn('dshome/shell: disabled itself: %O', error);
  }
}

let ctxLogger = null;

/** @param {import('@deepseek-ai/cordis').Context} ctx - host context */
export function apply(ctx) {
  ctxLogger = ctx.logger?.(name) ?? ctx.logger;
  try {
    // 树稳定后（webServer 已绑定）再解析 URL 并拉起窗口。
    setTimeout(() => spawnShell(backendUrl(ctx)), 1500);
  } catch (error) {
    ctxLogger?.warn('dshome/shell: disabled itself: %O', error);
  }
}