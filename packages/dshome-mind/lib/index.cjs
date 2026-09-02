// dshome-mind — 心智可视化面板（host 侧）。
// /api/mind/*：读 mind\（出厂）+ mind-private\（隐私）双区，返回状态/树/内容。
// 照 dshome/plugin-api 模式：loopback trust fence + webServer.register 子插件。
// 仅 web profile（webServer 存在）时经子插件激活；headless 自动跳过。

'use strict';
const fs = require('fs');
const path = require('path');

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
  },
};
