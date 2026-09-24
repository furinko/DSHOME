#!/usr/bin/env node
// scripts/growth-audit.mjs — 增长面看门狗（2026-09-12 建，收编自 CH4 v1.0.4 的「5MB 日志轮转」一课的**本级形态**）。
//
// 为什么是"看门狗"而不是"加轮转"：实测（2026-09-12）**我们自己的记录面本来就有界**——
//   `.dsh-market\mind-guard-marker.txt` / `mind-inject-marker.txt` 是 `slice(-20)` 环；recall / skill-loader
//   marker 是覆盖式单行；`snapshots\` 有时间窗流程；`TRASH\` 有回收流程。真正**无界**的是第三方
//   `dshmarket` 写的 `.dsh-market\log.ndjson`（建库至今 1314 行 / 177 KB，**它没有轮转**，而我们的代码改不了它）。
// ⇒ 本级的正确动作不是"再造一个轮转"，而是**把这些体积变成机器可见**：谁涨了、涨过多少、该找谁。
//
// 判定分两档（**只有 hard 会让本脚本 exit 1**，其余是提醒）：
//   hard = 我们自己的机制**坏了**（例如 marker 环被改坏、行数超上限）
//   warn = 体积增长/第三方面，只提醒，不拦提交
//
// 用法：node scripts/growth-audit.mjs [--json] [--root <dir>]
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/**
 * `TRASH\` 里"**可清的大件**"（Memory §十一 乙档＝可再生产物）——按扩展名 / 单件体积判定，**机器可证**。
 * 2026-09-23 加：原判据是 `trash.count > 100` 绝对件数，而 §十一 的"只增不减"让它**永不熄灭**（`limits.md`「恒亮灯＝没灯」）。
 * 现在 TRASH 行盯的是**有可执行动作的那部分**（主人放行后可清 ⇒ 可熄灭），总件数只作信息行。
 */
function cleanableBytes(dir) {
  const RE = /\.(exe|msi|zip|7z|iso|tar|gz|tgz|rar|bak|tmp|ndjson|log)$/i;
  let bytes = 0;
  let n = 0;
  const walk = (d) => {
    let items = [];
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) { walk(p); continue; }
      let b = 0;
      try { b = statSync(p).size; } catch { continue; }
      if (RE.test(it.name) || b > 20 * 1024 * 1024) { bytes += b; n += 1; }
    }
  };
  walk(dir);
  return { bytes, n };
}

/** 一行一条的检查项。kind: 'hard' | 'warn'。 */
function checks(root) {
  const priv = join(root, 'mind-private');
  const market = join(root, 'profiles', 'dshome', '.dsh-market');
  const out = [];
  const size = (p) => { try { return statSync(p).size; } catch { return null; } };
  const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return null; } };
  const cap = (p) => { try { return { count: readdirSync(p).length, bytes: readdirSync(p).reduce((a, f) => a + (size(join(p, f)) || 0), 0) }; } catch { return null; } };

  // ① 我们自己的 marker：环必须封顶（环坏了 = hard）
  const rings = { 'mind-guard-marker.txt': 20, 'mind-guard-hints.txt': 20, 'mind-inject-marker.txt': 20, 'mind-recall-marker.txt': 5, 'mind-skill-loader-marker.txt': 5 };
  for (const [name, max] of Object.entries(rings)) {
    const p = join(market, name);
    const n = lines(p);
    if (n === null) continue;
    out.push({ face: name, current: `${n} 行`, limit: `≤${max} 行`, kind: n > max ? 'hard' : 'ok', note: Math.max(...Object.values(rings)) === max ? '环/覆盖式（本插件负责封顶）' : '覆盖式单行' });
  }
  // ①' dshome/agent-roles 自己的两个产物（2026-09-24 加）：两者都有环上限
  //     （marker `slice(-20)` / 审计面 `slice(-2000)`，见 `packages/dshome/lib/host/agent-roles.js:194` 与 `:524`），
  //     但此前**不在本清单里** ⇒ 上限若被改坏，**没有任何门禁会红**（本脚本存在的意义正是"把体积变成机器可见"）。
  //     反证（可执行、零触碰真仓库）：`node scripts/growth-audit.mjs --root <临时树>`，树里放
  //     `profiles/dshome/.dsh-market/agent-roles-marker.txt` 共 21 行 ⇒ 本行由 ✅ 变 ❌ 且 exit 1。
  const roleFaces = { 'agent-roles-marker.txt': 20, 'agent-roles-writes.jsonl': 2000 };
  for (const [name, max] of Object.entries(roleFaces)) {
    const p = join(market, name);
    const n = lines(p);
    if (n === null) continue;
    out.push({ face: name, current: `${n} 行`, limit: `≤${max} 行`, kind: n > max ? 'hard' : 'ok', note: `环/审计面（slice(-${max})；本插件负责封顶）` });
  }
  // ② 第三方 log.ndjson：无轮转，只提醒
  const log = join(market, 'log.ndjson');
  const logB = size(log);
  if (logB !== null) {
    const kb = Math.round(logB / 1024);
    out.push({ face: 'log.ndjson（第三方 dshmarket 写）', current: `${kb} KB / ${lines(log)} 行`, limit: 'warn>512KB · 建议>5MB 人工归档', kind: logB > 512 * 1024 ? 'warn' : 'ok', note: '**它没有轮转机制**，我们的代码改不了它；超阈值时人工归档/清空（先备份）' });
  }
  // ③ 我们自己的审计/记忆面
  const faces = [
    ['compaction-log.md（我们的压缩留痕）', join(priv, 'tasks', 'evolution', 'compaction-log.md'), 256 * 1024, 'warn'],
    ['Learn.md（私有教训，只增不减）', join(priv, 'L1', 'Learn.md'), 128 * 1024, 'warn'],
    ['Memory.md（L1 规则）', join(root, 'mind', 'L1', 'Memory.md'), 48 * 1024, 'warn'],
    ['R0 注入源（SOUL+AGENTS 全文）', null, 20 * 1024, 'warn'],
  ];
  const r0 = ['SOUL.md', 'AGENTS.md'].reduce((a, f) => a + (size(join(root, 'mind', 'L0', f)) || 0), 0);
  for (const [name, p, lim, kind] of faces) {
    const b = name.startsWith('R0') ? r0 : size(p);
    if (b === null) continue;
    out.push({ face: name, current: `${Math.round(b / 1024)} KB`, limit: `≤${Math.round(lim / 1024)} KB`, kind: b > lim ? kind : 'ok', note: name.startsWith('R0') ? '每次会话注入一次（见 CH4 卡 §八）' : '' });
  }
  // ④ 目录面
  const snap = cap(join(priv, 'tasks', 'evolution', 'snapshots'));
  if (snap) out.push({ face: 'snapshots\\', current: `${snap.count} 文件 / ${Math.round(snap.bytes / 1048576 * 10) / 10} MB`, limit: 'warn>400 文件', kind: snap.count > 400 ? 'warn' : 'ok', note: '有时间窗裁剪流程（Memory §十一）' });
  const trash = cap(join(priv, 'TRASH'));
  if (trash) {
    const cl = cleanableBytes(join(priv, 'TRASH'));
    out.push({
      face: 'TRASH\\',
      current: `${trash.count} 件(顶层) / 可清大件 ${cl.n} 件 ${Math.round(cl.bytes / 1048576)} MB`,
      limit: 'warn>可清大件 100 MB',
      kind: cl.bytes > 100 * 1048576 ? 'warn' : 'ok',
      note: '总件数只作信息行（只增不减 ⇒ 设绝对阈值＝恒亮灯；Memory §十一 2026-09-23 订正）；本行盯**可清的大件**（乙档可再生产物，主人放行后可清 ⇒ 可熄灭）',
    });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const ri = args.findIndex((a) => a === '--root');
  const root = ri === -1 ? (process.env.DSH_HOME || REPO) : args[ri + 1];
  const rows = checks(root);
  if (args.includes('--json')) { console.log(JSON.stringify({ root, rows }, null, 2)); process.exit(rows.some((r) => r.kind === 'hard') ? 1 : 0); }
  console.log(`[growth-audit] 增长面（root=${root}）`);
  for (const r of rows) {
    const icon = r.kind === 'hard' ? '❌' : r.kind === 'warn' ? '⚠️' : '✅';
    console.log(`  ${icon} ${r.face.padEnd(38)} ${r.current.padEnd(22)} ${r.limit}${r.note ? '  ← ' + r.note : ''}`);
  }
  const hard = rows.filter((r) => r.kind === 'hard');
  const warn = rows.filter((r) => r.kind === 'warn');
  console.log(`[growth-audit] hard=${hard.length} warn=${warn.length}`);
  process.exit(hard.length ? 1 : 0);
}

main();
