// dshome-mind-mood — 情绪状态 host 插件（2026-09-28 立）
//
// 职责：把「她此刻怎样」做成**机器可判定的状态**，每轮第一步注入一条状态块（~50–100 字）。
//   三层划分（冻结规格 mood-spec §2）：人格＝人设卡（她是谁，静态权威源）；状态＝本文件的
//   `sessionProjections` 投影（尾巴/强度/成因/时间）；通道＝本文件的 `agent/pre-step` 钩子。
//   **状态绝不写进卡里**：卡是静态权威源，状态是动态的，混在一起两边都糊。
//   目标观感：情绪因为**真的发生了什么**而变，并且**会退潮**。
//
// ── 状态存储（投影）──────────────────────────────────────────────────────────
//   `ctx.sessionProjections.register({ key:'mood', stateVersion:1, stateSchema, init, apply })`。
//   · `apply` 是**纯 fold**：只看事件本身（时刻取 `event.time`，**不用 Date.now()**）——
//     这样"重放到哪儿、状态就是哪儿"，与宿主重启后的日志重放逐字一致。
//     **不写盘、不发日志、不衰减**（衰减只在注入时算，且不写回）。
//   · **无变化必须 `return state`（同一引用）**：上游按 `Object.is` 判变
//     （dsh-session-projection/lib/index.js:393/:412）。故本文件所有 fold 走**单出口**：
//     先算出候选对象，再用 `sameMood()` 逐字段比对，没变就退回原引用——绝不 mutate、绝不返回 undefined。
//   · state 必须是 plain JSON（缓存写盘走 `snapshotJsonValue`，非 plain 值直接抛 TypeError）。
//
// ── 触发规则（优先级：主人消息判定 > 同轮工具失败 > 跨轮连败；安抚覆盖表扬）──────
//   1 表扬：本轮主人消息命中 `/辛苦|厉害|不错|好鱼|乖|棒/` 且**不带否定前缀**（不/没/别）
//           ⇒ `tail='smug'`、`level=min(2, level+1)`。
//   2 安抚：主人消息命中 `/没事|别急|慢慢来|不怪你|摸摸/` ⇒ `tail='calm'`、`level=0`、`causes=[]`
//           （**覆盖**表扬）。
//   3 同轮工具失败 ≥2（`recent.fails>=2`）⇒ `tail='prickly'`、`level=1`
//           （规格 §4 表 3 的转移列写明 `calm/smug→prickly`：主人夸过之后工具连挂，照样炸毛）。
//   4 跨轮连续失败 ≥2 轮（`failStreak>=2`）⇒ `tail='droopy'`、`level=2`（**覆盖**第 3 条）。
//   封顶：`level` ≤2、`causes` ≤3 条（超出丢最早的）、同类事件**去重**
//   （2 次失败与 5 次失败只留一条成因，数字取最新）；已是 `droopy:2` 再连败只刷新 `since`，不升级。
//
// ── 注入（每轮第一步一次 + 压缩后自愈）───────────────────────────────────────
//   `ctx.on('agent/pre-step', handler, { prepend: true })`，范式＝官方 dsh-tmux-context:1510-1543
//   （`step !== 1` 早退 + 投影 + `{prepend:true}`）与 dsh-time-context:215-247（追加尾部）。
//   放法＝**追加队列尾部** `[...decision.messages, msg]`（规格 §8 第 1 条：恒在队尾、不抢占
//   R0/R1 在 claimed 之后的位次，且不依赖 `insertAfterClaimed` ⇒ 少一个静默失败面）。
//   在场判据（规格 §8 第 4 条）：内存记 `lastInjectSeq`，下次 pre-step 查
//   `agent.session.surface.nodes.includes(lastInjectSeq)`——**在场就不注、不在场（被压缩遮蔽）就补注**
//   （补注不看 step：压缩在回合中途不重置 step，只判 step===1 会在遮蔽后永不回补）。
//   seq 来源＝`session/event` 里认出本插件注入的 `user/message`（agent-loop:1028 会把
//   decision.messages 逐条 append）；取不到就**退化为「每轮至多一次」并留痕**（marker + warn，每会话一次）。
//   有效强度为 0 ⇒ **不注入**（静默＝一切如常，不刷"本鱼现在很平静"）。
//   文本严格照规格 §5：首注带完整边界说明，续注只给状态+成因+回落提示；**只给成因、不给台词**
//   （禁止"你应该说……"式指令）。
//
// ── 已知边界（记录在案，不自行扩设计）────────────────────────────────────────
//   · **成因不含工具名**：`ToolResultBlock` 只有 `toolCallId`（dsh-llm/lib/types/types.d.ts:81-86），
//     工具名在 `tool/call` 的 `data.name`，要靠 `tool/result.sourceEventSeqs[0]` 反查日志——
//     而投影 `apply` 是纯 fold、拿不到 session，且冻结的 state 形状没有缓存位 ⇒ 成因用通用措辞
//     （「本轮工具连续 N 次失败」）。要精确到工具名需扩 state 或允许注入期反查日志，留 Lead 裁断。
//   · `turn/start` 时若发现上一轮没有 `turn/end`（崩溃/中断）会**补结转**一次连败计数，
//     保证「跨轮连败」在崩溃下仍成立（`doneTurn` 与 `recent.turn` 的差就是判据）。
//   · 首注判定用**进程内** `ever` 标记：重启后本会话第一次注入会重新带一次边界说明（可接受，
//     因为冻结的 state 形状里没有"是否已首注"字段）。
//
// ── 纪律（fail-open）────────────────────────────────────────────────────────
//   · 任何异常只 `ctx.logger?.('dshome').warn(...)`，**绝不阻断会话**；marker 写失败不影响插件。
//   · `export const inject` 必须声明 `sessionProjections`（门禁 `probeContextServiceAccess`：
//     `ctx.<服务>` 属性访问未声明即红）。
//   · 诊断留痕 `profiles/dshome/.dsh-market/mind-mood-marker.txt`（文件名含 `marker`，
//     verify-host-plugins 的 `snapshotMarkers()` 才会自动保护它），追加式保留最近 20 行。

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 上游导出经 upstream 层**运行时**获取（见 upstream.js 头注：静态具名导入若在官方新版消失会在
// 模块链接期抛错，apply 的兜底够不着）⇒ 拿不到就是 null，调用方判空降级。
import { createUserMessage } from './upstream.js';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/mind-mood). */
export const name = 'dshome-mind-mood';

/** Services this row requires before activation（`sessionProjections` 必须声明，见头注）。 */
export const inject = ['fs', 'sessionProjections'];

/** 投影 key（规格 §3 冻结）。 */
export const MOOD_KEY = 'mood';

/** 投影 stateVersion（规格 §3 冻结；失配 ⇒ 上游丢缓存行、从 init 重放全日志，只慢不错）。 */
export const MOOD_STATE_VERSION = 1;

/** 衰减步长：每 30 分钟有效强度 −1（规格 §4 表 6）。 */
const DECAY_STEP_MS = 30 * 60 * 1000;
/** 冷启动阈值：间隔 ≥24 小时 ⇒ 视为冷启动（有效强度 0）。 */
const COLD_START_MS = 24 * 60 * 60 * 1000;
/** 成因条数封顶（规格 §4.1）。 */
const MAX_CAUSES = 3;

/** 表扬词（规格 §4 表 1）。 */
const PRAISE_RE = /辛苦|厉害|不错|好鱼|乖|棒/;
/** 否定前缀：否定词紧贴表扬词才算否定（「不错」本身以"不"开头，但"不"后接的是"错"⇒ 不误判）。 */
const PRAISE_NEG_RE = /(?:不|没|别)\s*(?:辛苦|厉害|不错|好鱼|乖|棒)/;
/** 安抚词（规格 §4 表 2）。 */
const SOOTHE_RE = /没事|别急|慢慢来|不怪你|摸摸/;

/** tail → 中文（规格 §5）。 */
const TAIL_CN = { calm: '平静', prickly: '炸毛', smug: '美滋滋', droopy: '蔫' };
/** level → 强度中文（规格 §5：1=轻 / 2=强）。 */
const LEVEL_CN = { 1: '轻', 2: '强' };

/** 投影 `stateSchema` 的**兜底**：上游契约是 zod（`stateSchema: ZodType`，`restore` 时无条件
 *  `def.stateSchema.parse(row.val)`，见 dsh-session-projection/lib/index.js:297）——但本包没把 zod
 *  写进 dependencies（本仓 host 插件从不依赖它），所以**不许**让"zod 解析失败"变成模块链接期错误
 *  （那会拖垮整个插件树，正是 upstream.js 头注记过的老病）。拿不到就用恒等 schema：
 *  state 本来就是 plain JSON，parse 返回原值同样正确，只是丢掉恢复时的形状校验。 */
const identityStateSchema = { parse: (value) => value };
let moodStateSchema = identityStateSchema;
let zodUnavailable = false;
try {
  const { z } = await import('zod');
  moodStateSchema = z.object({
    tail: z.enum(['calm', 'prickly', 'smug', 'droopy']),
    level: z.number().int().min(0).max(2),
    causes: z.array(z.string()),
    since: z.number().nullable(),
    recent: z.object({ turn: z.number(), fails: z.number(), total: z.number() }),
    failStreak: z.number(),
    doneTurn: z.number(),
  });
} catch {
  zodUnavailable = true;
}

/** 导出真用的 stateSchema（live binding）：跨重启恢复时上游会无条件 `stateSchema.parse(缓存行)`
 *  （dsh-session-projection/lib/index.js:297），所以"schema 能不能 parse 真 state"是个必须能自证的
 *  契约面——留一个可被独立探针取用的出口，别让这条只在会话恢复失败时才暴露。 */
export { moodStateSchema as MoodStateSchema };

/** 投影初值（会话首见/无可用缓存行时用）。 */
export function initMood() {
  return {
    tail: 'calm',
    level: 0,
    causes: [],
    since: null,
    recent: { turn: 0, fails: 0, total: 0 },
    failStreak: 0,
    doneTurn: 0,
  };
}

/** 有限数字取值（事件字段不可信时的归一）。 */
function num(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 两条成因列表是否逐项相同（决定 fold 要不要返回新引用）。 */
function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 两个 state 是否逐字段相同（**无变化 ⇒ 调用方退回原引用**，上游 Object.is 判变）。 */
function sameMood(a, b) {
  return a.tail === b.tail
    && a.level === b.level
    && a.since === b.since
    && a.failStreak === b.failStreak
    && a.doneTurn === b.doneTurn
    && sameList(a.causes, b.causes)
    && a.recent.turn === b.recent.turn
    && a.recent.fails === b.recent.fails
    && a.recent.total === b.recent.total;
}

/** 追加/替换一条成因：同前缀的旧条目先移除（同类事件**去重**，2 次与 5 次不叠加两条），
 *  再按 ≤3 条封顶（超出丢最早的）。 */
export function upsertCause(causes, prefix, text) {
  const list = Array.isArray(causes) ? causes.filter((c) => typeof c === 'string') : [];
  const kept = list.filter((c) => !c.startsWith(prefix));
  return [...kept, text].slice(-MAX_CAUSES);
}

/** 主人消息文本（content 可能是 string 或 blocks；只取 text block）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** 工具失败真值（规格 §8 第 7/13 条）：只看 `message.content[0].isError === true`；
 *  `error.code === 'interrupted'`（被中断）**不算失败**；沙箱拒/命令非 0 退出都已是 isError，计入。 */
export function isToolFailure(event) {
  const block = event?.data?.message?.content?.[0];
  if (block?.isError !== true) return false;
  return event?.data?.error?.code !== 'interrupted';
}

/** 一条事件 → 候选 state（**纯 fold**：只用 event 自带的字段与时刻，不碰 Date.now/磁盘/日志）。 */
function reduceMood(base, event) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const time = num(event?.time, null);

  // ── turn/start：重置本轮统计；补结转「上一轮没有 turn/end」的连败 ──────────────────
  if (type === 'turn/start') {
    const turn = num(event?.data?.turn, null);
    if (turn === null) return base;
    // 上一轮统计还挂在 recent 上、而 doneTurn 没跟上 ⇒ 那一轮没有正常收尾（崩溃/中断/被取消）。
    const carried = base.recent.turn === turn - 1 && base.doneTurn < turn - 1 && base.recent.total > 0;
    const failStreak = carried && base.recent.fails > 0 ? base.failStreak + 1 : base.failStreak;
    const doneTurn = carried ? turn - 1 : base.doneTurn;
    const next = { ...base, recent: { turn, fails: 0, total: 0 }, failStreak, doneTurn };
    // 连败 ≥2 轮 ⇒ droopy（覆盖同轮失败）；已是 droopy 则不动，只由 since 决定退潮节奏。
    if (failStreak >= 2 && base.tail !== 'droopy') {
      return {
        ...next,
        tail: 'droopy',
        level: 2,
        since: time ?? base.since,
        causes: upsertCause(base.causes, '连续', `连续 ${failStreak} 轮有工具失败`),
      };
    }
    return next;
  }

  // ── turn/end：把本轮 recent 结转到 doneTurn / failStreak ─────────────────────────
  if (type === 'turn/end') {
    const turn = num(event?.data?.turn, null);
    if (turn === null) return base;
    const ownsTurn = base.recent.turn === turn;
    const failStreak = ownsTurn ? (base.recent.fails > 0 ? base.failStreak + 1 : 0) : base.failStreak;
    const next = { ...base, failStreak, doneTurn: Math.max(base.doneTurn, turn) };
    if (failStreak >= 2 && base.tail !== 'droopy') {
      return {
        ...next,
        tail: 'droopy',
        level: 2,
        since: time ?? base.since,
        causes: upsertCause(base.causes, '连续', `连续 ${failStreak} 轮有工具失败`),
      };
    }
    return next;
  }

  // ── tool/result：累加本轮统计；失败 ≥2 次 ⇒ prickly（droopy 优先，不降级） ─────────
  if (type === 'tool/result') {
    const failed = isToolFailure(event);
    const fails = base.recent.fails + (failed ? 1 : 0);
    const next = { ...base, recent: { ...base.recent, fails, total: base.recent.total + 1 } };
    if (!failed || fails < 2) return next;
    if (base.failStreak >= 2 || base.tail === 'droopy') {
      // 已在连败（droopy:2）⇒ 同一状态不重复加码：只刷新 since（让它退潮更慢）。
      return { ...next, since: time ?? base.since };
    }
    return {
      ...next,
      tail: 'prickly',
      level: 1,
      since: time ?? base.since,
      causes: upsertCause(base.causes, '本轮工具', `本轮工具连续 ${fails} 次失败`),
    };
  }

  // ── user/message：只认**主人**消息（plugin/tool 来源一律不算）；安抚 > 表扬 ────────
  if (type === 'user/message') {
    if (event?.data?.source?.kind !== 'user') return base;
    const text = messageText(event.data);
    if (!text) return base;
    if (SOOTHE_RE.test(text)) {
      // 安抚：压回负向情绪（覆盖表扬），成因清空。
      return { ...base, tail: 'calm', level: 0, causes: [], since: time ?? base.since };
    }
    if (PRAISE_RE.test(text) && !PRAISE_NEG_RE.test(text)) {
      return {
        ...base,
        tail: 'smug',
        level: Math.min(2, base.level + 1),
        since: time ?? base.since,
        causes: upsertCause(base.causes, '主人夸', '主人夸了一句'),
      };
    }
    return base;
  }

  return base;
}

/** 投影 apply：纯 fold + **单出口的变更判定**（无变化 ⇒ 退回原引用；绝不返回 undefined）。 */
export function applyMood(state, event) {
  const base = state && typeof state === 'object' ? state : initMood();
  const next = reduceMood(base, event);
  if (next === base) return base;
  return sameMood(next, base) ? base : next;
}

/** 有效强度（**只在注入时算，不写回投影、不改 level**）：`level - floor(elapsed/30min)`，下限 0；
 *  间隔 ≥24h ⇒ 冷启动（有效强度 0）。 */
export function effectiveLevel(state, now) {
  const level = num(state?.level, 0);
  if (level <= 0) return 0;
  const since = num(state?.since, null);
  if (since === null) return level;
  const elapsed = now - since;
  if (elapsed >= COLD_START_MS) return 0;
  const drop = Math.floor(Math.max(0, elapsed) / DECAY_STEP_MS);
  return Math.max(0, level - drop);
}

/** 人话时长（续注用）。 */
export function humanElapsed(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '不到 1 分钟';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`;
  if (hours > 0) return `${hours} 小时${rest > 0 ? ` ${rest} 分` : ''}`;
  return `${rest} 分钟`;
}

/** 注入文本（模板严格照规格 §5；**只给成因，不给台词**）。 */
export function renderMoodText(state, level, now, first) {
  const tail = TAIL_CN[state?.tail] ?? TAIL_CN.calm;
  const strength = LEVEL_CN[level] ?? String(level);
  const causes = Array.isArray(state?.causes) && state.causes.length > 0 ? state.causes.join('、') : '—';
  if (first) {
    return `【情绪状态 · 每轮刷新】尾巴：${tail}（${strength}）· 成因：${causes}。\n`
      + '只影响语气与尾巴，不影响结论、数字、验证标准（人设卡 §边界）。主人这轮要正经，就照主人。';
  }
  const since = num(state?.since, null);
  const elapsed = humanElapsed(now - (since ?? now));
  return `【情绪】${tail}（${strength}）· ${causes} · 距上轮 ${elapsed}，正在回落。`;
}

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根（与 mind-inject/session-budget 同源）。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

/** 会话 id（Session 实例的 `id`；退一步读 header.id）。取不到返回 ''（该会话不参与）。 */
function sidOf(session) {
  if (session && typeof session.id === 'string' && session.id) return session.id;
  const header = session && session.header;
  if (header && typeof header.id === 'string' && header.id) return header.id;
  return '';
}

/** 诊断 marker（追加式保留最近 20 行；写失败不影响插件——照 mind-inject/session-budget）。 */
function writeMarker(content) {
  try {
    const dir = join(repoRoot(), 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'mind-mood-marker.txt');
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), content].slice(-20);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch { /* 诊断标记失败不影响插件 */ }
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const warn = (...args) => ctx.logger?.('dshome')?.warn?.(...args);

    // 会话级注入记账：sid -> { seq, turn, ever }。seq = 注入消息在会话里的 seq（压缩遮蔽判据）。
    const injects = new Map();
    // 降级留痕去重（每会话一次，别每步刷屏）。
    const degraded = new Set();

    const projections = ctx.sessionProjections;
    if (!projections || typeof projections.register !== 'function') {
      // 服务缺失 ⇒ 状态无处安放：不注册投影、也不注入（本仓 inject 已声明该服务，正常 profile 走不到这）。
      warn('dshome-mind-mood: sessionProjections 服务不可用 → 情绪状态停用');
      writeMarker(`apply: degraded — sessionProjections unavailable @ ${new Date().toISOString()}`);
      return;
    }

    /** 在场判据不可用时的留痕（每会话一次）：退化为「每轮至多一次」。 */
    const noteDegraded = (sid, why) => {
      if (degraded.has(sid)) return;
      degraded.add(sid);
      writeMarker(`degraded: ${why} @ ${new Date().toISOString()}`);
      warn('dshome-mind-mood: 在场判据不可用（%s）→ 退化为每轮至多一次', why);
    };

    // ① 投影注册（状态存储）：纯 fold + 单出口变更判定。注册必须在会话 hydrate 之前完成
    //    （启动期 apply 里注册即满足）——跨重启由上游 checkpoint restore 恢复（规格 §8 第 6 条）。
    projections.register({
      key: MOOD_KEY,
      stateVersion: MOOD_STATE_VERSION,
      stateSchema: moodStateSchema,
      init: () => initMood(),
      apply: (state, event) => applyMood(state, event),
    });

    // ② 会话事件：认出**本插件注入的** user/message，记下它的 seq（agent-loop:1028 会把它 append 成
    //    带 surfaceOp:'append' 的 user/message 事件）。只补「刚注过、seq 还没落」的那一条。
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'user/message') return;
        const source = event.data?.source;
        if (source?.kind !== 'plugin' || source.plugin !== name || source.form !== 'snapshot') return;
        const sid = sidOf(session);
        if (!sid) return;
        const rec = injects.get(sid);
        if (!rec || rec.seq !== null) return;
        const seq = num(event.seq, null);
        if (seq === null) return;
        rec.seq = seq;
      } catch (error) {
        warn('dshome-mind-mood: 会话事件处理失败 %O', error);
      }
    });

    // ③ 注入：每轮第一步一次（`{prepend:true}` 保证最外层包装 decision）+ 压缩遮蔽后自愈补注。
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next();
      try {
        if (decision?.kind === 'reject' || signal?.aborted === true) return decision;
        if (!createUserMessage) return decision; // 上游导出缺失 → 静默跳过（apply 期已留痕）
        // 子代理（成员）会话跳过注入（判据逐字照 session-budget.js:337；spec §6 V8）。
        if (agent?.session?.header?.origin === 'subagent') return decision;
        const session = agent?.session;
        const sid = sidOf(session);
        if (!sid) return decision;

        const rec = injects.get(sid) ?? null;
        const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : null;
        const trackedSeq = rec && Number.isSafeInteger(rec.seq) ? rec.seq : null;
        // 在场判定：true=在场 / false=**确知被遮蔽** / null=判不了（退化为每轮至多一次）。
        const onSurface = nodes !== null && trackedSeq !== null ? nodes.includes(trackedSeq) : null;
        const sameTurn = rec !== null && rec.turn === turn;
        if (step !== 1) {
          // 非首步：只有「确知注入已被压缩遮蔽」才补注（规格 §8 第 4 条：压缩在回合中途不重置 step，
          // 只判 step===1 会在遮蔽后永不回补）；在场或判不了都退化为每轮一次。
          if (onSurface !== false) {
            if (onSurface === null) noteDegraded(sid, 'surface.nodes/注入 seq 不可得（非首步）');
            return decision;
          }
        } else if (sameTurn && onSurface !== false) {
          return decision; // 幂等：本轮已注过且仍在场（或判不了）
        }

        const state = projections.stateOf(session, MOOD_KEY);
        if (!state || typeof state !== 'object') return decision; // 投影不可读 ⇒ 不猜、不注入
        const now = Date.now();
        const level = effectiveLevel(state, now);
        if (level <= 0) return decision; // 静默＝一切如常（不注入"本鱼现在很平静"）

        const first = rec?.ever !== true;
        const text = renderMoodText(state, level, now, first);
        const moodMessage = createUserMessage({
          content: [{ type: 'text', text }],
          // 官方 form 白名单内的 `snapshot`（message.d.ts:42-54）：语义＝某时刻的状态快照，
          // 且必须带 `sections`（同 :71-89）。**不用**白名单外的值。
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        });
        if (!Array.isArray(decision.messages)) return decision; // 无消息通道 ⇒ 静默跳过（不记账）
        // 追加队列尾部（规格 §8 第 1 条），不抢占 R0/R1 在 claimed 之后的位次。
        writeMarker(`inject: tail=${state.tail} level=${level} len=${text.length} @ ${new Date().toISOString()}`);
        // 先记账再返回：seq 待 ② 从会话事件里补（补不到 ⇒ 下轮退化为每轮一次）。
        injects.set(sid, { seq: null, turn, ever: true });
        return { ...decision, messages: [...decision.messages, moodMessage] };
      } catch (error) {
        warn('dshome-mind-mood: 注入失败 %O', error);
      }
      return decision;
    }, { prepend: true });

    // ④ 会话销毁 → 清状态（避免内存随会话数长存；照 session-budget.js:368）。
    ctx.on('session/disposed', (session) => {
      try {
        const sid = sidOf(session);
        if (!sid) return;
        injects.delete(sid);
        degraded.delete(sid);
      } catch (error) {
        warn('dshome-mind-mood: 清理失败 %O', error);
      }
    });

    if (zodUnavailable) writeMarker(`apply: degraded — zod 不可用（stateSchema 退回恒等） @ ${new Date().toISOString()}`);
    writeMarker(`apply: registered @ ${new Date().toISOString()}`);
    ctx.logger?.('dshome')?.info?.('dshome-mind-mood: 情绪状态投影 + 每轮首步注入钩子已挂载');
  } catch (error) {
    ctx.logger?.('dshome')?.warn?.('dshome-mind-mood: 初始化失败 %O', error);
  }
}
