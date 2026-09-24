// scripts/mind-prime-lib.mjs — 上工召回（mind-prime）的**可测纯函数库**
//
// 为什么单独成文件（2026-09-24）：
//   `mind-prime.mjs` 是**顶层即执行**的注入器——import 它就会跑完整装配并打印整个 R1 块，
//   纯函数塞在里面没法干净地做反例测试（会被副作用淹没，且测试与"跑了一次召回"混在一起）。
//   同族先例：`scripts/mind-search-lib.cjs`（searchL3 的唯一实现，供多处复用）。
//
// 判据可执行：`node scripts/mind-prime-rules-itest.mjs`（正例 / 反例 / 边界 / 稳定序 / 数值序）

/** user-rules 注入上限（条）。超限**不静默丢**：调用方必须把 hidden 条数写进注入面。 */
export const USER_RULES_MAX = 20;

/** 从 `## [<type>/imp<N>] …` 形态的规则行里挑出要注入的那些。
 *
 *  规则：
 *   ① 只收 `## [` 开头的行（rules.md 的正文/标题/空行不进注入面）；
 *   ② 按 `imp<N>` **数值**降序排序（`imp10` > `imp2`，不是字典序）；
 *   ③ 排序**稳定**：同 imp 保持文件原序；无 `imp` 的视为 1（排最后）；
 *   ④ 超过 max 时截前 max 条，并回报 hidden = 被截条数（调用方负责写进注入面）。
 *
 *  @param {string} text rules.md 全文
 *  @param {number} [max] 上限（默认 {@link USER_RULES_MAX}）
 *  @returns {{lines: string[], hidden: number}}
 */
export function pickUserRules(text, max = USER_RULES_MAX) {
  const cap = Number.isFinite(max) && max >= 0 ? Math.floor(max) : USER_RULES_MAX;
  const lines = String(text ?? '')
    .split('\n')
    .filter((l) => /^##\s+\[/.test(l));
  const impOf = (l) => {
    const m = /imp(\d+)/i.exec(l);
    return m ? Number(m[1]) : 1;
  };
  const sorted = lines
    .map((l, i) => ({ l, i, imp: impOf(l) }))
    .sort((a, b) => b.imp - a.imp || a.i - b.i) // 数值降序 + 稳定（同 imp 回落到原序）
    .map((x) => x.l);
  return sorted.length <= cap
    ? { lines: sorted, hidden: 0 }
    : { lines: sorted.slice(0, cap), hidden: sorted.length - cap };
}
