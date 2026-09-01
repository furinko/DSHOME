#!/usr/bin/env node
// DSHOME 裸跑冒烟脚本（scripts/smoke.mjs）
// 把「装/改插件后人工裸跑后端盯输出」变成可执行断言：
//   ① 后端在超时内输出 "dsh web:"
//   ② 输出中不含失败标记（ISSUE-001/002 的实测报错文本）
//   ③ HTTP GET 根路径 == 200
//   ④ profiles\node_modules 自愈结果为 junction（ISSUE-003 门禁：实体目录 = 安装包毒树复现）
// 用法：
//   node scripts/smoke.mjs                        # 正向冒烟（期望通过）
//   node scripts/smoke.mjs --patch <overlay.yml>  # 带额外 patch 层（阴性自测/复现用）
//   node scripts/smoke.mjs --expect-fail          # 期望失败（阴性路径自测，退出码取反）
//   node scripts/smoke.mjs --port <n>             # 指定端口（默认自动选空闲端口）
import { spawn } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(flagValue('--port') ?? 0); // 0 → 自动分配空闲端口
const patch = flagValue('--patch');
const expectFail = argv.includes('--expect-fail');
const BOOT_TIMEOUT_MS = 60000;
const SETTLE_MS = 5000; // 等到 dsh web: 后，再等 web boot 相关日志落定

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dshBin = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// 失败标记：DSHOME-ISSUE-001（插件树加载失败）与 ISSUE-002（client 侧激活失败）的实测文本。
const FAIL_MARKERS = ['plugin tree failed', 'did not activate', 'pending (waiting for service'];

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

function httpOk(port) {
  return new Promise((res) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 10000 }, (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); res(false); });
    req.on('error', () => res(false));
  });
}

// ISSUE-003：扁平模块 fallback 目录必须是 junction 集合（实体目录 = 安装包毒树复现）。
// 抽查依赖闭包代表包：dsh 本体与 dsh-app-boot（ensureSymlink 首个失败点）。
function assertFallbackJunctions(dshHome) {
  const probes = [
    ['@deepseek-ai', 'dsh'],
    ['@deepseek-ai', 'dsh-app-boot'],
  ];
  for (const seg of probes) {
    const p = join(dshHome, 'profiles', 'node_modules', ...seg);
    let st;
    try { st = lstatSync(p); } catch { return { ok: false, reason: `${p} 不存在（自愈未完成）` }; }
    if (!st.isSymbolicLink()) return { ok: false, reason: `${p} 不是 junction（ISSUE-003）` };
  }
  const dshLink = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  return { ok: true, reason: `profiles\\node_modules\\@deepseek-ai\\dsh → ${readlinkSync(dshLink)}` };
}

function tail(text) { return text.split('\n').filter(Boolean).slice(-20).join('\n'); }

async function main() {
  const dshHome = process.env.DSH_HOME || repoRoot;
  const listenPort = port || (await freePort());
  // ISSUE-001 教训：DSH_HOME 未设置时 dsh 会报误导性的 `profile "dshome" does not exist`。
  // 未显式指定 DSH_HOME 时注入 repoRoot（开发实例），避免依赖调用方环境。
  const childEnv = { ...process.env };
  if (!process.env.DSH_HOME) childEnv.DSH_HOME = dshHome;
  // 注意：--profile/--patch 是 launcher flag，必须排在内层 app 参数（--no-open/--port）之前，
  // 否则会被当作 app 参数报 unknown option。
  const args = [dshBin, '--profile', 'dshome'];
  if (patch) args.push('--patch', patch);
  args.push('--no-open', '--port', String(listenPort));

  const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let settled = false;

  const finish = (ok, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(bootTimer);
    try { child.kill(); } catch { /* ignore */ }
    const pass = ok !== expectFail;
    if (pass) {
      console.log(`SMOKE ${ok ? 'PASS' : 'PASS (expected failure detected)'}: ${reason}`);
      process.exit(0);
    }
    console.error(`SMOKE FAIL: ${reason}\n--- tail ---\n${tail(out)}`);
    process.exit(1);
  };

  const timer = setTimeout(
    () => finish(false, `超时：${BOOT_TIMEOUT_MS / 1000}s 内未见 "dsh web:"`),
    BOOT_TIMEOUT_MS
  );

  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => {
    if (!settled) finish(false, `后端提前退出（code=${code}）\n--- tail ---\n${tail(out)}`);
  });

  let booted = false;
  const bootTimer = setInterval(() => {
    if (settled) { clearInterval(bootTimer); return; }
    if (booted || !out.includes('dsh web:')) return;
    booted = true;
    clearInterval(bootTimer);
    // 等 web boot 相关日志落定，再统一断言（避免先于失败文本到达而漏报）
    setTimeout(finalize, SETTLE_MS);
  }, 250);

  async function finalize() {
    if (settled) return;
    const marker = FAIL_MARKERS.find((m) => out.includes(m));
    if (marker) return finish(false, `命中失败标记："${marker}"`);
    const okHttp = await httpOk(listenPort);
    if (!okHttp) return finish(false, `HTTP GET http://127.0.0.1:${listenPort}/ != 200`);
    const junc = assertFallbackJunctions(dshHome);
    if (!junc.ok) return finish(false, junc.reason);
    finish(true, `http://127.0.0.1:${listenPort} 启动成功，HTTP 200，无失败标记；${junc.reason}`);
  }
}

main().catch((err) => { console.error('SMOKE ERROR:', err); process.exit(1); });
