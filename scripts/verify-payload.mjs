#!/usr/bin/env node
// DSHOME 打包前门禁（ISSUE-003）
// 断言 build-stage/payload 不携带 profiles\node_modules 实体树：
//   dsh 的扁平模块 fallback 目录由首启 healProfilesModuleFallback 自动重建为 junction 集合；
//   7-Zip / Inno 等打包器均不保留 junction 语义，随包分发必被实体化 →
//   后端 ensureSymlink 自检抛 "exists and is not a symlink" 拒绝启动。
// 另校验发版号单源一致性（version-lib）：packages/dshome/package.json version == 4 个消费者
//   （壳应用 app.getVersion / 侧栏徽章 / updates.json / DSHOME.iss）——漏更会导致
//   「已是最新版却反复提示更新」。
// 用法：
//   node scripts/verify-payload.mjs            # 只校验（退出码 0=通过 / 1=失败）
//   node scripts/verify-payload.mjs --fix      # 失败时：隔离毒树 + 版本同步到单源（可逆/可审）
//   node scripts/verify-payload.mjs --quiet    # 通过时不打印明细
import { existsSync, lstatSync, readdirSync, renameSync, readFileSync } from 'node:fs';
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

function staleBackupWarn() {
  if (!existsSync(profilesDir)) return;
  for (const e of readdirSync(profilesDir)) {
    if (e.startsWith('node_modules.stale-')) {
      warn(`存在隔离备份 ${join('profiles', e)}——确认不再需要后手动删除（DSHOME.iss Excludes 已兜底）`);
    }
  }
}

function statuses() {
  return [agentsStatus(), poisonStatus(), versionStatus()];
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
