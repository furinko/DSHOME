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

/** frontmatter 取值（key: value，去引号）。 */
function fmValue(content, key) {
  const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
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

/**
 * 切块（2026-09-10 检索修复 B · **唯一实现**——searchL3 与 index.cjs dupCheck 共用，禁各自再写一份）。
 *
 * 病灶：原来只按 `\n(?=## )` 切，**没有小标题的记忆整篇算一块**（实测 349–874 字）→ 短查询
 * （「事务门禁」「payload 漂移」）与整块的 Jaccard 被分母稀释到 minScore(3%) 以下 → **写得进、召不回**。
 * 实测：4 个 dated lessons 短查询 5/5 未命中；带 `##` 的 toolchain.md 自召回 53%。
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
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    // 多粒度切块（2026-09-10 修复 B）：整节 + 节内各段都参评，取最高分块——见 chunksOf 注释
    let best = null;
    for (const c of chunksOf(body)) {
      const sc = jaccard(q, tokenize(c.text));
      if (!best || sc > best.score) best = { score: sc, sec: c.text, heading: c.heading };
    }
    if (best && best.score >= minScore) {
      const conf = confidenceRank(content);
      const scope = (fmValue(content, 'scope') || 'project').toLowerCase();
      const importance = Number(fmValue(content, 'importance')) || 2;
      // §十 排序：可信度(A/B/C) 优先级最高；同级内 scope（user>self>project）> importance > score
      const scopeRank = scope === 'user' ? 3 : scope === 'self' ? 2 : 1;
      hits.push({
        score: Math.round(best.score * 100),
        conf,
        scopeRank,
        importance,
        sortKey: conf * 1000 + scopeRank * 100 + importance * 10 + best.score,
        file: rel,
        // 展示优先用所属小节标题（段落块不带标题行时也能标出"在哪一节"）
        section: (best.heading || (best.sec.split('\n')[0] || '').replace(/^#+/, '')).slice(0, 60),
        snippet: best.sec.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  hits.sort((a, b) => b.sortKey - a.sortKey);
  return hits.slice(0, limit);
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

module.exports = { tokenize, jaccard, fmValue, confidenceRank, searchL3, listL3Files, listMemoryCandidates, listAllMemories, chunksOf };
