#!/usr/bin/env node
// DSHOME 打包前门禁（ISSUE-003）
// 断言 build-stage/payload 不携带 profiles\node_modules 实体树：
//   dsh 的扁平模块 fallback 目录由首启 healProfilesModuleFallback 自动重建为 junction 集合；
//   7-Zip / Inno 等打包器均不保留 junction 语义，随包分发必被实体化 →
//   后端 ensureSymlink 自检抛 "exists and is not a symlink" 拒绝启动。
// 用法：
//   node scripts/verify-payload.mjs            # 只校验（退出码 0=通过 / 1=失败）
//   node scripts/verify-payload.mjs --fix      # 失败时把毒树重命名隔离（可逆，不删除）
//   node scripts/verify-payload.mjs --quiet    # 通过时不打印明细
import { existsSync, lstatSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const quiet = argv.includes('--quiet');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const payloadDir = join(repoRoot, 'build-stage', 'payload');
const profilesDir = join(payloadDir, 'profiles');
const poisonDir = join(profilesDir, 'node_modules');

let failed = false;

function say(msg) { if (!quiet) console.log(`[verify-payload] ${msg}`); }
function warn(msg) { console.warn(`[verify-payload] WARN: ${msg}`); }
function fail(msg) { failed = true; console.error(`[verify-payload] FAIL: ${msg}`); }

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

function main() {
  if (!existsSync(payloadDir)) {
    say('build-stage/payload 不存在，跳过（尚未 staging）');
    process.exit(0);
  }

  // payload 顶层概览
  const top = readdirSync(payloadDir, { withFileTypes: true })
    .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
  say(`payload 顶层（${top.length} 项）：${top.slice(0, 40).join(', ')}${top.length > 40 ? ', …' : ''}`);

  const pKind = kind(poisonDir);
  if (pKind === 'missing') {
    say('PASS: payload 未携带 profiles\\node_modules（正确，由 dsh 首启自愈生成）');
  } else if (pKind === 'junction') {
    fail('payload\\profiles\\node_modules 是 junction——打包器会实体化它，必须排除（参考 DSHOME.iss Excludes）');
  } else {
    const n = countEntries(poisonDir);
    if (n === 0) {
      warn('payload\\profiles\\node_modules 存在但为空目录（无害，仍建议排除）');
    } else {
      fail(`payload\\profiles\\node_modules 含 ${n}+ 个实体条目（ISSUE-003 毒树）——dsh 首启自愈会重建，不应随包分发`);
    }
  }

  // 隔离备份提醒
  if (existsSync(profilesDir)) {
    for (const e of readdirSync(profilesDir)) {
      if (e.startsWith('node_modules.stale-')) {
        warn(`存在隔离备份 ${join('profiles', e)}——确认不再需要后手动删除（DSHOME.iss Excludes 已兜底）`);
      }
    }
  }

  if (failed && fix) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(profilesDir, `node_modules.stale-${ts}`);
    try {
      renameSync(poisonDir, backup);
      say(`--fix: 毒树已隔离为 ${join('profiles', `node_modules.stale-${ts}`)}（可逆；确认后手动删除）`);
      failed = false;
    } catch (err) {
      fail(`--fix 隔离失败: ${String(err)}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
