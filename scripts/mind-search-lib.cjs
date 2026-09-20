// scripts/mind-search-lib.cjs — L3 记忆检索共享库（§十 权威排序单一实现）
//
// 背景（2026-09-05 F3 修复）：L3 检索曾有两套实现——index.cjs searchMind（§十 权威
// 排序 conf→scope→importance→score）与 mind-prime search()（只按相似度）→ 自动召回
// 路径跑简化版，与 Memory §十 法律不符。本库抽出共享核心，两处引用同一实现。
//
// 消费方：
//   - packages/dshome-mind/lib/index.cjs（CJS require）——后续清理项
//   - scripts/mind-prime.mjs（ESM：createRequire 引入）——本次接入
//
// 本库只做"检索"，不含 fs 遍历（目录来源由调用方传入，避免双份 walk 差异）。
//
// 修复 C（2026-09-11）：**元信息块参评**——frontmatter tags + H1 标题合成一小块，**文件名另成一独立小块**。
//   此前 `body` 剥掉 frontmatter 后 tags 完全不参与检索（写在 tags 里的关键词写了也没用）。
//   实证（10 条回归集）：命中 8/10 → **10/10**，平均候选数 1.6 → 2.1，阈值/口径均未动。
//   注意：文件名必须**单独**成块——并进 tags 那块会因块变长而掉到 9/10（详见 searchL3 内注释）。
'use strict';

const fs = require('fs');
const path = require('path');

/** 词/二元组 tokenize（CJK bigram + ascii 词），与旧实现逐行一致。 */
function tokenize(text) {
  const s = String(text).toLowerCase();
  const tokens = new Set();
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1]);
  (s.match(/[a-z0-9][a-z0-9_\-./]+/g) || []).forEach((w) => tokens.add(w));
  return tokens;
}

/** Jaccard 相似度。 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** frontmatter 取值（key: value，去引号）。
 *  ⚠️ 2026-09-20 修（CRLF）：正则为 `^---\n` / `\n---` —— **CRLF 文件（Windows 风格）恒不匹配** ⇒
 *  `source`/`scope`/`importance`/`tags`/`status` **全部读不到** ⇒ 该记忆被**静默降为 C 档**（本机实测确有此类
 *  CRLF-frontmatter 的记忆）。而 `mind-validate` 会先把 CRLF 归一化 ⇒ **门禁放行、检索读不到**，两边口径不一致。
 *  修法：容忍 `\r`（与 `mind-validate:35` 的归一化同口径）。 */
function fmValue(content, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  if (!m) return '';
  const r = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n]+)').exec(m[1]);
  return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

/** 记忆可信度级别（§十：A有据 > B已验证 > C待验证）。依据 frontmatter 的 source/verified。 */
function confidenceRank(content) {
  const src = fmValue(content, 'source');
  const verified = fmValue(content, 'verified');
  if (src) return 3;                    // A 有据（source 可查证）
  if (String(verified).toLowerCase() === 'true') return 2; // B 已验证
  return 1;                             // C 待验证
}

/** 冻结位（2026-09-12 加，借灵枢"不删只冻结"）——`status: frozen` = **留库但不进默认召回**。
 *
 * 设计取舍（对照 Memory.md §十一「记忆重写范围」）：
 *   · **不删、不降权、不改分**——只在候选**进入检索时**跳过；文件仍在盘上、仍可 read、仍可显式检索。
 *   · 可逆：改一个字段就还原（比删除安全，比衰减可验证）。
 *   · 零迁移：无该字段 = active（存量 0 个 frozen，行为零变化）。
 *   · 动机（借灵枢评估结论）：真痛点不是"噪音多"，而是**检索分不清冷热**；
 *     冻结即可解决，**不必有删除权**（灵枢自己也坚持"永不删节点"，4 处重复）。 */
function isFrozen(content) {
  return String(fmValue(content, 'status') || '').toLowerCase() === 'frozen';
}

/** 写入准入裁决（2026-09-12 加，借灵枢 `forgetting.py` 的四态，但**只取不依赖新数据的三条**）。
 *
 * ⚠️ **只算不判**：返回值仅用于**观测与提示**——不阻塞写入、不改任何状态、不产生副作用。
 *    两条理由：① 借 DROP 需要"来源类型"字段（我没有），硬上会退化成"agent 自证式丢弃"；
 *    ② 灵枢自己的教训是「**没有消费端的 DEFER ＝ 静默全丢**」（实测 0 篇 md 文档）。
 *
 * 三条规则（顺序即语义；第一条必须是"显式优先"）：
 *   ① `explicit`（主人显式要求记）或 `importanceHint >= 0.7` → **ACCEPT**
 *      —— 🔴 红线：AGENTS §六「主人说记一下 → 实时落」，**闸门不得静默违抗显式指令**；
 *   ② 与既有记忆 `maxSimilarity >= 0.85` → **MERGE**（并入既有条目，不新增节点）；
 *   ③ 其余 → **DEFER**（判据不足就诚实待定；**不启用 DROP**——无来源类型字段）。
 *
 * @returns {{verdict:'ACCEPT'|'MERGE'|'DEFER', reason:string, maxSimilarity:number, policy:string}}
 *   `policy` 恒为 `'observe-only'`——防止未来有人误把它当硬门禁（要先有消费端）。
 */
function admitVerdict({ maxSimilarity = 0, importanceHint = 0, explicit = false } = {}) {
  const pct = Math.round(maxSimilarity * 100);
  if (explicit || importanceHint >= 0.7) {
    return {
      verdict: 'ACCEPT',
      reason: explicit
        ? '主人显式要求记（AGENTS §六：实时落，闸门不拦）'
        : `importanceHint ${importanceHint} ≥ 0.7（高重要度直接收录）`,
      maxSimilarity: pct,
      policy: 'observe-only',
    };
  }
  if (maxSimilarity >= 0.85) {
    return {
      verdict: 'MERGE',
      reason: `与既有记忆相似度 ${pct}% ≥ 85% → 并入既有条目（不新增）`,
      maxSimilarity: pct,
      policy: 'observe-only',
    };
  }
  return {
    verdict: 'DEFER',
    reason: `判据不足（最高相似度 ${pct}% < 85%；且无"来源类型 / 低熵"字段 ⇒ **不判 DROP**）→ 待定仅供观测，**不阻塞写入**`,
    maxSimilarity: pct,
    policy: 'observe-only',
  };
}

/**
 * 切块（2026-09-10 检索修复 B · **唯一实现**——searchL3 与 index.cjs dupCheck 共用，禁各自再写一份）。
 *
 * 病灶：原来只按 `\n(?=## )` 切，**没有小标题的记忆整篇算一块**（实测 349–874 字）→ 短查询
 * （「事务门禁」「payload 漂移」）与整块的 Jaccard 被分母稀释到 minScore(3%) 以下 → **写得进、召不回**。
 * 实测：4 个 dated lessons 短查询 5/5 未命中；带 `##` 小节的**结晶文档**自召回 53%。
 *
 * 现在返回**多粒度块**（整节 + 该节内各段），打分取最高：
 *   - 整节保留（不弱化"整节相关"的匹配，召回只增不减）；
 *   - 小节内按空行分段，**标题行跟首段成一块**（标题常是结论概括），其余段落各自成块——
 *     块越小分母越小，短语命中才浮得出来。
 * @returns {Array<{text:string, heading:string}>} text 参与打分；heading 供展示
 */
function chunksOf(body) {
  const out = [];
  const push = (text, heading) => { const t = String(text).trim(); if (t) out.push({ text: t, heading: heading || '' }); };
  const sections = String(body || '').split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
  for (const sec of sections) {
    const lines = sec.split('\n');
    const heading = /^#{2,3} /.test(lines[0]) ? lines.shift().replace(/^#+ /, '').trim() : '';
    const rest = lines.join('\n').trim();
    if (!rest) { push(heading, heading); continue; }
    push(heading ? `## ${heading}\n${rest}` : rest, heading); // 整节
    const paras = rest.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (paras.length <= 1) continue;                          // 单段小节已是最小块
    paras.forEach((p, i) => push(i === 0 && heading ? `## ${heading}\n${p}` : p, heading));
  }
  return out.length ? out : [{ text: String(body || '').trim(), heading: '' }];
}

/** 相关度带宽（**百分点**）：差 ≤ 本值 ⇒ 视为"**同等相关**"、由元数据裁决。
 *
 * 按**实测**定，不按理论值域定（本仓同一个坑第三次：09-11 `score` vs `imp` · 09-17 `scope` vs `score` · 09-20 `conf`）。
 * 2026-09-20 标定（两轮：先 n=20，**扩容到 n=40 后复标**；读数属私有面，归档私有区项目档案，此处不复述）：
 *   n=40 复标：**0 / 1 / 2 / 3 完全同档**（命中 39/40 · 第一名 33/40，四点读数一致）；4–5 只有 ±1 条波动（噪声内）；**8 起明显崩**（28→26）⇒ 拐点在 5–8 之间。
 *   **取 1** 的理由：0（＝"精确并列"）会把元数据的启用**绑死在取整巧合上**（换精度就永不启用，是坏接口）；
 *   1 是**平台区里最小**的"真实带宽"，两轮标定（n=20 / n=40）都显示它零代价。⇒ **已定死（2026-09-20）**：除非语料 / 题集再显著变化，不再改；变化时按同法复标（扫 0–10 找平台与拐点）。
 * 语义：它回答的是"**多大的相关度差才算真的差**"—— 而不是"给元数据多少权重"。 */
const REL_BAND = 1;

/**
 * 排序＝**相关度分平台 + 平台内比元数据**（2026-09-20 取代"加性加权"）。
 *
 * 病灶：加性式（旧 `conf*1000 + scope*50 + imp*5 + score*100`）会让某一维的"一档"吃掉另一维**整条量程**
 *   ——旧盘 conf 一档 1000 > 其余三维上限之和 ≈275 ⇒ 相关度**实际零权重**（实测 top1 全被 A 档占满）。
 * 现式**从结构上禁止**这件事：
 *   ① 按相关度降序；
 *   ② 把 `score ≥ 平台头 − REL_BAND` 的项并成同一"**平台**"（**不链式扩散**：以平台头为准，平台宽 ≤ REL_BAND）；
 *   ③ 平台**内**按 conf > scopeRank > importance 裁决（元数据**真的参与**）；
 *   ④ 平台**之间绝不跨越** —— 差 > REL_BAND 一律相关度说了算（元数据无权翻转）。
 * ⚠️ **诚实标注**：本层"平台内裁决"在 2026-09-20 的 20 题上**没有产生过可观测差异**（并列的第一名只 3/20，
 *   且胜者与"按文件顺序取第一个"一致 ⇒ 分不清它在裁决还是没在裁决）。保留它是为了"并列时有**有依据**的裁决"，
 *   **不是**为了成绩；等 C 档修完再实测它到底值多少。
 * 注：**score 不进 sortKey**，由"平台序号"隐式承载 —— 返回顺序即最终顺序；`sortKey` 供调用方**重排复现**。
 */
function bandOrder(hits, band = REL_BAND) {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const groups = [];
  let g = [];
  for (const h of sorted) {
    if (g.length && (g[0].score - h.score) > band) { groups.push(g); g = []; }
    g.push(h);
  }
  if (g.length) groups.push(g);
  groups.forEach((grp, gi) => {
    grp.sort((a, b) => (b.conf - a.conf) || (b.scopeRank - a.scopeRank) || (b.importance - a.importance));
    for (const h of grp) h.sortKey = gi * 1e9 + h.conf * 1e6 + h.scopeRank * 1e3 + h.importance;
  });
  return groups.flat();
}

/**
 * L3 记忆检索（§十 权威排序单一实现）。
 * @param {string} query 查询词
 * @param {Array<{full:string, rel:string}>} files 待检索文件列表（调用方遍历提供）
 * @param {number} limit top-N
 * @param {object} [opts] { minScore?: number } 默认 0.03
 * @returns {Array<{score,conf,scopeRank,importance,sortKey,file,section,snippet}>}
 *   按 sortKey 降序（conf→scope→importance→score），已 slice(limit)。
 */
function searchL3(query, files, limit = 6, opts = {}) {
  const q = tokenize(query);
  // minScore = 召回下限（2026-09-10 体检：原 0.03 卡在**真命中分布中间**——实测 20 条回归里
  // 真答案的最佳块落在 2.3~2.9%，全被阈值挡在候选之外；降到 0.02 后真答案 20/20 进 top3、
  // 平均位次 2.1、候选噪声仅 2.4→3.8；再降到 0.015 噪声涨到 5.4 且 top1 质量塌 → 0.02 为甜点）。
  const minScore = opts.minScore ?? 0.02;
  const hits = [];
  for (const f of files) {
    let content = '';
    try { content = require('fs').readFileSync(f.full, 'utf8'); } catch { continue; }
    const rel = f.rel.replace(/^L3\/index\//, '');
    // ⚠️ 2026-09-20：与 `fmValue` 同一处 CRLF 修复（`\r?`）—— 否则 CRLF 文件的 frontmatter 块剥不掉，
    //   它的元信息还会混进正文参与 Jaccard 打分（双重错误：降档 + 污染分数）。
    const fmRaw = (content.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    // 冻结位（2026-09-12）：`status: frozen` 的记忆**不进默认召回**。
    //   放过 `opts.includeFrozen` 的**显式检索**（/api/mind/search）——用户明确要查时应当查得到；
    //   否则冻结会变成"记忆凭空消失"，那正是灵枢「DEFER 只留痕不入队」的老毛病。
    if (!opts.includeFrozen && isFrozen(content)) continue;
    // 多粒度切块（2026-09-10 修复 B）：整节 + 节内各段都参评，取最高分块——见 chunksOf 注释
    // 元信息块（2026-09-11 修复 C）：H1 标题 + frontmatter tags **单独成一小块**参评。
    //   病灶（实测）：`body` 去掉 frontmatter 后 tags 完全不参与打分 → 按规范写在 tags 里的关键词
    //   **写了也没用**（`守护横幅误触` 那篇正文无「守护」，tags 行单独作块 5.88% ≫ 0.02，却 0 命中）；
    //   而元信息块天然很短，Jaccard 分母小——正好补上"短关键词查询对长段落结构性不可达"
    //   （440 字段落里 3-token 查询理论上限约 0.7%）。
    //   实测（10 条回归集，语料 7 文件）：8/10 → **10/10**，平均候选数 1.6 → 2.1，阈值与口径均未动。
    //   反例留档：把**文件名**也并进这块反而掉到 **9/10**（块变长 → 分母膨胀，R09 被挤到阈值下）——
    //   "往块里多塞人工文本"不是单调增益，加什么必须按实测选。
    const chunks = chunksOf(body);
    const metaText = [
      (/^#\s+(.+)$/m.exec(body) || [, ''])[1].trim(),
      (/^[ \t]*tags:\s*(.+)$/m.exec(fmRaw) || [, ''])[1].trim(),
    ].filter(Boolean).join(' ');
    if (metaText) chunks.push({ text: metaText, heading: '标题/tags' });
    // 文件名块（2026-09-11 修复 C 之二）：文件名**单独**成块，**不并进** metaText——并进去就是上面那个反例。
    //   动机（实测）：`守护横幅误触与前端失败检测` 那篇的 **H1 不含「横幅」**（H1 写的是内容主题），
    //   tags 里也没有「横幅」→ 自然短语「横幅误弹」0 命中，而这个词正是文件名里的。
    //   实测同类三选（10 条回归集）：单独成块 **10/10 · 平均候选 2.1**（与不启用同档）；
    //   并入同块 9/10（R09 掉阈值下）；顺带把「横幅误弹」从 0 条救到 1 条（top1 正确），
    //   并把「守护横幅」的得分余量 3.1% → **23.1%**（更抗阈值漂移）。
    const baseName = String(path.basename(f.full) || '').replace(/\.md$/, '');
    if (baseName) chunks.push({ text: baseName, heading: '文件名' });
    let best = null;
    for (const c of chunks) {
      const sc = jaccard(q, tokenize(c.text));
      if (!best || sc > best.score) best = { score: sc, sec: c.text, heading: c.heading };
    }
    if (best && best.score >= minScore) {
      const conf = confidenceRank(content);
      const scope = (fmValue(content, 'scope') || 'project').toLowerCase();
      const importance = Number(fmValue(content, 'importance')) || 2;
      // §十 排序（**2026-09-20 重定：相关度主序，元数据只在"完全并列"时裁决**）。
      //   旧式 `conf*1000 + scope*50 + imp*5 + score*100` 的病灶：**可信度一档 1000 分 > 其余三维上限之和 ≈275**
      //   ⇒ 任何 A 档文件只要越过 minScore，就必然排在所有 C 档之前，**与相关性无关**。
      //   实测（本机私有语料与回归集；**读数属私有面，归档私有区项目档案**）：旧量纲下 **top1 全部被 A 档占满**，
      //   未命中的期望绝大多数是 C 档文档 ⇒ 排序实际由「有没有写 `source:`」这一个字段决定，**与相关性无关**。
      //   判据（同一个坑第三次：09-11 `score` vs `imp` · 09-17 `scope` vs `score` · 本次 `conf` vs `score`）：
      //     **某一维的"一档"必须小于被它覆盖那一维的"实测跨度"** —— 按**实测分布**定，不按字段**理论值域**定。
      //     本语料相关度实测只有 **2–17 分**（Jaccard 0.02–0.17）；而 conf 一档 1000、scope 一档 50 都是它的数倍~数十倍。
      //   新式＝相关度按**整数百分比主序**（1 分一档 ＝ 实测分辨力），conf/scope/importance 只在**完全并列**时裁决。
      //   实测（20 条回归）：命中 **7→17**、第一名 **3→13**；带宽 1/2/3/5/10 下的第一名 = **13/12/12/10/10**
      //   （**越粗越差** ⇒ 带宽只能是 0，即只允许"完全并列"）。**语义不变**：可信度仍然"优先"，
      //   只是从"绝对碾压"回到 §十 原文的「**同级内**：scope > 相关度 > importance」。
      //   ⚠️ **诚实标注（2026-09-20 实测）**：这层"平手裁决"在现有 20 题上**没有产生过任何可观测差异**——
      //     第一名位置出现并列的只有 **3/20**，而那 3 次的胜者与"按文件名顺序取第一个"**完全一致**
      //     ⇒ 本次测量**分不清**"它在裁决"还是"它没在裁决"；**可观测行为 = 只按相关度**。
      //     保留它**不是**为了成绩，而是：① 并列时给出**有依据**的裁决（而非字母序的任意但稳定）；
      //     ② 为展示层/消费层保留可信等级来源；③ 零成本（带宽 0，不改变任何非平手顺序）。
      //     若将来认定"平手裁决"也是负担 ⇒ 删掉这三项 + **同批改 §十 排序契约**（L1 高危，需请卡）。
      // 相关度按**百分制**参与（`score*100`）：2026-09-11 精度修复——原为 `+ best.score`（恒 <1，与 `imp*10`
      // 差一个量级）⇒ **相关度实际上是零权重**。实测 5 条 top1 错全是同一形状："期望文件相关度高 5~7 倍，
      // 却因 importance 差一档而输"（R01 期望 21 vs 3、R03 期望 15 vs 4）。
      // 扫权重曲线定位（10 条回归集）：score 权重 10→5/10、**100→7/10**、1000→7/10（拐点 ×100）；
      // conf 权重 0→1000 **恒 7/10** ⇒ 档序本身没过，病在**量纲**。
      // 改后：top1 **5/10 → 7/10**、topN 恒 **10/10（召回不退化）**。剩余 3 条任何权重都救不动 ⇒
      // 属匹配质量/期望合理性问题，非排序（已单独立项）。
      const scopeRank = scope === 'user' ? 3 : scope === 'self' ? 2 : 1;
      // ⚠️ 2026-09-17 量纲调整（实验，已过 20 条回归）：原 `conf*1000 + scopeRank*100 + imp*10 + score*100`
      //   的病根与 2026-09-10 那次同类修复同形 —— **scopeRank 一档 100 恰好等于相关度的整条量程**，
      //   ⇒ scope 差一档就盖过相关度的全部变化。实测：`门禁 挂链 反例` 查询下，`scope:self` 的文件
      //   相关度 7 排第 1，而 `scope:common` 的通用 lessons 相关度 14（2 倍）排第 2（key 3153.5 vs 3227.1）。
      //   后果：**蒸馏产出的通用结晶系统性排在项目/自我文件之后** —— 用 20 条回归（口径偏项目）验收会低估它。
      //   新公式把 scopeRank 压到 50（< 相关度量程 100）、importance 压到 5（半档，不与 scope 同量级），
      //   **conf 仍最高（×1000，保持"可信度优先于相关度"的 §十 设计）**。
      //   回滚 = restore `snapshots/2026-09-17T08-15-42_dba4e926_mind-search-lib.cjs`。
      //   ⚠️ **已被 2026-09-20 的 S1 重定取代（本节保留为沿革）**：当时把 scopeRank 压到 50、imp 压到 5，
      //      但**分母用的是"字段理论量程 100"，而相关度实测跨度只有 2–17** ⇒ conf 一档 1000 仍是实测量程的 60 倍、
      //      scope 一档 50 仍是 3 倍 ⇒ **两个维度都仍违规**。现行式见下方 `sortKey`。
      hits.push({
        score: Math.round(best.score * 100),
        conf,
        scopeRank,
        importance,
        // 排序（2026-09-20 平台式）：`sortKey` **不在这里**算 —— 由下方 `bandOrder()` 按"平台序号 + 元数据"统一赋值，
        //   保证"返回顺序"与"按 sortKey 重排"是同一个结果（单一真源，不做两份）。
        file: rel,
        // 展示优先用所属小节标题（段落块不带标题行时也能标出"在哪一节"）
        section: (best.heading || (best.sec.split('\n')[0] || '').replace(/^#+/, '')).slice(0, 60),
        snippet: best.sec.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  // 相关度分平台 + 平台内比元数据（见 bandOrder 注释）：平台之间绝不跨越。
  return bandOrder(hits).slice(0, limit);
}

/**
 * 遍历 L3 记忆区 .md 文件（同 index.cjs walkContentMd 的过滤：仅 .md、排除 README/_index/.gitkeep）。
 * @param {string} rootDir 如 <root>/mind-private/L3/index
 * @returns {Array<{full:string, rel:string}>} rel 相对 rootDir（无前缀），供 searchL3 使用。
 */
function listL3Files(rootDir) {
  const out = [];
  (function walk(dir, rel) {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    es.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of es) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      try {
        if (e.isDirectory()) walk(full, r);
        else if (e.isFile() && e.name.endsWith('.md')
          && e.name !== 'README.md' && e.name !== '_index.md' && e.name !== '.gitkeep') out.push({ full, rel: r });
      } catch { /* ignore */ }
    }
  })(rootDir, '');
  return out;
}

/**
 * 记忆候选集（记忆层重构 2026-09-09）：候选 = common（通用，恒含）+ projects/<当前项目>（专属）。
 * 物理目录隔离——不再依赖 frontmatter project 字段过滤（旧 L3/index 单库方案）。
 * @param {string} L3Root 如 <root>/mind-private/L3
 * @param {string} project 当前项目 key（= 项目目录名，如 `DSHOME` 或其它项目目录名；空 = 只取通用）
 * @returns {Array<{full:string, rel:string}>} rel 相对 L3Root，带 common/ 或 projects/<key>/ 前缀
 */
function listMemoryCandidates(L3Root, project) {
  const out = [];
  const commonDir = path.join(L3Root, 'common');
  if (fs.existsSync(commonDir)) {
    for (const f of listL3Files(commonDir)) out.push({ full: f.full, rel: `common/${f.rel}` });
  }
  const projKey = String(project || '').trim();
  if (projKey && !/[/\\]/.test(projKey)) {
    // 项目层只扫「知识」结晶区（Memory.md §十 第 0 步：导航卡 project.md 与记忆档案在项目根、
    // 靠强制依赖上工直读，不进检索候选）。2026-09-11 修复：此前扫整个项目目录 → 实测
    // `projects/DSHOME/project.md` 被当记忆命中（score 20 挤进 top5），污染召回。
    const knowDir = path.join(L3Root, 'projects', projKey, '知识');
    if (fs.existsSync(knowDir)) {
      for (const f of listL3Files(knowDir)) out.push({ full: f.full, rel: `projects/${projKey}/知识/${f.rel}` });
    }
  }
  return out;
}

/**
 * 全库记忆候选（common + 全部项目）——回归集/全库场景用（等价旧 listL3Files(L3/index) 行为）。
 * @param {string} L3Root 如 <root>/mind-private/L3
 */
function listAllMemories(L3Root) {
  const out = [];
  const commonDir = path.join(L3Root, 'common');
  if (fs.existsSync(commonDir)) {
    for (const f of listL3Files(commonDir)) out.push({ full: f.full, rel: `common/${f.rel}` });
  }
  const projsDir = path.join(L3Root, 'projects');
  if (fs.existsSync(projsDir)) {
    let es; try { es = fs.readdirSync(projsDir, { withFileTypes: true }); } catch { return out; }
    for (const e of es) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      // 只扫「知识」结晶区，排除项目根的导航卡/记忆档案（同 listMemoryCandidates 口径，2026-09-11）
      const knowDir = path.join(projsDir, e.name, '知识');
      if (!fs.existsSync(knowDir)) continue;
      for (const f of listL3Files(knowDir)) out.push({ full: f.full, rel: `projects/${e.name}/知识/${f.rel}` });
    }
  }
  return out;
}

module.exports = { tokenize, jaccard, fmValue, confidenceRank, isFrozen, admitVerdict, searchL3, listL3Files, listMemoryCandidates, listAllMemories, chunksOf, bandOrder, REL_BAND };
