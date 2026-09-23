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
// ── 归属维度（2026-09-23 补 · 原先它自己承认"判不了归属"）──────────────────────
// 病灶（2026-09-23 实测，就在本仓）：`cron.cjs` 被另一会话 23:06:22 改（+37 行），而我
//   手里只有 `git status` + mtime ⇒ **判不出"这是谁在写"**，只能猜；原脚本的 `### 归属待核`
//   那段也白纸黑字承认这一点（index 被第三方从 2 件扩到 6 件时它仍报 ✅）。
// 补法：读 `mind-private/tasks/write-log.jsonl`——`dshome-mind-guard` 在 **write/edit 写成功**
//   后追加的一条归属记录 `{ts,session,tool,path}`（append-only）。据此：
//     ① 给每条在飞/暂存行标 **归属**（是谁、什么时候写的）；
//     ② 检出 **「同一文件被 ≥2 个会话在短窗口内写」**——注意口径：**并发会话本身不是问题，
//        同时改同一个东西才是**（技能 `concurrent-writers` / 主人 2026-09-23 明确）；
//     ③ 台账**不存在**（无心智区的仓库 / 没跑过写类工具）⇒ 如实报"归属未知"，不崩、不编。
//   ⚠️ 台账是**最近一次**的记录面，且有上界裁剪（512KB 保留后半）⇒ 归属只对**近期**有效。
//
// ── 用法 ─────────────────────────────────────────────────────────────────────
//   node scripts/git-writer-probe.mjs                  # 一次盘点（默认 · 无参只读）
//   node scripts/git-writer-probe.mjs --json           # 同一份读数，机器可读
//   node scripts/git-writer-probe.mjs --wait --until packages/x/ --timeout 6h --interval 45s
//   node scripts/git-writer-probe.mjs --claim-window 30m   # 并发写同一文件的判定窗口（默认 30m）
//   node scripts/git-writer-probe.mjs --selftest       # 隔离临时仓库跑正反例
//
// ── 退出码 ───────────────────────────────────────────────────────────────────
//   0 = 无跨写者风险信号 / `--wait` 等到落定
//   1 = 用法或环境错误（响亮失败，不静默降级）
//   2 = 检测到「提交会撞」的硬信号（暂存面非空，同时共享单写者面 / 新包目录正在被改）
//   3 = `--wait` 超时（仍未落定）
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

// ── 归属：读写入台账（见文件头「归属维度」）────────────────────────────────────
const CLAIM_REL = 'mind-private/tasks/write-log.jsonl';

/** 读归属台账。**台账不存在 ⇒ `available:false`**（无心智区的仓库照常可用），绝不抛。 */
function readClaims(root, windowMs) {
  const byPath = new Map(); // path -> 最近一条 { t, session, tool, ts }
  const recent = new Map(); // path -> Set<session>（窗口内）
  let raw = '';
  try { raw = readFileSync(join(root, CLAIM_REL), 'utf8'); } catch { return { available: false, byPath, recent }; }
  const cutoff = Date.now() - windowMs;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o.path !== 'string' || !o.path) continue;
    const p = norm(o.path);
    const t = Date.parse(o.ts);
    const prev = byPath.get(p);
    if (!prev || (Number.isFinite(t) && t >= prev.t)) byPath.set(p, { t, session: o.session ?? null, tool: o.tool ?? '', ts: o.ts });
    if (Number.isFinite(t) && t >= cutoff && o.session) {
      if (!recent.has(p)) recent.set(p, new Set());
      recent.get(p).add(String(o.session));
    }
  }
  return { available: true, byPath, recent };
}

/** 归属标注（给人看的尾巴）。台账里没这条路径 ⇒ 如实说"未知"，不拿"最近一个会话"顶上。 */
function claimTag(p, claims) {
  if (!claims.available) return '';
  const c = claims.byPath.get(norm(p));
  if (!c) return '   ← 归属未知（台账无此路径）';
  const sid = c.session ? String(c.session).slice(0, 8) : '无会话';
  const at = Number.isFinite(c.t) ? new Date(c.t).toTimeString().slice(0, 8) : '—';
  return `   ← ${sid} @ ${at}`;
}

/** 并发写同一文件：**同一路径在窗口内出现 ≥2 个不同会话** ⇒ 这才是"同时修改同一个东西"。
 *  同一会话反复写同一文件**不算**（那是一个人在反复改）。只在「涉及提交的面」上判。 */
function claimConflicts(st, claims) {
  const out = [];
  if (!claims.available) return out;
  const seen = new Set();
  for (const e of [...st.staged, ...st.flying]) {
    const p = norm(e.p);
    if (seen.has(p)) continue;
    seen.add(p);
    const set = claims.recent.get(p);
    if (set && set.size >= 2) out.push({ path: p, sessions: [...set].map((s) => s.slice(0, 8)).sort() });
  }
  return out;
}

/** 硬信号＝「提交会撞」：有暂存面，同时共享单写者面 / 新包目录 / **同一文件多会话在写**。 */
function hardSignals({ staged, flying, untracked }, conflicts = []) {
  const reasons = [];
  if (!staged.length) return reasons; // 没有要提交的东西 ⇒ 不存在"提交撞车"
  const shared = flying.filter((e) => isShared(e.p));
  const newDir = untracked.filter((e) => isNewDir(e.p));
  if (shared.length) reasons.push(`共享单写者面正在被改（${shared.length} 件）：${shared.map((e) => e.p).join('、')}`);
  if (newDir.length) reasons.push(`未跟踪的新建目录（${newDir.length} 件）：${newDir.map((e) => e.p).join('、')}`);
  for (const c of conflicts) {
    reasons.push(`**同一文件被 ${c.sessions.length} 个会话在窗口内写**（${c.path}）：${c.sessions.join(' / ')} ← 这才是"同时改同一个东西"，先定归属再决定谁退让`);
  }
  return reasons;
}

/** 归属读数（机器可读版）。台账里没这条路径 ⇒ `{known:false}`，绝不拿别的会话顶上。 */
function claimInfo(p, claims) {
  if (!claims.available) return null;
  const c = claims.byPath.get(norm(p));
  if (!c) return { known: false };
  return { known: true, session: c.session ? String(c.session).slice(0, 8) : null, ts: c.ts ?? null, tool: c.tool ?? '' };
}

const line = (e) => `    ${e.x}${e.y}  ${e.p}`;
const tagOf = (e) => (isShared(e.p) ? ' ← 共享单写者面' : (e.x === '?' && isNewDir(e.p) ? ' ← 未跟踪的新建目录' : ''));

function collect(root, claimWindowMs) {
  const st = classify(readStatus(root));
  const claims = readClaims(root, claimWindowMs);
  const conflicts = claimConflicts(st, claims);
  return { ...st, claims, conflicts, reasons: hardSignals(st, conflicts) };
}

function printReport(root, st) {
  console.log(`[git-writer-probe] 仓库：${root}`);
  console.log(`[git-writer-probe] 暂存面（我打算提交的）＝ ${st.staged.length} 件`);
  for (const e of st.staged) console.log(line(e) + claimTag(e.p, st.claims));
  const tagged = st.flying.filter((e) => tagOf(e));
  const rest = st.flying.filter((e) => !tagOf(e));
  console.log(`[git-writer-probe] 在飞的其它面 ＝ ${st.flying.length} 件（可能是别人在写，也可能是我自己没 add 的）`);
  for (const e of tagged) console.log(line(e) + tagOf(e) + claimTag(e.p, st.claims));
  for (const e of rest.slice(0, 8)) console.log(line(e) + claimTag(e.p, st.claims));
  if (rest.length > 8) console.log(`    …另有 ${rest.length - 8} 件普通在飞改动（未逐一列出）`);
  if (!st.flying.length) console.log('    （无）');
  if (!st.claims.available) {
    console.log('[git-writer-probe] ℹ️ 归属台账不存在（mind-private/tasks/write-log.jsonl）——归属维度不可用；**不猜、不编**（心智区外的仓库本来就没有它）。');
  }
  if (st.reasons.length) {
    console.error('[git-writer-probe] ⚠️ 硬信号：提交会撞 ——');
    for (const r of st.reasons) console.error(`    · ${r}`);
    console.error('[git-writer-probe] 先确认写者归属（技能 §一 step1）与暂存面只含自己该提交的（step5），再决定等 / 排除 / 换独立环境。');
  } else if (st.staged.length) {
    // 🔴 诚实边界（2026-09-23 实测抓到，同日**收窄**一次）：探针只能**列**暂存面——
    //    当天 17:48 暂存面只有自己的 2 件，17:51 被第三方会话扩成 6 件，而本脚本仍报 ✅。
    //    同日补了**归属维度**（write-log 台账 ⇒ 能标"谁**写**了这个文件"），但**仍判不了
    //    "哪些是我 `git add` 的"**：`add` 是 index 操作、不经过 write/edit 工具 ⇒ 台账里没有它。
    //    所以这句警告**保持有效**，只是从"完全不知道"收窄成"知道谁写的、不知道谁暂存的"。
    console.log(`[git-writer-probe] ⚠️ 无跨写者风险信号，但**暂存面归属待核**：${st.staged.length} 件——探针能标"谁写过它"（见上方「← 会话 @ 时刻」），但判不了"谁 add 的"；第三方可能已写进 index ⇒ 提交前逐项核对（技能 §一 step5）。`);
  } else {
    console.log('[git-writer-probe] ✅ 无跨写者风险信号且暂存面为空（注意：这不等于"没有别人在写"——只代表暂存面与非暂存面无交错）。');
  }
  // 并发写同一文件：这是「正在发生的事实」，**与暂存面无关** ⇒ 暂存面为空时也要报；
  //   但**不计入退出码**（没有要提交的东西 ⇒ 不存在"提交撞车"；避免恒红，见文件头定位）。
  if (st.conflicts.length && !st.staged.length) {
    console.error('[git-writer-probe] ⚠️ 并发写同一文件（暂存面为空，故不计入退出码，仅供知情）：');
    for (const c of st.conflicts) console.error(`    · ${c.path} ← 会话 ${c.sessions.join(' / ')}`);
    console.error('[git-writer-probe] 口径：**并发会话本身不是问题，同时改同一个东西才是**（技能 concurrent-writers）——先定归属，再决定谁退让 / 谁等落定。');
  }
}

function runReport() {
  const root = gitRoot(process.cwd());
  if (!root) return 1;
  const cw = parseDuration(flagVal('--claim-window') || '30m');
  if (cw == null || cw <= 0) { loud('`--claim-window` 写法不合法（例：`30m` / `1h` / `90s`）'); return 1; }
  let st;
  try { st = collect(root, cw); } catch (e) { loud(`读 git status 失败：${String(e.message || e).split('\n')[0]}`); return 1; }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      root,
      stagedCount: st.staged.length,
      staged: st.staged.map((e) => ({ xy: `${e.x}${e.y}`, path: e.p, claim: claimInfo(e.p, st.claims) })),
      flyingCount: st.flying.length,
      flying: st.flying.map((e) => ({ xy: `${e.x}${e.y}`, path: e.p, tag: tagOf(e).trim() || null, claim: claimInfo(e.p, st.claims) })),
      claimsAvailable: st.claims.available,
      claimWindowMs: cw,
      claimConflicts: st.conflicts,
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
  const cw = parseDuration(flagVal('--claim-window') || '30m');
  if (cw == null || cw <= 0) { loud('`--claim-window` 写法不合法（例：`30m` / `1h`）'); return 1; }
  const root = gitRoot(process.cwd());
  if (!root) return 1;
  const t0 = Date.now();
  let prev = null;
  console.log(`[git-writer-probe] 等待落定：${untils.join('、')}（超时 ${timeout}ms · 轮询 ${interval}ms · 只读）`);
  for (;;) {
    let st;
    try { st = collect(root, cw); } catch (e) { loud(`读 git status 失败：${String(e.message || e).split('\n')[0]}`); return 1; }
    const pending = untils.filter((u) => st.flying.some((e) => matchPath(e.p, u)));
    const sig = pending.join('|');
    if (sig !== prev) {
      // 落定等待里带上**归属**：等的时候最想知道的就是"到底谁在写它"（2026-09-23 实测需要）。
      const desc = pending.map((u) => {
        const e = st.flying.find((x) => matchPath(x.p, u));
        return e ? u + claimTag(e.p, st.claims) : u;
      });
      console.log(`[${ts()}] ${pending.length ? `仍在飞：${desc.join('、')}` : '三判据已消（目标全部离开工作区）'}`);
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

    // ⑩⑪⑫ 归属维度（2026-09-23 加）——**每个新判据都配一条能打红的反例**：
    //   反例：把 `claimConflicts` 的 `set.size >= 2` 改成 `>= 99` ⇒ ⑪ 必红；
    //        把 `claimTag` 直接 `return ''`（或无视台账）⇒ ⑩ 必红；
    //        把 `readClaims` 读不到文件时抛错 ⇒ ⑫ 必红。
    mkdirSync(join(tmp, 'mind-private', 'tasks'), { recursive: true });
    writeFileSync(join(tmp, 'mind-private', 'tasks', 'write-log.jsonl'), [
      // mine.txt：5 分钟前 aaaa、1 分钟前 bbbb ⇒ 窗口（30m）内 2 个会话 ⇒ 并发写同一文件
      { ts: new Date(Date.now() - 5 * 60000).toISOString(), session: 'aaaaaaaa-1111-2222', tool: 'edit', path: 'mine.txt' },
      { ts: new Date(Date.now() - 60000).toISOString(), session: 'bbbbbbbb-3333-4444', tool: 'write', path: 'mine.txt' },
      // 窗口外（3 小时前）且不在任何提交面上的路径 ⇒ 两样都不许被算进来
      { ts: new Date(Date.now() - 3 * 3600000).toISOString(), session: 'cccccccc-5555-6666', tool: 'edit', path: 'not-in-face.txt' },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');

    const c10 = run(['--json']);
    let claimOk = false;
    try {
      const o = JSON.parse(c10.stdout);
      const mine = (o.staged || []).find((x) => x.path === 'mine.txt');
      claimOk = o.claimsAvailable === true
        && !!mine && !!mine.claim && mine.claim.known === true
        && mine.claim.session === 'bbbbbbbb' // 取**最近**一条（1 分钟前那个），不是最旧的
        && o.claimConflicts.length === 1 && o.claimConflicts[0].sessions.length === 2;
    } catch { claimOk = false; }
    cases.push(['⑩ 台账在 → 标出归属（取最近写者）且 --json 带 claim/claimConflicts', claimOk]);

    const c11 = run([]);
    const c11out = c11.stdout + c11.stderr;
    cases.push(['⑪ 同一文件被 2 会话在窗口内写 + 有暂存 → 2 且点名（反例：阈值改 99 必红）',
      c11.status === 2 && /同一文件被 2 个会话/.test(c11out) && /mine\.txt/.test(c11out)]);

    // ⑫ 台账缺失（心智区外的仓库 / 没跑过写类工具）：**不崩、不编**，如实报"归属台账不存在"
    rmSync(join(tmp, 'mind-private'), { recursive: true, force: true });
    const c12 = run([]);
    cases.push(['⑫ 台账缺失 → 0 且如实报「归属台账不存在」（不猜、不编）',
      c12.status === 0 && /归属台账不存在/.test(c12.stdout)]);
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
