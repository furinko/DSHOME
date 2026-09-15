// DSHOME 安装包静默安装冒烟（打包流程步骤⑥）
// 教训：Inno /VERYSILENT 时 setup.exe 复制自身为 .tmp 副本继续解压，pwsh & exe 在原始进程退出后即返回
// → 必须先轮询 DSHOME-setup* 进程全部退出，再检查安装树；首启自愈 junction 需等后端起来。
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync, readdirSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';

// 默认安装包：相对仓库根（scripts/ 上溯两级）找 build-stage 下最新 DSHOME-setup-*.exe，
// 不硬编码个人盘符/版本号；可用 argv[2] 或 DSHOME_SETUP 覆盖。
const __dirname = dirname(fileURLToPath(import.meta.url));
const setupDir = join(__dirname, '..', 'build-stage');
// 取**版本号最新**的那个包（不是目录序第一个）。
// 反例（2026-09-14 实测踩中）：build-stage 同时存在 0.3.3 与 0.3.4 时，旧实现
// `readdirSync().find()` 返回的是**目录序第一个**（0.3.3 在前）⇒ 冒烟去装旧包、结论张冠李戴。
// 变红方法：造 `DSHOME-setup-0.3.9.exe` 与 `DSHOME-setup-0.3.10.exe` 两个文件，
// 断言选中 0.3.10 —— 旧实现的 `find()` 稳定选中 0.3.9（应当变红）。
const globSetup = () => {
  try {
    const key = (n) => {
      const m = /^DSHOME-setup-(.+)\.exe$/.exec(n);
      return (m ? m[1] : '').split('.').map((d) => parseInt(d, 10) || 0);
    };
    const cands = readdirSync(setupDir).filter((n) => /^DSHOME-setup-.+\.exe$/.test(n));
    cands.sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < 3; i += 1) { const d = (kb[i] || 0) - (ka[i] || 0); if (d) return d; }
      return 0;
    });
    return cands.length ? join(setupDir, cands[0]) : '';
  } catch { return ''; }
};
// 位置参数只认**非 `-` 开头**的那个：`--print-setup` 这类标志位不能被当成包路径
// （反例：2026-09-14 首版把 `process.argv[2]` 直接当路径，`--print-setup` 被回显成包名 = 假绿）
const cliSetup = process.argv.slice(2).find((a) => !a.startsWith('-'));
const SETUP = cliSetup || process.env.DSHOME_SETUP || globSetup() || 'DSHOME-setup-?.exe';
// --print-setup：只回显"选中哪个包"后退出——供上面 globSetup 的可执行反例用，也方便人工核对
// （2026-09-14 教训：脚本不打印它选了哪个包，装错包时无从察觉）。
if (process.argv.includes('--print-setup')) { console.log(SETUP); process.exit(0); }
const INSTALL_DIR = mkdtempSync(join(tmpdir(), 'dshome-install-'));
const PORT = 3199; // 避开 3099（开发实例）与 3100+（smoke 随机）

const results = [];
const ok = (m) => { results.push(['PASS', m]); console.log('[PASS] ' + m); };
const bad = (m) => { results.push(['FAIL', m]); console.error('[FAIL] ' + m); };

// 1) 静默安装（等待全部 setup 进程退出，含 .tmp 副本）
console.log(`[step1] 包=${SETUP}`);
console.log(`[step1] 静默安装到 ${INSTALL_DIR}`);
spawnSync('powershell', ['-NoProfile', '-Command',
  `Start-Process -FilePath '${SETUP}' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/DIR=${INSTALL_DIR}' -Wait`],
  { stdio: 'inherit', windowsHide: true });
// 轮询 setup 进程退出（Inno .tmp 副本）
let waited = 0;
while (waited < 120) {
  const p = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-Process | Where-Object { $_.ProcessName -like 'DSHOME-setup*' }).Count`],
    { encoding: 'utf8', windowsHide: true });
  const n = parseInt((p.stdout || '').trim() || '0', 10);
  if (n === 0) break;
  waited += 3;
  await new Promise((r) => setTimeout(r, 3000));
}
const installed = existsSync(join(INSTALL_DIR, 'DSHOME.exe')) && existsSync(join(INSTALL_DIR, 'unins000.exe'));
installed ? ok(`安装完成：DSHOME.exe + unins000.exe 在包（setup 进程轮询 ${waited}s 后全退）`) : bad(`安装不完整（缺 DSHOME.exe/unins000.exe）`);

// 2) 启动后端（直接 node 跑 dsh，避开 Electron 壳，快且可控）
const dshBin = join(INSTALL_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const runtime = join(INSTALL_DIR, 'runtime', 'node.exe');
const nodeExe = existsSync(runtime) ? runtime : 'node';
console.log(`[step2] 用自带 node 启动后端（${nodeExe}）`);
// 教训（2026-09-07 实测）：spawnSync 捕获 stdout 会被 dsh 派生的 worker 子进程继承输出句柄拖死
// （45s 超时只杀主进程、孙进程仍握管道 → 等 EOF 永等，实等 1h+）→ 改异步 spawn + 输出重定向到
// 日志文件（不阻塞、保留可诊断日志）；后端是否起来由 step3 的 HTTP 轮询判定。
const backendLog = join(INSTALL_DIR, 'backend-smoke.log');
const logFd = openSync(backendLog, 'w');
const child = spawn(nodeExe, [dshBin, '--profile', 'dshome', '--no-open', '--port', String(PORT)], {
  env: { ...process.env, DSH_HOME: INSTALL_DIR },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
let childExited = false;
child.on('exit', () => { childExited = true; });

// 3) 后端可用性：从后端日志取 token，**带 token** 请求根路径才算通过。
// 反例（2026-09-14 实测踩中）：旧断言写死 `res.statusCode === 200` 且裸 GET `/`，而当前 dsh 根路径
// **无 token 返回 401** ⇒ 该断言永远 FAIL，把"包坏了"与"断言过时"混在一起（当天我先被它误导一轮）。
// 变红方法：把 dshBin 指向一个起不来的脚本（或把 PORT 指到没人听的端口）⇒ 应当报 FAIL；
// 只连上但拿不到 token（后端没走到打印 `dsh web:` 那步）也算 FAIL。
const tokenFromLog = () => {
  try {
    const m = /dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(readFileSync(backendLog, 'utf8'));
    return m ? m[2] : '';
  } catch { return ''; }
};
let backendOk = false, httpSeen = '';
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('HTTP 超时')), 60000);
    const poll = () => {
      if (childExited) { clearTimeout(t); reject(new Error('后端已提前退出')); return; }
      const token = tokenFromLog();
      const req = get({ host: '127.0.0.1', port: PORT, path: token ? `/?token=${token}` : '/', timeout: 3000 }, (res) => {
        httpSeen = token ? `HTTP ${res.statusCode}（带 token）` : `HTTP ${res.statusCode}（无 token，后端可能未就绪）`;
        // 判据 = 带 token 时 **200 或 303**：实测（2026-09-15）`GET /?token=X` → **303 + Set-Cookie + Location: /**
        // （跟随重定向才得 200；裸 `/` 是 401）。写死 200 会把"token 握手成功"误判成失败——本脚本第二版就栽在这。
        // 反例（变红方法）：把 dshBin 指向起不来的脚本、或把 PORT 指到没人听的端口 ⇒ 应当 FAIL。
        if ((res.statusCode === 200 || res.statusCode === 303) && token) { clearTimeout(t); backendOk = true; resolve(); }
        else { res.resume(); setTimeout(poll, 1500); }
      });
      req.on('error', () => { clearTimeout(t); setTimeout(poll, 1500); });
      req.on('timeout', () => req.destroy());
    };
    poll();
  });
} catch { /* timeout or child exit */ }
backendOk
  ? ok(`后端可用：${httpSeen} @127.0.0.1:${PORT}（token 握手通过：200 或 303 均算）`)
  : bad(`后端不可用（最后响应：${httpSeen || '无响应'}；后端日志尾部：${readFileSync(backendLog, 'utf8').split('\n').filter(Boolean).slice(-6).join(' | ')}）`);

// 4) profiles\node_modules junction 断言（含 ISSUE-003 原失败点）
// 判据收窄（2026-09-15 实测）：**只有 profile 的 pin 依赖**必须自愈成 junction；`@aws-sdk` 在**开发态
// 同样是实体目录**（19 个子项，实测活着的 3099 实例）⇒ 它是 dsh 运行期生成的实体、**不是毒树**。
// 旧版把它一并当毒树 ⇒ 该断言恒 FAIL（与"裸 GET / 期望 200"同一种病：过宽断言让真缺陷淹没在噪音里）。
// 反例（变红方法）：把某个 pin 依赖（如 `@deepseek-ai\dsh`）换成实体目录 ⇒ 应当 FAIL 且列出"实体(毒树)"。
const pnm = join(INSTALL_DIR, 'profiles', 'node_modules');
const mustBeLink = ['@deepseek-ai\\dsh', '@earendil-works\\pi-ai']; // profile pin 依赖：必须 junction
const infoOnly = ['@aws-sdk'];                                      // 运行期实体目录：只记录，不判毒
let junctionOk = false, poison = 0;
const checked = [];
try {
  for (const t of mustBeLink) {
    const p = join(pnm, ...t.split('\\'));
    if (!existsSync(p)) { checked.push(`${t}=缺失`); continue; }
    if (lstatSync(p).isSymbolicLink()) { checked.push(`${t}=Junction`); junctionOk = true; }
    else { checked.push(`${t}=实体(毒树)`); poison += 1; }
  }
  for (const t of infoOnly) {
    const p = join(pnm, ...t.split('\\'));
    if (existsSync(p)) checked.push(`${t}=${lstatSync(p).isSymbolicLink() ? 'Junction' : '实体(非毒树·开发态同形)'}`);
  }
} catch (e) { bad(`profiles\\node_modules 读取失败: ${e.message}`); }
if (junctionOk && poison === 0) ok(`profiles\\node_modules pin 依赖自愈为 junction（${checked.join(' · ')}）`);
else bad(`junction 断言失败：${checked.join(' · ')}（毒树=${poison}）`);

// 5) **先出结论，再清理**。
// 反例（2026-09-14 实测踩中）：旧实现把结论打印放在 `rmSync` 之后 ⇒ 删 1 GB 安装树慢/进程被杀时
// **零输出**（当天 600s 超时什么都没看到，只能另写等价验证取判据）。变红方法：把下面 rmSync 前加长
// sleep 并在中途 kill ⇒ 旧实现无结论、新实现结论已落屏。
const failed = results.filter((r) => r[0] === 'FAIL');
console.log('----');
console.log(`INSTALL SMOKE: ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
console.log(`[cleanup] 安装目录：${INSTALL_DIR}（结论已输出；清理失败不影响判定）`);

spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).status;
await new Promise((r) => setTimeout(r, 1500));
try { rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch { /* AV 锁定时忽略 */ }

process.exit(failed.length ? 1 : 0);
