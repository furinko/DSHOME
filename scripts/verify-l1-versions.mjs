#!/usr/bin/env node
// scripts/verify-l1-versions.mjs — L1 规则文件「改正文必须提版本」门禁（2026-09-17 建）
//
// ── 为什么需要它（真实漏项，不是假想）────────────────────────────────────────
// 既定流程（`Ritual §四` 自我修改事务）要求：改 L1 规则 ⇒ **版本号 +0.1 + 版本行追加本次授权与
// 改动摘要**。但 `mind-validate` 的"版本四元"只覆盖 **L2 Skill**（frontmatter ↔ 文件尾 ↔ `Tree`
// ↔ `_index`）——**L1 规则文件（Ritual / Power / Memory / Invariants / HUB / Concepts /
// Design-Philosophy / Wisdom）的头/尾版本行无人校验**。2026-09-17 实测：同一天我把
// `Ritual.md`（§四 四段式 + `:47`）与 `Power.md`（`:79` 口径）正文改了两次、**两次都忘了提版本**，
// 靠收工自查才发现（事后补 1.15 / 1.14）。同类已知盲区：`Skill\README.md` 能力表。
//
// ── 判据（不需要任何台账）───────────────────────────────────────────────────
// 拿 **staged 内容 vs HEAD 内容** 直接比：
//   · 内容变了 + 版本行**没变** ⇒ ❌ 红（"改了正文没提版本"）
//   · 内容变了 + 版本行变了   ⇒ ✅（这就是流程要求的形态）
//   · 头/尾版本号不一致（两行都在时）⇒ ⚠️ warn（**历史遗留**只提示、不拦）
//   · **本次改动新引入**的头/尾不一致（改前一致、改后不一致）⇒ ❌ 红（2026-09-24 收紧：原先只 warn，
//     实测「头 1.3 / 尾 1.4」仍 PASS ⇒ 新改动引入的不一致会**静默通过**；历史遗留不误伤）
// 只看**已暂存**的改动（pre-commit 里就是本次提交的内容）；新文件（HEAD 无同名）跳过。
//
// ── 反例（写不出反例＝没验过；`--selftest` 可执行）──────────────────────────
//   ① 只改正文不动版本行 → 必须红 · ② 只动版本行 → 必须不红 · ③ 两处都改 → 不红
//   ④ 内容未变 → 不红 · ⑤ 历史遗留的头尾不一致 → warn（不红）
//   ⑧ 改前一致、改后不一致（本次引入）⇒ 必须红
//
// 用法：node scripts/verify-l1-versions.mjs [--selftest]
// 退出码：0 = 通过；1 = 有断言失败（或 git 不可用——门禁跑不起来要响亮，见 verify-integrity）
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const L1_DIR = 'mind/L1/';

const HEAD_RE = /^>\s*版本：\s*([0-9]+(?:\.[0-9]+)*)/m;
const FOOT_RE = /^_版本：\s*([0-9]+(?:\.[0-9]+)*)/gm;

/** 取头/尾版本号（缺则为 null）。
 *  🔴 尾版本取**最后一个**匹配，不取第一个：正文里可能内嵌"版本行模板"（`Memory.md` 的 §模板
 *    就含 `_版本：vX | 日期 | 本轮摘要_`，实文件尾在千行之后）。取第一个会**认错尾行** ⇒ 假 warn。
 *     反例（`--selftest` ⑥）：正文放一个 `_版本：1.0 …_` 占位、真尾是 1.1 ⇒ 必须读出 1.1。 */
function versionsOf(text) {
  const head = HEAD_RE.exec(text)?.[1] ?? null;
  const all = [...String(text ?? '').matchAll(FOOT_RE)];
  const foot = all.length > 0 ? all[all.length - 1][1] : null;
  return { head, foot };
}
const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n');

/**
 * 纯判定：一次 L1 文件改动是否合规。
 * @param {string} oldText - HEAD 里的内容（新文件传 null）。
 * @param {string} newText - 暂存区里的内容。
 * @returns {{ok: boolean, warn: string|null, reason: string}}
 */
export function judgeL1VersionChange(oldText, newText) {
  if (oldText === null || oldText === undefined) return { ok: true, warn: null, reason: '新文件 → 跳过' };
  const a = norm(oldText);
  const b = norm(newText);
  if (a === b) return { ok: true, warn: null, reason: '内容未变 → 无需提版本' };
  const va = versionsOf(a);
  const vb = versionsOf(b);
  const bumped = va.head !== vb.head || va.foot !== vb.foot;
  const mismatchAfter = vb.head !== null && vb.foot !== null && vb.head !== vb.foot;
  const mismatchBefore = va.head !== null && va.foot !== null && va.head !== va.foot;
  const warn = mismatchAfter ? `头(${vb.head}) ≠ 尾(${vb.foot})` : null;
  if (!bumped) {
    return {
      ok: false, warn,
      reason: `内容已改但版本行未变（头 ${va.head ?? '—'} / 尾 ${va.foot ?? '—'}）⇒ 按 Ritual §四 须「版本号 +0.1 + 版本行追加摘要」`,
    };
  }
  // 2026-09-24 收紧：**本次改动新引入**的头尾不一致 ⇒ 红（两行同批改才是流程要求的形态）；
  //   **历史遗留**的不一致（改前就一致不了）仍只 warn，避免误伤与本次改动无关的旧账。
  if (mismatchAfter && !mismatchBefore) {
    return {
      ok: false, warn,
      reason: `本次改动引入了头/尾版本不一致（头 ${vb.head} / 尾 ${vb.foot}）—— 两行必须同批改（历史遗留的不一致仍只提示）`,
    };
  }
  return { ok: true, warn, reason: `版本行已更新（头 ${va.head ?? '—'}→${vb.head ?? '—'} / 尾 ${va.foot ?? '—'}→${vb.foot ?? '—'}）` };
}

// ── 自检：五条可执行反例 ────────────────────────────────────────────────────
function selftest() {
  const base = [
    '> 版本：1.0 | 2026-01-01 | 初版',
    '',
    '## 一、正文',
    '- 原文',
    '',
    '_版本：1.0 | 2026-01-01 | 初版_',
  ].join('\n');
  const cases = [
    ['① 只改正文 → 必须红', base, base.replace('- 原文', '- 改了正文'), false],
    ['② 只动版本行 → 不红', base, base.replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02'), true],
    ['③ 两处都改 → 不红', base, base.replace('- 原文', '- 改了正文').replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02'), true],
    ['④ 内容未变 → 不红', base, base, true],
    ['⑤ 历史遗留的头尾不一致 → warn 但不红', base.replace('_版本：1.0', '_版本：0.9'), base.replace('- 原文', '- 改了正文').replace('> 版本：1.0', '> 版本：1.1'), true],
    ['⑧ 本次改动引入头尾不一致 → 必须红', base, base.replace('- 原文', '- 改了正文').replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02').replace('_版本：1.1', '_版本：1.0'), false],
  ];
  let bad = 0;
  for (const [name, oldT, newT, wantOk] of cases) {
    const r = judgeL1VersionChange(oldT, newT);
    const wantWarn = name.startsWith('⑤') || name.startsWith('⑧');
    const ok = r.ok === wantOk && (wantWarn ? !!r.warn : true);
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  → ok=${r.ok} warn=${r.warn ?? '—'}  «${r.reason}»`);
  }
  // ⑥ 反例之反例：把"内容变"造出来却不带版本行，判定必须为红（防 judge 退化成恒绿）
  const r6 = judgeL1VersionChange(base, base.replace('- 原文', '- 改了正文'));
  if (r6.ok) { bad += 1; console.error('FAIL ⑥ judge 对「改正文不提版本」返回了绿 ⇒ 判据退化'); }
  else console.log('ok   ⑥ 判据未退化（改正文不提版本 ⇒ 红）');
  // ⑦ 尾版本必须取**最后一个**：正文里内嵌模板占位（Memory.md §模板那种）不得冒充真尾行
  const withTemplate = [
    '> 版本：1.0 | 2026-01-01 | 初版', '', '## 模板', '_版本：vX | 日期 | 本轮摘要_', '', '',
    '_版本：1.2 | 2026-03-03 | 真尾_',
  ].join('\n');
  const v7 = versionsOf(withTemplate);
  if (v7.foot === '1.2') console.log('ok   ⑦ 尾版本取最后一个匹配（模板占位不冒充真尾）');
  else { bad += 1; console.error(`FAIL ⑦ 尾版本取错：得到 ${v7.foot}（期望 1.2）—— 正文模板占位会遮住真尾行`); }
  console.log(bad ? `\nverify-l1-versions --selftest: ${bad} 项失败` : '\nverify-l1-versions --selftest: 全部通过（6 反例 + 1 退化检查 + 1 尾行取值检查 = 8 项）');
  process.exit(bad ? 1 : 0);
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function main() {
  if (process.argv.includes('--selftest')) selftest();
  let changed;
  try {
    changed = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', L1_DIR])
      .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md'));
  } catch (e) {
    // 🔴 门禁跑不起来要**响亮**（verify-integrity：输入缺失即失败）——静默跳过＝假绿。
    console.error(`[verify-l1-versions] ❌ 无法读取暂存区（git 不可用？）：${e?.message ?? e}`);
    process.exit(1);
  }
  if (changed.length === 0) { console.log('[verify-l1-versions] 本次提交无 L1 改动 → 跳过'); process.exit(0); }
  let failed = 0; let warned = 0;
  for (const p of changed) {
    let oldText = null;
    try { oldText = git(['show', `HEAD:${p}`]); } catch { oldText = null; /* 新文件 */ }
    let newText = '';
    try { newText = git(['show', `:${p}`]); } catch { console.error(`[verify-l1-versions] ❌ 读不到暂存内容：${p}`); failed += 1; continue; }
    const r = judgeL1VersionChange(oldText, newText);
    if (!r.ok) { failed += 1; console.error(`  ❌ ${p}：${r.reason}`); }
    else if (r.warn) { warned += 1; console.log(`  ⚠️  ${p}：${r.warn}（历史遗留，只提示）`); }
    else console.log(`  ✅ ${p}：${r.reason}`);
  }
  console.log(failed
    ? `\n[verify-l1-versions] ❌ ${failed} 个 L1 文件改了正文却没提版本（Ritual §四：版本号 +0.1 + 版本行追加摘要）`
    : `\n[verify-l1-versions] ✅ 通过（${changed.length} 个 L1 改动${warned ? `，${warned} 处头尾不一致仅提示` : ''}）`);
  process.exit(failed ? 1 : 0);
}

main();
