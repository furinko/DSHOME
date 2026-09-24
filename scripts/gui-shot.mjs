#!/usr/bin/env node
// scripts/gui-shot.mjs — **活 SPA** 的界面截图探针（CDP + 真实时间）
//
// ── 与 scripts/shot.mjs 的分工 ────────────────────────────────────────────────
//   · `shot.mjs`   —— `chrome --headless=new --screenshot` + `--virtual-time-budget`（**虚拟时间**），
//                    适合静态页 / 一次性渲染；对**活着的 SPA**（DSHOME GUI：SSE 长连接、**永不 idle**）
//                    会**卡死超时**、拿不到帧（本机实测）。
//   · 本文件        —— 走 CDP（DevTools 协议）+ **真实时间**：起常驻 headless chrome → 连 page target 的 ws →
//                    `Page.navigate` → 真等 `--wait` →（可选）点按钮 → `Page.captureScreenshot`。
//                    活 SPA 也拿得到帧；点击能验证「UI 真的响应了」而不是「看起来像渲染了」。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/gui-shot.mjs <url> [--out <png>] [--wait <ms>] [--click <按钮文本>] [--after-click <ms>] [--probe] [--timeout <ms>]
//     <url>              http(s):// 地址（活页面的地址；file:// 不支持——静态页请用 shot.mjs）
//     --out <png>        输出 PNG（默认 %TEMP%\dshome-gui-shot\shot-<时间戳>.png）
//     --wait <ms>        导航后**真实时间**等待（默认 8000；SPA 首屏/SSE 握手需要它）
//     --click <文本>     点「文本**包含**该字符串的第一个 `<button>`」；找不到 ⇒ **响亮失败**（非 0 退出、不出图）
//     --after-click <ms> 点击后等待（默认 1500）
//     --probe            额外打印一段 DOM 摘要 JSON（url / title / composer / buttons 前 25）
//     --timeout <ms>     整体看门狗超时（默认 30000）
//
//   ⚠️ argless（不给参数）＝ 只打用法并 `exit 2` —— 与 `shot.mjs:9,52-56` 同款，故可安全挂
//      `scripts/verify-scripts-run.mjs` 白名单（该冒烟把「usage 退出」视为正常）。
//
// ── 输出 ──────────────────────────────────────────────────────────────────────
//   `[gui-shot] ✅ <PNG 绝对路径>  (<字节数> B)`；`--probe` 时另有 `[gui-shot] DOM 摘要: {…}`。
//
// ── 约束 ──────────────────────────────────────────────────────────────────────
//   · **零依赖**：只用 node 内置 + 全局 `fetch` / `WebSocket`（Node 22+ 自带），不引第三方包。
//   · **不写仓库任何文件**：只写 `--out` 指定处（或系统临时目录），chrome profile 用临时目录、**退出即删**。
//   · 本文件**不得出现本机盘符 / 仓库绝对路径**（`shot.mjs:23` 的 2026-09-11 教训：硬编码被推送即 MODULE_NOT_FOUND）。
//   · 无论成败都清理：杀 chrome（Windows 上 `taskkill /T` 连子进程）+ 删临时 profile 目录。
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 视口（`--window-size`）：DSHOME GUI 的常用桌面尺寸；本工具不暴露宽高参数（要别的尺寸请改常量）。
const VIEW_W = 1440;
const VIEW_H = 900;

function usage() {
  console.log('用法: node scripts/gui-shot.mjs <url> [--out <png>] [--wait <ms>] [--click <按钮文本>] [--after-click <ms>]');
  console.log('                                  [--probe] [--timeout <ms>]');
  console.log('  <url>              http(s):// 活页面地址（静态页/一次性渲染请用 shot.mjs —— 虚拟时间）');
  console.log('  --out <png>        输出 PNG（默认 %TEMP%\\dshome-gui-shot\\shot-<时间戳>.png）');
  console.log('  --wait <ms>        导航后真实等待（默认 8000）');
  console.log('  --click <文本>     点第一个「文本包含该字符串」的 <button>；找不到 ⇒ 非 0 退出（不出图）');
  console.log('  --after-click <ms> 点击后等待（默认 1500）');
  console.log('  --probe            额外打印 DOM 摘要 JSON（url/title/composer/buttons）');
  console.log('  --timeout <ms>     整体超时（默认 30000）');
  console.log('  浏览器发现顺序: env DSHOME_GUI_SHOT_BROWSER → Chrome 常见安装位 → Edge → PATH');
}

function parseArgs(list) {
  const o = { url: null, out: null, wait: 8000, click: null, afterClick: 1500, probe: false, timeout: 30000 };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--out') o.out = list[++i];
    else if (a === '--wait') o.wait = num(list[++i], 8000);
    else if (a === '--click') o.click = list[++i];
    else if (a === '--after-click') o.afterClick = num(list[++i], 1500);
    else if (a === '--probe') o.probe = true;
    else if (a === '--timeout') o.timeout = num(list[++i], 30000);
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!o.url) o.url = a;
    else { console.error(`[gui-shot] 未知参数: ${a}`); process.exit(2); }
  }
  return o;
}

const o = parseArgs(argv);
if (o.help || !o.url) { usage(); process.exit(o.help ? 0 : 2); }
if (!/^https?:\/\//i.test(o.url)) {
  console.error(`[gui-shot] ❌ url 必须是 http(s):// 开头（活页面地址）：${o.url}`);
  console.error('[gui-shot]    静态 HTML/文件截图请用 `node scripts/shot.mjs <file.html>`（虚拟时间那条路）');
  process.exit(2);
}
if (o.out && !/\.png$/i.test(o.out)) { console.error(`[gui-shot] ❌ --out 必须是 .png 文件路径：${o.out}`); process.exit(2); }

/** 浏览器发现：env DSHOME_GUI_SHOT_BROWSER → Chrome 常见安装位 → Edge → PATH（思路同 shot.mjs:58-70）。找不到就**响亮失败**。 */
function findBrowser() {
  const cands = [];
  if (process.env.DSHOME_GUI_SHOT_BROWSER) cands.push(process.env.DSHOME_GUI_SHOT_BROWSER);
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  cands.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  cands.push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const p of (process.env.PATH || '').split(';').filter(Boolean)) {
    cands.push(join(p, 'chrome.exe'), join(p, 'msedge.exe'));
  }
  for (const c of cands) { try { if (c && existsSync(c)) return c; } catch { /* 忽略非法路径 */ } }
  return null;
}

const browser = findBrowser();
if (!browser) {
  console.error('[gui-shot] ❌ 找不到无头浏览器（试过：DSHOME_GUI_SHOT_BROWSER / ProgramFiles·LOCALAPPDATA 下 Chrome·Edge / PATH）');
  console.error('[gui-shot]    可设 DSHOME_GUI_SHOT_BROWSER=<chrome.exe 绝对路径> 指定；不静默跳过');
  process.exit(1);
}

/** 随机空闲端口：让内核分配一个（listen 0 → 读端口 → 立即关闭）。 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/** 等 chrome 的 DevTools HTTP 端点给出第一个 page target（拿它的 ws 地址）。 */
async function waitPageTarget(port, deadline, chromeState) {
  while (Date.now() < deadline) {
    if (chromeState.exited !== null) throw new Error(`chrome 提前退出（exit=${chromeState.exited}）`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 端点还没起来 */ }
    await sleep(200);
  }
  throw new Error(`等待 http://127.0.0.1:${port}/json/list 上的 page target 超时`);
}

function connectWs(url, timeoutMs) {
  return new Promise((res, rej) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { rej(e); return; }
    const t = setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } rej(new Error('CDP WebSocket 连接超时')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(t); res(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP WebSocket 连接失败')); }, { once: true });
  });
}

/** 极简 CDP 客户端：id → promise，只认自己发的 id 的响应。 */
function makeSend(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
      else res(msg.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const PROBE_EXPR = `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  return {
    url: location.href,
    title: document.title,
    composer: !!document.querySelector('[data-composer-input]'),
    buttons: btns.slice(0, 25).map((b) => (b.textContent || '').trim()),
  };
})()`;

function clickExpr(want) {
  return `(() => {
  const want = ${JSON.stringify(want)};
  const btns = Array.from(document.querySelectorAll('button'));
  const hit = btns.find((b) => (b.textContent || '').includes(want));
  if (!hit) return { ok: false, url: location.href, buttons: btns.slice(0, 25).map((b) => (b.textContent || '').trim()) };
  hit.click();
  return { ok: true, text: (hit.textContent || '').trim() };
})()`;
}

// ── 输出落点（只写 --out 指定处 / 系统临时目录；不落仓库）──────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = o.out ? resolve(o.out) : join(tmpdir(), 'dshome-gui-shot', `shot-${stamp}.png`);
mkdirSync(dirname(outPath), { recursive: true });
const profileDir = join(tmpdir(), `dshome-gui-shot-profile-${stamp}-${process.pid}`);
mkdirSync(profileDir, { recursive: true });

// ── 清理（幂等 · 无论成败都跑）────────────────────────────────────────────────
// 实测（2026-09-24 本机）：只 `taskkill /PID <主进程> /T /F` **不够** —— chrome 的 utility 子进程
// （zygote fork 出来的，父子链不完整）会活下来并占住 profile 目录句柄 ⇒ `rmSync` 一直 EPERM，
// 三次运行留下 3 个残留目录 + 1 个残留进程。故分三层收尾：
//   ① CDP `Browser.close`（经 **browser 级** ws）让 chrome **自己有序退出**（子进程一起走）
//   ② 等主进程退出 → `rmSync` 重试
//   ③ 兜底：`taskkill /T` + 「按命令行含本 profileDir 精确杀 chrome」（只动本进程起的那一个）→ 再重试
let child = null;
let port = null;
let send = null;
let cdpWs = null;
let chromeState = { exited: null };
let cleanupDone = false;

function killChromeTree() {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* 已退出 / 权限不足都无所谓：下面再兜 */ }
  try { child.kill(); } catch { /* 忽略 */ }
}

/** 兜底③：只杀「命令行里带本进程临时 profile 目录」的 chrome（**绝不**碰用户自己的 chrome）。 */
function killChromeByProfileDir() {
  if (process.platform !== 'win32') return;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profileDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 15000 }); } catch { /* powershell 不在也无妨 */ }
}

function rmProfileOnce() {
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { /* 句柄还占着：外层重试 */ }
  return !existsSync(profileDir);
}

/** exit 钩子兜底：必须是**同步**的（进程已在退出路径上，不能再 await）。 */
function cleanupSync() {
  if (cleanupDone) return;
  cleanupDone = true;
  killChromeTree();
  rmProfileOnce();
}

/** 主清理：优雅关 → 等退出 → 重试删 → 兜底杀 → 再删。 */
async function cleanupAsync() {
  if (cleanupDone) return;
  cleanupDone = true;
  // ① Browser.close（browser 级 ws）
  if (port && chromeState.exited === null) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const v = await r.json();
      if (v && v.webSocketDebuggerUrl) {
        const bws = await connectWs(v.webSocketDebuggerUrl, 3000);
        const bsend = makeSend(bws);
        await Promise.race([bsend('Browser.close').catch(() => {}), sleep(1500)]);
        try { bws.close(); } catch { /* 忽略 */ }
      }
    } catch { /* chrome 可能已退出 / 端点已关：走兜底 */ }
  }
  try { if (cdpWs) cdpWs.close(); } catch { /* 忽略 */ }
  // ② 等 chrome 主进程退出，再删
  const deadline = Date.now() + 4000;
  while (chromeState.exited === null && Date.now() < deadline) await sleep(100);
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) { ok = rmProfileOnce(); if (!ok) await sleep(200); }
  // ③ 兜底：杀不干净就强杀（含按 profileDir 精确匹配的残留子进程）再删
  if (!ok) {
    killChromeTree();
    killChromeByProfileDir();
    await sleep(500);
    for (let i = 0; i < 8 && !ok; i++) { ok = rmProfileOnce(); if (!ok) await sleep(250); }
  }
  if (ok) console.log(`[gui-shot] 清理: 已关 chrome 并删临时 profile ${profileDir}`);
  else console.error(`[gui-shot] ⚠️ 临时 profile 目录清理失败（可手删）：${profileDir}`);
}
process.on('exit', cleanupSync);

let code = 0;
const watchdog = setTimeout(() => {
  console.error(`[gui-shot] ❌ 整体超时 ${o.timeout}ms（可用 --timeout 调大）——清理后退出`);
  try { if (cdpWs) cdpWs.close(); } catch { /* 忽略 */ }
  cleanupSync();
  process.exit(1);
}, o.timeout);

try {
  port = await freePort();
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*', // Node 的 WebSocket 客户端握手需要它（DevTools 端点会校验 Origin）
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${VIEW_W},${VIEW_H}`,
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ];
  child = spawn(browser, args, { stdio: 'ignore' });
  child.on('error', () => { chromeState.exited = 'spawn-error'; });
  child.on('exit', (c) => { chromeState.exited = c; });

  console.log(`[gui-shot] 浏览器: ${browser}`);
  console.log(`[gui-shot] 目标: ${o.url} · 端口 ${port} · 视口 ${VIEW_W}×${VIEW_H} · 真实等待 ${o.wait}ms`);

  const page = await waitPageTarget(port, Date.now() + Math.min(15000, o.timeout), chromeState);
  cdpWs = await connectWs(page.webSocketDebuggerUrl, Math.min(10000, o.timeout));
  send = makeSend(cdpWs);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: o.url });
  await sleep(o.wait);

  if (o.click) {
    const r = await send('Runtime.evaluate', { expression: clickExpr(o.click), returnByValue: true });
    const v = r && r.result && r.result.value;
    if (!v || !v.ok) {
      const list = (v && v.buttons) || [];
      throw new Error([
        `找不到「文本包含 ${o.click}」的 <button>（页面：${(v && v.url) || o.url}）`,
        `[gui-shot]    当前按钮文本（前 25）：${list.length ? list.map((b) => `「${b}」`).join('、') : '(一个 <button> 都没有)'}`,
        '[gui-shot]    ⇒ 响亮失败：**不出图**（静默产出一张"看起来成功"的截图比失败更坏）',
      ].join('\n'));
    }
    console.log(`[gui-shot] 已点击按钮：「${v.text}」→ 再等 ${o.afterClick}ms`);
    await sleep(o.afterClick);
  }

  if (o.probe) {
    const r = await send('Runtime.evaluate', { expression: PROBE_EXPR, returnByValue: true });
    console.log(`[gui-shot] DOM 摘要: ${JSON.stringify(r && r.result && r.result.value)}`);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot || !shot.data) throw new Error('Page.captureScreenshot 未返回 data');
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  const bytes = statSync(outPath).size;
  if (!(bytes > 0)) throw new Error('PNG 字节数为 0');
  console.log(`[gui-shot] ✅ ${outPath}  (${bytes} B)`);
} catch (e) {
  console.error(`[gui-shot] ❌ ${e && e.message ? e.message : e}`);
  code = 1;
} finally {
  clearTimeout(watchdog);
  await cleanupAsync();
}
process.exit(code);
