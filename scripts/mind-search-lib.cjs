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
  const minScore = opts.minScore ?? 0.03;
  const hits = [];
  for (const f of files) {
    let content = '';
    try { content = require('fs').readFileSync(f.full, 'utf8'); } catch { continue; }
    const rel = f.rel.replace(/^L3\/index\//, '');
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const sections = body.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
    let best = null;
    for (const sec of sections) {
      const sc = jaccard(q, tokenize(sec));
      if (!best || sc > best.score) best = { score: sc, sec };
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
        section: ((best.sec.split('\n')[0] || '').replace(/^#+/, '')).slice(0, 60),
        snippet: best.sec.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  hits.sort((a, b) => b.sortKey - a.sortKey);
  return hits.slice(0, limit);
}

/**
 * 遍历 L3/index 下的记忆 .md 文件（同 index.cjs walkContentMd 的过滤：仅 .md、排除 README/_index/.gitkeep）。
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

module.exports = { tokenize, jaccard, fmValue, confidenceRank, searchL3, listL3Files };
