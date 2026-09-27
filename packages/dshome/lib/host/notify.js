// dshome/notify — DSHOME 回合级通知 host 插件（主线 A 第 2 步）。
//
// 职责：往 Electron 薄壳的本地通知监听（DSHOME_NOTIFY_PORT，默认 32123，
// POST /notify {title, body, sound}）发送系统通知，覆盖四类"值得抬头看一眼"的时刻：
//   ① 主任务回合结束（completed / 失败）② 后台任务结束 ③ **成员（subagent）任务结束**（契约 v2）
//   ④ **有东西在等你操作**——审批确认弹窗（`approval/asked`）与模型提问（`ask_user_question`）。
// 是否发送由设置命名空间 `dshome` 的 `enabled`（总开关）+ 各分项开关决定
// （DSHOME 设置 → 通知）。
//
// 音色分组（契约 v2，主人取向「主任务与其余任务用不同的音」）：
//   soundTurnCompletion ← 主任务（turn-completed / turn-failed）
//   soundBackground     ← 其余（job-completed / job-failed / member-completed / member-failed）
//   soundApproval / soundUserQuestion ← 审批 / 提问（不变）
// POST body 的 `sound`（文件名或 .wav 绝对路径；空串 = 不额外播音）：壳收不到/不支持该字段时
// 只是不播音、通知照弹——**向后兼容**：旧壳忽略多出来的字段。
//
// 事件源接缝：`sessions.on("session/event", ...)` 的 turn/start、user/message、turn/end
// （来自官方 dsh-plugin-desktop 的 notifications 插件，被 DSH Desktop 2.0.3 验证）；
// ④ 复用同一条会话事件流：`approval/asked`（官方 dsh-user-approval 在请求批准时追加，
// 带 toolName / reason）与 `tool/call`（name === 'ask_user_question'）。
// ③ **成员会话走的是同一条链**（本机实测取证：129 个 `origin:'subagent'` 会话里 98 个含
// `turn/end`；子会话经 `agents.create()` → `sessions.enter/announce` 进会话商店 ⇒ 派发点与主会话一致）。
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
  // 后台任务（jobs）与**成员任务**（subagent 回合）结束时的提醒（契约 v2）
  notifyOnBackground: z.boolean().default(true),
  // 分事件音色（契约 v1）：值是**文件名或 .wav 绝对路径**；空串 "" = 不额外播音
  // （只听系统通知自带的音）。文件名落在 %WINDIR%\Media；不可播时壳播系统默认音（不静默）。
  // 「主任务」＝你发起的回合完成/失败（soundTurnCompletion）。
  soundTurnCompletion: z.string().default('Windows Notify System Generic.wav'),
  // 「其余」＝后台任务完成/失败 + 成员任务完成/失败（soundBackground，契约 v2 起分开）
  soundBackground: z.string().default('Windows Notify Email.wav'),
  // 需要你确认时（审批弹窗）
  soundApproval: z.string().default('Windows Notify Calendar.wav'),
  // 有提问等你回答时（模型调 ask_user_question）
  soundUserQuestion: z.string().default('Windows Notify Messaging.wav'),
}) : null;

// 注意 direction：`NotifySettingsSchema({})` 只做**反向**归一（把已有值补默认），
// 不会把 .default() 填进传入的空对象 ⇒ schema 缺失/未归一时的兜底必须自带音色默认值，
// 否则「设置面停用」这条分支会静默把音色变成空串（= 假绿）。
const DEFAULT_SETTINGS = NotifySettingsSchema
  ? NotifySettingsSchema({})
  : {
      enabled: true, notifyOnTurnCompletion: true, notifyOnApproval: true, notifyOnUserQuestion: true,
      notifyOnBackground: true,
      soundTurnCompletion: 'Windows Notify System Generic.wav',
      soundBackground: 'Windows Notify Email.wav',
      soundApproval: 'Windows Notify Calendar.wav',
      soundUserQuestion: 'Windows Notify Messaging.wav',
    };

/** 事件 key → 用哪个音色设置项（冻结分组，契约 v2：主任务一个音、「其余」一个音）。 */
const SOUND_BY_KEY = {
  // 主任务（你发起的回合）
  'turn-completed': 'soundTurnCompletion',
  'turn-failed': 'soundTurnCompletion',
  // 「其余」：后台任务 + 成员任务
  'job-completed': 'soundBackground',
  'job-failed': 'soundBackground',
  'member-completed': 'soundBackground',
  'member-failed': 'soundBackground',
  'approval-asked': 'soundApproval',
  'user-question': 'soundUserQuestion',
};

/** 当前设置快照 —— **单一真相源**（模块级）：所有函数（含 `deliver` 这类模块级函数与 `apply` 里的
 *  闭包）都读它，`apply()` 每次取值/变更都经 `syncSettings()` 写回这里。
 *  为什么是模块级：2026-09-27 阻断事故里，`deliver` 读了一个**只存在于 apply 局部**的 `settings`
 *  ⇒ 每次投递 ReferenceError ⇒ async 的 rejected promise 无人 catch ⇒ **后端整个被杀**
 *  （壳日志 `{"backend":"exit","code":1}`）。
 *  为什么现在没有"apply 局部副本"了：两份状态靠一个**箭头函数**同步，而箭头函数不在 RM 体检的
 *  `function` 声明覆盖内 ⇒ 分叉没有运行时判据。删掉副本 = 没有分叉。 */
let currentSettings = DEFAULT_SETTINGS;

/** 取某事件该带的音色值；设置缺失/值非字符串 ⇒ 空串（= 不额外播音，交壳按无音处理）。 */
function soundForEvent(settings, key) {
  const field = SOUND_BY_KEY[key];
  if (!field) return '';
  const value = settings?.[field];
  return typeof value === 'string' ? value : '';
}

/** 壳内通知监听端口（与 shell.js 的 NOTIFY_PORT 默认一致）。 */
const NOTIFY_PORT = Number(process.env.DSHOME_NOTIFY_PORT || 32123);

/** 通知文案（中文为主；DSHOME 界面即中文）。 */
const COPY = {
  'turn-completed': { title: 'DSHOME 回合完成', body: '一个由你发起的回合已处理完毕，可查看结果。' },
  'turn-failed': { title: 'DSHOME 回合失败', body: '一个由你发起的回合未能完成，请查看详情。' },
  'job-completed': { title: 'DSHOME 后台任务完成', body: '有一个后台任务已结束。' },
  'job-failed': { title: 'DSHOME 后台任务失败', body: '有一个后台任务未能完成，请查看详情。' },
  'member-completed': { title: 'DSHOME 成员任务完成', body: '一个成员任务已完成。' },
  'member-failed': { title: 'DSHOME 成员任务失败', body: '一个成员任务未能完成，请查看详情。' },
  'approval-asked': { title: 'DSHOME 需要你确认', body: '有一个操作在等你确认后才会继续。' },
  'user-question': { title: 'DSHOME 有个问题等你回答', body: '模型在等你选择或补充信息。' },
};

/** 成员任务的称呼：优先取会话头里能认人的字段（`label`/`title`/`name`——官方 subagent 把派活时的
 *  `description` 作为 label 持久化），拿不到就用**短会话 id**；再拿不到返回空串（文案退回通用句）。
 *  **绝不猜**：这些字段都不存在时不要拿 `agentPreset` 之类的字段充数（那是模型预设，不是成员名）。 */
function memberLabel(session) {
  const header = session?.header;
  for (const field of ['label', 'title', 'name']) {
    const value = oneLine(header?.[field], 40);
    if (value !== '') return value;
  }
  const id = oneLine(header?.id, 12);
  return id === '' ? '' : `会话 ${id.slice(0, 8)}`;
}

/** 成员任务的通知文案（带上能辨认是哪个成员的信息）。 */
function memberCopy(key, session) {
  const entry = COPY[key];
  if (!entry) return void 0;
  const who = memberLabel(session);
  const done = key === 'member-completed';
  return {
    title: entry.title,
    body: who === ''
      ? entry.body
      : (done
        ? `成员「${who}」的回合已完成，可查看结果。`
        : `成员「${who}」的回合未能完成，请查看详情。`),
  };
}

/** 同类提醒的最小间隔：并发会话各提醒一次，但同一会话别连发刷屏。 */
const ATTENTION_THROTTLE_MS = 5000;
/** key（`<场景>:<会话 id>`）→ 上次投递时刻。 */
const lastAttentionAt = new Map();
/** 成员任务通知的**音效全局窗口**（契约 v2）：所有成员共用一个 5s 窗口，窗口内只有第一条带音，
 *  其余的通知照投、`sound` 传空串（= 壳只弹通知不出声）。多成员同时交卷时连响一串音比不响更烦。 */
const MEMBER_SOUND_WINDOW_MS = 5000;
/** 上次给成员通知配了音的时刻（0 = 从未）。**只在真投递成功时消费**（见 deliverAttention）。 */
let lastMemberSoundAt = 0;
/** 投递失败留痕的限频窗口与计数（同类 60s 一条，别每次刷屏）。 */
const DELIVER_FAIL_NOTE_MS = 60000;
const deliverFailNote = { at: 0, count: 0 };

/** 本刻该不该给成员通知配音（纯函数，便于隔离断言「窗口内第二条必须没音」）。 */
function memberSoundAllowed(now, lastAt) {
  return now - lastAt >= MEMBER_SOUND_WINDOW_MS;
}

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

/** 投递一条通知到壳。**整函数体**包 try/catch：所有调用点都不接它的 promise ⇒
 *  try 外任何抛错都是"无人 catch 的 rejected promise"（2026-09-27 就是这样把后端整个杀掉的）。
 *  契约：本函数**永不 reject**（`scripts/verify-notify-sound.mjs` 的 RL 节有断言）。
 *  `detail` 可覆盖文案（用于带上"在等什么"的上下文）；body 另带 `sound`
 *  （分事件音色；空串/缺省 ⇒ 壳只弹通知、不播音）；
 *  `detail.silentSound === true` ⇒ 本次只清音、仍照投（成员通知的音效全局节流用它）。 */
async function deliver(key, detail) {
  try {
    if (!NOTIFY_PORT) return;
    const entry = COPY[key];
    if (!entry) return;
    // ⚠️ 必须读**模块级** `currentSettings`：本函数在模块作用域，读不到 `apply()` 里可能存在的局部
    //    （2026-09-27 实测事故：写成 `settings` ⇒ ReferenceError ⇒ async 的 rejected promise
    //    无人 catch ⇒ Node 把后端整个杀掉；壳日志 `{"backend":"exit","code":1}`）。
    const sound = detail?.silentSound === true ? '' : soundForEvent(currentSettings, key);
    const payload = detail
      ? { title: detail.title ?? entry.title, body: detail.body ?? entry.body, sound }
      : { ...entry, sound };
    await fetch(`http://127.0.0.1:${NOTIFY_PORT}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // 投递失败是**宿主侧唯一的失败观测点**（壳没起/端口不通/RST 全在这里才看得见）⇒ 必须留痕，
    // 但按同类限频，别每次刷屏（deliverFailNote 内部判窗口）。
    const detail = String(error?.message ?? error);
    const now = Date.now();
    if (deliverFailNote.at === 0 || now - deliverFailNote.at >= DELIVER_FAIL_NOTE_MS) {
      deliverFailNote.at = now;
      deliverFailNote.count += 1;
      try {
        console.warn('dshome-notify: deliver failed (%d) port=%s: %s', deliverFailNote.count, String(NOTIFY_PORT), detail);
      } catch { /* 日志本身失败也不能抛（本函数的契约是永不 reject） */ }
    }
  }
}

/**
 * 带节流的"等你操作"提醒：同一会话同一场景 5s 内只发一条。
 *
 * 两件互相咬合的事：
 *   · **返回值 = 是否真投递**（被节流吞掉 ⇒ `false`）：调用方据此决定要不要消费别的状态
 *     （成员通知的音效窗口就绑在这里，见 `trackMemberTurn`）。
 *   · **音效窗口的消费与投递绑定**：`detail.silentSound === true` ⇒ 本次强制无音、且**不消费**窗口；
 *     未指定 silentSound（成员通知）⇒ 由本函数在**确认要投递之后**才判窗口并消费。
 *     ⚠️ 顺序不能反：先消费窗口再投递 ⇒ 被节流吞掉的那条把窗口吃掉了，**下一个成员该响却静音**
 *     （独立复核给的反例，RL 节有断言）。
 * @returns {boolean} true = 真投递出去了；false = 被同会话 5s 节流吞掉（或 key 不可投）。
 */
function deliverAttention(key, sessionId, detail) {
  const throttleKey = `${key}:${sessionId}`;
  const now = Date.now();
  if (now - (lastAttentionAt.get(throttleKey) ?? 0) < ATTENTION_THROTTLE_MS) return false;
  lastAttentionAt.set(throttleKey, now);
  // 防泄漏：Map 只随会话数增长，陈旧条目在会话销毁时清（见下 stopDisposed）。
  // ⚠️ **只有成员通知才碰音效窗口**（`detail.memberSound === true` 显式认领）。
  //    不这么写就会出真 bug（本次实测踩到）：把窗口判定搬进本函数后，非成员的
  //    `user-question` / `approval-asked` 也会消费这 5s 窗口 ⇒ 紧接着的成员通知被静音；
  //    而窗口状态**只能在真投递之后**才消费（复核反例：被同会话节流吞掉的那条不许吃窗口）。
  let outgoing = detail;
  if (detail?.memberSound === true) {
    const withSound = memberSoundAllowed(now, lastMemberSoundAt);
    if (withSound) lastMemberSoundAt = now;
    outgoing = { ...detail, silentSound: !withSound, memberSound: undefined };
  }
  void deliver(key, outgoing);
  return true;
}

/**
 * 成员（subagent）会话的回合提醒（契约 v2）。
 *
 * 判据（写清，免得后来者按主会话的假设改坏它）：
 *   · **成员会话确实会派发 `turn/start` / `turn/end`**（本机实测：129 个 subagent 会话中 98 个
 *     含 `turn/end`，`reason.kind` 观测值 `completed` / `aborted` / `interrupted`；事件由
 *     `dsh-agent-loop` 逐回合 append，子会话经 `agents.create()` → `sessions.enter/announce`
 *     进入会话商店 ⇒ 与主会话**同一条** `session/event` 派发链）。不是防御性死码。
 *   · **不要求 `userInitiated`**：成员由 Lead 派活驱动，不是"用户发起"的回合。
 *   · **通知照投**（成员交卷必须看得见），但**音效全局节流**：所有成员共用一个 5s 窗口，
 *     窗口内只有第一条带 `sound`（= `soundBackground`，分组见 SOUND_BY_KEY），
 *     其余 `sound` 传空串 ⇒ 壳只弹通知不出声（连响一串音比不响更烦）。
 *     实现上靠 `memberSound: true` 显式认领窗口（非成员的等待类通知不碰它）。
 *   · 同会话仍走 `deliverAttention` 的 5s 窗口（同一成员重试不刷屏）。
 *   · **窗口只被真投递消费**：同会话被节流吞掉的那条不会消耗音效窗口（复核反例，RL 有断言）。
 *   · ⚠️ `aborted` / `interrupted`（用户中断 / 被取消）**不在契约 v2 的两类里** ⇒ 明确不投递，
 *     别自作主张归进 member-failed（契约没说到的地方不许自己发明）。
 *
 * @param {object} session - 会话头。
 * @param {object} event - session/event 载荷。
 */
function trackMemberTurn(session, event) {
  if (!currentSettings.enabled) return;
  if (currentSettings.notifyOnBackground !== true) return;
  if (event.type !== 'turn/end') return;
  const key = event.data?.reason?.kind === 'completed'
    ? 'member-completed'
    : ((event.data?.reason?.kind === 'error' || event.data?.reason?.kind === 'max-tokens') ? 'member-failed' : '');
  if (key === '') return;
  // 音效全局窗口的判定与消费都在 deliverAttention 内、且**只在真投递时**发生
  // （`memberSound: true` 是显式认领：非成员通知不碰这个窗口，见那里的注释）。
  deliverAttention(key, String(session.header?.id ?? ''), { ...memberCopy(key, session), memberSound: true });
}

/**
 * 跟踪一个正在进行的回合。
 *   · 主会话（非 subagent）：仅在"用户发起的回合"结束时投递 `turn-completed`/`turn-failed`。
 *   · 成员会话（subagent）：走 `trackMemberTurn`（契约 v2，判据见那里的注释）。
 * 设置一律读模块级 `currentSettings`（**单一真相源**：不再有 apply 局部副本，见 :102 注释）。
 * @param {Map<string, {turn:number,userInitiated:boolean}>} openTurns - 进行中回合。
 * @param {object} session - 会话头。
 * @param {object} event - session/event 载荷。
 */
function trackTurn(openTurns, session, event) {
  if (!currentSettings.enabled) return;
  // 成员（subagent）会话：不是"用户发起"的回合，但同样要提醒（契约 v2）。
  if (session.header?.origin === 'subagent') {
    trackMemberTurn(session, event);
    return;
  }
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
  if (reason === 'completed' && currentSettings.notifyOnTurnCompletion) {
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
 * @param {object} session - 会话头。
 * @param {object} event - session/event 载荷。
 */
function trackAttention(session, event) {
  if (!currentSettings.enabled) return;
  const sessionId = String(session.header?.id ?? '');
  if (event.type === 'approval/asked') {
    if (!currentSettings.notifyOnApproval) return;
    const tool = oneLine(event.data?.toolName, 40) || '未知工具';
    const reason = oneLine(event.data?.reason);
    deliverAttention('approval-asked', sessionId, {
      body: reason ? `工具「${tool}」请求确认：${reason}` : `工具「${tool}」在等你确认后才会继续。`,
    });
    return;
  }
  if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
    if (!currentSettings.notifyOnUserQuestion) return;
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
  // **单一真相源**：全局只认模块级 `currentSettings`（`let currentSettings = DEFAULT_SETTINGS`）。
  // 历史教训（2026-09-27 阻断事故）：这里曾有一份 apply 局部副本 `let settings`，靠一个**箭头函数**
  // 维持两处同步 —— 箭头函数不在 `scripts/verify-notify-sound.mjs` RM 体检的 `function` 声明覆盖内，
  // 副本一旦被漏同步就没人测得出来。现在没有副本，就没有分叉。
  const syncSettings = (next) => { currentSettings = next; };

  // 1) 注册 `dshome` 设置命名空间并持续跟踪其值（设置面读写同一命名空间）。
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      if (!NotifySettingsSchema) {
        ctx.logger?.('dshome').warn('dshome-notify: schemastery 缺失 → 设置面停用（通知按默认值工作）');
        return;
      }
      settingsCtx.effect(() => {
        const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, NotifySettingsSchema, { applies: 'live' });
        syncSettings(scope.get());
        const stopWatching = scope.watch((next) => {
          syncSettings(next);
        });
        return () => {
          stopWatching();
          syncSettings(DEFAULT_SETTINGS);
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
          trackTurn(openTurns, session, event);
          trackAttention(session, event);
        });
        const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
          const id = String(session.header?.id ?? '');
          openTurns.delete(id);
          // 顺手清掉本会话的节流条目（key 形如 `<场景>:<会话 id>`），别让 Map 随会话数长存。
          // ⚠️ 成员（subagent）会话**确实**会走到这里（已核代码链）：`detachEntered()` 对 announced 过的
          //    会话 emit `session/disposed`（dsh-session/lib/index.js:1461-1467），而子会话同样经
          //    enter→announce→detach（dsh-agent-loop/lib/index.js:1714-1716 挂、:1669-1670 摘）。
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

  // 3) 订阅后台任务结束（契约 v2：归「其余」组，受 notifyOnBackground 管辖 + 带 soundBackground）。
  try {
    ctx.inject(['jobs'], (jobsCtx) => {
      jobsCtx.effect(() => jobsCtx.jobs.onJobDone((snapshot) => {
        if (!currentSettings.enabled) return;
        if (currentSettings.notifyOnBackground !== true) return;
        if (snapshot.status === 'completed') deliver('job-completed');
        else if (snapshot.status === 'failed') deliver('job-failed');
      }), 'dshome-notify: background job attention');
    });
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-notify jobs disabled: %O', error);
  }

  ctx.logger?.('dshome').info('dshome-notify ready: turn/member/job/approval/question notifications on port %d', NOTIFY_PORT);
}
