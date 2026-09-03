// DSHOME shell — Electron main process (v0.2.0).
// 崩溃保护自包含：壳（本进程）是后端的唯一守护者，零外部依赖（不依赖任何外部 watchdog/计划任务）。
// - 单实例锁（二次启动只聚焦已有窗口）
// - 后端生命周期：壳负责启动 / 3s 探活 / 挂了自动重启（指数退避）/ 安全模式 / fail-loud 错误弹窗
// - 窗口加载 DSHOME 后端 URL；后端挂 → 离线页；后端恢复 → 自动加载 UI
// - 系统托盘：显示窗口 / 刷新页面 / 重启后端 / 安全模式重启 / 开机自启 / 退出
// - 本地通知监听（DSHOME_NOTIFY_PORT，POST /notify {title, body}）
// - 观测日志：%APPDATA%\dshome-shell\dshome-shell.log
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const updater = require('./updater.cjs');

// ---- 配置 ----
const DEFAULT_PORT = 3099;
const POLL_MS = 3000;
const BOOT_GRACE_MS = 15000;          // 后端启动宽限期：撑过 = 启动成功，重置失败计数
const RESTART_DELAYS = [1000, 3000, 10000, 30000]; // 指数退避序列（ms）
const MAX_CONSECUTIVE_FAILS = 3;      // 连续启动失败次数 → 弹窗建议安全模式
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const STATE_FILE = path.join(app.getPath('userData'), 'dshome-shell-state.json');
const LOG_FILE = path.join(app.getPath('userData'), 'dshome-shell.log');
const SAFE_OVERLAY_FILE = path.join(app.getPath('userData'), 'dshome-safe.yml');
const ICON_FILE = path.join(__dirname, 'icon-official.png');
const TRAY_ICON_FILE = path.join(__dirname, 'tray-official.png');
const WINDOW_TITLE = 'DSHOME';

function targetUrl() {
  return process.env.DSHOME_URL || `http://127.0.0.1:${backendPort()}`;
}
function backendPort() {
  return Number(process.env.DSHOME_PORT || DEFAULT_PORT);
}

// ---- 后端规格解析 ----
// 优先级：环境变量 DSHOME_BACKEND_CMD（开发/测试）> 安装版 install.env（向上遍历查找）
function findInstallEnv() {
  // 安装布局：<install>\install.env 与 <install>\src\packages\dshome\shell-app（本目录）
  // 从本目录向上最多找 6 级（兼容旧布局 packages\dshome\install.env）
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, 'install.env');
    if (fs.existsSync(f)) return f;
    dir = path.dirname(dir);
  }
  return null;
}

function resolveBackendSpec() {
  const envCmd = process.env.DSHOME_BACKEND_CMD;
  if (envCmd) return { kind: 'cmd', cmd: envCmd, env: { ...process.env } };
  const envFile = findInstallEnv();
  if (envFile) {
    try {
      const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
      const instDir = (lines[1] || '').trim();
      const profDir = (lines[2] || '').trim();
      if (instDir && profDir) {
        const nodeExe = path.join(instDir, 'runtime', 'node.exe');
        const cliBin = path.join(profDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
        if (fs.existsSync(nodeExe) && fs.existsSync(cliBin)) {
          return { kind: 'install', instDir, profDir, nodeExe, cliBin, env: { ...process.env, DSH_HOME: instDir } };
        }
      }
    } catch { /* 忽略坏 env 文件 */ }
  }
  return null; // 无法解析 → 壳只做 UI 客户端（后端由外部启动）
}

// ---- 日志 ----
function logLine(entry) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch { /* ignore */ }
}

// ---- 状态 ----
let window = null;
let tray = null;
let isOnline = false;
let pollTimer = null;
let quitting = false;

// 后端管理
let backend = null;
let restartCount = 0;
let restartTimer = null;
let bootWatchTimer = null;
let stderrBuffer = '';
// 初始安全模式：DSHOME_SAFE_MODE=1 时壳以 --patch 覆盖层禁全部自有插件启动（命令行入口/自动化测试）
let safeMode = process.env.DSHOME_SAFE_MODE === '1';

function state() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...patch }, null, 2)); } catch { /* ignore */ }
}

// ---- 后端生命周期 ----
function safeOverlayContent() {
  // 禁用全部自有插件（对应 dshome 包 cordis.patch.yml 的 7 行）
  const ids = [
    'dshome-core',
    'dshome-shell',
    'dshome-theme',
    'dshome-palette',
    'dshome-notify',
    'dshome-plugin-manager',
    'dshome-desktop',
  ];
  return [
    '# DSHOME safe-mode overlay: disable every own plugin row.',
    ...ids.map((id) => `- id: ${id}\n  disabled: true`),
    '',
  ].join('\n');
}

function writeSafeOverlay() {
  try { fs.writeFileSync(SAFE_OVERLAY_FILE, safeOverlayContent(), 'utf8'); }
  catch (e) { logLine({ safeOverlayError: String(e?.message ?? e) }); }
}

function startBackend() {
  if (backend) return;
  const spec = resolveBackendSpec();
  if (!spec) {
    logLine({ backend: 'no-spec' }); // 无法解析后端规格：只做 UI 客户端
    return;
  }
  stderrBuffer = '';
  logLine({ backend: 'start', safe: safeMode, count: restartCount });
  if (safeMode) writeSafeOverlay();
  try {
    if (spec.kind === 'cmd') {
      // 开发/测试：DSHOME_BACKEND_CMD 是完整命令行（node + 参数）
      backend = spawn(spec.cmd, { shell: true, windowsHide: true, env: spec.env, stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      const args = [spec.cliBin, '--profile', 'dshome', '--no-open', '--port', String(backendPort())];
      if (safeMode) args.push('--patch', SAFE_OVERLAY_FILE);
      backend = spawn(spec.nodeExe, args, { windowsHide: true, env: spec.env, stdio: ['ignore', 'ignore', 'pipe'] });
    }
  } catch (e) {
    logLine({ backend: 'spawn-error', error: String(e?.message ?? e) });
    backend = null;
    return;
  }
  backend.stderr?.on('data', (d) => {
    stderrBuffer = (stderrBuffer + d.toString()).slice(-4000);
  });
  backend.on('exit', (code, signal) => {
    logLine({ backend: 'exit', code, signal, safe: safeMode, errTail: stderrBuffer.split('\n').slice(-8).join('\n') });
    backend = null;
    if (quitting) return;
    scheduleRestart();
  });
  // 启动宽限：撑过 BOOT_GRACE_MS 视为启动成功
  clearTimeout(bootWatchTimer);
  bootWatchTimer = setTimeout(() => {
    if (backend && backend.exitCode === null) {
      restartCount = 0;
      logLine({ backend: 'boot-ok' });
    }
  }, BOOT_GRACE_MS);
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartCount += 1;
  const idx = Math.min(restartCount - 1, RESTART_DELAYS.length - 1);
  const delay = RESTART_DELAYS[idx];
  logLine({ backend: 'restart-scheduled', delay, count: restartCount });
  if (restartCount >= MAX_CONSECUTIVE_FAILS && process.env.DSHOME_FAIL_LOUD !== '0') {
    // fail-loud：连续启动失败 → 弹窗询问（重试 / 安全模式 / 取消）
    // DSHOME_FAIL_LOUD=0 时跳过弹窗（自动化测试用），直接按「重试」继续退避
    const errTail = stderrBuffer.split('\n').slice(-6).join('\n');
    try {
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'DSHOME 后端启动失败',
        message: `后端连续 ${restartCount} 次启动失败，可能由插件或配置损坏引起。`,
        detail: errTail ? `最近错误：\n${errTail}` : '（无错误输出）',
        buttons: ['重试', '安全模式重启', '回滚上次插件变更并重启', '取消'],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      });
      if (choice === 1) {
        safeMode = true;
        restartCount = 0;
        startBackend();
        return;
      }
      if (choice === 2) {
        // 回滚由 rollbackLastPluginChange 异步执行，完成后自动重启后端
        rollbackLastPluginChange();
        return;
      }
      if (choice === 3) {
        quitting = true;
        app.quit();
        return;
      }
    } catch { /* 弹窗失败也继续退避 */ }
  }
  restartTimer = setTimeout(startBackend, delay);
}

function stopBackend() {
  clearTimeout(restartTimer);
  clearTimeout(bootWatchTimer);
  if (backend) {
    const pid = backend.pid;
    backend = null;
    try {
      // 杀整棵进程树（node 可能带 worker 子进程）；用 spawnSync 保证杀完再退出/重启，
      // 避免异步 taskkill 与 app.quit() 竞态导致后端漏杀成孤儿（DSHOME-ISSUE-004 旁支）。
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch { /* ignore */ }
  }
}

/** 按端口清理监听进程（含外部/孤儿拉起的后端）：netstat 找 LISTENING 的 PID 再整树杀。 */
function killPortOwner(port) {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    if (out.status !== 0 || !out.stdout) return;
    const seen = new Set();
    for (const line of out.stdout.split(/\r?\n/)) {
      // 行格式: TCP 127.0.0.1:3099 0.0.0.0:0 LISTENING 17128 （IPv6 为 [::1]:3099）
      const m = /^TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line.trim());
      if (!m || Number(m[1]) !== port) continue;
      const pid = Number(m[2]);
      if (!(pid > 0) || pid === process.pid || seen.has(pid)) continue;
      seen.add(pid);
      logLine({ portKill: { port, pid } });
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    }
  } catch (e) {
    logLine({ portKillError: String(e?.message ?? e) });
  }
}

function restartBackend(mode) {
  if (mode === 'safe') safeMode = true; else safeMode = false;
  restartCount = 0;
  stopBackend();
  // 接管孤儿/外部拉起的后端：先清掉 3099 的监听进程，再拉自己的（否则新进程撞端口）
  killPortOwner(backendPort());
  // 等待 taskkill 生效后重启
  setTimeout(startBackend, 500);
}

// ---- 一键回滚（崩溃弹窗按钮）：跑 scripts/plugin-change-guard.mjs --recover ----
function findGuardScript() {
  let dir = __dirname;
  for (let i = 0; i < 7; i++) {
    const f = path.join(dir, 'scripts', 'plugin-change-guard.mjs');
    if (fs.existsSync(f)) return f;
    dir = path.dirname(dir);
  }
  return null;
}

function rollbackLastPluginChange() {
  const guard = findGuardScript();
  if (!guard) {
    logLine({ rollback: 'guard-not-found' });
    try {
      dialog.showMessageBoxSync(window, {
        type: 'error', title: 'DSHOME 回滚',
        message: '找不到 scripts/plugin-change-guard.mjs（开发/安装布局不符），请手动恢复备份。',
        buttons: ['确定'], noLink: true,
      });
    } catch { /* ignore */ }
    return;
  }
  // 安装布局用自带 runtime\node.exe；否则用系统 node（dev）
  let nodeExe = 'node';
  const spec = resolveBackendSpec();
  if (spec && spec.kind === 'install') nodeExe = spec.nodeExe;
  logLine({ rollback: 'start', guard, nodeExe });
  try {
    const child = spawn(nodeExe, [guard, '--recover'], { shell: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    child.on('exit', (code) => {
      logLine({ rollback: 'exit', code });
      try {
        if (code === 0) {
          dialog.showMessageBoxSync(window, {
            type: 'info', title: 'DSHOME 回滚',
            message: '已回滚上次插件变更，正在重启后端。',
            buttons: ['确定'], noLink: true,
          });
          restartBackend('normal');
        } else {
          dialog.showMessageBoxSync(window, {
            type: 'error', title: 'DSHOME 回滚失败',
            message: `回滚失败（exit ${code}）。\n${err.slice(-800)}`,
            buttons: ['确定'], noLink: true,
          });
        }
      } catch { /* dialog 失败不阻塞 */ }
    });
  } catch (e) {
    logLine({ rollback: 'spawn-error', error: String(e?.message ?? e) });
  }
}

// 离线页「重新连接」：壳立即探活；后端没起且有启动规格 → 立刻拉起（不等 3s 轮询）
ipcMain.handle('shell:retry-backend', async () => {
  try {
    const up = await isBackendUp();
    if (up) {
      await applyBackendState(true);
      return { ok: true, up: true };
    }
    if (resolveBackendSpec()) {
      startBackend();
      logLine({ retry: 'backend-down, spawn requested' });
      return { ok: true, up: false, started: true };
    }
    logLine({ retry: 'backend-down, no spec (manual start needed)' });
    return { ok: true, up: false, started: false, reason: 'no-spec' };
  } catch (e) {
    logLine({ retryError: String(e?.message ?? e) });
    return { ok: false };
  }
});

// ---- 壳与 UI ----
async function isBackendUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const r = await fetch(targetUrl(), { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return r.ok;
  } catch (e) {
    clearTimeout(timer);
    return false;
  }
}

async function applyBackendState(nowUp) {
  if (nowUp === isOnline) return; // nothing changed
  isOnline = nowUp;
  logLine({ state: isOnline ? 'online' : 'offline', url: targetUrl() });
  try {
    if (isOnline) await window.loadURL(targetUrl());
    else await window.loadFile(OFFLINE_FILE, { query: { url: targetUrl() } });
  } catch (error) {
    logLine({ loadError: isOnline ? 'url' : 'offline', error: String(error.message ?? error) });
  }
  if (tray) rebuildTrayMenu();
  if (window) window.setTitle(stateTitle());
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'DSHOME',
        body: isOnline ? '后端已恢复，窗口已重连' : '后端未连接，窗口已切换离线页',
      });
      n.on('click', showWindow);
      n.show();
    }
  } catch { /* notification failure is not fatal */ }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try { await applyBackendState(await isBackendUp()); } catch (e) { logLine({ pollError: String(e?.message ?? e) }); }
  }, POLL_MS);
}

function stateTitle() {
  return isOnline ? WINDOW_TITLE : `${WINDOW_TITLE} — 后端未连接`;
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// 供 updater 在应用更新前退出壳 + 后端
global.__dshomeQuitBeforeUpdate = () => {
  quitting = true;
  stopBackend();
  app.quit();
};

// 启动后延迟静默检查更新（有更新才通知，失败静默）
function scheduleStartupUpdateCheck() {
  const silent = process.env.DSHOME_NO_UPDATE_CHECK === '1';
  if (silent) return;
  setTimeout(async () => {
    const info = await updater.checkForUpdate();
    if (!info) return;
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'DSHOME 有更新',
          body: `发现新版本 v${info.version}，点击查看。`,
        });
        n.on('click', async () => {
          const applied = await updater.applyUpdate(info, () => window);
          if (applied) { /* 壳已退出，由安装器接管 */ }
        });
        n.show();
      }
    } catch { /* notification failure is not fatal */ }
  }, 5000);
}

// 手动检查更新（托盘入口）
async function manualCheckUpdate() {
  try {
    const info = await updater.checkForUpdate();
    if (!info) {
      dialog.showMessageBoxSync(window, {
        type: 'info',
        title: 'DSHOME 检查更新',
        message: '当前已是最新版本。',
        buttons: ['确定'],
        noLink: true,
      });
      return;
    }
    await updater.applyUpdate(info, () => window);
  } catch (e) {
    logLine({ updater: 'manual-fail', error: String(e?.message ?? e) });
    try {
      dialog.showMessageBoxSync(window, {
        type: 'error',
        title: 'DSHOME 检查更新失败',
        message: `检查更新失败：${String(e?.message ?? e)}`,
        buttons: ['确定'],
        noLink: true,
      });
    } catch { /* ignore */ }
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const status = isOnline ? '后端：运行中' : '后端：未连接';
  const menu = Menu.buildFromTemplate([
    { label: 'DSHOME', enabled: false },
    { type: 'separator' },
    { label: status },
    { label: '显示窗口', click: showWindow },
    { label: '刷新页面', click: () => { if (window) window.webContents.reloadIgnoringCache(); } },
    { label: '重启后端', click: () => restartBackend('normal') },
    { label: '安全模式重启', click: () => restartBackend('safe') },
    { label: '检查更新…', click: () => manualCheckUpdate() },
    { type: 'separator' },
    {
      label: `开机自启 ${openAtLogin ? '✓' : '✗'}`,
      click: () => {
        const next = !app.getLoginItemSettings().openAtLogin;
        app.setLoginItemSettings({ openAtLogin: next });
        saveState({ autoStart: next });
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; stopBackend(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`DSHOME — ${status}`);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: WINDOW_TITLE,
    icon: ICON_FILE,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  window.setMenuBarVisibility(false);
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(stateTitle());
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { window = null; });
  loadInitial();
}

async function loadInitial() {
  logLine({ stage: 'loadInitial', target: targetUrl() });
  let up = false;
  try { up = await isBackendUp(); } catch (e) { logLine({ loadInitialError: String(e?.message ?? e) }); }
  if (!up) {
    // 后端没在跑：壳负责拉起（零外部依赖）
    const spec = resolveBackendSpec();
    if (spec) startBackend();
  }
  isOnline = up;
  try {
    if (isOnline) await window.loadURL(targetUrl());
    else await window.loadFile(OFFLINE_FILE, { query: { url: targetUrl() } });
  } catch (error) {
    logLine({ initialLoadError: String(error.message ?? error) });
  }
  if (tray) rebuildTrayMenu();
  if (window) window.setTitle(stateTitle());
  startPolling();
}

function createTray() {
  tray = new Tray(TRAY_ICON_FILE);
  rebuildTrayMenu();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function startNotifyListener() {
  const port = Number(process.env.DSHOME_NOTIFY_PORT || 0);
  if (!port) return;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/notify') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { title, body: text } = JSON.parse(body || '{}');
          if (Notification.isSupported()) new Notification({ title: title ?? 'DSHOME', body: text ?? '' }).show();
          res.writeHead(204); res.end();
        } catch { res.writeHead(400); res.end(); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, '127.0.0.1');
}

// ---- 入口 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    quitting = false;
    createWindow();
    createTray();
    startNotifyListener();
    scheduleStartupUpdateCheck();
  });
  app.on('window-all-closed', () => { /* keep alive in tray */ });
  app.on('before-quit', () => { quitting = true; });
}
