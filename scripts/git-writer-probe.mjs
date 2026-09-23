#!/usr/bin/env node
// scripts/git-writer-probe.mjs — 共享工作区「写者盘点 / 落定等待」探针（2026-09-23 建）
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// L2 技能 `concurrent-writers` §一 step1 要求：动手前先问一句「还有谁在动这批文件」。
// 但这条纪律此前**只有文字、没有工具**，而 `git status` 干净最容易被误当"没有别的写者"
// （2026-09-11 多会话并发改主 profile ⇒ 后端 38 轮崩溃循环；2026-09-23 又实测到两个写者
// 同时把 git 之外的 payload 快照点红）。本脚本把那一"问"变成一条命令。
//
// ⚠️ 定位（不许当闸卖）：**它是探针，不是闸**。它治「我不知道有并发写者」，
//    不治「两个人同时写」——后者只能靠单写者协议 / 独立 DSH_HOME（技能 §一 step3）。
//    因此它**不进 pre-commit 当拦门**：判据是"别人在飞"，而对方可能几小时不落定 ⇒ 会恒红
//    （`limits.md`「恒亮灯＝没灯」同型）。它只**报**，判定权在调用者。
//
// ── 用法 ─────────────────────────────────────────────────────────────────────
//   node scripts/git-writer-probe.mjs                  # 一次盘点（默认 · 无参只读）
//   node scripts/git-writer-probe.mjs --json           # 同一份读数，机器可读
//   node scripts/git-writer-probe.mjs --wait --until packages/x/ --timeout 6h --interval 45s
//   node scripts/git-writer-probe.mjs --selftest       # 隔离临时仓库跑正反例
//
// ── 退出码 ───────────────────────────────────────────────────────────────────
//   0 = 无跨写者风险信号 / `--wait` 等到落定
//   1 = 用法或环境错误（响亮失败，不静默降级）
//   2 = 检测到「提交会撞」的硬信号（暂存面非空，同时共享单写者面 / 新包目录正在被改）
//   3 = `--wait` 超时（仍未落定）
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

const USAGE = `用法：
  node scripts/git-writer-probe.mjs                     一次盘点（无参只读）
  node scripts/git-writer-probe.mjs --json              机器可读读数
  node scripts/git-writer-probe.mjs --wait --until <路径> [--until <路径>…] [--timeout 6h] [--interval 45s]
  node scripts/git-writer-probe.mjs --selftest          隔离临时仓库正反例
退出码：0 无风险信号 / 1 用法或环境错误 / 2 提交会撞的硬信号 / 3 --wait 超时`;

// ── 共享单写者面（技能 §一 step3：同一时刻只允许一个写者）────────────────────
// 判据来自 2026-09-11 那次崩溃的写面：profile 的 bundles/依赖与 workspace 锁文件。
const SHARED_RES = [
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^profiles\/[^/]+\/package\.json$/,
  /^profiles\/[^/]+\/cordis\.patch\.yml$/,
];
const isShared = (p) => SHARED_RES.some((re) => re.test(p));
/** 未跟踪的**新建目录**——半成品新包的典型形态。注意 `git status` 的折叠规则：
 *  `packages/` 里只要有**已跟踪**文件，新目录就折叠成 `packages/<名>/`；若整个 `packages/` 都没被跟踪，
 *  只折叠成 `packages/`。**两种形态都要认**——2026-09-23 自测实测：只认前者会让后者静默通过（假绿）。 */
const isNewDir = (p) => /^packages(\/[^/]+)?\/$/.test(p);

const norm = (s) => String(s).trim().replace(/\\/g, '/').replace(/\/+$/, '');
const matchPath = (p, u) => { const a = norm(p); const b = norm(u); return a === b || a.startsWith(b + '/'); };
const ts = () => new Date().toTimeString().slice(0, 8);
const flagVals = (name) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]); return out; };
const flagVal = (name) => (flagVals(name)[0] ?? null);

function loud(msg) { console.error(`[git-writer-probe] ❌ ${msg}`); }

/** 仓库根；不是 git 工作区 → 响亮失败（`verify-integrity` #4：无输入即响亮失败，不静默跳过）。 */
function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    loud(`不在 git 工作区（git rev-parse 失败：${String(e.message || e).split('\n')[0]}）`);
    return null;
  }
}

/** `--porcelain=v1 -z`：NUL 分隔、非 ASCII 路径不转义（本仓有中文路径）。 */
function readStatus(root) {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parts = raw.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const x = e[0]; const y = e[1]; const p = e.slice(3);
    if (x === 'R' || x === 'C') i += 1; // 重命名/复制：下一段是原路径，跳过
    entries.push({ x, y, p });
  }
  return entries;
}

function classify(entries) {
  const staged = []; const flying = []; const untracked = [];
  for (const e of entries) {
    if (e.x === '?' && e.y === '?') { untracked.push(e); flying.push(e); continue; }
    if (e.x !== ' ') staged.push(e);   // X 位＝暂存面（我打算提交的）
    if (e.y !== ' ') flying.push(e);   // Y 位＝工作树未暂存
  }
  return { staged, flying, untracked, entries };
}

/** 硬信号＝「提交会撞」：有暂存面，同时共享单写者面或新包目录正在被改。 */
function hardSignals({ staged, flying, untracked }) {
  const reasons = [];
  if (!staged.length) return reasons; // 没有要提交的东西 ⇒ 不存在"提交撞车"
  const shared = flying.filter((e) => isShared(e.p));
  const newDir = untracked.filter((e) => isNewDir(e.p));
  if (shared.length) reasons.push(`共享单写者面正在被改（${shared.length} 件）：${shared.map((e) => e.p).join('、')}`);
  if (newDir.length) reasons.push(`未跟踪的新建目录（${newDir.length} 件）：${newDir.map((e) => e.p).join('、')}`);
  return reasons;
}

const line = (e) => `    ${e.x}${e.y}  ${e.p}`;
const tagOf = (e) => (isShared(e.p) ? ' ← 共享单写者面' : (e.x === '?' && isNewDir(e.p) ? ' ← 未跟踪的新建目录' : ''));

function collect(root) {
  const st = classify(readStatus(root));
  return { ...st, reasons: hardSignals(st) };
}

function printReport(root, st) {
  console.log(`[git-writer-probe] 仓库：${root}`);
  console.log(`[git-writer-probe] 暂存面（我打算提交的）＝ ${st.staged.length} 件`);
  for (const e of st.staged) console.log(line(e));
  const tagged = st.flying.filter((e) => tagOf(e));
  const rest = st.flying.filter((e) => !tagOf(e));
  console.log(`[git-writer-probe] 在飞的其它面 ＝ ${st.flying.length} 件（可能是别人在写，也可能是我自己没 add 的）`);
  for (const e of tagged) console.log(line(e) + tagOf(e));
  for (const e of rest.slice(0, 5)) console.log(line(e));
  if (rest.length > 5) console.log(`    …另有 ${rest.length - 5} 件普通在飞改动（未逐一列出）`);
  if (!st.flying.length) console.log('    （无）');
  if (st.reasons.length) {
    console.error('[git-writer-probe] ⚠️ 硬信号：提交会撞 ——');
    for (const r of st.reasons) console.error(`    · ${r}`);
    console.error('[git-writer-probe] 先确认写者归属（技能 §一 step1）与暂存面只含自己该提交的（step5），再决定等 / 排除 / 换独立环境。');
  } else if (st.staged.length) {
    // 🔴 诚实边界（2026-09-23 实测抓到）：探针只能**列**暂存面，**判不了归属**——
    //    当天 17:48 暂存面只有自己的 2 件，17:51 被第三方会话扩成 6 件，而本脚本仍报 ✅。
    //    判不了就说判不了，不许把"没交错"说成"安全"。
    console.log(`[git-writer-probe] ⚠️ 无跨写者风险信号，但**暂存面归属待核**：${st.staged.length} 件——探针只**列**它，判不了其中哪些是"你 add 的"；第三方可能已写进 index ⇒ 提交前逐项核对（技能 §一 step5）。`);
  } else {
    console.log('[git-writer-probe] ✅ 无跨写者风险信号且暂存面为空（注意：这不等于"没有别人在写"——只代表暂存面与非暂存面无交错）。');
  }
}

function runReport() {
  const root = gitRoot(process.cwd());
  if (!root) return 1;
  let st;
  try { st = collect(root); } catch (e) { loud(`读 git status 失败：${String(e.message || e).split('\n')[0]}`); return 1; }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      root,
      stagedCount: st.staged.length,
      staged: st.staged.map((e) => ({ xy: `${e.x}${e.y}`, path: e.p })),
      flyingCount: st.flying.length,
      flying: st.flying.map((e) => ({ xy: `${e.x}${e.y}`, path: e.p, tag: tagOf(e).trim() || null })),
      hardSignals: st.reasons,
    }, null, 2));
  } else {
    printReport(root, st);
  }
  return st.reasons.length ? 2 : 0;
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(n * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 'ms']));
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function runWait() {
  const untils = flagVals('--until');
  if (!untils.length) {
    loud('`--wait` 必须至少给一个 `--until <路径>`——否则不知道在等什么（响亮失败，不静默降级）');
    console.error(USAGE);
    return 1;
  }
  const timeout = parseDuration(flagVal('--timeout') || '6h');
  const interval = parseDuration(flagVal('--interval') || '45s');
  if (timeout == null || interval == null || interval <= 0) {
    loud('`--timeout` / `--interval` 写法不合法（例：`6h` / `90s` / `1500ms`）');
    return 1;
  }
  const root = gitRoot(process.cwd());
  if (!root) return 1;
  const t0 = Date.now();
  let prev = null;
  console.log(`[git-writer-probe] 等待落定：${untils.join('、')}（超时 ${timeout}ms · 轮询 ${interval}ms · 只读）`);
  for (;;) {
    let st;
    try { st = collect(root); } catch (e) { loud(`读 git status 失败：${String(e.message || e).split('\n')[0]}`); return 1; }
    const pending = untils.filter((u) => st.flying.some((e) => matchPath(e.p, u)));
    const sig = pending.join('|');
    if (sig !== prev) {
      console.log(`[${ts()}] ${pending.length ? `仍在飞：${pending.join('、')}` : '三判据已消（目标全部离开工作区）'}`);
      prev = sig;
    }
    if (!pending.length) {
      console.log(`[${ts()}] READY：已落定（等待 ${Math.round((Date.now() - t0) / 1000)}s）→ 可继续复核暂存面 / 同步快照`);
      return 0;
    }
    if (Date.now() - t0 >= timeout) {
      loud(`超时 ${timeout}ms：仍未落定 —— ${pending.join('、')}`);
      return 3;
    }
    sleepMs(interval);
  }
}

// ── 自测：隔离临时仓库，正例 + **应当变红**的反例（gate-ledger 棘轮精神）────────
// 反证方法：把 `hardSignals` 的共享面判据注释掉 ⇒ 用例 ③ 必红；把 `--wait` 超时判据删掉 ⇒ 用例 ⑥ 必红。
function selftest() {
  const tmp = mkdtempSync(join(tmpdir(), 'git-writer-probe-'));
  const cases = [];
  const run = (args) => spawnSync(process.execPath, [SELF, ...args], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  const git = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '-q']);
    writeFileSync(join(tmp, 'base.txt'), 'base\n');
    cases.push(['① 干净仓库 → 0', run([]).status === 0]);

    writeFileSync(join(tmp, 'mine.txt'), 'mine\n');
    git(['add', 'mine.txt']);
    cases.push(['② 只有我的产物 staged（无交错面）→ 0', run([]).status === 0]);

    writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const c3 = run([]);
    cases.push(['③ 共享面在飞 + 有暂存 → 2（反例：注释掉共享面判据必红）', c3.status === 2 && /共享单写者面/.test(c3.stdout)]);

    rmSync(join(tmp, 'pnpm-lock.yaml'));
    // 先让 `packages/` 里有一件**已跟踪**文件 ⇒ git 才会把新目录单独折叠成 `packages/newpkg/`
    // （否则整个 `packages/` 未跟踪、折叠成 `packages/`——这一形态本脚本第一版漏判过，见 `isNewDir` 注释）
    mkdirSync(join(tmp, 'packages', 'keep'), { recursive: true });
    writeFileSync(join(tmp, 'packages', 'keep', 'tracked.txt'), 'keep\n');
    git(['add', 'packages/keep/tracked.txt']);
    mkdirSync(join(tmp, 'packages', 'newpkg'), { recursive: true });
    writeFileSync(join(tmp, 'packages', 'newpkg', 'index.js'), 'export {};\n');
    const c4 = run([]);
    cases.push(['④ 未跟踪新建目录（折叠成 packages/<名>/）+ 有暂存 → 2', c4.status === 2 && /未跟踪的新建目录/.test(c4.stdout)]);

    // ④b：**整个 `packages/` 未跟踪**那一形态（git 只吐 `?? packages/`）也必须报 2 —— 第一版的假绿缺口
    const tmp2 = mkdtempSync(join(tmpdir(), 'git-writer-probe-b-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmp2, stdio: ['ignore', 'pipe', 'pipe'] });
      writeFileSync(join(tmp2, 'mine.txt'), 'mine\n');
      execFileSync('git', ['add', 'mine.txt'], { cwd: tmp2, stdio: ['ignore', 'pipe', 'pipe'] });
      mkdirSync(join(tmp2, 'packages', 'newpkg'), { recursive: true });
      writeFileSync(join(tmp2, 'packages', 'newpkg', 'index.js'), 'export {};\n');
      const c4b = spawnSync(process.execPath, [SELF], { cwd: tmp2, encoding: 'utf8', timeout: 60000 });
      cases.push(['④b 整个 packages/ 未跟踪（折叠成 packages/）→ 2', c4b.status === 2 && /未跟踪的新建目录/.test(c4b.stdout)]);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }

    const c5 = run(['--wait', '--until', 'packages/gone', '--timeout', '2s', '--interval', '50ms']);
    cases.push(['⑤ --wait 目标已不在工作区 → 0 且印 READY', c5.status === 0 && /READY/.test(c5.stdout)]);

    const c6 = run(['--wait', '--until', 'packages/newpkg', '--timeout', '1s', '--interval', '100ms']);
    cases.push(['⑥ --wait 目标恒在 → 3 超时（反例：删掉超时判据必红）', c6.status === 3]);

    cases.push(['⑦ --wait 缺 --until → 1 响亮失败', run(['--wait']).status === 1]);

    const c8 = run(['--json']);
    let jsonOk = false;
    try { const o = JSON.parse(c8.stdout); jsonOk = o.stagedCount === 2 && o.hardSignals.length === 1; } catch { jsonOk = false; }
    cases.push(['⑧ --json 读数可解析且暂存/硬信号计数正确', jsonOk]);

    // ⑨ 无交错但**暂存面非空** ⇒ 不得只报"✅ 无风险"，必须提示「归属待核」
    //   （第一版在这里给过假安心：2026-09-23 实测 index 被第三方从 2 件扩到 6 件，而探针仍报 ✅）
    rmSync(join(tmp, 'packages', 'newpkg'), { recursive: true, force: true });
    rmSync(join(tmp, 'base.txt'), { force: true });
    const c9 = run([]);
    cases.push(['⑨ 暂存面非空、无交错 → 0 但必须提示「归属待核」', c9.status === 0 && /归属待核/.test(c9.stdout)]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('[git-writer-probe --selftest] 隔离临时仓库（真仓库零触碰）');
  for (const [name, ok] of cases) console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  const bad = cases.filter(([, ok]) => !ok).length;
  if (bad) { console.error(`[git-writer-probe --selftest] ❌ ${bad} 个用例未过`); return 1; }
  console.log(`[git-writer-probe --selftest] ✅ ${cases.length}/${cases.length} 通过`);
  return 0;
}

if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
if (argv.includes('--selftest')) process.exit(selftest());
process.exit(argv.includes('--wait') ? runWait() : runReport());
