// dshome-input — node half：一条同源路由，给三档 dock 提供「调整待发顺序」能力。
//
// 为什么需要 host 半：官方 remote 面只有 cancel / prompt / updateQueue，而
// `QueueAction = { kind: 'edit' | 'remove' | 'steer' }` —— **没有重排通道**
// （核实：dsh-api-session-controller/lib/typert.host.js 的方法清单 + types/types.d.ts:135）。
// 重排只能落在宿主侧 inbox：`agent.inbox.nextTurn` 读、`agent.inbox.splice('next-turn', …)` 写。
// 机制与社区插件 dsh-queue-reorder 同源，全走官方公开 API（ctx.agents + ctx.webServer）。
//
// ⚠️ 踩过的坑（2026-09-23 实测，别回退这个写法）：**不要把 `webServer` 放进本插件的
// 导出级 inject**（`module.exports.inject = ['agents','webServer']`）——那样整个 profile
// 装配会挂起：后端 30s 零监听、stdout/stderr 全空、界面永远起不来。
// 本机可用写法（照 `packages/dshome-mind/lib/index.cjs:1150-1168`）＝主插件 apply 里
// `ctx.plugin({ name, inject: ['agents','webServer'], apply })` 挂一个**子插件**，
// 依赖由子插件自己声明。
//
// 安全约定（每条都是**显式拒绝**，不是静默兜底）：
//   ① 只搬普通用户 prompt（`source.kind === 'user'`）；steering（next-step）行一律不动；
//   ② 子代理会话的队列拒绝——它归父会话所有；
//   ③ 调用方必须带 `expectedOrder`，与实时队列不一致就拒：**队列在调用过程中变了就绝不打乱**。
'use strict';

/** 同源端点（由本插件的 client 半调用，两侧路径必须一致）。 */
const ROUTE_PATH = '/dshome-input/reorder';
/** 一次请求的体积与队列长度上限（防御性）。 */
const MAX_QUEUE_ITEMS = 200;
const MAX_BODY_BYTES = 32 * 1024;

class ReorderError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => new ReorderError(status, code, message);

function stringField(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw fail(400, 'BAD_REQUEST', `${field} 必须是非空字符串`);
  }
  return value;
}

function indexField(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fail(400, 'BAD_REQUEST', 'toIndex 必须是非负整数');
  }
  return value;
}

function orderField(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUEUE_ITEMS) {
    throw fail(400, 'BAD_REQUEST', 'expectedOrder 必须是非空有界数组');
  }
  const order = value.map((item, index) => stringField(item, `expectedOrder[${String(index)}]`));
  if (new Set(order).size !== order.length) throw fail(400, 'BAD_REQUEST', 'expectedOrder 含重复 id');
  return order;
}

/** @returns 队列行的 id 序列（当前顺序）。 */
function idsOf(messages) {
  return messages.map((message) => String(message.id));
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 拒绝本插件不该动的队列。 */
function assertOrdinary(agent) {
  if (agent.session.header.origin === 'subagent') {
    throw fail(409, 'SUBAGENT_UNSUPPORTED', '子代理会话的待发队列归父会话所有，不能在此调整');
  }
}

/** 拒绝会丢弃「harness 仍在追踪的工作」的那一段。 */
function assertUserSources(messages, start, end) {
  for (let index = start; index <= end; index += 1) {
    if (messages[index]?.source?.kind !== 'user') {
      throw fail(409, 'NON_USER_MESSAGE', '该行不是用户消息（可能是任务/目标提示），搬动它会取消 harness 仍在追踪的工作');
    }
  }
}

/**
 * 把一条待发消息搬到新位置。
 *
 * 整个搬动是**一次** `agent/inbox/spliced` 事件，覆盖同时包含起点与终点的最小 span，
 * 所以只有 durable inbox 投影变化、transcript 只记录一次变更。
 */
function moveQueuedMessage(resolveAgent, request) {
  const agent = resolveAgent(request.sessionId);
  if (agent === undefined) throw fail(404, 'AGENT_NOT_FOUND', '该会话已没有活着的 agent');
  assertOrdinary(agent);
  const current = [...agent.inbox.nextTurn];
  if (current.length === 0) throw fail(409, 'QUEUE_EMPTY', '队列是空的');
  if (!sameOrder(idsOf(current), request.expectedOrder)) {
    throw fail(409, 'QUEUE_CHANGED', '队列在你操作前排已经变了——已拒绝，请按最新顺序重试');
  }
  if (request.toIndex >= current.length) throw fail(400, 'INVALID_TARGET', '目标位置超出当前队列');
  const from = current.findIndex((message) => String(message.id) === request.itemId);
  if (from < 0) throw fail(409, 'ITEM_NOT_FOUND', '该条目已不在待发队列里');
  if (from === request.toIndex) return { ok: true, order: idsOf(current) };

  const start = Math.min(from, request.toIndex);
  const end = Math.max(from, request.toIndex);
  assertUserSources(current, start, end);
  const replacement = current.slice(start, end + 1);
  const [moving] = replacement.splice(from - start, 1);
  if (moving === undefined) throw fail(409, 'ITEM_NOT_FOUND', '该条目已不在待发队列里');
  replacement.splice(request.toIndex - start, 0, moving);
  agent.inbox.splice('next-turn', start, end - start + 1, replacement);
  return { ok: true, order: idsOf(agent.inbox.nextTurn) };
}

function contentType(request) {
  const raw = request.headers?.['content-type'];
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

/** 读一个有界 JSON 请求体。 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      bytes += data.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        reject(fail(413, 'BODY_TOO_LARGE', '请求体过大'));
        return;
      }
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    request.on('end', () => {
      if (failed) return;
      try {
        text += decoder.decode();
        resolve(JSON.parse(text));
      } catch {
        reject(fail(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function respondJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

/** 解码不可信请求体（导出供自测直接调用）。 */
function decodeReorderRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail(400, 'BAD_REQUEST', '请求体必须是对象');
  }
  return {
    sessionId: stringField(value.sessionId, 'sessionId'),
    itemId: stringField(value.itemId, 'itemId'),
    toIndex: indexField(value.toIndex),
    expectedOrder: orderField(value.expectedOrder),
  };
}

/** 处理一次重排请求；每种失败保留自己的状态码与错误码，便于 dock 说清原因。 */
async function handleRoute(resolveAgent, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' });
    response.end();
    return;
  }
  if (!contentType(request).toLowerCase().startsWith('application/json')) {
    respondJson(response, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '需要 application/json' } });
    return;
  }
  try {
    respondJson(response, 200, moveQueuedMessage(resolveAgent, decodeReorderRequest(await readJsonBody(request))));
  } catch (error) {
    if (error instanceof ReorderError) {
      respondJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
      return;
    }
    respondJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: '重排失败' } });
  }
}

/** 经子插件注册（依赖声明放子插件，见文件头 ⚠️ 说明）；fail-open：失败只告警，不阻断启动。 */
function apply(ctx) {
  const routesPlugin = {
    name: 'dshome-input-reorder',
    inject: ['agents', 'webServer'],
    apply(wctx) {
      const disposers = [];
      try {
        disposers.push(wctx.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: (request, response) => void handleRoute((sessionId) => wctx.agents.get(sessionId), request, response),
        }));
      } catch (error) {
        for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
        console.warn('dshome-input: reorder route registration failed', error);
      }
      wctx.effect?.(() => () => { for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } } });
    },
  };
  try {
    ctx.plugin?.(routesPlugin);
  } catch (error) {
    console.warn('dshome-input: reorder sub-plugin failed', error);
  }
}

module.exports = {
  name: 'dshome-input',
  apply,
  ROUTE_PATH,
  decodeReorderRequest,
  moveQueuedMessage,
};
