// DSHOME shell — Electron main process.
// - single instance lock（二次启动只聚焦已有窗口）
// - BrowserWindow 加载 DSHOME 后端 URL（env DSHOME_URL）
// - 活性轮询：后端挂 -> 离线页；后端恢复 -> 自动加载 UI
// - 系统托盘：显示窗口 / 刷新 / 状态 / 开机自启 / 退出；关窗最小化到托盘
// - 本地通知监听（DSHOME_NOTIFY_PORT，POST /notify {title, body}）
// - 观测日志：%APPDATA%\dshome-shell\dshome-shell.log（调试用）
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const TARGET_URL = process.env.DSHOME_URL || 'http://127.0.0.1:3081';
const WINDOW_TITLE = 'DSHOME';
const POLL_MS = 3000;
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const STATE_FILE = path.join(app.getPath('userData'), 'dshome-shell-state.json');
// 官方图标（临时回退，待 DSHOME 自有图标定稿后替换）
const ICON_FILE = path.join(__dirname, 'icon-official.png');
const TRAY_ICON_FILE = path.join(__dirname, 'tray-official.png');
const LOG_FILE = path.join(app.getPath('userData'), 'dshome-shell.log');

function logLine(entry) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch { /* ignore */ }
}

let window = null;
let tray = null;
let isOnline = false;
let pollTimer = null;

function state() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...patch }, null, 2)); } catch { /* ignore */ }
}

async function isBackendUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const r = await fetch(TARGET_URL, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    logLine({ fetch: 'ok', status: r.status });
    return r.ok;
  } catch (e) {
    clearTimeout(timer);
    logLine({ fetch: 'fail', error: String(e?.message ?? e) });
    return false;
  }
}

async function applyBackendState(nowUp) {
  if (nowUp === isOnline) return; // nothing changed
  isOnline = nowUp;
  logLine({ state: isOnline ? 'online' : 'offline', url: TARGET_URL });
  try {
    if (isOnline) await window.loadURL(TARGET_URL);
    else await window.loadFile(OFFLINE_FILE, { query: { url: TARGET_URL } });
    logLine({ loaded: isOnline ? 'url' : 'offline' });
  } catch (error) {
    logLine({ loadError: isOnline ? 'url' : 'offline', error: String(error.message ?? error) });
  }
  if (tray) rebuildTrayMenu();
  if (window) window.setTitle(stateTitle());
  // 在线/离线切换给一条系统通知（通知桥 v1）
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

function stopBackend() {
  const pid = Number(process.env.DSHOME_BACKEND_PID || 0);
  if (pid) {
    try {
      spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
    { type: 'separator' },
    {
      // 不用 checkbox 类型：Windows 会给整份菜单预留勾选列，把其它项文字推右。
      label: `开机自启 ${openAtLogin ? '✓' : '✗'}`,
      click: () => {
        const next = !app.getLoginItemSettings().openAtLogin;
        app.setLoginItemSettings({ openAtLogin: next });
        saveState({ autoStart: next });
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; stopBackend(); app.quit(); } },
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
  });
  window.setMenuBarVisibility(false);
  // 页面加载后会用自身 <title>（官方 HTML 为 "DeepSeek Harness"）覆盖窗口标题，
  // 这里拦截并锁定为 DSHOME；离线时显示状态后缀。
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(stateTitle());
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { window = null; });
  loadInitial();
}

async function loadInitial() {
  logLine({ stage: 'loadInitial', target: TARGET_URL });
  let up = false;
  try { up = await isBackendUp(); } catch (e) { logLine({ loadInitialError: String(e?.message ?? e) }); }
  isOnline = up;
  try {
    if (isOnline) await window.loadURL(TARGET_URL);
    else await window.loadFile(OFFLINE_FILE, { query: { url: TARGET_URL } });
    logLine({ initialLoaded: isOnline ? 'url' : 'offline' });
  } catch (error) {
    logLine({ initialLoadError: String(error.message ?? error) });
  }
  if (tray) rebuildTrayMenu(); // 初始探测完成后刷新托盘状态标签
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    app.isQuiting = false;
    createWindow();
    createTray();
    startNotifyListener();
  });
  app.on('window-all-closed', () => { /* keep alive in tray */ });
  app.on('before-quit', () => { app.isQuiting = true; });
}