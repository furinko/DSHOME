#!/usr/bin/env node
// scripts/gate-ledger.mjs — 门禁「反证台账」（2026-09-12 建，收编自 CH4 v1.0.4 的 `checks\v3\n0x_*.mau` 负例谱一课）。
//
// 为什么要它：CH4 把「应当失败」的用例做成**独立文件谱**（`n01_illegal_char` / `n02_unbounded` /
// `n03_no_recovery`），随仓库长期在。我们这边反证一直是**内联断言 + 一次性手工实验**——
// 2026-09-12 当天就有两例手工反证（marker 保护线序、门禁零污染），跑完就没了（与 `verify-trash` 起源
// 同一句教训：「那些测试是一次性的，跑完就没了」）。
// 彻底改成文件谱是大工程；**本级先做最能落地的一半：把"每个门禁有没有反证"变成机器可查的台账**，
// 并对**新**门禁设棘轮——没有反证痕迹的新门禁不允许进 pre-commit。
//
// 判定：
//   命中 = 脚本里出现反证类措辞（`反证`/`反例`/`应当变红`/`应当失败`/`should fail`/`变异测试`/`反向`），
//          或显式逃生标记 `gate-ledger: reverse-cases <说明>`（作者声明反证在哪）。
//   棘轮 = `ZERO_TRACE_ALLOWED` 里的历史门禁允许暂时为零；**不在名单里的门禁为零 ⇒ exit 1**（新门禁必须带反证）。
//
// 用法：node scripts/gate-ledger.mjs [--check] [--root <dir>]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** 反证痕迹的识别措辞（脚本注释/字符串里写明"应当变红"即算）。 */
const TRACE_RE = /反证|反例|应当变红|应当失败|should fail|变异测试|反向验证|gate-ledger: reverse-cases/;

/** 棘轮基线（2026-09-12 实测为零痕迹的历史门禁）。**只许减，不许加**。 */
const ZERO_TRACE_ALLOWED = new Set([
  'verify-boot-recall.mjs',
  'verify-payload.mjs',
  'verify-safe-overlay.mjs',
  'verify-upstream-contract.mjs',
]);

/** 台账范围 = `scripts\verify-*.mjs`（**行为门禁**）。
 *  不纳入 `syntax-check` / `mind-validate` 这两个基础设施脚本：它们的反证天然是"人工造一个坏输入"
 *  （2026-09-12 实测用过：四元镜像漂移 → mind-validate 红；坏源文件 → syntax-check 红），
 *  把它们塞进棘轮只会逼出一堆声明式逃生标记 —— 那是**台账造假**，不是覆盖。口径写清，宁可窄。 */
function gates(root) {
  const dir = join(root, 'scripts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && f.startsWith('verify-'))
    .sort()
    .map((f) => ({ file: f, path: join(dir, f) }));
}

function main() {
  const args = process.argv.slice(2);
  const ri = args.findIndex((a) => a === '--root');
  const root = ri === -1 ? (process.env.DSH_HOME || REPO) : args[ri + 1];
  const rows = gates(root).map((g) => {
    const text = readFileSync(g.path, 'utf8');
    const hits = (text.match(new RegExp(TRACE_RE.source, 'g')) || []).length;
    return { file: g.file, hits };
  });
  const zero = rows.filter((r) => r.hits === 0);
  console.log(`[gate-ledger] 门禁反证台账（${rows.length} 个门禁）`);
  for (const r of rows) {
    const allowed = ZERO_TRACE_ALLOWED.has(r.file);
    const icon = r.hits > 0 ? '✅' : allowed ? '⚠️' : '❌';
    let tail = '';
    if (r.hits === 0) tail = allowed ? '（历史门禁，棘轮允许）' : '（❌ 新门禁没有反证）';
    console.log(`  ${icon} ${r.file.padEnd(32)} 反证痕迹=${r.hits}${tail}`);
  }
  const offenders = zero.filter((r) => !ZERO_TRACE_ALLOWED.has(r.file));
  console.log(`[gate-ledger] 零痕迹=${zero.length}（棘轮允许 ${ZERO_TRACE_ALLOWED.size}）· 越界=${offenders.length}`);
  if (args.includes('--check') && offenders.length) {
    console.error(`[gate-ledger] ❌ 以下门禁没有任何反证痕迹：${offenders.map((r) => r.file).join(', ')}`);
    console.error('  要么补一条「应当变红」的用例（推荐：隔离副本上跑，见 Learn 2026-09-11），');
    console.error('  要么在脚本里写明逃生标记 `// gate-ledger: reverse-cases <反证在哪>`。');
    process.exit(1);
  }
  process.exit(0);
}

main();
