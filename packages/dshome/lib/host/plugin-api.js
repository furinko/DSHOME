// dshome/plugin-api — 插件管理控制面（/api/dshome/plugins）。
// 照 dsh-evolve web-routes 模式：loopback trust fence + webServer.register。
// 仅 web profile（webServer 存在）时经子插件激活；headless 自动跳过。
// 数据/启停复用 ./plugin-store.js（与设置页总线同一份真相）。

import { snapshot, writeToggle } from './plugin-store.js';

export const PLUGIN_API_PREFIX = '/api/dshome/plugins';
const BODY_LIMIT = 64 * 1024;

// ── loopback trust fence（移植自 dsh-evolve web-routes.js）──────────────────
function isIPv4Loopback(v4) {
  const parts = v4.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const n = address.toLowerCase();
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
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 构建 /api/dshome/plugins 路由：GET 列表、POST /toggle 启停。 */
export function makePluginRoutes(ctx) {
  const guard = (req, res) => {
    if (isTrustedLocalRequest(req)) return true;
    json(res, 403, { ok: false, error: 'forbidden' });
    return false;
  };
  return [
    {
      kind: 'exact',
      path: PLUGIN_API_PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try { json(res, 200, { ok: true, plugins: snapshot(ctx) }); }
        catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
    {
      kind: 'exact',
      path: `${PLUGIN_API_PREFIX}/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!guard(req, res)) return;
        try {
          const body = await readJson(req);
          if (typeof body?.id !== 'string' || typeof body?.enabled !== 'boolean') {
            return json(res, 400, { ok: false, error: 'body must be { id, enabled }' });
          }
          const target = snapshot(ctx).find((e) => e.entryId === body.id || e.moduleName === body.id);
          // 受保护语义：仅禁止停用【运行中】的核心插件；已停用的核心（如 dshome-desktop）
          // 允许启用（保护防"停用"，不防"启用"）。
          if (target?.protected && target?.enabled) {
            return json(res, 403, { ok: false, protected: true, message: '核心插件运行中，不可停用' });
          }
          const out = await writeToggle(body.id, body.enabled);
          json(res, 200, { ok: out.ok, message: out.message, restartNeeded: !!out.ok });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    },
  ];
}

/** 经 inject webServer 的子插件激活（仅 web profile；headless 自动跳过）。 */
export function setupPluginApi(ctx) {
  // 注意：cordis 子插件的 ctx 服务受限（仅 inject 声明的服务）。
  // loader 属于主 ctx —— 数据函数用主 ctx，子插件只负责 webServer.register。
  const hostCtx = ctx;
  const routesPlugin = {
    name: 'dshome-plugin-api',
    inject: ['webServer'],
    apply(wctx) {
      const disposers = [];
      try {
        for (const route of makePluginRoutes(hostCtx)) disposers.push(wctx.webServer.register(route));
        wctx.logger?.('dshome').info(`dshome plugin-api ready: ${PLUGIN_API_PREFIX}`);
      } catch (e) {
        for (const d of disposers) { try { d(); } catch { /* ignore */ } }
        wctx.logger?.('dshome').warn(`dshome plugin-api route registration failed: ${e?.message ?? e}`);
      }
      wctx.effect?.(() => () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } });
    },
  };
  try { ctx.plugin?.(routesPlugin); } catch (e) { ctx.logger?.('dshome').warn(`dshome plugin-api disabled: ${e?.message ?? e}`); }
}
