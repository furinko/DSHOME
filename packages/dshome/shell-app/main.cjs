// DSHOME shell — Electron main process (v0.3.1).
// 崩溃保护自包含：壳（本进程）是后端的唯一守护者，零外部依赖（不依赖任何外部 watchdog/计划任务）。
// - 单实例锁（二次启动只聚焦已有窗口）
// - 后端生命周期：壳负责启动 / 3s 探活 / 挂了自动重启（指数退避）/ 安全模式 / fail-loud 错误弹窗
// - 窗口加载 DSHOME 后端 URL；后端挂 → 离线页；后端恢复 → 自动加载 UI
// - 系统托盘：显示窗口 / 刷新页面 / 重启后端 / 安全模式重启 / 开机自启 / 退出
// - 本地通知监听（DSHOME_NOTIFY_PORT，POST /notify {title, body}）
// - 观测日志：%APPDATA%\dshome-shell\dshome-shell.log
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, net } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const updater = require('./updater.cjs');
const safeOverlay = require('./safe-overlay.cjs');

// ---- 配置 ----
const DEFAULT_PORT = 3099;
const POLL_MS = 3000;
const BOOT_GRACE_MS = 15000;          // 后端启动宽限期：撑过 = 启动成功，重置失败计数
const RESTART_DELAYS = [1000, 3000, 10000, 30000]; // 指数退避序列（ms）
const MAX_CONSECUTIVE_FAILS = 3;      // 连续异常退出次数 → 弹窗建议安全模式
const STABLE_MS = 120000;             // 后端稳定存活满 2 分钟才把崩溃计数清零
const DIALOG_MIN_INTERVAL_MS = 60000; // 两次崩溃弹窗的最小间隔（防连环弹）
const HEALTHCHECK_TIMEOUT_MS = 4000;  // 探活超时（ms）：放宽到 4s，避免忙时一次打盹就误判离线
const OFFLINE_REQUIRED = 3;           // 连续探活失败多少次才切离线页（防抖：单次瞬态假失败不翻页）
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const STATE_FILE = path.join(app.getPath('userData'), 'dshome-shell-state.json');
const LOG_FILE = path.join(app.getPath('userData'), 'dshome-shell.log');
const SAFE_OVERLAY_FILE = path.join(app.getPath('userData'), 'dshome-safe.yml');
// 后端 stderr 全量滚动落盘：外壳日志此前只留最后 8 行 errTail，真崩因被截断（2026-09-11 教训）
const STDERR_FILE = path.join(app.getPath('userData'), 'dshome-backend-stderr.log');
const STDERR_KEEP_CHARS = 200 * 1024; // 内存里单次启动保留的最后 stderr 字符数
const ICON_FILE = path.join(__dirname, 'icon-official.png');
const TRAY_ICON_FILE = path.join(__dirname, 'tray-official.png');
const WINDOW_TITLE = 'DSHOME';

/** 后端 stdout 打印的「带 token URL」。
 *  0.1.5 起根路径启用一次性 token 鉴权：壳的存活探测（isBackendUp 的 GET）与窗口加载
 *  都用 targetUrl()，裸 URL 会 401 → r.ok=false → 壳永远判「后端 down」并停在离线页。
 *  token 只出现在后端 stdout 的 `dsh web: <url>` 行，所以壳必须把 stdout 设为 pipe 抓它。 */
let backendAuthUrl = null;
/** 后端 spawn 序号：用于在日志里区分「同一次外壳启动中连续拉起的多个后端」。 */
let backendSpawnSeq = 0;
/** 存活探测失败只记前几次（避免每 3 秒刷屏），用于拿到「401 还是别的」这一关键事实。 */
let healthFailLogged = 0;
function targetUrl() {
  // 优先级：后端自报的带 token URL > dshome/shell 注入的 DSHOME_URL > 裸 URL 兜底
  return backendAuthUrl || process.env.DSHOME_URL || `http://127.0.0.1:${backendPort()}`;
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

/** 取文本最后 n 行（丢弃结尾空行），用于日志尾/弹窗详情。 */
function tailOf(text, n) {
  const arr = String(text ?? '').split(/\r?\n/);
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr.slice(-n).join('\n');
}

/** 把本轮后端 stderr 全量追加到诊断文件（滚动：超 2MB 只留最后 1MB）。 */
function dumpBackendStderr(meta) {
  if (!stderrFull.trim()) return;
  try {
    fs.appendFileSync(STDERR_FILE, `\n===== ${new Date().toISOString()} ${JSON.stringify(meta)} =====\n${stderrFull}`);
    if (fs.statSync(STDERR_FILE).size > 2 * 1024 * 1024) {
      fs.writeFileSync(STDERR_FILE, fs.readFileSync(STDERR_FILE, 'utf8').slice(-1024 * 1024));
    }
  } catch (e) { logLine({ stderrDumpError: String(e?.message ?? e) }); }
}

// ---- 状态 ----
let window = null;
let tray = null;
let isOnline = false;
let offlineStreak = 0; // 连续探活失败计数（防抖：够 OFFLINE_REQUIRED 次才认定离线）
let pollTimer = null;
let quitting = false;

// 后端管理
let backend = null;
let restartCount = 0;
let restartTimer = null;
let bootWatchTimer = null;
let stderrBuffer = '';
/** 本轮后端的完整 stderr（内存里截尾保留，退出时落盘）——真崩因诊断用。 */
let stderrFull = '';
/** 后端本轮启动时刻，用于算存活时长（区分「起不来」与「跑一会儿才崩」）。 */
let backendStartedAt = 0;
/** 连续异常退出计数：只要没稳定活满 STABLE_MS 就累加；这是弹窗判据（旧版用启动失败计数，
 *  被 boot-ok 一清零 → 「能启动、随后崩」的循环永远凑不满 3 次，报错框形同消失）。 */
let crashStreak = 0;
/** 上次崩溃弹窗时刻（防连环弹）。 */
let lastFailDialogAt = 0;
// 初始安全模式：DSHOME_SAFE_MODE=1 时壳以 --patch 覆盖层禁全部自有插件启动（命令行入口/自动化测试）
let safeMode = process.env.DSHOME_SAFE_MODE === '1';

function state() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...patch }, null, 2)); } catch { /* ignore */ }
}

// ---- 后端生命周期 ----
// 自有插件清单从 patch 各层动态解析（v3，2026-09-11）：
// v2 只取「找到的第一个 patch 文件」→ 只覆盖 L3 产品层 15 行，L4 覆盖层后加的
// dsh-imagegen / Agent Teams 实验包不在禁用范围（dump-config 实测证实）；
// 现改为汇总 L3+L4 全部候选文件（纯函数在 safe-overlay.cjs，可单独 node 测试）。
// 找不到任何 patch 层才回退静态清单并告警。
const SAFE_FALLBACK_IDS = [
  'dshome-core', 'dshome-shell', 'dshome-theme', 'dshome-palette', 'dshome-notify',
  'dshome-plugin-manager', 'dshome-plugin-center', 'dshome-assistant-identity',
  'dshome-mind', 'dshome-mind-inject', 'dshome-mind-guard', 'dshome-mind-recall',
  'dshome-mind-connect', 'dshome-mind-skill-loader', 'dshome-desktop',
];

function safeProfileName(spec) {
  if (!spec) return null;
  if (spec.kind === 'install') return 'dshome';       // 安装版固定 profile 名
  return safeOverlay.profileFromCmd(spec.cmd);        // dev：从 DSHOME_BACKEND_CMD 里取
}

/** 汇总自有插件 id + 来源层；找不到层则回退静态清单。 */
function buildSafeOverlay() {
  const spec = resolveBackendSpec();
  const { ids, sources } = safeOverlay.collectSafeIds({
    shellDir: __dirname,
    profDir: spec?.profDir ?? null,
    instDir: spec?.instDir ?? null,
    dshHome: process.env.DSH_HOME || null,
    profile: safeProfileName(spec),
  });
  const dynamic = ids.length > 0;
  if (!dynamic) logLine({ safeOverlayFallback: 'no patch layer found, using static list' });
  const used = dynamic ? ids : SAFE_FALLBACK_IDS;
  return {
    text: safeOverlay.overlayText(used),
    ids: used,
    dynamic,
    sources: sources.map((s) => s.file),
  };
}

function writeSafeOverlay() {
  const built = buildSafeOverlay();
  try {
    fs.writeFileSync(SAFE_OVERLAY_FILE, built.text, 'utf8');
    logLine({
      safeOverlay: {
        file: SAFE_OVERLAY_FILE, count: built.ids.length, dynamic: built.dynamic,
        layers: built.sources, ids: built.ids,
      },
    });
  } catch (e) { logLine({ safeOverlayError: String(e?.message ?? e) }); }
}

function startBackend() {
  if (backend) return;
  const spec = resolveBackendSpec();
  if (!spec) {
    logLine({ backend: 'no-spec' }); // 无法解析后端规格：只做 UI 客户端
    return;
  }
  // 🔴 先清掉端口占用者（孤儿/外部后端）：否则新后端撞 EADDRINUSE，外壳陷入
  // 「启动 → 崩 → 15s 后重启」的无限循环。2026-09-11 实测：退出外壳后，由
  // dshome/shell 插件拉起的那类后端会成为**孤儿**继续占着 3099，把新起的壳彻底卡死
  // （日志表现：backend start → exit code=1 errTail 里带 port: 3099）。
  // 安全性：单实例锁保证同一时刻只有一个外壳，故 3099 的占用者必是孤儿/外部进程。
  killPortOwner(backendPort());
  // 🔴 清掉上一轮后端的 token：**每次启动后端都会生成新 token**，沿用旧值会让存活探测
  // 永远 401 → 外壳据此判「后端 down」→ 又去重拉后端 → 形成
  // 「杀健康后端 → 新 token → 仍用旧 token 探测失败」的**自杀循环**
  // （2026-09-11 实景：日志 portKill → start → auth-url-captured → retry → 无限重复）。
  backendAuthUrl = null;
  stderrBuffer = '';
  stderrFull = '';
  logLine({ backend: 'start', safe: safeMode, count: restartCount, crashStreak });
  if (safeMode) writeSafeOverlay();
  try {
    if (spec.kind === 'cmd') {
      // 开发/测试：DSHOME_BACKEND_CMD 是完整命令行（node + 参数）。
      // 🔴 安全模式必须把 --patch 插到 launcher 旗标区（--profile 之后、app 参数之前）：
      // 旧写法拼在末尾 → dsh 判 `unknown option '--patch'` → 后端根本起不来。
      const cmd = safeMode ? safeOverlay.withPatchFlag(spec.cmd, SAFE_OVERLAY_FILE) : spec.cmd;
      if (safeMode) logLine({ backend: 'spawn-cmd', patched: true, cmd });
      backend = spawn(cmd, { shell: true, windowsHide: true, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      // 🔴 --patch 必须排在 app 参数之前（0.1.5 实测：`--no-open --port x --patch y` = unknown option）
      const args = [spec.cliBin, '--profile', 'dshome'];
      if (safeMode) args.push('--patch', SAFE_OVERLAY_FILE);
      args.push('--no-open', '--port', String(backendPort()));
      if (safeMode) logLine({ backend: 'spawn-install', patched: true, args });
      backend = spawn(spec.nodeExe, args, { windowsHide: true, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (e) {
    logLine({ backend: 'spawn-error', error: String(e?.message ?? e) });
    backend = null;
    crashStreak += 1;      // spawn 直接抛异常也算一次异常退出，否则壳会静默停摆不再重启
    scheduleRestart();
    return;
  }
  backendStartedAt = Date.now();
  backend.stderr?.on('data', (d) => {
    const text = d.toString();
    stderrBuffer = (stderrBuffer + text).slice(-4000);
    stderrFull = (stderrFull + text).slice(-STDERR_KEEP_CHARS);
  });
  // 抓后端 stdout 的 `dsh web: <带 token URL>`：0.1.5 起根路径需一次性 token 鉴权，
  // 而壳的存活探测与窗口加载都用 targetUrl()（见 backendAuthUrl 注释）。
  // 🔴 必须消费 stdout：pipe 不读会写满管道、反把后端卡死。
  // 🔴 只认「当前 backend」：同一次外壳启动里，离线页 retry 可能连续 spawn 多个后端；
  //    若采纳了**已弃用进程**的 stdout，壳就拿「死后端的 token」探测 → 永远 401
  //    → 判 down → 再 retry（2026-09-11 实景）。
  const spawnSeq = ++backendSpawnSeq;
  const child = backend;
  logLine({ backend: 'spawn', seq: spawnSeq, pid: typeof child.pid === 'number' ? child.pid : null });
  child.stdout?.on('data', (d) => {
    if (backend !== child) return; // 已被更新的后端取代 → 忽略它的输出
    const m = /dsh web:\s*(\S+)/.exec(d.toString());
    if (!m) return;
    backendAuthUrl = m[1];
    const tokenLen = (/(?:[?&]token=)([^&\s]*)/.exec(backendAuthUrl)?.[1] ?? '').length;
    logLine({ backend: 'auth-url-captured', seq: spawnSeq, tokenLen });
    // 🔴 不能写成 `if (isOnline && window)`：首次抓到 token 时 isOnline 恒为 false
    //（鸡生蛋——探测从未成功过，于是永不加载），窗口会白等一个轮询周期才切在线页。
    // 抓到 token 就**立刻**探一次并按结果切换。
    if (window) {
      void (async () => {
        try {
          if (await isBackendUp()) await applyBackendState(true);
        } catch { /* 失败留给 3s 轮询兜底 */ }
      })();
    }
  });
  backend.on('exit', (code, signal) => {
    // 🔴 只认「当前 backend」：手动重启（stopBackend 杀老进程）时，老进程也会触发 exit；
    //    若无条件接管状态，会把老进程误记成一次崩溃、还可能把新 backend 引用清空。
    const isCurrent = backend === child;
    const uptimeMs = backendStartedAt ? Date.now() - backendStartedAt : 0;
    logLine({
      backend: 'exit', code, signal, safe: safeMode, uptimeMs, current: isCurrent,
      errTail: tailOf(stderrBuffer, 8),
    });
    dumpBackendStderr({ code, signal, safe: safeMode, uptimeMs }); // 全量 stderr 落盘（诊断真崩因）
    if (!isCurrent) return;
    backend = null;
    backendStartedAt = 0;
    if (quitting) return;
    // 🔴 弹窗判据 = 「异常退出」，不是「启动失败」：活过 15s 的宽限期不代表健康，
    //    「起得来、跑一会儿就崩」同样要计数（旧版在这里被 boot-ok 清零 → 永不弹框）。
    if (uptimeMs >= STABLE_MS) {
      crashStreak = 0;
      logLine({ backend: 'crash-streak-reset', uptimeMs });
    } else {
      crashStreak += 1;
      logLine({ backend: 'crash-streak', crashStreak, uptimeMs });
    }
    scheduleRestart();
  });
  // 启动宽限：撑过 BOOT_GRACE_MS 视为「进程没秒退」，仅用于重置退避计数（不再清零崩溃计数）
  clearTimeout(bootWatchTimer);
  bootWatchTimer = setTimeout(() => {
    if (backend && backend.exitCode === null) {
      restartCount = 0;
      logLine({ backend: 'boot-ok', uptimeMs: Date.now() - backendStartedAt, crashStreak });
    }
  }, BOOT_GRACE_MS);
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartCount += 1;
  const idx = Math.min(restartCount - 1, RESTART_DELAYS.length - 1);
  const delay = RESTART_DELAYS[idx];
  logLine({ backend: 'restart-scheduled', delay, count: restartCount, crashStreak });
  // fail-loud：连续异常退出 → 弹窗询问（重试 / 安全模式 / 取消）。
  // DSHOME_FAIL_LOUD=0 时跳过弹窗（自动化测试用），直接按「重试」继续退避。
  const quiet = process.env.DSHOME_FAIL_LOUD === '0';
  const canDialog = !quiet
    && crashStreak >= MAX_CONSECUTIVE_FAILS
    && Date.now() - lastFailDialogAt >= DIALOG_MIN_INTERVAL_MS;
  if (canDialog) {
    const streak = crashStreak;
    lastFailDialogAt = Date.now();
    crashStreak = 0; // 弹过即重新计数：避免用户点「重试」后被同一轮崩溃连环弹
    const errTail = tailOf(stderrFull, 20) || '（无 stderr 输出）';
    try {
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'DSHOME 后端异常退出',
        message: `后端连续 ${streak} 次异常退出（每次都没能稳定运行满 ${Math.round(STABLE_MS / 1000)} 秒），可能由插件或配置损坏引起。`,
        detail: [
          '最近错误（stderr 尾部）：',
          errTail,
          '',
          `完整 stderr 已落盘：${STDERR_FILE}`,
          `安全模式覆盖层：${SAFE_OVERLAY_FILE}`,
        ].join('\n'),
        buttons: ['重试', '安全模式重启', '回滚上次插件变更并重启', '取消'],
        defaultId: 1, // 反复崩说明「重试」已无效，默认指向安全模式
        cancelId: 3,
        noLink: true,
      });
      logLine({ failDialog: { streak, choice, safeMode } });
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
    } catch (e) { logLine({ failDialogError: String(e?.message ?? e) }); }
  }
  restartTimer = setTimeout(startBackend, delay);
}

function stopBackend() {
  clearTimeout(restartTimer);
  clearTimeout(bootWatchTimer);
  if (backend) {
    const pid = backend.pid;
    backend = null;
    backendStartedAt = 0;
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
  backendStartedAt = 0;
  logLine({ backend: 'manual-restart', safe: safeMode, crashStreak });
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
  const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
  const url = targetUrl();
  try {
    const r = await net.fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok && healthFailLogged < 3) {
      healthFailLogged += 1;
      // 脱敏：只记状态码 + 本次 URL 是否带 token，**绝不记 token 值**
      logLine({ healthcheck: { status: r.status, hasToken: url.includes('token=') } });
    }
    return r.ok;
  } catch (e) {
    clearTimeout(timer);
    if (healthFailLogged < 3) {
      healthFailLogged += 1;
      logLine({ healthcheckError: String(e?.message ?? e), hasToken: url.includes('token=') });
    }
    return false;
  }
}

async function applyBackendState(nowUp) {
  if (nowUp) offlineStreak = 0; // 探到后端在线：清零失败计数，防抖通道恢复正常
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
    try {
      const up = await isBackendUp();
      if (up) {
        offlineStreak = 0;
        await applyBackendState(true);
      } else {
        // 防抖：单次/个别瞬态假失败不回离线页；连续 OFFLINE_REQUIRED 次才真正切离线。
        offlineStreak += 1;
        if (offlineStreak < OFFLINE_REQUIRED) return;
        await applyBackendState(false);
      }
    } catch (e) { logLine({ pollError: String(e?.message ?? e) }); }
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
