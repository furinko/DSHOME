// DSHOME 安装包静默安装冒烟（打包流程步骤⑥）
// 教训：Inno /VERYSILENT 时 setup.exe 复制自身为 .tmp 副本继续解压，pwsh & exe 在原始进程退出后即返回
// → 必须先轮询 DSHOME-setup* 进程全部退出，再检查安装树；首启自愈 junction 需等后端起来。
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';

// 默认安装包：相对仓库根（scripts/ 上溯两级）找 build-stage 下最新 DSHOME-setup-*.exe，
// 不硬编码个人盘符/版本号；可用 argv[2] 或 DSHOME_SETUP 覆盖。
const __dirname = dirname(fileURLToPath(import.meta.url));
const setupDir = join(__dirname, '..', 'build-stage');
const globSetup = () => {
  try {
    const f = readdirSync(setupDir).find((n) => /^DSHOME-setup-.+\.exe$/.test(n));
    return f ? join(setupDir, f) : '';
  } catch { return ''; }
};
const SETUP = process.argv[2] || process.env.DSHOME_SETUP || globSetup() || 'DSHOME-setup-?.exe';
const INSTALL_DIR = mkdtempSync(join(tmpdir(), 'dshome-install-'));
const PORT = 3199; // 避开 3099（开发实例）与 3100+（smoke 随机）

const results = [];
const ok = (m) => { results.push(['PASS', m]); console.log('[PASS] ' + m); };
const bad = (m) => { results.push(['FAIL', m]); console.error('[FAIL] ' + m); };

// 1) 静默安装（等待全部 setup 进程退出，含 .tmp 副本）
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
const child = spawnSync(nodeExe, [dshBin, '--profile', 'dshome', '--no-open', '--port', String(PORT)], {
  env: { ...process.env, DSH_HOME: INSTALL_DIR },
  timeout: 45000, windowsHide: true, encoding: 'utf8',
});

// 3) HTTP 200
let http200 = false;
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('HTTP 超时')), 40000);
    const poll = () => {
      const req = get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 3000 }, (res) => {
        if (res.statusCode === 200) { clearTimeout(t); http200 = true; resolve(); }
        else { res.resume(); setTimeout(poll, 1500); }
      });
      req.on('error', () => { clearTimeout(t); setTimeout(poll, 1500); });
      req.on('timeout', () => req.destroy());
    };
    poll();
  });
} catch { /* timeout */ }
http200 ? ok(`HTTP 200 @127.0.0.1:${PORT}`) : bad(`HTTP 未达 200（后端输出尾部：${String(child.stdout || '').split('\n').slice(-6).join(' | ')}）`);

// 4) profiles\node_modules junction 断言（含原失败点）
const pnm = join(INSTALL_DIR, 'profiles', 'node_modules');
let junctionOk = false, poison = 0, checked = [];
try {
  const { readdirSync } = await import('node:fs');
  const entries = readdirSync(pnm, { withFileTypes: true });
  const targets = ['@deepseek-ai\\dsh', '@earendil-works\\pi-ai', '@aws-sdk'];
  for (const t of targets) {
    const p = join(pnm, ...t.split('\\'));
    if (existsSync(p)) {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { checked.push(`${t}=Junction`); junctionOk = true; }
      else poison++;
    }
  }
} catch (e) { bad(`profiles\\node_modules 读取失败: ${e.message}`); }
if (junctionOk && poison === 0) ok(`profiles\\node_modules 自愈为 junction（${checked.join(', ')}）`);
else bad(`junction 断言失败：junction=${junctionOk} 实体毒树=${poison}`);

// 5) 清理
spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).status;
await new Promise((r) => setTimeout(r, 1500));
try { rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch { /* AV 锁定时忽略 */ }

const failed = results.filter((r) => r[0] === 'FAIL');
console.log('----');
console.log(`INSTALL SMOKE: ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
process.exit(failed.length ? 1 : 0);
