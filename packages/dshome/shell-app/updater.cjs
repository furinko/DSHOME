// DSHOME updater — 更新检查/下载/校验/静默安装（零外部依赖，壳内闭环）。
// 版本源：GitHub raw 的 updates.json（双源：直连 + ghfast.top 镜像）。
// 更新包：全量安装包 exe（Inno Setup，/SILENT 静默安装）。
// 任何网络失败都静默降级，绝不阻塞 DSHOME 正常使用。
'use strict';

const { app, dialog, Notification } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---- 版本源配置 ----
const UPDATES_JSON_URLS = [
  'https://raw.githubusercontent.com/furinko/DSHOME/main/updates.json',
  'https://ghfast.top/https://raw.githubusercontent.com/furinko/DSHOME/main/updates.json',
];
const MIRROR_PREFIX = 'https://ghfast.top/';
const REQUEST_TIMEOUT_MS = 8000;

// ---- 小工具 ----
function logLine(entry) {
  try {
    const logFile = path.join(app.getPath('userData'), 'dshome-shell.log');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch { /* ignore */ }
}

function fetchText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 1024 * 1024) req.destroy(new Error('too large')); });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      res.on('data', (c) => {
        received += c.length;
        if (onProgress && total) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    });
    req.setTimeout(0); // 下载不设超时（大文件），失败由连接错误处理
    req.on('error', (e) => { file.close(); fs.unlink(dest, () => {}); reject(e); });
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ---- 核心逻辑 ----
async function fetchUpdatesJson() {
  let lastErr = null;
  for (const url of UPDATES_JSON_URLS) {
    try {
      const text = await fetchText(url);
      const data = JSON.parse(text);
      if (data && data.version && data.url) return data;
    } catch (e) {
      lastErr = e;
      logLine({ updater: 'fetch-json-fail', url, error: String(e?.message ?? e) });
    }
  }
  throw lastErr || new Error('all update sources failed');
}

// 检查更新：返回 { version, url, sha256, downloadUrl } 或 null（无更新/检查失败）
async function checkForUpdate() {
  try {
    const info = await fetchUpdatesJson();
    const current = app.getVersion();
    if (compareVersions(info.version, current) <= 0) {
      logLine({ updater: 'no-update', current, latest: info.version });
      return null;
    }
    // 主下载源 + 镜像源
    const urls = [info.url];
    if (!info.url.startsWith(MIRROR_PREFIX)) urls.push(MIRROR_PREFIX + info.url);
    logLine({ updater: 'update-found', current, latest: info.version });
    return { version: info.version, sha256: info.sha256 || '', urls };
  } catch (e) {
    logLine({ updater: 'check-fail', error: String(e?.message ?? e) });
    return null;
  }
}

async function downloadUpdate(info, onProgress) {
  const dest = path.join(app.getPath('temp'), `DSHOME-setup-${info.version}.exe`);
  let lastErr = null;
  for (const url of info.urls) {
    try {
      await downloadFile(url, dest, onProgress);
      if (info.sha256) {
        const actual = await sha256File(dest);
        if (actual.toLowerCase() !== info.sha256.toLowerCase()) {
          fs.unlink(dest, () => {});
          throw new Error(`SHA256 mismatch: expected ${info.sha256}, got ${actual}`);
        }
        logLine({ updater: 'sha256-ok', version: info.version });
      }
      return dest;
    } catch (e) {
      lastErr = e;
      logLine({ updater: 'download-fail', url, error: String(e?.message ?? e) });
    }
  }
  throw lastErr || new Error('download failed');
}

// 应用更新：下载 → 校验 → 确认 → 退出 → 静默安装
async function applyUpdate(info, getWindow) {
  const win = getWindow ? getWindow() : null;
  const notify = (title, body) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch { /* ignore */ }
  };
  try {
    notify('DSHOME 更新', `发现新版本 v${info.version}，开始下载…`);
    const installer = await downloadUpdate(info, (received, total) => {
      const pct = Math.round((received / total) * 100);
      if (pct % 20 === 0) logLine({ updater: 'progress', pct });
    });
    if (!win) throw new Error('窗口不可用');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'DSHOME 更新就绪',
      message: `DSHOME v${info.version} 已下载并校验完成。`,
      detail: 'DSHOME 将退出并静默安装新版本，安装完成后请重新打开 DSHOME。',
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice !== 0) return false;
    // 退出 DSHOME（壳 + 后端）后静默安装
    global.__dshomeQuitBeforeUpdate && global.__dshomeQuitBeforeUpdate();
    await new Promise((r) => setTimeout(r, 1500));
    spawn(installer, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return true;
  } catch (e) {
    logLine({ updater: 'apply-fail', error: String(e?.message ?? e) });
    notify('DSHOME 更新失败', `更新失败：${String(e?.message ?? e)}`);
    return false;
  }
}

module.exports = { checkForUpdate, applyUpdate, compareVersions };
