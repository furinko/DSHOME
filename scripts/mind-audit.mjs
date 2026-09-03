// scripts/mind-audit.mjs — 心智生长哲学底座·组件C：离线漏查审计（观测器）
// 目标：批量审计「该查没查」——会话里用户问题命中 L3 已有记忆主题，但 agent
//       在那一轮没有做任何记忆/权威源检索（mind-prime / /api/mind/search /
//       grep mind-private L3 等）。≥2 次同主题 → 输出「意图→记忆弱路由」建议候选。
// 性质：观测器，离线跑；不拦 commit（exit 0），只产出候选；用数据长，不拍脑袋。
//
// 用法：
//   node scripts/mind-audit.mjs                 # 扫 sessions/ 全部 zstd 会话，输出候选（默认）
//   node scripts/mind-audit.mjs --json          # 结构化输出（供 cron/面板消费）
//   node scripts/mind-audit.mjs --sessions <dir># 指定会话根（默认 repoRoot/sessions）
//
// 判据（启发式，宁缺毋滥）：
//   a. 主题词表 = mind-private/L3/index 主题目录名 + 记忆文件名（去 YYYY-MM-DD_ 前缀）+ _index 摘要词；
//   b. 用户回合文本命中 ≥1 主题词 → 该回合「该查」；
//   c. 查证证据 = 同一回合（下一用户消息前）出现检索类行为：mind-prime 调用、
//      /api/mind/search、grep/read 命中 mind-private/L3、读 project.md、读 L3 主题文件；
//   d. 该查但无查证证据 → 漏查候选；同主题累计 ≥2 次 → 弱路由建议。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const SESSIONS = process.argv.includes('--sessions') ? process.argv[process.argv.indexOf('--sessions') + 1] : join(repoRoot, 'sessions');
const PRIV = join(repoRoot, 'mind-private');
const asJson = process.argv.includes('--json');
const MIN_ROUNDS_FOR_ROUTE = 3; // 同主题漏查 ≥3 才建议弱路由（方案原文阈值，宁缺毋滥）

// ── zstd 多帧扫描/解码（照 dsh-session-persistence-jsonl scanZstdFrames）────
const ZSTD_MAGIC = 0xFD2FB528;
function scanFrames(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const start = o;
    if (buf.length - o < 4) break;
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) break;
    o += 4;
    if (o === buf.length) break;
    const d = buf.readUInt8(o); o += 1;
    if ((d & 24) !== 0) break; // reserved bits
    const contentSizeFlag = d >>> 6;
    const singleSegment = (d & 32) !== 0;
    const checksum = (d & 4) !== 0;
    const dictFlag = d & 3;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const cszBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const rem = (singleSegment ? 0 : 1) + dictBytes + cszBytes;
    if (buf.length - o < rem) break;
    o += rem;
    for (;;) {
      if (buf.length - o < 3) return frames;
      const bh = buf.readUIntLE(o, 3); o += 3;
      const last = (bh & 1) !== 0;
      const btype = (bh >>> 1) & 3;
      const bsize = bh >>> 3;
      if (btype === 3) return frames; // reserved block type → 终止
      const pay = btype === 1 ? 1 : bsize;
      if (buf.length - o < pay) return frames;
      o += pay;
      if (last) break;
    }
    if (checksum) { if (buf.length - o < 4) return frames; o += 4; }
    frames.push({ start, end: o });
  }
  return frames;
}
function decodeSessionFile(path) {
  try {
    const raw = readFileSync(path);
    const frames = scanFrames(raw);
    if (!frames.length) return [];
    let text = '';
    for (const fr of frames) {
      try { text += zstdDecompressSync(raw.subarray(fr.start, fr.end)).toString('utf8'); }
      catch { /* 单帧损坏跳过，不影响其余 */ }
    }
    const events = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* 跳过非 JSON 行 */ }
    }
    return events;
  } catch { return []; }
}
function walkFiles(dir, out = [], rel = '') {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    if (statSync(full).isDirectory()) walkFiles(full, out, r);
    else if (e.endsWith('.jsonl.zstd')) out.push({ full, rel: r });
  }
  return out;
}

// ── 主题词表（L3 index：主题目录名 + frontmatter tags + _index 摘要列）─────
function topicTerms() {
  const terms = new Set();
  const idxRoot = join(PRIV, 'L3', 'index');
  if (!existsSync(idxRoot)) return terms;
  for (const topic of readdirSync(idxRoot)) {
    const tdir = join(idxRoot, topic);
    if (!statSync(tdir).isDirectory()) continue;
    terms.add(topic.toLowerCase());
    for (const f of readdirSync(tdir)) {
      if (!f.endsWith('.md')) continue;
      // frontmatter tags 是最准的主题词（数值/平衡/T值/幸存者Like…）
      try {
        const body = readFileSync(join(tdir, f), 'utf8');
        const fm = /^---\n([\s\S]*?)\n---/.exec(body);
        if (fm) {
          const tagsRaw = /(?:^|\n)\s*tags:\s*\[([^\]]*)\]/m.exec(fm[1]);
          if (tagsRaw) {
            for (const tg of tagsRaw[1].split(',')) {
              const t = tg.trim().replace(/['"\[\]]/g, '');
              if (!t) continue;
              if (/[\u4e00-\u9fff]/.test(t) ? t.length >= 2 : t.length >= 5) terms.add(t.toLowerCase());
            }
          }
        }
      } catch { /* ignore */ }
      if (f === '_index.md') {
        try {
          const body = readFileSync(join(tdir, f), 'utf8');
          for (const m of body.matchAll(/\|([^|]{2,24})\|/g)) {
            const cell = m[1].trim().replace(/[`|]/g, '');
            if (/[\u4e00-\u9fff]/.test(cell) && cell.length <= 20) terms.add(cell.toLowerCase());
          }
        } catch { /* ignore */ }
      }
    }
  }
  return terms;
}

// ── 事件流 → 回合（user 消息为界）──────────────────────────────────────────
function contentTextOf(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => (typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  return '';
}
// 只收用户真实提问：排除系统注入（AGENTS/workspace instructions）、goal/plugin 壳文本
const SYSTEM_NOISE = /<system-reminder>|<goal_round>|<goal_blocked>|approval policy changed|Workspace instructions|system instructions/i;
function isUserTurnText(t, sourceKind) {
  if (!t || !t.trim()) return false;
  if (sourceKind && sourceKind !== 'user') return false;
  if (SYSTEM_NOISE.test(t)) return false;
  if (t.length < 2 || t.length > 2000) return false;
  return true;
}
function extractUserTexts(events) {
  const out = [];
  for (const ev of events) {
    const d = ev.data;
    if (!d) continue;
    if (ev.type === 'agent/inbox/spliced' && Array.isArray(d.inserted)) {
      for (const m of d.inserted) {
        const t = contentTextOf(m);
        if (isUserTurnText(t, m.source && m.source.kind)) out.push(t);
      }
    } else if (ev.type === 'user/message') {
      const t = contentTextOf(d);
      if (isUserTurnText(t, 'user')) out.push(t);
    }
  }
  return out;
}
function extractToolEvidence(events) {
  const ev = [];
  for (const e of events) {
    if (e.type === 'tool/call') {
      const d = e.data || {};
      ev.push({ name: d.name || d.tool || '', args: JSON.stringify(d.arguments || d.input || d).slice(0, 300) });
    }
  }
  return ev;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const terms = topicTerms();
const termList = [...terms];
const files = walkFiles(SESSIONS);
const rounds = [];   // {session, userText, hitTerm, evidence}
const sessionNotes = [];
for (const f of files) {
  const events = decodeSessionFile(f.full);
  if (!events.length) continue;
  const texts = extractUserTexts(events);
  const tools = extractToolEvidence(events);
  const toolBlob = tools.map((t) => `${t.name} ${t.args}`).join('\n');
  sessionNotes.push(`会话 ${basename(f.rel)}：${texts.length} 条用户消息 / ${tools.length} 次工具调用`);
  // 检索证据判定（任一命中即视为「查了」）
  const searched = /mind-prime|\/api\/mind\/search|L3\/index|mind-private[\\/]L3|project\.md|grep.*mind|mind.*grep|dup-check|search\?q=/i.test(toolBlob);
  for (const ut of texts) {
    const low = ut.toLowerCase();
    const hit = termList.find((t) => low.includes(t));
    if (hit) {
      rounds.push({
        session: basename(f.rel),
        term: hit,
        userText: ut.replace(/\s+/g, ' ').slice(0, 160),
        searched,
      });
    }
  }
}

// 聚合：同主题漏查次数 + 该主题是否从未被查
const byTerm = new Map();
for (const r of rounds) {
  if (r.searched) continue; // 查了的不算漏查
  const key = r.term;
  if (!byTerm.has(key)) byTerm.set(key, { term: key, misses: 0, samples: [] });
  const st = byTerm.get(key);
  st.misses += 1;
  if (st.samples.length < 3) st.samples.push({ session: r.session, text: r.userText });
}
const candidates = [...byTerm.values()]
  .sort((a, b) => b.misses - a.misses);

if (asJson) {
  console.log(JSON.stringify({
    scanned: files.length,
    sessions: sessionNotes.length,
    terms: termList.length,
    roundsChecked: rounds.length,
    routeThreshold: MIN_ROUNDS_FOR_ROUTE,
    missesByTerm: byTerm.size,
    // 全部漏查主题明细（含不足阈值，供观察趋势）
    misses: [...byTerm.values()].map((c) => ({ term: c.term, misses: c.misses, samples: c.samples })),
    // 达到阈值 → 意图→记忆弱路由建议
    candidates: candidates.filter((c) => c.misses >= MIN_ROUNDS_FOR_ROUTE).map((c) => ({
      term: c.term,
      misses: c.misses,
      route: `意图含「${c.term}」→ 先 /api/mind/search?q=${encodeURIComponent(c.term)} 或 grep L3 再作答`,
      samples: c.samples,
    })),
  }, null, 2));
  process.exit(0);
}

console.log(`[mind-audit] 扫描会话 ${files.length} 个，主题词 ${termList.length} 个`);
for (const n of sessionNotes.slice(0, 20)) console.log('  ' + n);
console.log(`[mind-audit] 命中主题的用户回合 ${rounds.length} 次；漏查主题 ${byTerm.size} 个（晋升阈值 ${MIN_ROUNDS_FOR_ROUTE} 次）`);
if (!byTerm.size) {
  console.log('[mind-audit] 无漏查主题（全部命中回合都做过检索，或尚无会话数据）');
  process.exit(0);
}
console.log('[mind-audit] 漏查明细（含不足阈值，趋势观察）：');
for (const c of [...byTerm.values()].sort((a, b) => b.misses - a.misses)) {
  console.log(`  ▪ ${c.term}  ×${c.misses}${c.misses >= MIN_ROUNDS_FOR_ROUTE ? '  ← 达到阈值' : ''}`);
  if (c.misses >= MIN_ROUNDS_FOR_ROUTE) console.log(`    建议：意图含「${c.term}」→ 先 /api/mind/search?q=${encodeURIComponent(c.term)} 或 grep L3 再作答`);
  for (const s of c.samples.slice(0, 2)) console.log(`    - [${s.session}] ${s.text}`);
}
if (!candidates.length) console.log(`[mind-audit] 暂无 ≥${MIN_ROUNDS_FOR_ROUTE} 次的漏查主题（数据积累中，用数据长不拍脑袋）`);
