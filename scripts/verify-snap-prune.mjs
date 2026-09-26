#!/usr/bin/env node
// scripts/verify-snap-prune.mjs — 「快照时间窗裁剪」的行为核验（2026-09-26 建）
//
// 被测件：`scripts/evolve-log.mjs` 的 `snap-prune` 子命令（`Memory §十一` 范围表那条口径的机器件）。
// 手法与 `verify-trash.mjs` 同源：**每个用例一个独立临时 DSH_HOME**，真仓库的快照区与 changelog 零触碰。
//
// 判据（每条都对应规则原文或安全要求）：
//   1. 不带 `--apply` ⇒ **一个字节都不动**（dry-run 是默认，规则说"裁剪要留痕"，先看不做）。
//   2. `--keep-days N` ⇒ 保留快照名里日期最近的 N 个**自然日**（同一天多批全留，不是"最近 N 个文件"）。
//   3. `--apply` ⇒ 超窗的**移入 TRASH**（不是删除！）+ 索引 + changelog 留痕；窗内的一个不少。
//   4. `--keep-days 0` ⇒ 全部超窗（边界）；目录不存在 / 无快照 ⇒ 不报错、不动手。
//   5. 不合规文件名（不是 `YYYY-MM-DDTHH-MM-SS_…`）**不进候选**（不猜、不误伤）。
//
// 用法：node scripts/verify-snap-prune.mjs；退出码 0＝全过 / 1＝偏差 / 2＝环境不可用。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EVO = join(here, 'evolve-log.mjs');
if (!existsSync(EVO)) { console.error(`[verify-snap-prune] ❌ 环境不可用：找不到 ${EVO}`); process.exit(2); }

let pass = 0; const failures = [];
function assert(label, cond, expected, actual) {
  if (cond) { pass++; console.log(`  ok   ${label}`); return; }
  failures.push(label); console.log(`  FAIL ${label}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
  console.log(`       actual:   ${JSON.stringify(actual)}`);
}
/** 夹具：3 个自然日的快照（09-20 两批 / 09-21 一批 / 09-22 一批）+ 一个不合规文件名。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'verify-snapprune-'));
  const snap = join(home, 'mind-private', 'tasks', 'evolution', 'snapshots');
  mkdirSync(snap, { recursive: true });
  const names = [
    '2026-09-20T10-00-00_aaaaaaaa_AGENTS.md',
    '2026-09-20T11-00-00_bbbbbbbb_AGENTS.md',
    '2026-09-21T10-00-00_cccccccc_AGENTS.md',
    '2026-09-22T10-00-00_dddddddd_AGENTS.md',
    '手工备份-别动我.md',
  ];
  for (const n of names) writeFileSync(join(snap, n), 'x');
  return { home, snap, names };
}
function prune(home, args) {
  const r = spawnSync(process.execPath, [EVO, 'snap-prune', ...args], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const inTrash = (home) => { try { return readdirSync(join(home, 'mind-private', 'TRASH')); } catch { return []; } };

console.log('[verify-snap-prune] 快照时间窗裁剪 · 行为核验');

// ── 1) 默认 dry-run ─────────────────────────────────────────────────────────
{
  const f = fixture();
  const r = prune(f.home, []);
  assert('不带 --apply ⇒ 退出 0 且什么都不动（5 个文件都在）', r.code === 0 && readdirSync(f.snap).length === 5, '5 个仍在', readdirSync(f.snap).length);
  assert('dry-run 不写 TRASH', inTrash(f.home).length === 0, 'TRASH 空', inTrash(f.home));
  assert('dry-run 明确打印「不加 --apply 不动」', /DRY-RUN/.test(r.out), '含 DRY-RUN', r.out.split('\n')[0]);
  rmSync(f.home, { recursive: true, force: true });
}

// ── 2) --keep-days 2：保留最近 2 个自然日（09-22、09-21），09-20 的两批超窗 ──
{
  const f = fixture();
  const r = prune(f.home, ['--apply', '--keep-days', '2']);
  const left = readdirSync(f.snap).sort();
  assert('--keep-days 2 ⇒ 退出 0', r.code === 0, 0, r.code);
  assert('窗内 2 天的快照一个不少（含同一天的两批）', left.includes('2026-09-21T10-00-00_cccccccc_AGENTS.md') && left.includes('2026-09-22T10-00-00_dddddddd_AGENTS.md'), '09-21 与 09-22 都在', left);
  assert('超窗那天（09-20）的两批都移走', !left.some((n) => n.startsWith('2026-09-20')), '09-20 不在快照区', left);
  assert('**不合规文件名不进候选**（手工备份仍在原位）', left.includes('手工备份-别动我.md'), '手工备份仍在', left);
  assert('超窗件是**移入 TRASH**（不删）', inTrash(f.home).filter((n) => n.includes('AGENTS.md')).length === 2, 'TRASH 里 2 件', inTrash(f.home));
  assert('移入动作留痕：changelog 有 ↳裁剪 行', /↳裁剪/.test(readFileSync(join(f.home, 'mind-private', 'tasks', 'evolution', 'changelog.md'), 'utf8')), '有 ↳裁剪', '无');
  assert('移入动作留痕：TRASH 索引有行', /AGENTS\.md/.test(readFileSync(join(f.home, 'mind-private', 'TRASH', '_index.md'), 'utf8')), '索引有行', '无');
  rmSync(f.home, { recursive: true, force: true });
}

// ── 3) 边界：--keep-days 0 已被下限拒绝（复核后改：0 会清空整区）──────────────
{
  const f = fixture();
  const r = prune(f.home, ['--apply', '--keep-days', '0']);
  assert('--keep-days 0 ⇒ 退出 1 且**一个快照都没动**（含不合规名）', r.code === 1 && readdirSync(f.snap).length === 5, '1 + 5 个仍在', { code: r.code, n: readdirSync(f.snap).length });
  rmSync(f.home, { recursive: true, force: true });
}

// ── 4) 无快照目录 / 空目录 ⇒ 不报错、不动手、退出 0；且**干跑不许建库**（复核指出：建库＝写盘副作用）──
{
  const home = mkdtempSync(join(tmpdir(), 'verify-snapprune-empty-'));
  mkdirSync(join(home, 'mind-private'), { recursive: true });
  const r = prune(home, []);
  assert('无 snapshots/ ⇒ 退出 0 且明说无裁剪对象', r.code === 0 && /无裁剪对象|为空/.test(r.out), '0 + 明说', { code: r.code, out: r.out.trim().slice(0, 60) });
  assert('**干跑零写盘**：snapshots/ 与 changelog 都没被建出来', !existsSync(join(home, 'mind-private', 'tasks', 'evolution', 'snapshots')) && !existsSync(join(home, 'mind-private', 'tasks', 'evolution', 'changelog.md')), '两者都不存在', { snap: existsSync(join(home, 'mind-private', 'tasks', 'evolution', 'snapshots')), log: existsSync(join(home, 'mind-private', 'tasks', 'evolution', 'changelog.md')) });
  rmSync(home, { recursive: true, force: true });
}

// ── 5) 反例：--keep-days 给非法值 ⇒ 响亮失败（不静默当 0）；0 也要拒（会清空整区）────────
{
  const f = fixture();
  const r = prune(f.home, ['--apply', '--keep-days', 'abc']);
  assert('--keep-days abc ⇒ 退出 1（响亮失败）且快照一个没动', r.code === 1 && readdirSync(f.snap).length === 5, '1 + 5 个仍在', { code: r.code, n: readdirSync(f.snap).length });
  const r0 = prune(f.home, ['--apply', '--keep-days', '0']);
  assert('--keep-days 0 ⇒ 退出 1（复核后加下限：0 会把当天刚建的也判超窗、清空整区）', r0.code === 1 && readdirSync(f.snap).length === 5, '1 + 5 个仍在', { code: r0.code, n: readdirSync(f.snap).length });
  rmSync(f.home, { recursive: true, force: true });
}

// ── 6) 窗口按**本地日**（复核指出：快照名是 UTC，本地 00:00-08:00 打的会被算成前一天）────────
// 夹具：名字日期＝昨天的 UTC 时刻，但换算到本地日就是"今天"⇒ `--keep-days 1` 必须留住它。
{
  const home = mkdtempSync(join(tmpdir(), 'verify-snapprune-tz-'));
  const snap = join(home, 'mind-private', 'tasks', 'evolution', 'snapshots');
  mkdirSync(snap, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // 取"当前时刻"的 UTC 名（与今天/昨天都可能重合，取决于本地时区）——用它验证：按本地日算必须留住最新
  const utcName = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}_aaaaaaaa_Tree.md`;
  writeFileSync(join(snap, utcName), 'x');
  const r = prune(home, ['--apply', '--keep-days', '1']);
  assert(`窗口按本地日：刚建的快照（名 ${utcName.slice(0, 16)}Z）必须留在窗内`, readdirSync(snap).includes(utcName), '仍在', readdirSync(snap));
  assert('本地日窗口：退出 0', r.code === 0, 0, r.code);
  rmSync(home, { recursive: true, force: true });
}

// ── 7) 回滚链口径 --keep-per-file（2026-09-26 加）：同一目标文件只留最近 N 版 ──────────
// 为什么单独验：这条判据的"价值＝兜住的那一版"，**唯一回滚点必须恒保**——反例就是"链长 1 也被裁"。
{
  const home = mkdtempSync(join(tmpdir(), 'verify-snapprune-perfile-'));
  const snap = join(home, 'mind-private', 'tasks', 'evolution', 'snapshots');
  mkdirSync(snap, { recursive: true });
  // 链 A（tag aaaaaaaa）同一天 4 版；链 B（bbbbbbbb）2 版；链 C（cccccccc）**只 1 版**
  const names = [
    '2026-09-20T10-00-00_aaaaaaaa_Learn.md',
    '2026-09-20T11-00-00_aaaaaaaa_Learn.md',
    '2026-09-20T12-00-00_aaaaaaaa_Learn.md',
    '2026-09-20T13-00-00_aaaaaaaa_Learn.md',
    '2026-09-21T10-00-00_bbbbbbbb_Tree.md',
    '2026-09-21T11-00-00_bbbbbbbb_Tree.md',
    '2026-09-22T10-00-00_cccccccc_Ritual.md',
  ];
  for (const n of names) writeFileSync(join(snap, n), 'v-' + n);
  const dry = spawnSync(process.execPath, [EVO, 'snap-prune', '--keep-per-file', '2'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  const dryOut = `${dry.stdout || ''}${dry.stderr || ''}`;
  assert('--keep-per-file 2 干跑：列出 2 个超版（A 链 4→2，B/C 不动）', dry.status === 0 && /超出保留版数 2 个/.test(dryOut), '干跑列 2 个', dryOut.trim().split('\n').slice(-2));
  const r = spawnSync(process.execPath, [EVO, 'snap-prune', '--apply', '--keep-per-file', '2'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  const left = readdirSync(snap).sort();
  assert('--keep-per-file 2 ⇒ 退出 0', r.status === 0, 0, r.status);
  assert('A 链（4 版）留最近 2 版（12:00 与 13:00）', left.filter((n) => n.includes('_aaaaaaaa_')).length === 2 && left.includes('2026-09-20T13-00-00_aaaaaaaa_Learn.md') && left.includes('2026-09-20T12-00-00_aaaaaaaa_Learn.md'), '留 12:00/13:00', left.filter((n) => n.includes('aaaaaaaa')));
  assert('**反例：链长 1 的绝不断根**（C 链那唯一一版必须还在）', left.includes('2026-09-22T10-00-00_cccccccc_Ritual.md'), '仍在', left.filter((n) => n.includes('cccccccc')));
  assert('B 链（2 版）没被动', left.filter((n) => n.includes('_bbbbbbbb_')).length === 2, '2 版都在', left.filter((n) => n.includes('bbbbbbbb')));
  const r1 = spawnSync(process.execPath, [EVO, 'snap-prune', '--apply', '--keep-per-file', '1'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  const left1 = readdirSync(snap).sort();
  assert('--keep-per-file 1 ⇒ 每链只留**最新**一版（A 留 13:00、B 留 11:00）', r1.status === 0 && left1.includes('2026-09-20T13-00-00_aaaaaaaa_Learn.md') && left1.includes('2026-09-21T11-00-00_bbbbbbbb_Tree.md'), '各留最新', left1);
  const rMix = spawnSync(process.execPath, [EVO, 'snap-prune', '--keep-days', '2', '--keep-per-file', '1'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  assert('--keep-days 与 --keep-per-file 混用 ⇒ 退出 1（口径二选一）', rMix.status === 1 && /二选一/.test(`${rMix.stderr || ''}${rMix.stdout || ''}`), 'exit 1 + 提示', rMix.status);
  const rBad = spawnSync(process.execPath, [EVO, 'snap-prune', '--keep-per-file', '0'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  assert('--keep-per-file 0 ⇒ 退出 1（不许把每链清空）', rBad.status === 1, 1, rBad.status);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures.length === 0 ? `PASS ${pass}/${pass}` : `FAIL ${failures.length}/${pass + failures.length} assertion(s)`);
process.exit(failures.length === 0 ? 0 : 1);
