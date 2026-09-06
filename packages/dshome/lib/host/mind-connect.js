// dshome-mind-connect — 「接入心智」每会话开关 host 插件（v1.0）。
//
// 职责（单一）：
//   1) 持有「每个会话是否接入心智」的开关（默认接入=true）；
//   2) 向 mind-inject / mind-recall 提供读取接口 isMindConnected(sessionId)，
//      由它们决定是否注入 R0 宪法 / 上工召回；
//   3) 暴露 /api/mind/connect（GET 读当前态 / POST 写）供浏览器「接入心智」开关读写。
//
// 设计取舍：
//   - per-session：按 agent session id 独立记忆（用户明确要每会话独立，见 2026-09-06 决策）。
//   - 非侵入：不动 mind-inject/recall 的注入逻辑，只在其决策点前加一行守卫。
//   - fails-open：开关文件/读写失败 → 视为「接入」（默认态），绝不阻断会话。
//   - 持久化：只存「明确关闭」的会话（{ "<sessionId>": false }），默认真由「不存在=接入」表达，
//     重启后仍保持（会话续聊不会因重启意外重注入心智）。
//
// 与 mind-inject/recall 的关系：
//   inject 管 R0 宪法注入、recall 管上工召回，本插件只管「要不要」。三件解耦、可独立启停。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/mind-connect). */
export const name = 'dshome-mind-connect';

/** Services this row requires before activation（webServer 为条件注入，故不硬依赖）。 */
export const inject = [];

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

/** 开关持久化文件（只存「明确关闭」的会话，默认真）。 */
function stateFile() {
  return join(repoRoot(), 'profiles', 'dshome', '.dsh-market', 'mind-connect.json');
}

/** 内存态：sessionKey -> false（true = 默认，不入表）。 */
const store = new Map();

function sessionKeyOf(sessionId) {
  return sessionId ? `session:${sessionId}` : null;
}

/** 启动时加载持久化的「关闭」会话。 */
function loadStore() {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(raw)) {
        if (raw[k] === false) store.set(k, false);
      }
    }
  } catch { /* 无文件/坏文件 = 全默认接入 */ }
}

/** 把「关闭」集落盘（只写 false，默认真不写）。 */
function persist() {
  try {
    const obj = {};
    for (const [k, v] of store) if (v === false) obj[k] = false;
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* 落盘失败不影响运行态守护 */ }
}

/** 读：该会话是否接入心智（默认接入；未知/空/异常均视为接入）。 */
export function isMindConnected(sessionId) {
  if (!sessionId) return true;
  return store.get(sessionKeyOf(sessionId)) !== false;
}

/** 写：设置该会话是否接入心智。 */
export function setMindConnected(sessionId, enabled) {
  const key = sessionKeyOf(sessionId);
  if (!key) return { ok: false, error: 'bad-session' };
  if (enabled) store.delete(key);
  else store.set(key, false);
  persist();
  return { ok: true, enabled: !!enabled };
}

/** 读接口别名（API 用）。 */
export function getMindConnected(sessionId) {
  return isMindConnected(sessionId);
}

// ── loopback trust fence（同源 API 防外部调用，移植自 dshome-mind index.cjs）──
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad-json')); } });
    req.on('error', reject);
  });
}

/** 宿主插件主体：加载 + 注册 /api/mind/connect。 */
export function apply(ctx) {
  loadStore();
  try {
    ctx.inject(['webServer'], (wctx) => {
      const disposers = [];
      const guard = (req, res) => {
        if (isTrustedLocalRequest(req)) return true;
        json(res, 403, { ok: false, error: 'forbidden' });
        return false;
      };
      const route = {
        kind: 'exact',
        path: '/api/mind/connect',
        handler: async (req, res) => {
          if (!guard(req, res)) return;
          const url = new URL(req.url, 'http://localhost');
          const session = (url.searchParams.get('session') || '').trim();
          if (req.method === 'GET') {
            return json(res, 200, { ok: true, session, enabled: isMindConnected(session) });
          }
          if (req.method === 'POST') {
            let body = {};
            try { body = await readJsonBody(req); } catch { body = {}; }
            const sid = typeof body?.session === 'string' ? body.session.trim() : session;
            const out = setMindConnected(sid, body?.enabled === true);
            return json(res, out.ok ? 200 : 400, out);
          }
          return json(res, 405, { ok: false, error: 'method-not-allowed' });
        },
      };
      try {
        disposers.push(wctx.webServer.register(route));
        wctx.logger?.('dshome').info('dshome-mind-connect: /api/mind/connect ready');
      } catch (e) {
        wctx.logger?.('dshome').warn(`dshome-mind-connect route failed: ${e?.message ?? e}`);
      }
      return () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
    });
  } catch (e) {
    ctx.logger?.('dshome').warn('dshome-mind-connect disabled: %O', e);
  }
  ctx.logger?.('dshome').info('dshome-mind-connect ready: per-session mind toggle');
}
