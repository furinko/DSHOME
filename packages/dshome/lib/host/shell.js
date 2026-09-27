// dshome/shell — DSHOME 薄壳 host 插件（Phase 2）。
//
// 职责：后端就绪后 spawn Electron 窗口应用（shell-app），并维持与壳的
// 生命周期关系（壳关 = 后端退出时随关；后端被杀 = 壳自动切离线页）。
//
// 护栏（设计见历史文档，已归档）：全程 try/catch，electron 缺装/启动失败
// 只记日志，绝不阻断 profile 启动。
//
// 🔴 2026-09-27 补两道闸（主人报障「DSHOME 自动切到前台」的根因）：
//   本插件的 apply() 会 spawn 一个真 Electron 壳，而 `scripts/verify-host-plugins.mjs`
//   （pre-commit 钩子第 ③ 步）会对**每个** host 插件真调一次 apply() ⇒ **每次 git commit
//   都多起一个壳**。已有壳在跑时它抢不到单实例锁就退出，但退出前会给已有壳发
//   `second-instance`，壳把它处理成 `restore + show + focus` ⇒ 窗口被拽到前台；
//   壳已经不在了（主人刚关掉）⇒ 这一下直接把窗口开出来，还顺手拉起后端。
//   两道闸 = ① 环境开关（验证器/门禁进程用）② 端口探针（已有壳就不起）。见 apply()。

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (row: `name: dshome/shell`). */
export const name = 'dshome-shell';

/** 官方 webserver 默认端口 3080；DSHOME 专属默认 3099（补丁 webserver 行兜底一致；launcher 显式 --port 3099，旧基线 3081 已弃）。 */
const DEFAULT_PORT = 3099;
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
  const base = `http://127.0.0.1:${port}`;
  // 🔴 0.1.5 起根路径启用**一次性 token 鉴权**：裸 URL 返回 401，而 shell-app 的
  // 存活探测（isBackendUp 的 GET）与窗口加载都用这个 URL → 壳会一直停在离线页
  // （症状：后端明明活着，窗口却「后端未连接」）。
  // 优先向官方 `connection` 服务要「已鉴权 URL」——与 web-app 打印 `dsh web: …?token=` 同源。
  try {
    const conn = ctx.get?.('connection');
    const target = conn?.connection ?? conn;
    const make = target?.authenticatedUrl;
    if (typeof make === 'function') {
      const authed = make.call(target, base);
      if (typeof authed === 'string' && authed) return authed;
    }
  } catch { /* 拿不到就退回裸 URL（= 旧版行为；新版会 401，壳显示离线页） */ }
  return base;
}

function electronPath() {
  try {
    // electron 是 dshome 包的本地依赖（dshome/node_modules 下）；
    // 该包 main 导出 ELECTRON 可执行文件的路径字符串。
    return require('electron');
  } catch (error) {
    throw new Error(`dshome/shell: electron is not installed in the dshome package (npm i -D electron, or run scripts/install-electron.mjs): ${String(error)}`);
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

/** 端口上有没有东西在听 = **已经有壳在跑**（壳在 NOTIFY_PORT 上开 /sounds 与 /notify）。
 *  只做 TCP 可连判断，不解析 HTTP：口子在听就够了，没必要起第二个壳。
 *  正常首启（没有壳）时 connect 立刻 ECONNREFUSED ⇒ 零额外等待、行为与旧版一致。 */
function portListening(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    if (!(port > 0)) { resolve(false); return; } // 0 = 通知口关闭 ⇒ 探不到，按旧行为起壳
    const sock = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - host context */
export function apply(ctx) {
  ctxLogger = ctx.logger?.(name) ?? ctx.logger;
  try {
    // 闸 ①：验证器/门禁进程**不该有"开窗口"的副作用**。
    //   `scripts/verify-host-plugins.mjs` 在调 apply() 前设 `DSHOME_SHELL_NO_SPAWN=1`。
    if (process.env.DSHOME_SHELL_NO_SPAWN === '1') {
      ctxLogger?.info?.('dshome/shell: spawn skipped (DSHOME_SHELL_NO_SPAWN=1)');
      return;
    }
    // 树稳定后（webServer 已绑定）再解析 URL 并拉起窗口。
    setTimeout(async () => {
      // 闸 ②：已经有壳在跑就别再起（见 portListening 注释：多出来的那个壳会把窗口拽到前台）。
      if (await portListening(NOTIFY_PORT)) {
        ctxLogger?.info?.(`dshome/shell: spawn skipped (a shell is already listening on port ${NOTIFY_PORT})`);
        return;
      }
      spawnShell(backendUrl(ctx));
    }, 1500);
  } catch (error) {
    ctxLogger?.warn('dshome/shell: disabled itself: %O', error);
  }
}