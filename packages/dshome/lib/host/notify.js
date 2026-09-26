// dshome/notify — DSHOME 回合级通知 host 插件（主线 A 第 2 步）。
//
// 职责：往 Electron 薄壳的本地通知监听（DSHOME_NOTIFY_PORT，默认 32123，
// POST /notify {title, body}）发送系统通知，覆盖三类"值得抬头看一眼"的时刻：
//   ① 回合结束（completed / 失败）② 后台任务结束 ③ **有东西在等你操作**——
//      审批确认弹窗（`approval/asked`）与模型提问（`ask_user_question`）。
// 是否发送由设置命名空间 `dshome` 的 `enabled`（总开关）+ 各分项开关决定
// （DSHOME 设置 → 通知）。
//
// 事件源接缝：`sessions.on("session/event", ...)` 的 turn/start、user/message、turn/end
// （来自官方 dsh-plugin-desktop 的 notifications 插件，被 DSH Desktop 2.0.3 验证）；
// ③ 复用同一条会话事件流：`approval/asked`（官方 dsh-user-approval 在请求批准时追加，
// 带 toolName / reason）与 `tool/call`（name === 'ask_user_question'）。
//
// 护栏（设计见历史文档，已归档）：每个服务挂载独立 try/catch，失败只记日志，
// 绝不阻断 profile 启动；通知投递失败静默忽略。

// 上游导出（schemastery 的 z + dsh-settings 的 settingsNamespace）经 upstream 层运行时获取。
// 理由见 upstream.js 头注：静态导入是 ESM 链接期错误，官方改名/移除即带崩整棵插件树。
import { settingsNamespace, schemastery as z } from './upstream.js';

/** Stable Cordis plugin name (row: `name: dshome/notify`). */
export const name = 'dshome-notify';

/** Services this row requires before activation. */
export const inject = [];

/** 通知设置命名空间（与客户端设置行共用；须匹配 `^[a-z][a-z0-9-]*$`）。 */
// settingsNamespace() 只做格式校验并**原样返回字符串**，故上游缺失时退回同值字符串：
// 正常路径行为完全一致，且**不在模块求值期抛错**（真正的注册失败由 apply 的 try/catch 兜）。
export const SETTINGS_NAMESPACE = settingsNamespace ? settingsNamespace('dshome') : 'dshome';

/** 设置 schema：扁平对象，便于客户端 scope.set 单字段写入。 */
// schemastery 缺失（上游消失/改名）→ 不再构造 schema：本插件**设置面**停用，但模块照常
// 加载。原静态 default 导入会在模块求值期直接抛错 → 可能带崩整棵插件树（见 upstream.js 头注）。
// 三元短路是必须的——`z.boolean()` 在实参求值期就先跑，函数体里判空拦不住。
export const NotifySettingsSchema = z ? z.object({
  // 通知总开关
  enabled: z.boolean().default(true),
  // 回合完成时提醒（仅在总开关开启时生效）
  notifyOnTurnCompletion: z.boolean().default(true),
  // 需要你确认时提醒（审批/危险操作确认弹窗：approval/asked）
  notifyOnApproval: z.boolean().default(true),
  // 有提问等你回答时提醒（模型调 ask_user_question）
  notifyOnUserQuestion: z.boolean().default(true),
}) : null;

const DEFAULT_SETTINGS = NotifySettingsSchema
  ? NotifySettingsSchema({})
  : { enabled: true, notifyOnTurnCompletion: true, notifyOnApproval: true, notifyOnUserQuestion: true };

/** 壳内通知监听端口（与 shell.js 的 NOTIFY_PORT 默认一致）。 */
const NOTIFY_PORT = Number(process.env.DSHOME_NOTIFY_PORT || 32123);

/** 通知文案（中文为主；DSHOME 界面即中文）。 */
const COPY = {
  'turn-completed': { title: 'DSHOME 回合完成', body: '一个由你发起的回合已处理完毕，可查看结果。' },
  'turn-failed': { title: 'DSHOME 回合失败', body: '一个由你发起的回合未能完成，请查看详情。' },
  'job-completed': { title: 'DSHOME 后台任务完成', body: '有一个后台任务已结束。' },
  'job-failed': { title: 'DSHOME 后台任务失败', body: '有一个后台任务未能完成，请查看详情。' },
  'approval-asked': { title: 'DSHOME 需要你确认', body: '有一个操作在等你确认后才会继续。' },
  'user-question': { title: 'DSHOME 有个问题等你回答', body: '模型在等你选择或补充信息。' },
};

/** 同类提醒的最小间隔：并发会话各提醒一次，但同一会话别连发刷屏。 */
const ATTENTION_THROTTLE_MS = 5000;
/** key（`<场景>:<会话 id>`）→ 上次投递时刻。 */
const lastAttentionAt = new Map();

/** 把任意文本压成一行并截断，免得把长命令整条塞进通知气泡。 */
function oneLine(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 从 `ask_user_question` 的 arguments（JSON 字符串）里取第一条问题做摘要；解析失败/无问题返回空串。 */
function questionSummary(raw) {
  try {
    const parsed = JSON.parse(raw ?? '');
    const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : void 0;
    if (first === void 0 || first === null) return '';
    return oneLine(first?.header || first?.question, 80);
  } catch {
    return '';
  }
}

/** 投递一条通知到壳；失败静默。`detail` 可覆盖文案（用于带上"在等什么"的上下文）。 */
async function deliver(key, detail) {
  if (!NOTIFY_PORT) return;
  const entry = COPY[key];
  if (!entry) return;
  const payload = detail ? { title: detail.title ?? entry.title, body: detail.body ?? entry.body } : entry;
  try {
    await fetch(`http://127.0.0.1:${NOTIFY_PORT}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // 通知投递是尽力而为：壳未起/端口未监听都只静默忽略。
  }
}

/** 带节流的"等你操作"提醒：同一会话同一场景 5s 内只发一条。 */
function deliverAttention(key, sessionId, detail) {
  const throttleKey = `${key}:${sessionId}`;
  const now = Date.now();
  if (now - (lastAttentionAt.get(throttleKey) ?? 0) < ATTENTION_THROTTLE_MS) return;
  lastAttentionAt.set(throttleKey, now);
  // 防泄漏：Map 只随会话数增长，陈旧条目在会话销毁时清（见下 stopDisposed）。
  void deliver(key, detail);
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
 * "等你操作"提醒：审批确认弹窗与模型提问。
 *
 * 判据（写清边界，免得后来者以为它覆盖了"所有等待"）：
 *   · `approval/asked` = 官方 dsh-user-approval 在请求批准时追加的审计事件，也是 GUI
 *     弹「确认」框的同源信号（`toolName` 是请求批准的工具，`reason` 是人类可读缘由）。
 *     **不按会话来源过滤**：子会话/成员会话里的确认框同样要人点，漏报比多报更糟；
 *     刷屏交给 deliverAttention 的同会话节流兜。
 *   · `tool/call` 且 name === 'ask_user_question' = 模型要你在选项里挑或补充信息
 *     （官方 dsh-tool-ask-user 内部 await ctx.userQuestions.ask，直到你作答才继续）。
 *     **按会话来源过滤掉 `subagent`**：子代理不是 live runtime root，ask() 会直接抛
 *     DELEGATED_CALLER 而根本弹不出窗，报了就是假警报。
 *
 * @param {ReturnType<typeof NotifySettingsSchema>} settings - 当前设置快照。
 * @param {object} session - 会话头。
 * @param {object} event - session/event 载荷。
 */
function trackAttention(settings, session, event) {
  if (!settings.enabled) return;
  const sessionId = String(session.header?.id ?? '');
  if (event.type === 'approval/asked') {
    if (!settings.notifyOnApproval) return;
    const tool = oneLine(event.data?.toolName, 40) || '未知工具';
    const reason = oneLine(event.data?.reason);
    deliverAttention('approval-asked', sessionId, {
      body: reason ? `工具「${tool}」请求确认：${reason}` : `工具「${tool}」在等你确认后才会继续。`,
    });
    return;
  }
  if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
    if (!settings.notifyOnUserQuestion) return;
    if (session.header?.origin === 'subagent') return;
    const summary = questionSummary(event.data?.arguments);
    deliverAttention('user-question', sessionId, {
      body: summary || COPY['user-question'].body,
    });
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
      if (!NotifySettingsSchema) {
        ctx.logger?.('dshome').warn('dshome-notify: schemastery 缺失 → 设置面停用（通知按默认值工作）');
        return;
      }
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

  // 2) 订阅"会话事件"：跟踪用户回合完成/失败，以及"等你操作"（确认弹窗 / 模型提问）。
  try {
    ctx.inject(['sessions'], (sessionsCtx) => {
      sessionsCtx.effect(() => {
        const openTurns = new Map();
        const stopEvents = sessionsCtx.on('session/event', (session, event) => {
          trackTurn(settings, openTurns, session, event);
          trackAttention(settings, session, event);
        });
        const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
          const id = String(session.header?.id ?? '');
          openTurns.delete(id);
          // 顺手清掉本会话的节流条目（key 形如 `<场景>:<会话 id>`），别让 Map 随会话数长存。
          const suffix = `:${id}`;
          for (const key of [...lastAttentionAt.keys()]) {
            if (key.endsWith(suffix)) lastAttentionAt.delete(key);
          }
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

  ctx.logger?.('dshome').info('dshome-notify ready: turn/job/approval/question notifications on port %d', NOTIFY_PORT);
}
