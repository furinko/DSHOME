#!/usr/bin/env node
// DSHOME 打包前门禁（ISSUE-003）
// 断言 build-stage/payload 不携带 profiles\node_modules 实体树：
//   dsh 的扁平模块 fallback 目录由首启 healProfilesModuleFallback 自动重建为 junction 集合；
//   7-Zip / Inno 等打包器均不保留 junction 语义，随包分发必被实体化 →
//   后端 ensureSymlink 自检抛 "exists and is not a symlink" 拒绝启动。
// 另校验发版号单源一致性（version-lib）：packages/dshome/package.json version == 4 个消费者
//   （壳应用 app.getVersion / 侧栏徽章 / updates.json / DSHOME.iss）——漏更会导致
//   「已是最新版却反复提示更新」。
// 2026-09-10 增：出厂内容区一致性（payload vs 源码）。payload 是**本地打包快照**（git 不跟踪，
//   只靠发版时 stage-payload 刷新），原来只有 mind\L0\AGENTS.md 被 validate (c) 盯着，
//   其余静默落后（当日实测 mind\ 15 个文件陈旧、含 AGENTS 3.3 vs 源 3.4）→ 规则陈旧会随包发给用户。
//   判据：mind\ = 出厂固件（行为规则/记忆模式）→ FAIL；scripts/docs/packages（代码·文档）→ WARN。
// 用法：
//   node scripts/verify-payload.mjs            # 只校验（退出码 0=通过 / 1=失败）
//   node scripts/verify-payload.mjs --fix      # 失败时：隔离毒树 + 版本同步到单源（可逆/可审）
//   node scripts/verify-payload.mjs --quiet    # 通过时不打印明细
import { existsSync, lstatSync, readdirSync, renameSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSUMERS, readCanonical, syncAll } from './version-lib.mjs';

const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const quiet = argv.includes('--quiet');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const payloadDir = join(repoRoot, 'build-stage', 'payload');
const profilesDir = join(payloadDir, 'profiles');
const poisonDir = join(profilesDir, 'node_modules');

function say(msg) { if (!quiet) console.log(`[verify-payload] ${msg}`); }
function warn(msg) { console.warn(`[verify-payload] WARN: ${msg}`); }
function fail(msg) { console.error(`[verify-payload] FAIL: ${msg}`); }

function kind(p) {
  try {
    const s = lstatSync(p);
    if (s.isSymbolicLink()) return 'junction';
    if (s.isDirectory()) return 'dir';
    return 'file';
  } catch { return 'missing'; }
}

// 递归统计实体条目数（上限封顶，避免巨树全量遍历）
function countEntries(dir, cap = 5000) {
  let n = 0;
  const walk = (d) => {
    if (n >= cap) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n >= cap) return;
      n += 1;
      if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  walk(dir);
  return n;
}

// 每项检查返回状态对象：{ ok, msg, say?, warn? }
//   say=true  → 通过且需打印（PASS）
//   warn=true → 通过但告警（不影响退出码）
//   !ok       → 失败（影响退出码）
function agentsStatus() {
  const authAgents = join(repoRoot, 'mind', 'L0', 'AGENTS.md');
  const payloadAgents = join(payloadDir, 'AGENTS.md');
  if (!existsSync(authAgents) || !existsSync(payloadAgents)) return { ok: true };
  const norm = (s) => String(s).replace(/\r\n/g, '\n');
  if (norm(readFileSync(authAgents, 'utf8')) !== norm(readFileSync(payloadAgents, 'utf8'))) {
    return { ok: false, msg: `payload\\AGENTS.md 与权威版 mind\\L0\\AGENTS.md 内容不一致——payload 是打包快照（禁止手改，打包时从权威版同步）。请重新组装 payload（robocopy 让 payload\\AGENTS.md = mind\\L0\\AGENTS.md）后再打包` };
  }
  return { ok: true };
}

function poisonStatus() {
  const pKind = kind(poisonDir);
  if (pKind === 'missing') return { ok: true, say: true, msg: 'PASS: payload 未携带 profiles\\node_modules（正确，由 dsh 首启自愈生成）' };
  if (pKind === 'junction') return { ok: false, msg: 'payload\\profiles\\node_modules 是 junction——打包器会实体化它，必须排除（参考 DSHOME.iss Excludes）' };
  const n = countEntries(poisonDir);
  if (n === 0) return { ok: true, warn: true, msg: 'payload\\profiles\\node_modules 存在但为空目录（无害，仍建议排除）' };
  return { ok: false, msg: `payload\\profiles\\node_modules 含 ${n}+ 个实体条目（ISSUE-003 毒树）——dsh 首启自愈会重建，不应随包分发` };
}

function versionStatus() {
  let canonical;
  try { canonical = readCanonical(); } catch { return { ok: true }; }
  for (const c of CONSUMERS) {
    const full = join(repoRoot, c.file);
    if (!existsSync(full)) continue;
    const actual = c.read(readFileSync(full, 'utf8'));
    if (actual !== canonical) {
      return { ok: false, msg: `版本漂移: ${c.name}=${actual} != 单源=${canonical}（${c.file}）——请运行 node scripts\\sync-version.mjs` };
    }
  }
  return { ok: true };
}

// ── 出厂内容区一致性（2026-09-10）────────────────────────────────────────────
// 内容比对：字节相同即同；否则按 CRLF→LF 归一化再比（避免换行风格误报）。
function sameFile(a, b) {
  try {
    const ba = readFileSync(a);
    const bb = readFileSync(b);
    if (ba.equals(bb)) return true;
    const norm = (x) => x.replace(/\r\n/g, '\n');
    return norm(ba.toString('utf8')) === norm(bb.toString('utf8'));
  } catch { return false; }
}
// 列出内容文件（跳过 node_modules；封顶防巨树）
function listFiles(root, cap = 20000) {
  const acc = [];
  const walk = (dir, rel) => {
    if (acc.length >= cap) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (acc.length >= cap) return;
      if (e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile()) acc.push(r);
    }
  };
  walk(root, '');
  return acc;
}
// mind\ 陈旧 = 出厂固件陈旧（用户拿到旧行为规则）→ FAIL；
// packages\ + scripts\ 陈旧 = **会随包发出去的产品代码/工具陈旧**（2026-09-12 提为 hard：
//   实测 payload 里两份 host 插件仍是「让 46 个会话历史加载失败」的旧 source，而它当时只算
//   WARN 且本脚本不在任何门禁链里 ⇒ 装机版会带旧 bug 出门）→ 现在漂移即 FAIL。
// docs\ → WARN（文档漂移没有功能后果）
function contentDriftStatus() {
  const GROUPS = [
    { root: 'mind', hard: true },
    { root: 'scripts', hard: true },
    { root: 'docs', hard: false },
    { root: 'packages', hard: true },
  ];
  const hardHits = [];
  const softHits = [];
  for (const { root, hard } of GROUPS) {
    const srcRoot = join(repoRoot, root);
    const dstRoot = join(payloadDir, root);
    if (!existsSync(srcRoot)) continue;
    if (!existsSync(dstRoot)) { (hard ? hardHits : softHits).push(`${root}\\ 整目录缺失`); continue; }
    const drifted = [];
    const missing = [];
    for (const rel of listFiles(srcRoot)) {
      const dp = join(dstRoot, rel);
      if (!existsSync(dp)) { missing.push(rel); continue; }
      if (!sameFile(join(srcRoot, rel), dp)) drifted.push(rel);
    }
    if (drifted.length || missing.length) {
      const sample = drifted.concat(missing).slice(0, 4).map((r) => r.replace(/\\/g, '/')).join('、');
      (hard ? hardHits : softHits).push(`${root}\\ 陈旧 ${drifted.length} 个、payload 缺 ${missing.length} 个（如 ${sample}${drifted.length + missing.length > 4 ? ' …' : ''}）`);
    }
  }
  if (hardHits.length) {
    return { ok: false, msg: `出厂固件与 payload 不一致——${hardHits.join('；')}。payload 是本地打包快照（git 不跟踪，只靠发版时同步），规则陈旧会随包发给用户：先跑 node scripts\\stage-payload.mjs 再打包` };
  }
  if (softHits.length) {
    return { ok: true, warn: true, msg: `payload 内容区落后源码（不影响本次 PASS）——${softHits.join('；')}；发版前建议 node scripts\\stage-payload.mjs 同步` };
  }
  return { ok: true };
}

// ── 私有面残留（双区红线，2026-09-11）────────────────────────────────────────
// stage-payload 只保证「不复制」私有区/运行时数据，不负责清理历史存量：实测 09-05 起
// `.dshw-usage.json`（机主余额/每日用量）、`私有暂存区\`（交接记录）等一直躺在 payload 里，
// 下次打包就会随安装包发给使用者 → 每次打包前在这里硬拦。
const PRIVATE_PAYLOAD_NAMES = [
  '.credentials.yaml', 'settings.yaml', '.anonymous-user-id', '.dshw-size.json', '.dshw-usage.json',
  'mind-private', 'sessions', 'storages', 'attachments', '.agent-snapshot', '.dsh-market', '私有暂存区',
];
function privateLeakStatus() {
  const hits = PRIVATE_PAYLOAD_NAMES.filter((n) => existsSync(join(payloadDir, n)));
  let junk = [];
  try {
    junk = readdirSync(payloadDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.bak/i.test(e.name))
      .map((e) => e.name);
  } catch { /* payload 不可读 → 交给其它检查 */ }
  if (hits.length) {
    return { ok: false, msg: `payload 含私有面文件/目录（会随安装包发给使用者）：${hits.join('、')}——删除这些存量；stage-payload 只保证不复制，不负责清理` };
  }
  if (junk.length) {
    return { ok: true, warn: true, msg: `payload 顶层有备份垃圾：${junk.join('、')}（建议删除，别随包发）` };
  }
  return { ok: true, say: true, msg: 'PASS: payload 无私有面文件 / 备份垃圾' };
}

// ── Electron exe 图标（任务栏按钮图标的真正来源，2026-09-11）─────────────────
// 任务栏按钮图标 = 进程 exe 内嵌图标（BrowserWindow.icon 无效，实测 2026-09-11）。
// payload 的 electron.exe 必须是打过 DSHOME 图标的版本，否则装机版任务栏显示 Electron 原子图标。
function iconStatus() {
  if (process.platform !== 'win32') return { ok: true, warn: true, msg: '非 Windows 平台：跳过 electron.exe 图标校验' };
  const exe = join(payloadDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(exe)) return { ok: true };
  const patcher = join(here, 'patch-electron-icon.mjs');
  const r = spawnSync(process.execPath, [patcher, '--target', exe, '--verify-only', '--quiet'], { stdio: 'ignore' });
  if (r.status !== 0) {
    return { ok: false, msg: `payload 的 electron.exe 未带 DSHOME 图标（装机版任务栏会显示 Electron 图标）——跑 node scripts\\stage-payload.mjs，或 node scripts\\patch-electron-icon.mjs --target "${exe}"` };
  }
  return { ok: true, say: true, msg: 'PASS: payload electron.exe 内嵌图标 = DSHOME' };
}

function staleBackupWarn() {
  if (!existsSync(profilesDir)) return;
  for (const e of readdirSync(profilesDir)) {
    if (e.startsWith('node_modules.stale-')) {
      warn(`存在隔离备份 ${join('profiles', e)}——确认不再需要后手动删除（DSHOME.iss Excludes 已兜底）`);
    }
  }
}

function statuses() {
  return [agentsStatus(), poisonStatus(), versionStatus(), contentDriftStatus(), privateLeakStatus(), iconStatus()];
}

function main() {
  if (!existsSync(payloadDir)) {
    say('build-stage/payload 不存在，跳过（尚未 staging）');
    process.exit(0);
  }

  // payload 顶层概览
  const top = readdirSync(payloadDir, { withFileTypes: true })
    .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
  say(`payload 顶层（${top.length} 项）：${top.slice(0, 40).join(', ')}${top.length > 40 ? ', …' : ''}`);

  // 第一遍：报告状态，并认定失败
  let failed = false;
  for (const s of statuses()) {
    if (s.say) say(s.msg);
    else if (s.warn) warn(s.msg);
    else if (!s.ok) { fail(s.msg); failed = true; }
  }
  staleBackupWarn();

  // --fix：隔离毒树 + 版本同步（仅修这两类；AGENTS 快照漂移不可自动修复）
  if (fix) {
    const pKind = kind(poisonDir);
    if (pKind === 'junction' || pKind === 'dir') {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(profilesDir, `node_modules.stale-${ts}`);
      try {
        renameSync(poisonDir, backup);
        say(`--fix: 毒树已隔离为 ${join('profiles', `node_modules.stale-${ts}`)}（可逆；确认后手动删除）`);
      } catch (err) {
        fail(`--fix 隔离失败: ${String(err)}`);
      }
    }
    const drift = versionStatus();
    if (!drift.ok) {
      try {
        const canonical = readCanonical();
        const changed = syncAll(canonical);
        say(`--fix: 版本已同步到单源（${canonical}）——${changed.map((c) => c.name).join('、')}`);
      } catch (err) {
        fail(`--fix 版本同步失败: ${String(err)}`);
      }
    }
    // 重算：只认仍在失败的检查（毒树+版本+AGENTS；warn 不影响）
    failed = false;
    for (const s of statuses()) if (!s.ok) failed = true;
  }

  process.exit(failed ? 1 : 0);
}

main();
