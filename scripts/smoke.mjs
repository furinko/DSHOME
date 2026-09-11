#!/usr/bin/env node
// DSHOME 裸跑冒烟脚本（scripts/smoke.mjs）
// 把「装/改插件后人工裸跑后端盯输出」变成可执行断言：
//   ① 后端在超时内输出 "dsh web:"
//   ② 输出中不含失败标记（ISSUE-001/002 的实测报错文本）
//   ③ 复刻浏览器落地路径后根路径 == 200（dsh 0.1.5-rc.2 起启用 token 鉴权：
//      `?token=` → 303 + Set-Cookie → 带 cookie 求 `/` 才 200；裸请求 401。
//      判据不放松成 `200 || 401`，详见下方 httpOk() 注释）
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

// token 只用于本地探活，日志/报错里一律打码（不得把 token 写进 CI 输出）。
function maskToken(url) {
  return String(url).replace(/token=[^&\s]*/g, 'token=***');
}

// 单发 GET（可带 cookie），把判定所需的三件事都带回来。
function getOnce(target, cookie) {
  let t;
  try {
    t = new URL(target);
  } catch {
    return Promise.resolve({ status: 0, why: 'bad url: ' + maskToken(target) });
  }
  return new Promise((res) => {
    const req = get(
      {
        host: t.hostname,
        port: t.port || 80,
        path: t.pathname + t.search,
        headers: cookie ? { cookie } : {},
        timeout: 10000,
      },
      (r) => {
        r.resume();
        r.on('end', () => res({ status: r.statusCode, location: r.headers.location, setCookie: r.headers['set-cookie'] }));
      }
    );
    req.on('timeout', () => { req.destroy(); res({ status: 0, why: 'timeout' }); });
    req.on('error', (e) => res({ status: 0, why: e.code || e.message }));
  });
}

// dsh 0.1.5-rc.2 起根路径启用 token 鉴权，且**不是**「带 token 就 200」：
//   GET /?token=…  → 303 + Set-Cookie: dsh-auth-…  → Location: /
//   GET /（带该 cookie）→ 200 ；不带 cookie → 401
// （2026-09-12 实测。注意 curl/PowerShell 会自动跟跳转，所以只看它们的结果会误以为 200。）
// 本判据复刻浏览器那条落地路径：拿 cookie → 带 cookie 求 200。不放松成 `200 || 401`——
// 那会把「页面真坏了」也判绿。httpOk 返回 {ok,status,why} 供报错打点。
async function httpOk(bootUrl) {
  const first = await getOnce(bootUrl);
  // 首跳直接 200 = 无鉴权版本下页面**直接可用** ⇒ 也判活。这是**有意保留的兼容分支**，
  // 不是漏洞：本判据回答「页面起没起来」，不负责断言「鉴权开着」（0.1.5-rc.2 有 token 时必走 303，
  // 该分支不可达；将来若鉴权被摘掉，200 仍是"页面可用"的正确结论）。
  if (first.status === 200) return { ok: true, status: 200 };
  const cookie = (first.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  const next = first.location ? new URL(first.location, bootUrl).toString() : bootUrl;
  const second = await getOnce(next, cookie);
  if (second.status === 200) return { ok: true, status: 200 };
  return { ok: false, status: second.status || first.status, why: second.why || first.why || `首跳 status=${first.status}` };
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

  // 2026-09-12 修（独立复核员 smoke-judge-reviewer 抓到 · task-1）：失败路径会把后端 stdout
  // **尾巴**打进日志/CI，而 `out` 里含 `dsh web: http://127.0.0.1:PORT/?token=<真 token>`
  // ⇒ 原来的 `tail(out)` 会把进程 token 明文写进日志，与 maskToken 的声明自相矛盾。
  // 已实测复现（未修复版：明文 token ×1 / 打码 ×0），改为一律先走 maskToken 再打印。
  const maskedTail = () => maskToken(tail(out));

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
    console.error(`SMOKE FAIL: ${reason}\n--- tail ---\n${maskedTail()}`);
    process.exit(1);
  };

  const timer = setTimeout(
    () => finish(false, `超时：${BOOT_TIMEOUT_MS / 1000}s 内未见 "dsh web:"`),
    BOOT_TIMEOUT_MS
  );

  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => {
    if (!settled) finish(false, `后端提前退出（code=${code}）\n--- tail ---\n${maskedTail()}`);
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
    // 无鉴权 URL = 无输入即响亮失败（不退回裸请求 401 的模糊判定）
    const bootUrl = (out.match(/dsh web:\s*(\S+)/) || [])[1];
    if (!bootUrl) return finish(false, '未从后端输出取到 "dsh web:" 带鉴权 URL（无法判定 HTTP 200）');
    const http = await httpOk(bootUrl);
    if (!http.ok) {
      return finish(
        false,
        `HTTP GET ${maskToken(bootUrl)} != 200（实测 status=${http.status}${http.why ? ' / ' + http.why : ''}）`
      );
    }
    const junc = assertFallbackJunctions(dshHome);
    if (!junc.ok) return finish(false, junc.reason);
    finish(true, `http://127.0.0.1:${listenPort} 启动成功，HTTP 200，无失败标记；${junc.reason}`);
  }
}

main().catch((err) => { console.error('SMOKE ERROR:', err); process.exit(1); });
