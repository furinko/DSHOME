// dshome/notify — DSHOME 回合级通知 host 插件（主线 A 第 2 步）。
//
// 职责：当"当前前台回合"结束（completed/失败）或后台任务结束，往 Electron 薄壳的
// 本地通知监听（DSHOME_NOTIFY_PORT，默认 32123，POST /notify {title, body}）发送
// 一条系统通知；是否发送由设置命名空间 `dshome` 的 `enabled` / `notifyOnTurnCompletion`
// 决定（DSHOME 设置 → 通知 开关）。
//
// 事件源接缝：`sessions.on("session/event", ...)` 的 turn/start、user/message、turn/end
// （来自官方 dsh-plugin-desktop 的 notifications 插件，被 DSH Desktop 2.0.3 验证）。
//
// 护栏（DSHOME-DESIGN.md §13.5）：每个服务挂载独立 try/catch，失败只记日志，
// 绝不阻断 profile 启动；通知投递失败静默忽略。

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Stable Cordis plugin name (row: `name: dshome/notify`). */
export const name = 'dshome-notify';

/** Services this row requires before activation. */
export const inject = [];

/** 通知设置命名空间（与客户端设置行共用；须匹配 `^[a-z][a-z0-9-]*$`）。 */
export const SETTINGS_NAMESPACE = settingsNamespace('dshome');

/** 设置 schema：扁平对象，便于客户端 scope.set 单字段写入。 */
export const NotifySettingsSchema = z.object({
  // 通知总开关
  enabled: z.boolean().default(true),
  // 回合完成时提醒（仅在总开关开启时生效）
  notifyOnTurnCompletion: z.boolean().default(true),
});

const DEFAULT_SETTINGS = NotifySettingsSchema({});

/** 壳内通知监听端口（与 shell.js 的 NOTIFY_PORT 默认一致）。 */
const NOTIFY_PORT = Number(process.env.DSHOME_NOTIFY_PORT || 32123);

/** 通知文案（中文为主；DSHOME 界面即中文）。 */
const COPY = {
  'turn-completed': { title: 'DSHOME 回合完成', body: '一个由你发起的回合已处理完毕，可查看结果。' },
  'turn-failed': { title: 'DSHOME 回合失败', body: '一个由你发起的回合未能完成，请查看详情。' },
  'job-completed': { title: 'DSHOME 后台任务完成', body: '有一个后台任务已结束。' },
  'job-failed': { title: 'DSHOME 后台任务失败', body: '有一个后台任务未能完成，请查看详情。' },
};

/** 投递一条通知到壳；失败静默。 */
async function deliver(key) {
  if (!NOTIFY_PORT) return;
  const entry = COPY[key];
  if (!entry) return;
  try {
    await fetch(`http://127.0.0.1:${NOTIFY_PORT}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    });
  } catch (error) {
    // 通知投递是尽力而为：壳未起/端口未监听都只静默忽略。
  }
}

/**
 * 跟踪一个正在进行的回合：仅在"用户发起"的回合结束时投递。
 * @param {ReturnType<typeof NotifySettingsSchema>} settings - 当前设置快照。
 * @param {Map<string, {turn:number,userInitiated:boolean}>} openTurns - 进行中回合。
 * @param {object} session - 会话头。
 * @param {object} event - session/event 载荷。
 */
function trackTurn(settings, openTurns, session, event) {
  if (!settings.enabled) return;
  // 子代理(subagent)回合不打扰用户。
  if (session.header?.origin === 'subagent') return;
  const sessionId = String(session.header.id);
  if (event.type === 'turn/start') {
    openTurns.set(sessionId, { turn: event.data.turn, userInitiated: false });
    return;
  }
  if (event.type === 'user/message') {
    const openTurn = openTurns.get(sessionId);
    if (openTurn !== void 0 && event.data.source?.kind === 'user') openTurn.userInitiated = true;
    return;
  }
  if (event.type !== 'turn/end') return;
  const openTurn = openTurns.get(sessionId);
  if (openTurn === void 0 || openTurn.turn !== event.data.turn) return;
  openTurns.delete(sessionId);
  if (!openTurn.userInitiated) return;
  const reason = event.data.reason?.kind;
  if (reason === 'completed' && settings.notifyOnTurnCompletion) {
    deliver('turn-completed');
  } else if (reason === 'error' || reason === 'max-tokens') {
    deliver('turn-failed');
  }
}

/**
 * 主机插件主体：注册设置命名空间 + 订阅回合/后台任务事件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context。
 */
export function apply(ctx) {
  let settings = DEFAULT_SETTINGS;

  // 1) 注册 `dshome` 设置命名空间并持续跟踪其值（设置面读写同一命名空间）。
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(() => {
        const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, NotifySettingsSchema, { applies: 'live' });
        settings = scope.get();
        const stopWatching = scope.watch((next) => {
          settings = next;
        });
        return () => {
          stopWatching();
          settings = DEFAULT_SETTINGS;
        };
      }, 'dshome-notify: settings namespace');
    });
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-notify settings disabled: %O', error);
  }

  // 2) 订阅"会话事件"以跟踪用户回合完成/失败。
  try {
    ctx.inject(['sessions'], (sessionsCtx) => {
      sessionsCtx.effect(() => {
        const openTurns = new Map();
        const stopEvents = sessionsCtx.on('session/event', (session, event) => {
          trackTurn(settings, openTurns, session, event);
        });
        const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
          openTurns.delete(String(session.header.id));
        });
        return () => {
          stopDisposed();
          stopEvents();
        };
      }, 'dshome-notify: user turn attention');
    });
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-notify sessions disabled: %O', error);
  }

  // 3) 订阅后台任务结束。
  try {
    ctx.inject(['jobs'], (jobsCtx) => {
      jobsCtx.effect(() => jobsCtx.jobs.onJobDone((snapshot) => {
        if (!settings.enabled) return;
        if (snapshot.status === 'completed') deliver('job-completed');
        else if (snapshot.status === 'failed') deliver('job-failed');
      }), 'dshome-notify: background job attention');
    });
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-notify jobs disabled: %O', error);
  }

  ctx.logger?.('dshome').info('dshome-notify ready: turn-level notifications on port %d', NOTIFY_PORT);
}
