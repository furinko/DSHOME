// dshome-quick-phrases — node half：快捷短语的读写端点（list / save / delete）。
//
// 数据落点：<repoRoot>/mind-private/plugin-data/quick-phrases.json
//   · 主人选定「本机私密区」：.gitignore:42 的 `mind-private/` 已忽略该目录，永不推送。
//   · 形状 `{ version: 1, phrases: [{ id, name, text, createdAt, updatedAt }] }`，id = crypto.randomUUID()。
//
// 契约（照抄本仓库既有实现，非推测）：
//   · repoRoot 解析 → packages/dshome-mind/lib/index.cjs:22-28
//     （env DSH_HOME 存在且其下有 mind/ 目录时用它，否则 path.resolve(__dirname, '../../..')）。
//   · loopback trust fence → packages/dshome-mind/lib/index.cjs:32-61（isLoopbackAddress /
//     isLoopbackHostname / isTrustedLocalRequest 判据）与 :694-698（拒绝方式 403 {ok:false,error:'forbidden'}）。
//   · 子插件注册范式 → packages/dshome-input/lib/index.cjs:197-222。
//     ⚠️ 同文件 9-14 行的坑：**不要把 webServer 放进导出级 inject 数组**——那样整个 profile
//     装配会挂起（后端 30s 零监听、界面永远起不来）。依赖只由子插件声明。
//   · 端点路径字面量与 client 半 lib/client.js 顶部的三个常量**逐字一致**（两侧注释互相指明）。
//
// 读写纪律（每条都是显式选择，不是兜底）：
//   · 文件不存在 → 视为空列表，绝不因「还没建过文件」而抛错；目录不存在 → mkdirSync recursive。
//   · 写入 = 写同目录临时文件 + renameSync 覆盖（原子替换，读者永远看到完整文件）。
//   · 文件存在但读不懂（坏 JSON / 权限 / 非对象）→ **显式 500 拒绝，绝不静默当空列表**：
//     否则下一次保存就把主人原有的短语覆盖没了。
//   · delete 幂等：删一个已经不存在的 id 也返回 200 + 全量列表（面板二次确认后的重试不报假错）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 同源端点（本包 client 半 lib/client.js 顶部三个常量必须与这三行逐字一致）。 */
const LIST_PATH = '/dshome-quick-phrases/list';
const SAVE_PATH = '/dshome-quick-phrases/save';
const DELETE_PATH = '/dshome-quick-phrases/delete';

/** 数据文件（相对 repoRoot）：本机私密区，随 mind-private/ 一起被忽略。 */
const DATA_RELATIVE = path.join('mind-private', 'plugin-data', 'quick-phrases.json');

/** 防御性上限：只为挡住畸形/超大请求，不改设计。 */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PHRASES = 500;
const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 20000;

class QuickPhrasesError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => new QuickPhrasesError(status, code, message);

// ── 数据落点 ────────────────────────────────────────────────────────────────
// 照抄 packages/dshome-mind/lib/index.cjs:22-28：dev 时 __dirname 上溯三级＝仓库根；
// 安装态（包被实体化到 profiles/<name>/node_modules/ 下）由 env DSH_HOME 指路。
function repoRoot() {
  if (process.env.DSH_HOME && fs.existsSync(path.join(process.env.DSH_HOME, 'mind'))) {
    return process.env.DSH_HOME;
  }
  return path.resolve(__dirname, '../../..');
}

const dataFile = () => path.join(repoRoot(), DATA_RELATIVE);

const emptyStore = () => ({ version: 1, phrases: [] });

const textOf = (value) => (typeof value === 'string' ? value : '');

/** 单条短语的规范化读入：字段不全的记录直接丢弃（一条坏行不扩散成坏列表）。 */
function normalizePhrase(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const id = textOf(raw.id);
  const name = textOf(raw.name);
  const text = textOf(raw.text);
  if (id.length === 0 || name.length === 0 || text.length === 0) return null;
  return { id, name, text, createdAt: textOf(raw.createdAt), updatedAt: textOf(raw.updatedAt) };
}

/** 读全量短语。文件不存在＝空列表；文件坏掉＝显式报错（不覆盖数据）。 */
function readStore() {
  let raw;
  try {
    raw = fs.readFileSync(dataFile(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw fail(500, 'DATA_UNREADABLE', `短语文件读不出来：${String(error?.message ?? error)}`);
  }
  if (raw.trim().length === 0) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(500, 'DATA_CORRUPT', `短语文件不是合法 JSON（未做任何改动）：${dataFile()}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw fail(500, 'DATA_CORRUPT', `短语文件顶层不是对象（未做任何改动）：${dataFile()}`);
  }
  const phrases = [];
  for (const item of Array.isArray(parsed.phrases) ? parsed.phrases : []) {
    const phrase = normalizePhrase(item);
    if (phrase !== null) phrases.push(phrase);
  }
  return { version: 1, phrases };
}

/** 原子写：同目录临时文件 → renameSync 覆盖。写失败清理临时文件后显式报错。 */
function writeStore(store) {
  const file = dataFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    throw fail(500, 'DATA_UNWRITABLE', `短语目录建不出来：${String(error?.message ?? error)}`);
  }
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 清理失败不掩盖原错 */ }
    throw fail(500, 'DATA_UNWRITABLE', `短语写不进去：${String(error?.message ?? error)}`);
  }
  return store;
}

// ── 字段校验（不接受就显式 400，不猜测调用方意图）────────────────────────────
function bodyObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail(400, 'BAD_REQUEST', '请求体必须是对象');
  }
  return value;
}

function nameField(value) {
  if (typeof value !== 'string') throw fail(400, 'BAD_REQUEST', 'name 必须是字符串');
  const name = value.trim();
  if (name.length === 0) throw fail(400, 'BAD_REQUEST', 'name 不能为空');
  if (name.length > MAX_NAME_LENGTH) throw fail(400, 'BAD_REQUEST', `name 太长（上限 ${MAX_NAME_LENGTH} 字）`);
  return name;
}

function phraseTextField(value) {
  if (typeof value !== 'string') throw fail(400, 'BAD_REQUEST', 'text 必须是字符串');
  if (value.trim().length === 0) throw fail(400, 'BAD_REQUEST', 'text 不能为空');
  if (value.length > MAX_TEXT_LENGTH) throw fail(400, 'BAD_REQUEST', `text 太长（上限 ${MAX_TEXT_LENGTH} 字）`);
  return value;
}

function idField(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail(400, 'BAD_REQUEST', 'id 必须是非空字符串');
  }
  return value;
}

/**
 * 保存一条短语：无 id 或 id 不在库里＝新建，否则更新；两种情况都返回全量列表。
 *
 * 新建一律由 host 铸 id（`crypto.randomUUID()`）——客户端给的**未知** id 不采纳，
 * 免得客户端能自铸身份；已知 id 才算「更新这一条」。
 */
function savePhrase(body) {
  const request = bodyObject(body);
  const phrase = bodyObject(request.phrase);
  const name = nameField(phrase.name);
  const text = phraseTextField(phrase.text);
  const wantedId = typeof phrase.id === 'string' && phrase.id.length > 0 ? phrase.id : null;
  const store = readStore();
  const now = new Date().toISOString();
  const index = wantedId === null ? -1 : store.phrases.findIndex((item) => item.id === wantedId);
  if (index < 0) {
    if (store.phrases.length >= MAX_PHRASES) {
      throw fail(400, 'TOO_MANY', `短语数量已达上限 ${MAX_PHRASES} 条`);
    }
    store.phrases.push({ id: crypto.randomUUID(), name, text, createdAt: now, updatedAt: now });
  } else {
    // 展开保留未知字段：本插件不认识的附加字段不该在一次编辑里被抹掉。
    store.phrases[index] = { ...store.phrases[index], name, text, updatedAt: now };
  }
  writeStore(store);
  return { ok: true, phrases: store.phrases };
}

/** 删除一条短语（幂等）；返回全量列表。 */
function deletePhrase(body) {
  const request = bodyObject(body);
  const id = idField(request.id);
  const store = readStore();
  const next = store.phrases.filter((phrase) => phrase.id !== id);
  if (next.length !== store.phrases.length) writeStore({ ...store, phrases: next });
  return { ok: true, phrases: next };
}

// ── loopback trust fence（判据照抄 packages/dshome-mind/lib/index.cjs:32-61）──
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
  const host = request.headers?.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (origin === undefined) return site === 'same-origin' || site === 'none';
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────
function contentType(request) {
  const raw = request.headers?.['content-type'];
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

/** 读一个有界 JSON 请求体。 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    let bytes = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        reject(fail(413, 'BODY_TOO_LARGE', '请求体过大'));
        return;
      }
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    request.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(fail(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    request.on('error', (error) => {
      if (!failed) reject(fail(400, 'BAD_REQUEST', `请求体读取失败：${String(error?.message ?? error)}`));
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/** 只允许本机访问（拒绝方式照 packages/dshome-mind/lib/index.cjs:694-698）。 */
function guard(request, response) {
  if (isTrustedLocalRequest(request)) return true;
  json(response, 403, { ok: false, error: 'forbidden' });
  return false;
}

/** 失败回话：业务错误保留自己的状态码与错误码，未知错误 500 兜底。 */
function failResponse(response, error, fallback) {
  if (error instanceof QuickPhrasesError) {
    json(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  json(response, 500, { ok: false, error: { code: 'INTERNAL', message: fallback } });
}

function methodNotAllowed(response, allow) {
  response.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `只接受 ${allow}` } }));
}

/**
 * POST 端点的公共前段：方法 → **loopback 校验** → 媒体类型 → 有界 JSON 体。
 *
 * 顺序是刻意排的：先拒不可信来源，再读请求体——不替外部主机读它送来的字节。
 * @returns { ok: true, body } 或 { ok: false }（回话已发出，调用方直接返回）。
 *   刻意用信封而不是 null：合法 JSON 体本身就可能等于 null（`JSON.stringify(null)`）。
 */
async function beginPost(request, response) {
  if (request.method !== 'POST') {
    methodNotAllowed(response, 'POST');
    return { ok: false };
  }
  if (!guard(request, response)) return { ok: false };
  if (!contentType(request).toLowerCase().startsWith('application/json')) {
    json(response, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '需要 application/json' } });
    return { ok: false };
  }
  try {
    return { ok: true, body: await readJsonBody(request) };
  } catch (error) {
    failResponse(response, error, '请求体读取失败');
    return { ok: false };
  }
}

// ── 三个端点 ────────────────────────────────────────────────────────────────
async function handleList(request, response) {
  if (request.method !== 'GET') {
    methodNotAllowed(response, 'GET');
    return;
  }
  if (!guard(request, response)) return;
  try {
    json(response, 200, { ok: true, phrases: readStore().phrases });
  } catch (error) {
    failResponse(response, error, '读取短语失败');
  }
}

async function handleSave(request, response) {
  const attempt = await beginPost(request, response);
  if (!attempt.ok) return;
  try {
    json(response, 200, savePhrase(attempt.body));
  } catch (error) {
    failResponse(response, error, '保存短语失败');
  }
}

async function handleDelete(request, response) {
  const attempt = await beginPost(request, response);
  if (!attempt.ok) return;
  try {
    json(response, 200, deletePhrase(attempt.body));
  } catch (error) {
    failResponse(response, error, '删除短语失败');
  }
}

/** 三条同源路由（注册形状照 packages/dshome-input/lib/index.cjs:205-209）。 */
function makeQuickPhrasesRoutes() {
  return [
    { kind: 'exact', path: LIST_PATH, handler: (request, response) => void handleList(request, response) },
    { kind: 'exact', path: SAVE_PATH, handler: (request, response) => void handleSave(request, response) },
    { kind: 'exact', path: DELETE_PATH, handler: (request, response) => void handleDelete(request, response) },
  ];
}

/** 经子插件注册（依赖声明放子插件，见文件头 ⚠️）；fail-open：失败只告警，不阻断启动。 */
function apply(ctx) {
  const routesPlugin = {
    name: 'dshome-quick-phrases-api',
    inject: ['webServer'],
    apply(wctx) {
      const disposers = [];
      try {
        for (const route of makeQuickPhrasesRoutes()) disposers.push(wctx.webServer.register(route));
      } catch (error) {
        for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
        console.warn('dshome-quick-phrases: route registration failed', error);
      }
      wctx.effect?.(() => () => { for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } } });
    },
  };
  try {
    ctx.plugin?.(routesPlugin);
  } catch (error) {
    console.warn('dshome-quick-phrases: api sub-plugin failed', error);
  }
}

module.exports = { name: 'dshome-quick-phrases', apply };
