// dshome-mind — 心智可视化面板（host 侧）。
// /api/mind/*：读 mind\（出厂）+ mind-private\（隐私）双区，返回状态/树/内容。
// 照 dshome/plugin-api 模式：loopback trust fence + webServer.register 子插件。
// 仅 web profile（webServer 存在）时经子插件激活；headless 自动跳过。

'use strict';
const fs = require('fs');
const path = require('path');
const { DshCron, setCronInstance, getCronInstance } = require('./cron.cjs');

const API_PREFIX = '/api/mind';
const MAX_DEPTH = 5;

// ── 心智基座路径 ────────────────────────────────────────────────────────────
function repoRoot() {
  // dev：packages/dshome-mind/lib → 仓库根；env DSH_HOME 优先（dsh-evolve 同款）。
  if (process.env.DSH_HOME && fs.existsSync(path.join(process.env.DSH_HOME, 'mind'))) {
    return process.env.DSH_HOME;
  }
  return path.resolve(__dirname, '../../..');
}
const mindFactoryDir = () => path.join(repoRoot(), 'mind');
const mindPrivateDir = () => path.join(repoRoot(), 'mind-private');

// ── loopback trust fence（移植自 dshome/plugin-api.js）──────────────────────
function isIPv4Loopback(v4) {
  const parts = String(v4).split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const n = String(address).toLowerCase();
  if (n === '::1') return true;
  if (n.startsWith('::ffff:')) return isIPv4Loopback(n.slice(7));
  return isIPv4Loopback(n);
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}
function isTrustedLocalRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try { hostUrl = new URL('http://' + host); } catch { return false; }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (origin === undefined) return site === 'same-origin' || site === 'none';
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ── 双区扫描 ────────────────────────────────────────────────────────────────
function scanDir(dir, rel, depth) {
  const node = { name: rel || '/', dirs: [], files: [] };
  if (depth > MAX_DEPTH || !fs.existsSync(dir)) return node;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return node; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 跳过隐藏/.git 等
    const full = path.join(dir, entry.name);
    const relName = rel ? `${rel}/${entry.name}` : entry.name;
    try {
      if (entry.isDirectory()) node.dirs.push(scanDir(full, relName, depth + 1));
      else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
        node.files.push({ name: entry.name, path: relName, size: fs.statSync(full).size });
      }
    } catch { /* 权限/占用跳过 */ }
  }
  return node;
}

/** 路径穿越防护：rel 必须在 zone 根内。 */
function resolveInZone(zone, rel) {
  const root = zone === 'private' ? mindPrivateDir() : mindFactoryDir();
  const abs = path.resolve(root, String(rel || '').replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

// ── 图谱数据：节点（内容文件）+ 边（frontmatter related）────────────────────
const LAYER_MAP = [
  [/^L0\//, { id: 'L0', label: 'L0 宪法', color: '#8b5cf6' }],
  [/^L1\//, { id: 'L1', label: 'L1 法律', color: '#4D6BFE' }],
  [/^L2\/Skill\//, { id: 'L2S', label: 'L2 技能', color: '#10b981' }],
  [/^L2\/Exp\//, { id: 'L2E', label: 'L2 经验', color: '#14b8a6' }],
  [/^L3\/history\//, { id: 'L3H', label: 'L3 历史', color: '#f59e0b' }],
  [/^L3\//, { id: 'L3I', label: 'L3 记忆', color: '#f97316' }],
  [/^Project\//, { id: 'PJ', label: 'Project', color: '#ef4444' }],
  [/^TRASH\//, { id: 'TR', label: 'TRASH', color: '#64748b' }],
  [/^tasks\//, { id: 'TK', label: '任务缓冲', color: '#ec4899' }],
];
function layerOf(rel) {
  for (const [re, lay] of LAYER_MAP) if (re.test(rel)) return lay;
  return { id: 'OT', label: rel.split('/')[0] || '?', color: '#64748b' };
}
function walkContentMd(dir, zone, rel, out) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const relName = rel ? `${rel}/${e.name}` : e.name;
    try {
      if (e.isDirectory()) walkContentMd(full, zone, relName, out);
      else if (e.isFile() && e.name.endsWith('.md')
        && e.name !== 'README.md' && e.name !== '_index.md' && e.name !== '.gitkeep') {
        out.push({ zone, rel: relName, full });
      }
    } catch { /* ignore */ }
  }
}
function fmName(content) {
  const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
  if (!m) return '';
  const n = /(?:^|\n)\s*name:\s*([^\n]+)/.exec(m[1]);
  return n ? n[1].trim().replace(/^['"]|['"]$/g, '') : '';
}
function firstTitle(content) {
  const body = String(content || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const t = /^#+\s+(.+?)\s*$/m.exec(body);
  return t ? t[1].trim().replace(/[#*`]/g, '') : '';
}
function relatedList(content) {
  const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
  if (!m) return [];
  const r = /(?:^|\n)\s*related:\s*\[([^\]]*)\]/.exec(m[1]);
  if (!r) return [];
  return r[1].split(',').map((s) => {
    const tail = String(s).trim().replace(/^['"]|['"]$/g, '').split(/[\/\\]/).pop() || '';
    return tail.replace(/\.md$/i, '').toLowerCase();
  }).filter(Boolean);
}
function buildGraph() {
  const files = [];
  walkContentMd(mindFactoryDir(), 'factory', '', files);
  walkContentMd(mindPrivateDir(), 'private', '', files);
  const nodes = [];
  const byLabel = new Map();
  const readText = (full) => { try { return fs.readFileSync(full, 'utf8'); } catch { return ''; } };
  for (const f of files) {
    const content = readText(f.full);
    const seg = f.rel.split('/');
    let label = fmName(content);
    if (!label && seg[0] === 'L3' && seg[1] === 'index' && seg[2]) label = seg[2]; // 记忆主题短名（dshome-build…）
    if (!label) label = firstTitle(content);
    if (!label) label = path.basename(f.rel).replace(/\.md$/, '');
    const lay = layerOf(f.rel);
    nodes.push({
      id: `${f.zone}:${f.rel}`,
      label,
      layer: lay.id,
      layerLabel: lay.label,
      color: lay.color,
      zone: f.zone,
      path: f.rel,
      rel: f.rel,
    });
    byLabel.set(label.toLowerCase(), nodes[nodes.length - 1]);
    byLabel.set(path.basename(f.rel).replace(/\.md$/, '').toLowerCase(), nodes[nodes.length - 1]);
  }
  const edges = [];
  const seen = new Set();
  for (const f of files) {
    const srcId = `${f.zone}:${f.rel}`;
    for (const r of relatedList(readText(f.full))) {
      const tgt = byLabel.get(r);
      if (!tgt || tgt.id === srcId) continue;
      const key = [srcId, tgt.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: srcId, target: tgt.id, type: 'related' });
    }
  }
  return { ok: true, nodes, edges };
}

// ── 治理：待放行（pending）与整理候选（curate）──────────────────────────────
const pendingDir = () => path.join(mindPrivateDir(), 'tasks', 'pending');
const trashDir = () => path.join(mindPrivateDir(), 'TRASH');
const historyDir = () => path.join(mindPrivateDir(), 'L3', 'history');

function fmValue(content, key) {
  const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
  if (!m) return '';
  const r = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n]+)').exec(m[1]);
  return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : '';
}
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 目标文件名：原名已带 YYYY-MM-DD_ 前缀则不再重复加；否则补日期前缀。 */
function stampedName(original, suffix) {
  const base = path.basename(String(original || '')).replace(/\.md$/, '');
  const prefix = /^\d{4}-\d{2}-\d{2}_/.test(base) ? '' : todayStamp() + '_';
  return prefix + base + (suffix || '') + '.md';
}

/** 待放行列表：扫描 tasks/pending/*.md。 */
function listPending() {
  const dir = pendingDir();
  const items = [];
  if (!fs.existsSync(dir)) return items;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    items.push({
      file: f,
      kind: fmValue(content, 'kind') || 'note',
      importance: fmValue(content, 'importance') || '2',
      scope: fmValue(content, 'scope') || 'project',
      topic: fmValue(content, 'topic') || '',
      proposedBy: fmValue(content, 'proposedBy') || '',
      proposedAt: fmValue(content, 'proposedAt') || '',
      content: body.slice(0, 600),
    });
  }
  items.sort((a, b) => String(b.file).localeCompare(String(a.file)));
  return items;
}

/** 放行：pending/<file> → L3/index/<topic>/<日期>_<file>。 */
function approvePending(file) {
  const safe = path.basename(String(file || ''));
  const src = path.join(pendingDir(), safe);
  if (!/\.md$/.test(safe) || !fs.existsSync(src)) return { ok: false, error: 'not-found' };
  const content = fs.readFileSync(src, 'utf8');
  const topic = fmValue(content, 'topic') || 'general';
  const targetDir = path.join(mindPrivateDir(), 'L3', 'index', topic);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, stampedName(safe));
  fs.renameSync(src, target);
  return { ok: true, movedTo: `L3/index/${topic}/${path.basename(target)}` };
}

/** 拒绝：pending/<file> → mind-private/TRASH/。 */
function rejectPending(file) {
  const safe = path.basename(String(file || ''));
  const src = path.join(pendingDir(), safe);
  if (!/\.md$/.test(safe) || !fs.existsSync(src)) return { ok: false, error: 'not-found' };
  fs.mkdirSync(trashDir(), { recursive: true });
  const target = path.join(trashDir(), stampedName(safe));
  fs.renameSync(src, target);
  return { ok: true, movedTo: `TRASH/${path.basename(target)}` };
}

/** 整理候选扫描（L3/index 全部内容文件）。 */
const CURATE_OVERSIZED = 20 * 1024;   // >20KB：建议蒸馏/拆分
const CURATE_THIN = 400;              // <400B：合集文件过薄提示（单记忆文件除外）
const curateKeptFile = () => path.join(mindPrivateDir(), '.curate-kept.json');
function readKept() {
  try { return JSON.parse(fs.readFileSync(curateKeptFile(), 'utf8')).files || []; }
  catch { return []; }
}
function keepCurate(relPath) {
  const safe = String(relPath || '').replace(/^\/+/, '');
  const src = path.join(mindPrivateDir(), 'L3', 'index', safe);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return { ok: false, error: 'not-found' };
  const kept = readKept();
  if (!kept.includes(safe)) kept.push(safe);
  fs.mkdirSync(mindPrivateDir(), { recursive: true });
  fs.writeFileSync(curateKeptFile(), JSON.stringify({ files: kept }, null, 2));
  return { ok: true, kept: kept.length };
}
/** 作业队列：用户点「让鱼鱼处理」的候选，鱼鱼收工时检查执行。 */
const curateJobsFile = () => path.join(mindPrivateDir(), '.curate-jobs.json');
function readJobs() {
  try { return JSON.parse(fs.readFileSync(curateJobsFile(), 'utf8')).jobs || []; }
  catch { return []; }
}
function assignCurate(relPath) {
  const safe = String(relPath || '').replace(/^\/+/, '');
  const src = path.join(mindPrivateDir(), 'L3', 'index', safe);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return { ok: false, error: 'not-found' };
  const jobs = readJobs();
  if (!jobs.some((j) => j.file === safe)) jobs.push({ file: safe, at: new Date().toISOString(), status: 'assigned' });
  fs.mkdirSync(mindPrivateDir(), { recursive: true });
  fs.writeFileSync(curateJobsFile(), JSON.stringify({ jobs }, null, 2));
  return { ok: true, jobs: jobs.length };
}
function listCurate() {
  const files = [];
  walkContentMd(path.join(mindPrivateDir(), 'L3', 'index'), 'L3/index', '', files);
  const kept = new Set(readKept());
  const jobs = new Map(readJobs().map((j) => [j.file, j]));
  const items = [];
  const tagSeen = new Map();
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    const size = Buffer.byteLength(content, 'utf8');
    const name = path.basename(f.rel).replace(/\.md$/, '');
    const rel = f.rel.replace(/^L3\/index\//, '');
    const reasons = [];
    // 单记忆文件（YYYY-MM-DD_ 前缀，pending 放行产物）短是正常的，不判 thin
    const isSingle = /^\d{4}-\d{2}-\d{2}_/.test(name);
    if (size > CURATE_OVERSIZED) reasons.push({ type: 'oversized', hint: `${(size / 1024).toFixed(0)}KB 超长，建议蒸馏成速查或拆分` });
    if (size < CURATE_THIN && !isSingle) reasons.push({ type: 'thin', hint: '合集内容过薄，建议并入同主题或归档' });
    // 同 tags 疑似重复（同 kind + 完全相同 tags）
    const kind = fmValue(content, 'kind');
    const tagsRaw = /(?:^|\n)\s*tags:\s*\[([^\]]*)\]/.exec(/^---\n([\s\S]*?)\n---/.exec(content)?.[1] || '');
    const tags = tagsRaw ? tagsRaw[1].split(',').map((s) => s.trim().replace(/['"\[\]]/g, '')).filter(Boolean).sort().join(',') : '';
    if (tags && kind) {
      const key = `${kind}|${tags}`;
      if (tagSeen.has(key)) {
        const prev = tagSeen.get(key);
        reasons.push({ type: 'dup-tags', hint: `与 ${prev} 同 kind+tags，疑似重复，建议合并` });
      } else tagSeen.set(key, name);
    }
    if (reasons.length && !kept.has(f.rel)) items.push({ file: f.rel, zone: 'private', name, rel, size, reasons, assigned: jobs.has(f.rel) });
  }
  return items;
}

/** 归档整理候选：L3/index/<path> → L3/history/<日期>_<名>_归档.md。 */
function archiveCurate(relPath) {
  const safe = String(relPath || '').replace(/^\/+/, '');
  const src = path.join(mindPrivateDir(), 'L3', 'index', safe);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return { ok: false, error: 'not-found' };
  fs.mkdirSync(historyDir(), { recursive: true });
  const base = path.basename(safe).replace(/\.md$/, '');
  const target = path.join(historyDir(), stampedName(base, '_归档'));
  fs.renameSync(src, target);
  return { ok: true, movedTo: `L3/history/${path.basename(target)}` };
}

// ── 近重复检测（bigram-Jaccard，照 dsh-evolve search 思路，防"同事实存两份"）──
function tokenize(text) {
  const s = String(text).toLowerCase();
  const tokens = new Set();
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1]);
  (s.match(/[a-z0-9][a-z0-9_\-./]+/g) || []).forEach((w) => tokens.add(w));
  return tokens;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
/** 扫 topic 目录（+ user-rules 兜底），目标文件按 ## 条目切块逐块比对（防长文件稀释）。 */
function dupCheck(topic, content) {
  const hits = [];
  const dirs = [];
  if (topic) dirs.push(path.join(mindPrivateDir(), 'L3', 'index', topic));
  const ur = path.join(mindPrivateDir(), 'L3', 'index', 'user-rules');
  if (topic !== 'user-rules' && fs.existsSync(ur)) dirs.push(ur);
  const q = tokenize(content);
  for (const dir of dirs) {
    const files = [];
    walkContentMd(dir, '', '', files);
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
      const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
      // 按 ## 条目切块（主题文件是条目合集）；无 ## 则整文件为一块
      const sections = body.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
      let best = null;
      for (const sec of sections) {
        const score = jaccard(q, tokenize(sec));
        if (!best || score > best.score) best = { score, sec };
      }
      if (best && best.score >= 0.12) {
        const title = (best.sec.split('\n')[0] || '').replace(/^#+/, '').trim();
        hits.push({
          file: f.rel || path.basename(f.full),
          score: Math.round(best.score * 100),
          section: title.slice(0, 60),
          snippet: best.sec.replace(/\s+/g, ' ').slice(0, 140),
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 5);
}

/** 记忆模糊检索：扫 mind-private/L3/index 全库，bigram 相似度召回 top-N（附 snippet）。 */
function searchMind(query, limit = 6) {
  const files = [];
  walkContentMd(path.join(mindPrivateDir(), 'L3', 'index'), 'L3/index', '', files);
  const q = tokenize(query);
  const hits = [];
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    const rel = f.rel.replace(/^L3\/index\//, '');
    const sections = content.replace(/^---\n[\s\S]*?\n---\n?/, '').split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
    let best = null;
    for (const sec of sections) {
      const sc = jaccard(q, tokenize(sec));
      if (!best || sc > best.score) best = { score: sc, sec };
    }
    if (best && best.score >= 0.03) {
      hits.push({
        score: Math.round(best.score * 100),
        file: rel,
        section: ((best.sec.split('\n')[0] || '').replace(/^#+/, '')).slice(0, 60),
        snippet: best.sec.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// ── 待办（project.md「下一步」区 `- [ ]` 行）───────────────────────────────
function todoFile() { return path.join(mindPrivateDir(), 'Project', 'DSHOME', 'project.md'); }
function readTodos() {
  const f = todoFile(); if (!fs.existsSync(f)) return [];
  const todos = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*-\s*\[( |x)\]\s*(.*)$/.exec(line);
    if (m) todos.push({ text: m[2], done: m[1] === 'x' });
  }
  return todos;
}
function mutateTodos(op, arg) {
  const f = todoFile(); const body = fs.readFileSync(f, 'utf8');
  const lines = body.split('\n');
  const idxs = [];
  lines.forEach((line, i) => { if (/^\s*-\s*\[( |x)\]/.test(line)) idxs.push(i); });
  let changed = false;
  if (op === 'add') {
    let tail = lines.length - 1;
    let inTodo = false;
    lines.forEach((line, i) => { if (!inTodo && line.startsWith('## 下一步')) inTodo = true; else if (inTodo && line.startsWith('## ')) { tail = i - 1; inTodo = false; } });
    if (idxs.length && idxs[idxs.length - 1] > tail - 3) tail = idxs[idxs.length - 1];
    lines.splice(tail + 1, 0, '- [ ] ' + arg);
    changed = true;
  } else if (op === 'toggle' || op === 'remove') {
    const i = idxs[Number(arg)];
    if (i === undefined) return { ok: false, error: 'bad index' };
    if (op === 'toggle') { lines[i] = lines[i].replace(/\[( |x)\]/, function (m, s) { return (s === ' ' ? '[x]' : '[ ]'); }); changed = true; }
    else { lines.splice(i, 1); changed = true; }
  }
  if (changed) fs.writeFileSync(f, lines.join('\n'));
  return { ok: true, todos: readTodos() };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new Error('body-too-large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad-json')); } });
    req.on('error', reject);
  });
}

// ── 路由 ────────────────────────────────────────────────────────────────────
function makeMindRoutes() {
  const guard = (req, res) => {
    if (isTrustedLocalRequest(req)) return true;
    json(res, 403, { ok: false, error: 'forbidden' });
    return false;
  };
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          json(res, 200, {
            ok: true,
            factory: scanDir(mindFactoryDir(), '', 0),
            private: scanDir(mindPrivateDir(), '', 0),
          });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/read`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const url = new URL(req.url, 'http://localhost');
          const zone = url.searchParams.get('zone') === 'private' ? 'private' : 'factory';
          const rel = url.searchParams.get('rel') || '';
          const abs = resolveInZone(zone, rel);
          if (!abs) return json(res, 404, { ok: false, error: 'not-found' });
          const content = fs.readFileSync(abs, 'utf8');
          json(res, 200, { ok: true, zone, rel, content });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/graph`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          json(res, 200, buildGraph());
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/pending`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try { json(res, 200, { ok: true, items: listPending() }); }
        catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/pending/approve`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const out = approvePending(body?.file);
          json(res, out.ok ? 200 : 404, out);
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/pending/reject`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const out = rejectPending(body?.file);
          json(res, out.ok ? 200 : 404, out);
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/curate`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try { json(res, 200, { ok: true, items: listCurate() }); }
        catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/curate/archive`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const out = archiveCurate(body?.file);
          json(res, out.ok ? 200 : 404, out);
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/curate/keep`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const out = keepCurate(body?.file);
          json(res, out.ok ? 200 : 404, out);
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/curate/assign`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const out = assignCurate(body?.file);
          json(res, out.ok ? 200 : 404, out);
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/search`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const q = (new URL(req.url, 'http://localhost').searchParams.get('q') || '').trim();
          if (!q) return json(res, 400, { ok: false, error: 'q required' });
          json(res, 200, { ok: true, hits: searchMind(q) });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/cron`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const cron = getCronInstance();
          json(res, 200, { ok: true, tasks: cron ? cron.list() : [] });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/cron/add`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const b = await readJsonBody(req);
          const cron = getCronInstance();
          if (!cron) return json(res, 503, { ok: false, error: 'cron unavailable' });
          const out = cron.add({ id: b?.id, cron: b?.cron, prompt: b?.prompt, cwd: b?.cwd, once: !!b?.once, catchUp: !!b?.catchUp, timezone: b?.timezone });
          json(res, out.ok ? 200 : 400, out);
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/cron/remove`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const b = await readJsonBody(req);
          const cron = getCronInstance();
          if (!cron) return json(res, 503, { ok: false, error: 'cron unavailable' });
          json(res, 200, cron.remove(b?.id));
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/cron/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const b = await readJsonBody(req);
          const cron = getCronInstance();
          if (!cron) return json(res, 503, { ok: false, error: 'cron unavailable' });
          json(res, 200, cron.toggle(b?.id));
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/todos`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try { json(res, 200, { ok: true, todos: readTodos() }); }
        catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/todos/add`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const b = await readJsonBody(req);
          if (!b?.text) return json(res, 400, { ok: false, error: 'text required' });
          json(res, 200, mutateTodos('add', b.text.trim()));
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/todos/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const b = await readJsonBody(req);
          json(res, 200, mutateTodos('toggle', b?.index));
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/todos/remove`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const b = await readJsonBody(req);
          json(res, 200, mutateTodos('remove', b?.index));
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/dup-check`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
          const content = typeof body?.content === 'string' ? body.content : '';
          if (!content) return json(res, 400, { ok: false, error: 'content required' });
          json(res, 200, { ok: true, hits: dupCheck(topic, content) });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
  ];
}

// ── 经 inject webServer 的子插件激活（仅 web profile）───────────────────────
module.exports = {
  name: 'dshome-mind',
  apply(ctx) {
    const routesPlugin = {
      name: 'dshome-mind-api',
      inject: ['webServer'],
      apply(wctx) {
        const disposers = [];
        try {
          for (const route of makeMindRoutes()) disposers.push(wctx.webServer.register(route));
          wctx.logger?.('dshome').info(`dshome-mind api ready: ${API_PREFIX}/status`);
        } catch (e) {
          for (const d of disposers) { try { d(); } catch { /* ignore */ } }
          wctx.logger?.('dshome').warn(`dshome-mind route registration failed: ${e?.message ?? e}`);
        }
        wctx.effect?.(() => () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } });
      },
    };
    try { ctx.plugin?.(routesPlugin); } catch (e) { ctx.logger?.('dshome').warn(`dshome-mind disabled: ${e?.message ?? e}`); }

    // ── cron 自治：定时拉起 agent 会话执行任务（照 dsh-scheduler 蓝图）─────
    try {
      ctx.inject(['webServer'], (hostCtx) => {
        let cron;
        try {
          cron = new DshCron(hostCtx);
          setCronInstance(cron); // 供 /api/mind/cron 路由实时管理
          cron.start();
          hostCtx.logger?.('dshome')?.info?.('dshome-mind cron ready');
        } catch (e) {
          hostCtx.logger?.('dshome')?.warn?.(`dshome-mind cron init failed: ${e?.message ?? e}`);
          cron?.clear?.();
          return () => {};
        }
        return () => cron.clear();
      });
    } catch (e) { ctx.logger?.('dshome').warn(`dshome-mind cron disabled: ${e?.message ?? e}`); }
  },
};
