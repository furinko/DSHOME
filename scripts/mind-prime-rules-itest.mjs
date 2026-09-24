// scripts/mind-prime-rules-itest.mjs — pickUserRules 真值表（含反例与边界）
//
// 为什么要有它（2026-09-24）：
//   `userRules()` 原来把 rules.md 里所有 `## [` 行**全量直出、无上限**（实测 14 条 / 525 字符），
//   而 rules.md 只增不减 ⇒ 这是"随时间的隐性地雷"（同族教训：Learn 涨到 88 条、快照被时间窗裁死）。
//   加"排序 + 上限"这种**看起来显然**的改动最容易写成恒绿：所以按本仓惯例配可执行反例——
//   裁错了条、裁了不该裁的、imp 按字典序比（imp10 < imp2）都必须在这一跑里变红。
//
// 退出码：0 = 全过；1 = 有断言失败。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickUserRules, USER_RULES_MAX } from './mind-prime-lib.mjs';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✅ ${name}${detail ? '  «' + detail + '»' : ''}`);
  else { bad += 1; console.error(`  ❌ ${name}${detail ? '  «' + detail + '»' : ''}`); }
};
const mk = (...imps) => imps.map((i) => `## [lesson/imp${i}] 第 ${i} 条`).join('\n');

console.log(`[mind-prime-rules-itest] 上限=${USER_RULES_MAX}`);

// ① 空输入
{
  const r = pickUserRules('');
  ok('① 空文本 → 0 条 · hidden=0', r.lines.length === 0 && r.hidden === 0, `lines=${r.lines.length} hidden=${r.hidden}`);
}

// ② 正例：不超限 → 全给，且 imp 降序
{
  const r = pickUserRules(mk(1, 3, 2));
  const order = r.lines.map((l) => Number(/imp(\d+)/.exec(l)[1]));
  ok('② 不超限 → 全给 3 条', r.lines.length === 3 && r.hidden === 0);
  ok('② imp 降序 3,2,1', JSON.stringify(order) === '[3,2,1]', order.join(','));
}

// ③ 稳定序：同 imp 保持文件原序
{
  const text = ['## [a/imp2] A', '## [b/imp2] B', '## [c/imp3] C', '## [d/imp2] D'].join('\n');
  const got = pickUserRules(text).lines.join('|');
  ok('③ 同 imp 稳定（C 提最前，A/B/D 原序不变）', got === '## [c/imp3] C|## [a/imp2] A|## [b/imp2] B|## [d/imp2] D', got);
}

// ④ 无 imp → 视为 1，排最后
{
  const text = ['## [x] 无等级', '## [y/imp2] 二级', '## [z] 也无等级'].join('\n');
  const got = pickUserRules(text).lines.join('|');
  ok('④ 无 imp 视为 1（排最后且保留原序）', got === '## [y/imp2] 二级|## [x] 无等级|## [z] 也无等级', got);
}

// ⑤ 边界：恰好 max 条 → 不多裁（hidden=0）
{
  const text = mk(...Array.from({ length: USER_RULES_MAX }, (_, i) => (i % 3) + 1));
  const r = pickUserRules(text);
  ok(`⑤ 恰好 ${USER_RULES_MAX} 条 → 全留 hidden=0`, r.lines.length === USER_RULES_MAX && r.hidden === 0, `lines=${r.lines.length}`);
}

// ⑥ 反例：max+1 条 → 裁 1，且被裁的是 imp 最低那条
{
  const imps = [...Array.from({ length: USER_RULES_MAX }, () => 3), 1];
  const r = pickUserRules(mk(...imps));
  const kept = r.lines.map((l) => Number(/imp(\d+)/.exec(l)[1]));
  ok(`⑥ max+1 条 → 留 ${USER_RULES_MAX} 条 · hidden=1`, r.lines.length === USER_RULES_MAX && r.hidden === 1, `lines=${r.lines.length} hidden=${r.hidden}`);
  ok('⑥ 被裁的正是 imp1 那条', !kept.includes(1) && kept.every((i) => i === 3), kept.join(','));
}

// ⑦ 反例：非 `## [` 行不进结果（正文/大标题/空行/二级标题）
{
  const text = ['# 规则文件', '', '这是一段说明。', '## 不带方括号的小节', '## [ok/imp3] 真规则', ''].join('\n');
  const r = pickUserRules(text);
  ok('⑦ 只收 `## [` 行（1 条）', r.lines.length === 1 && r.lines[0].includes('真规则'), `lines=${r.lines.length}`);
}

// ⑧ 反例：imp 必须按**数值**比（字典序会把 imp10 排到 imp2 前面）
{
  const r = pickUserRules(mk(10, 2, 9));
  const order = r.lines.map((l) => Number(/imp(\d+)/.exec(l)[1]));
  ok('⑧ imp10 > imp2（数值序，非字典序）', JSON.stringify(order) === '[10,9,2]', order.join(','));
}

// ⑨ 真数据面：拿本机真实 rules.md 走一遍（只读；不写任何东西）
{
  const f = join(repoRoot, 'mind-private', 'L3', 'common', 'user-rules', 'rules.md');
  if (!existsSync(f)) {
    console.log('  ⏭  ⑨ 真数据面：本机无 rules.md → 跳过（不算失败）');
  } else {
    const raw = readFileSync(f, 'utf8');
    const total = raw.split('\n').filter((l) => /^##\s+\[/.test(l)).length;
    const r = pickUserRules(raw);
    ok('⑨ 真数据面：条数与 hidden 自洽', r.lines.length + r.hidden === total, `总 ${total} 条 → 注入 ${r.lines.length} · 隐藏 ${r.hidden}`);
    const chars = r.lines.join('\n').length;
    console.log(`     （真读数：${total} 条 / 注入 ${r.lines.length} 条 / ${chars} 字符）`);
  }
}

console.log(bad
  ? `\n[mind-prime-rules-itest] ❌ ${bad} 项失败`
  : '\n[mind-prime-rules-itest] ✅ 全部通过（9 组：正例 2 / 稳定序 1 / 边界 2 / 反例 3 / 真数据 1）');
process.exit(bad ? 1 : 0);
