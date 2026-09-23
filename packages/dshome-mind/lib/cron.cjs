// dshome-mind/lib/cron.cjs — cron 自治：定时拉起 agent 会话执行任务。
// 蓝图：dsh-scheduler executor.js（rc.8）。rc.2 等价 API 已确认：
//   agents.create / installModelSelection / createMessage / agent.followup。
// 存储：mind-private/tasks/cron.json（任务 + prompt + cron 表达式）。
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Cron } = require('croner');

let warnedHomeIgnored = false;
function repoRoot() {
  if (process.env.DSH_HOME && fs.existsSync(path.join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  // 🔴 2026-09-18 响亮化（实伤驱动）：`DSH_HOME` 设了但**不含 `mind/` 子目录**时，原来**静默**回落真仓库根。
  //    实伤：一次临时根只建了 `mind-private/` 的探针 ⇒ 把**生产** `cron-runs.jsonl` 写成 4500 行垃圾、
  //    真记录被覆盖且不可恢复（该文件 gitignored、无快照）。回落本身是**安全设计**（拒绝把非心智目录当根），
  //    错的只是"静默"——本行让"回落"可见。测试/探针用临时根请**同时建 `mind/`**。
  if (process.env.DSH_HOME && !warnedHomeIgnored) {
    warnedHomeIgnored = true;
    console.warn(`[dshome-cron] ⚠️ DSH_HOME=${process.env.DSH_HOME} 不含 mind/ 子目录 ⇒ 回落真仓库根 ${path.resolve(__dirname, '../../..')}；若这是测试临时根，会写到**生产**台账`);
  }
  return path.resolve(__dirname, '../../..');
}
const CRON_FILE = () => path.join(repoRoot(), 'mind-private', 'tasks', 'cron.json');

/** 自治 run 结果台账（JSONL·**追加不覆盖**）：`mind-private/tasks/cron-runs.jsonl`。
 *  为什么需要（2026-09-12 三参照物清单 P0-①）：`run()` 过去拿「会话被创建」当成功 ⇒ 自治会话
 *  真跑挂了也照样写 `lastRunAt`，09-09/09-10 连崩两天无人知。台账让"跑了但没成"变成可查事实。 */
const CRON_RUNS_FILE = () => path.join(repoRoot(), 'mind-private', 'tasks', 'cron-runs.jsonl');

/** `turn/end` 的 `reason.kind` → 运行结果。形状取自上游 `dsh-session` 的 `TurnEndReasonMap`
 *  （`completed` / `error` / `max-tokens` / `aborted` / `blocked` / `interrupted`…），
 *  仓内先例＝`packages/dshome/lib/host/notify.js:96`（读的也是 `event.data.reason?.kind`）。
 *  🔴 反例（写不出反例＝没验过）：形状再变也**不许静默**——未知/缺失 reason 落 `unknown`，
 *     绝不当作 ok；`error`/`max-tokens` 等一律非 ok。 */
function outcomeOfTurnEnd(event) {
  const kind = event?.data?.reason?.kind;
  if (kind === 'completed') return { status: 'ok' };
  if (kind === undefined) return { status: 'unknown', errorCode: 'no-reason-kind' };
  return { status: 'error', errorCode: String(kind) };
}

/** 追加一条 run 记录。台账写坏不抛（不能反过来影响自治），但**响亮告警**。 */
/** 台账上界（2026-09-18 加）：超限保留**后半**——台账是为了可查，不该无界增长。
 *  实测体量本就有界（2 条/日 ≈ 150KB/年），此为上界保险：万一任务被配成"每分钟型"也不会撑爆。 */
const LEDGER_MAX_BYTES = 512 * 1024;
function trimLedgerIfNeeded(file) {
  try {
    if (fs.statSync(file).size <= LEDGER_MAX_BYTES) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(-Math.max(1, Math.floor(lines.length / 2))).join('\n') + '\n');
    return true;
  } catch { return false; }
}
function appendCronRun(rec) {
  try {
    const f = CRON_RUNS_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(rec) + '\n');
    if (trimLedgerIfNeeded(f)) console.warn('[dshome-cron] run 台账超上界，已保留后半（最旧的被裁——台账是"可查"不是"全存"）');
    return true;
  } catch (e) {
    console.warn('[dshome-cron] run 台账写入失败（自治本身不受影响）:', e?.message ?? e);
    return false;
  }
}

// ── 任务级模型 → 完整 selection 对象 {provider, model} ─────────────────────
// 系统提示的 {{model}} 取自 selection.model，而 selection 契约要求 {provider, model}
// 一对（见 dsh-agent installModelSelection 取 selected.provider/selected.model，
// dsh-agent-default-model.currentSelection() 返回同形状对象）。只塞模型名（字符串）
// 会让底层取到 selected.model === undefined → 组 prompt 时
// 「prompt variable "{{model}}" has no value (section "deployment:persona")」
// → 自治会话第一句就崩。故此处统一归一；拿不到 provider 宁可不装选择。
function normalizeModel(raw, fallback) {
  const fb = (fallback && typeof fallback === 'object' && fallback.model) ? fallback : null;
  if (raw === undefined || raw === null || raw === '') return fb;
  if (typeof raw === 'string') {
    // 旧数据 / 简写：默认 provider + 该模型名。不继承默认 reasoningEffort——
    // 换了模型可能不支持那个档位，缺省让适配器用新模型自己的默认行为。
    return fb ? { provider: fb.provider, model: raw } : null;
  }
  if (typeof raw === 'object' && typeof raw.model === 'string' && raw.model) {
    const provider = (typeof raw.provider === 'string' && raw.provider) ? raw.provider : (fb ? fb.provider : null);
    if (!provider) return null;
    return { provider, model: raw.model, ...(raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}) };
  }
  return fb;
}

// ── 到点执行：新建 agent 会话 + 注入 prompt + followup 驱动 ────────────────
async function executeTask(hostCtx, task) {
  try {
    const agents = hostCtx.get('agents');
    if (agents === undefined || typeof agents.create !== 'function') {
      return { status: 'failed', error: 'agents 服务不可用（dsh-agent 未组合）' };
    }
    const sessionId = randomUUID();
    const defaultModel = hostCtx.get('agentDefaultModel')?.currentSelection?.();
    const modelChoice = normalizeModel(task && task.model, defaultModel); // 任务级模型优先，统一归一成 {provider, model}
    if (task && task.model && !modelChoice) {
      console.warn('[dshome-cron]', task.id, '：model 缺 provider 无法归一，本次按无模型选择运行');
    }
    const { agent } = await agents.create({
      sessionId,
      meta: { cwd: task.cwd ?? process.cwd() },
      setup: async (agentCtx) => {
        // 低层 agents.create 不会自动把 agent 加入任何 agent preset。若不 mount，该会话的
        // 工具/提示词/skills 会解析到空的 global 层，只剩宿主平面插件（如 AgentTeams）注册的
        // 工具——没有 read/glob/grep/write/edit/pwsh/web，定时任务 A+B 根本无法执行。
        // 每个任务可显式指定 agent preset（cron.json 的 "preset" 字段）；未指定时缺省用
        // 出厂全量 "standard"（不挂 router-bootstrap，因此无渐进门控），让定时任务真正具备
        // 文件/Shell/检索/网页工具，不会卡在阶段 0 拿不到 write/pwsh。
        const presetId = (task && task.preset) || 'standard';
        const presets = agentCtx?.get?.('agentPresets');
        if (presets && typeof presets.mount === 'function') {
          // 挂载失败（如 preset id 不存在）即抛错：宁可任务报 failed，也不让它跑成
          // 一个"只写报告、干不了活"的空壳会话。
          await presets.mount(agentCtx, presetId);
        } else {
          console.warn('[dshome-cron] agentPresets unavailable; cron agent may run with empty tool layer');
        }
        // 低层 agents.create 不装模型选择，系统提示 {{model}} 会 undefined
        if (modelChoice) {
          const { installModelSelection } = require('@deepseek-ai/dsh-agent');
          installModelSelection(agentCtx, { current: modelChoice, assembled: undefined });
        }
      },
    });
    // ── 登记进工作区（2026-09-23 加）─────────────────────────────────────────────
    // 病灶（2026-09-23 实测）：`executeTask` 走的是**低层 `agents.create`**，不经 GUI
    //   「新建会话」那条登记路径 ⇒ 这些自治会话**从不进入 workspace 名册**（`sessionIds`），
    //   于是侧边栏按 `dsh-client-ui-workspace` 的 `sessionVisible()` 判据把它们归进
    //   **「未分组」（Ungrouped）**——实测本机 4 条全是 cron 会话（self-clean ×2 / self-feed ×1 /
    //   另一条），且**每跑一次就多一条、只增不减**。
    // 修法：建完会话补一次 `entity.attachSession(sessionId)`（官方登记动作），与普通会话同待遇。
    //   路径口径与 host 一致：用包导出的 `realpathNormalize`（该包唯一的 uniqueness canon）。
    //   失败只告警、**不影响任务执行**（登记是侧边栏归属，不是任务前置条件）。
    try {
      const workspace = hostCtx.get('workspace');
      if (workspace && typeof workspace.list === 'function') {
        const { realpathNormalize } = require('@deepseek-ai/dsh-workspace');
        const cwd = task.cwd ?? process.cwd();
        let cwdCanon = null;
        try { cwdCanon = await realpathNormalize(cwd); } catch { cwdCanon = null; }
        if (cwdCanon === null) {
          console.warn('[dshome-cron]', task.id, '：cwd 非完整限定路径或不存在的目录，会话不登记工作区（将落「未分组」）:', String(cwd));
        } else {
          let attached = false;
          for (const entity of workspace.list()) {
            const p = entity && entity.record && entity.record.path;
            if (typeof p !== 'string' || typeof entity.attachSession !== 'function') continue;
            let pCanon = null;
            try { pCanon = await realpathNormalize(p); } catch { pCanon = null; }
            if (pCanon !== null && pCanon === cwdCanon) { await entity.attachSession(sessionId); attached = true; break; }
          }
          if (!attached) {
            console.warn('[dshome-cron]', task.id, '：无匹配的工作区注册，本会话将落「未分组」（可在侧边栏「添加目录」后重跑）:', cwdCanon);
          }
        }
      } else {
        console.warn('[dshome-cron]', task.id, '：workspace 服务不可用，本会话将落「未分组」');
      }
    } catch (e) {
      console.warn('[dshome-cron]', task.id, '：工作区登记失败（不影响任务执行）:', e && e.message);
    }
    const { createMessage } = require('@deepseek-ai/dsh-llm');
    // 上工自动召回：把 mind-prime 的输出预置进任务 prompt（定时任务开机即带上下文，不靠 agent 记得）。
    let primeContext = '';
    try {
      const { execFileSync } = require('child_process');
      primeContext = execFileSync(process.execPath, [path.join(repoRoot(), 'scripts', 'mind-prime.mjs')], { cwd: repoRoot(), encoding: 'utf8', timeout: 15000 }).toString().trim();
    } catch (e) { primeContext = ''; console.warn('[dshome-cron] mind-prime failed:', e.message); }
    const prompt = primeContext ? `${primeContext}\n\n===== 任务 =====\n\n${task.prompt}` : task.prompt;
    const message = createMessage({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dshome-mind' },
    });
    agent.followup(message);
    return { status: 'created', sessionId: String(agent.id) };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

// ── 串行闸：自治会话同时只跑一个（2026-09-14 加，用户放行）───────────────────
// 病灶（当日实测）：`catchUpMissed()` 用一次 for 循环把**所有错过点**几乎同时 executeTask
//   —— 2026-09-14 09:07:25 实测 self-clean(.045s) / self-feed(.126s) 相差 80ms ⇒ 多个自治
//   会话并发跑（一个 12 分钟、一个 22 分钟），期间并发写同一批文件（evolve-log 账本、
//   各 `_index.md`、`Tree.md`）。croner 的 `protect` 只防「同一 job 自我重叠」，跨任务无效；
//   executeTask 在 followup 后立即返回，也拦不住「会话还在慢慢跑」。
// 口径：同一进程内**同时只跑一个自治会话**；到点却忙 → 入队，等当前自治会话 turn/end
//   或 session/disposed 后依序补跑（不丢、不并发）。
// 加法槽：复用现成的会话事件面 `sessions.on('session/event')`（写法同 `dshome/lib/host/notify.js`），
//   不新增机制、不动宿主。
// 失败面（fail-open）：拿不到 sessions 服务 / 事件丢失 ⇒ `BUSY_MAX_MS` 兜底强制放闸，
//   最坏降级成旧行为（并发不保证），但**绝不把队列卡死**。
const BUSY_MAX_MS = 45 * 60 * 1000; // 单会话占闸上限（防 turn/end 事件丢失）
// 补跑前的**等闸**上限（2026-09-23 修 · 见 `deferCatchUp`）：
//   `watching = true` 写在 `hostCtx.inject` 的**回调**里，而真宿主该回调**不是同步调用** ⇒
//   原 `start()` 里"先接事件、再 catchUp"的顺序保证**不成立**（2026-09-23 实测同型复发）。
//   env 覆盖只给测试用（`DSHOME_CRON_GATE_WAIT_MS`）：itest 要能把 30s 压到几百毫秒，
//   否则"等满上限则放行"这条失败面**没法在测试里验**。
const GATE_WAIT_MS = Number(process.env.DSHOME_CRON_GATE_WAIT_MS) > 0
  ? Number(process.env.DSHOME_CRON_GATE_WAIT_MS) : 30 * 1000;
const GATE_POLL_MS = 500; // 等闸轮询间隔（仅兜底；闸一接上会**主动**叫醒，见 watchSessions）

// ── 任务存储 ────────────────────────────────────────────────────────────────
function loadCron() {
  try { return JSON.parse(fs.readFileSync(CRON_FILE(), 'utf8')).tasks || []; }
  catch { return []; }
}
function saveCron(tasks) {
  fs.mkdirSync(path.dirname(CRON_FILE()), { recursive: true });
  fs.writeFileSync(CRON_FILE(), JSON.stringify({ tasks }, null, 2));
}

// ── 调度器（croner，防重叠）─────────────────────────────────────────────────
class DshCron {
  constructor(hostCtx) {
    this.hostCtx = hostCtx;
    this.jobs = new Map();
    this.tasks = loadCron();
    this.active = new Map(); // sessionId|'pending:<uuid>' -> { id: 任务 id, since: ms }（占闸中的自治会话）
    this.queue = []; // [{ id, reason, at }]（到点却忙 → 排队，放闸后依序补跑）
    this.watching = false; // 串行闸是否真的接上了 sessions 事件
    this._gateTimer = null; // 等闸轮询定时器（deferCatchUp）
    this._gateTick = null;  // 闸接上时**主动**叫醒补跑的钩子（不必干等一轮轮询）
  }
  start() {
    for (const t of this.tasks) this.schedule(t);
    this.watchSessions(); // 必须先接事件，再 catchUp —— 否则补跑建出的会话漏听 turn/end（闸卡死）
    this.deferCatchUp();  // 重启补跑：**等闸接上再发**（2026-09-23 修 · 见 deferCatchUp 注释）
    this.timer = setInterval(() => this.reload(), 60000); // 每分钟扫新任务/改动
  }
  /** 补跑**必须等闸接上**（2026-09-23 修 · 实测同型复发）─────────────────────────────
   *  病灶：原实现 `watchSessions(); catchUpMissed();` 是**同步**连着的，而 `watching = true`
   *    写在 `hostCtx.inject(['sessions'], cb)` 的**回调里**——真宿主该回调**不是同步调用**
   *    ⇒ 补跑的任务全落在 `watching === false` 的窗口内 ⇒ `trigger()` 走 fail-open 降级分支
   *    （**不查 `isBusy()`，直接 `run()`**）⇒ 并发。
   *    实测（本机 2026-09-23）：`self-clean` 与 `self-feed` 的会话 `createdAt` 相差 **2ms**
   *    （22:43:34.031 / .033），并发跑了 3 分 51 秒；与 2026-09-14 那次"差 80ms"**同型复发**。
   *    而这条路径**每次重启都会走**（catch-up 是启动必经），不是罕见边角。
   *  修法：拿不到闸就**等**（轮询 + 闸接上时主动叫醒），接上再补跑。
   *  失败面（仍 fail-open，但**不静默**）：等满 `GATE_WAIT_MS` 还没接上 ⇒ **响亮告警** +
   *    按旧行为补跑 —— "不并发"不能以"不跑"为代价（原注释担心的正是队列卡死）。
   *  口径提醒：**并发会话本身不是问题，同时改同一个东西才是**（L2 技能 `concurrent-writers`）。
   *    本闸是**粗粒度兜底**（整会话串行），不是文件级互斥；它失效的代价是撞车概率上升，
   *    而不是"必然出错"——所以这里只做"尽量不并发 + 降级必留痕"，不假装它是写锁。
   */
  deferCatchUp() {
    if (this.watching === true) { this.catchUpMissed(); return; }
    const t0 = Date.now();
    let done = false; // 只放行一次（tick 有两条触发路：主动叫醒 + 轮询）
    const tick = () => {
      if (done) return; // 去重（见 itest D1：旧实现漏了 clearTimeout ⇒ 同一实例补跑两遍）
      if (this._gateTimer) clearTimeout(this._gateTimer); // 🔴 只置 null 是"丢引用"，定时器照跑
      this._gateTimer = null;
      this._gateTick = null;
      if (this.watching === true) {
        done = true;
        console.log('[dshome-cron] 串行闸已接上（等了 ' + (Date.now() - t0) + 'ms）→ 补跑错过的任务');
        this.catchUpMissed();
        return;
      }
      if (Date.now() - t0 >= GATE_WAIT_MS) {
        done = true;
        // 响亮失败（Invariants #14）：绝不静默降级——这条 warning 是"本次补跑不保证串行"的唯一现场证据。
        console.warn(`[dshome-cron] ⚠️ 等待串行闸 ${GATE_WAIT_MS}ms 仍未接上（sessions 不可用）`
          + ' ⇒ 按旧行为补跑：**不保证不并发**（2026-09-14 / 09-23 两次并发的成因就是这条路径），'
          + '但绝不把补跑卡死。请查 sessions 为何不可用。');
        this.catchUpMissed();
        return;
      }
      this._gateTimer = setTimeout(tick, GATE_POLL_MS);
    };
    this._gateTick = tick;
    this._gateTimer = setTimeout(tick, GATE_POLL_MS);
  }
  /** 订阅会话事件：自治会话结束 → 放闸 + 依序补跑队列。 */
  watchSessions() {
    if (typeof this.hostCtx?.inject !== 'function') {
      console.warn('[dshome-cron] 上下文无 inject：串行闸降级（退回旧行为，不保证不并发）');
      return;
    }
    try {
      this.hostCtx.inject(['sessions'], (sctx) => {
        const offEvent = sctx.on('session/event', (session, event) => {
          if (event?.type !== 'turn/end') return;
          const sid = String(session?.header?.id);
          // 🔴 先取任务身份再 release（release 会把这个 sid 从 active 里删掉）。
          //    只在"这条会话是我们拉起的自治会话"时记账 ⇒ 用户会话/子代理的 turn/end 不污染台账。
          const at = this.active.get(sid);
          if (at) {
            this.recordRun(at.id, {
              sessionId: sid, ...outcomeOfTurnEnd(event),
              durationMs: Date.now() - at.since, source: 'turn-end',
            });
          }
          this.release(sid);
        });
        const offDisposed = sctx.on('session/disposed', (session) => this.release(String(session?.header?.id)));
        this.watching = true;
        // 闸一接上就**主动**叫醒等闸中的补跑（2026-09-23 加）：否则要干等一轮 GATE_POLL_MS。
        // 叫醒失败也无妨——`_gateTimer` 的轮询会兜底（不把补跑挂在"这一行必须成功"上）。
        try { this._gateTick?.(); } catch { /* 兜底见 _gateTimer 轮询 */ }
        this._stopWatch = () => { try { offEvent?.(); offDisposed?.(); } catch { /* dispose 期忽略 */ } };
      });
    } catch (e) {
      console.warn('[dshome-cron] sessions 订阅失败：串行闸降级（' + (e?.message ?? e) + '）');
    }
  }
  /** 闸：有活着的自治会话 → 入队；否则立刻跑。 */
  trigger(task, reason) {
    // 降级面（诚实优先）：拿不到 sessions 事件 ⇒ 无法知道会话什么时候结束，
    //   **不能入队**——否则队列永远等不到放闸（实测反例：只入队不补跑，任务静默延迟）。
    //   此时退回旧行为（不串行、但一定跑），并只提醒一次。
    if (this.watching !== true) {
      if (this._warnedDegrade !== true) {
        this._warnedDegrade = true;
        console.warn('[dshome-cron] 串行闸未接上（sessions 不可用）：退回旧行为 —— 不保证不并发，但不会入队卡死');
      }
      // 降级**必留痕**（2026-09-23 补 · 可观测缺口）：此前降级事实只进 `console.log`（stdout，
      //   被壳 `pipe` 消费后不留存）⇒ 事后从持久记录**看不出这次走没走降级**——当日复盘就卡在这，
      //   只能靠两条会话 `createdAt` 相差 2ms 反推。现在落一条台账（`status:'degraded'`）。
      this.recordDegrade(task.id, reason);
      this.run(task, reason + '+unserialized');
      return;
    }
    // 去重（两条都要）：① 已在队列里 → 不重复入队 ② 这个任务正跑着又来一次 tick
    //   → 跳过（等价 croner protect 的语义，否则「每分钟型」任务会在长会话期间堆成 N 条队列，
    //   放闸后连跑 N 次）。跳过只记日志，静默即违规（Invariants #14）。
    if (this.queue.some((q) => q.id === task.id)) {
      console.log('[dshome-cron]', task.id, 'skip:already-queued', `(reason=${reason})`);
      return;
    }
    if ([...this.active.values()].some((v) => v.id === task.id)) {
      console.log('[dshome-cron]', task.id, 'skip:already-running', `(reason=${reason})`);
      return;
    }
    if (this.isBusy()) {
      this.queue.push({ id: task.id, reason, at: Date.now() });
      console.log('[dshome-cron]', task.id, 'queued:busy', `(reason=${reason}, 队列=${this.queue.length})`);
      return;
    }
    this.run(task, reason);
  }
  isBusy() {
    const now = Date.now();
    for (const [sid, v] of this.active) {
      if (now - v.since > BUSY_MAX_MS) {
        this.active.delete(sid);
        console.warn('[dshome-cron] 占闸超时释放（疑似 turn/end 丢失）:', sid, v.id);
        // 超时同样落台账（P0-①）：这条会话**从没回过 turn/end**，属于"跑了但没结果"，不许静默。
        this.recordRun(v.id, {
          sessionId: sid, status: 'timeout',
          errorCode: `no-turn-end>${Math.round(BUSY_MAX_MS / 60000)}min`,
          durationMs: now - v.since, source: 'busy-timeout',
        });
      }
    }
    return this.active.size > 0;
  }
  release(sessionId) {
    if (!this.active.has(sessionId)) return; // 非自治会话（用户会话/子代理）—— 不管
    this.active.delete(sessionId);
    console.log('[dshome-cron] release', sessionId, `(剩 ${this.active.size} 个在跑)`);
    this.drain();
  }
  /** 放闸即补跑：队列里的任务依序跑，跑一个又占住闸，天然串行。 */
  drain() {
    while (!this.isBusy() && this.queue.length) {
      const next = this.queue.shift();
      const task = this.tasks.find((t) => t.id === next.id);
      if (!task || task.enabled === false) { console.log('[dshome-cron] queue drop', next.id, '（已删/已停用）'); continue; }
      this.run(task, next.reason + '+queued');
    }
  }
  /** 记一次自治 run 的**真实结果**：JSONL 台账 + 任务上的 `lastResult` + 非成功时**响亮告警**。
   *  `lastRunAt` 语义保持不变（= 触发时刻，供 missed 补跑判定）——本函数补的是"**成没成**"，
   *  而不是改"跑没跑过"（改它会引来持续失败时的补跑风暴）。 */
  recordRun(taskId, info) {
    const rec = { ts: new Date().toISOString(), taskId, ...info };
    appendCronRun(rec);
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) {
      task.lastResult = {
        at: rec.ts, status: rec.status,
        ...(rec.errorCode !== undefined ? { errorCode: rec.errorCode } : {}),
        ...(rec.sessionId !== undefined ? { sessionId: rec.sessionId } : {}),
      };
      saveCron(this.tasks);
    }
    if (rec.status !== 'ok') {
      console.error(`[dshome-cron] ❗自治 run 非成功：task=${taskId} status=${rec.status}`
        + `${rec.errorCode !== undefined ? ' code=' + rec.errorCode : ''}`
        + ` session=${rec.sessionId ?? '—'}（不再静默；台账 mind-private/tasks/cron-runs.jsonl）`);
    }
    return rec;
  }
  /** 降级**事件**台账（2026-09-23 加 · 补可观测缺口）────────────────────────────────
   *  与 `recordRun`（"跑成没成"）**分账**：这里记的是"**闸没接上也照样发了**"。
   *  为什么不复用 `recordRun`：它会写 `lastResult`，而 `lastResult` 的语义是"成没成"——
   *  被降级事件污染之后，"这个任务上次成功了吗"就再也答不准了。
   *  ⚠️ 只落台账 + 响亮告警，**不改任何判定**（降不降级由 `watching` 决定）。 */
  recordDegrade(taskId, reason) {
    try {
      appendCronRun({
        ts: new Date().toISOString(), taskId,
        status: 'degraded', errorCode: 'gate-not-attached', source: `${reason}+unserialized`,
      });
    } catch { /* 留痕失败不影响任务本身 */ }
    console.error(`[dshome-cron] ❗串行闸未接上仍发出：task=${taskId} reason=${reason}`
      + '（本次**不保证与其它自治会话不并发**；台账 mind-private/tasks/cron-runs.jsonl）');
  }
  /** 真正拉会话：**同步占闸**（防同一 tick 双发），成功后换成真实 sessionId。 */
  run(task, reason) {
    const token = 'pending:' + randomUUID();
    this.active.set(token, { id: task.id, since: Date.now() });
    executeTask(this.hostCtx, task).then((r) => {
      this.active.delete(token);
      console.log('[dshome-cron]', task.id, r.status, r.error || `session=${r.sessionId || ''}`, `(reason=${reason})`);
      if (r.status === 'created') {
        // 只在闸接上时才占闸（降级面不跟踪，免得 active 永久积累没人放闸）
        if (this.watching === true) this.active.set(String(r.sessionId), { id: task.id, since: Date.now() }); // 交棒给真实会话
        // 记录实际触发时间（供 missed 补跑判定）
        task.lastRunAt = new Date().toISOString();
        saveCron(this.tasks);
        // 一次性任务：跑完自动移除 + 停表
        if (task.once) {
          this.unschedule(task.id);
          this.tasks = this.tasks.filter((x) => x.id !== task.id);
          saveCron(this.tasks);
        }
      } else {
        // 🔴 executeTask 自己就失败了（agents 服务不可用 / preset 挂载抛错…）：**不再只打一行日志**
        //    —— 过去这行日志闪过就没了，任务照样算"跑过"（P0-① 的病根）。
        this.recordRun(task.id, {
          status: 'error', errorCode: String(r.error ?? r.status ?? 'unknown'), source: 'create',
        });
      }
      if (!this.isBusy()) this.drain(); // 没占上闸（failed）/ 一次性已移除 → 别让队列干等
    }).catch((e) => {
      this.active.delete(token);
      console.error('[dshome-cron] execute error', e);
      // 拉会话这一步就抛了：同样落台账（P0-①：不许只在控制台一闪而过）
      this.recordRun(task.id, { status: 'error', errorCode: String(e?.message ?? e), source: 'create-throw' });
      if (!this.isBusy()) this.drain();
    });
  }
  schedule(task) {
    this.unschedule(task.id);
    // 停用任务：保留在 tasks（可再启用），但不建 job（不触发）
    if (task.enabled === false) return true;
    try {
      const tz = typeof task.timezone === 'string' ? { timezone: task.timezone } : {};
      const job = new Cron(task.cron, { protect: true, ...tz }, () => {
        this.trigger(task, 'tick'); // 串行闸：忙则入队，不并发（见文件头「串行闸」）
      });
      this.jobs.set(task.id, job);
      return true;
    } catch { return false; }
  }
  /** 重启补跑：上次实际跑过（有 lastRunAt）之后有"该触发点"已过去 → 错过，立即补跑一次。 */
  catchUpMissed() {
    for (const t of this.tasks) {
      const job = this.jobs.get(t.id);
      if (!job) continue;
      // 任务级开关：只有显式 catchUp:true 的任务才补跑（幂等/每日型补；提醒/一次性/敏感型不补）
      if (t.catchUp !== true) continue;
      if (!t.lastRunAt) { t.lastRunAt = new Date().toISOString(); saveCron(this.tasks); continue; }
      const next = job.nextRun(new Date(t.lastRunAt));
      if (next && next < new Date()) {
        console.log('[dshome-cron] catch-up missed:', t.id, '->', next.toISOString());
        // 串行闸：错过的多个任务不再一起发（原病灶就是这里并发），逐一到队、放闸依序跑
        this.trigger(t, 'catch-up');
      }
    }
  }
  unschedule(id) {
    const j = this.jobs.get(id);
    if (j) { j.stop(); this.jobs.delete(id); }
  }
  reload() {
    this.tasks = loadCron();
    for (const t of this.tasks) if (!this.jobs.has(t.id)) this.schedule(t);
    this.drain(); // 每分钟兜底：占闸超时（turn/end 事件丢失）被 isBusy() 剪掉后，队列靠这里继续跑
  }
  clear() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    if (this.timer) clearInterval(this.timer);
    // 等闸轮询也要停（2026-09-23）：否则 clear() 之后它还醒过来补跑一次——测试里会串场，
    //   运行期则是"已 dispose 的实例仍拉起会话"。清掉钩子，让 tick 没有下一个触发点。
    if (this._gateTimer) clearTimeout(this._gateTimer);
    this._gateTimer = null;
    this._gateTick = null;
    try { this._stopWatch?.(); } catch { /* ignore */ }
    this._stopWatch = null;
    this.watching = false;
    this.active.clear();
    this.queue = [];
  }
  // ── 面板管理：增/删/启停/列表 ──────────────────────────────────────────────
  nextRunFor(id) {
    const job = this.jobs.get(id);
    return job ? (job.nextRun() ? job.nextRun().toISOString() : null) : null;
  }
  list() {
    return this.tasks.map((t) => ({
      ...t,
      enabled: t.enabled !== false,
      nextRun: this.nextRunFor(t.id),
      running: this.active.size > 0 && [...this.active.values()].some((v) => v.id === t.id),
      queued: this.queue.some((q) => q.id === t.id),
    }));
  }
  add(task) {
    const id = task.id || ('cron-' + require('crypto').randomUUID().slice(0, 8));
    if (!task.cron || !task.prompt) return { ok: false, error: 'cron+prompt required' };
    if (this.tasks.some((t) => t.id === id)) return { ok: false, error: 'id exists' };
    const t = { ...task, id, enabled: task.enabled !== false };
    this.tasks.push(t);
    this.schedule(t);
    saveCron(this.tasks);
    return { ok: true, id };
  }
  remove(id) {
    const before = this.tasks.length;
    this.unschedule(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return { ok: false, error: 'not-found' };
    saveCron(this.tasks);
    return { ok: true, removed: id };
  }
  toggle(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'not-found' };
    t.enabled = t.enabled === false ? true : false;
    this.schedule(t); // enabled 则建 job，停用则不建（schedule 内已判）
    saveCron(this.tasks);
    return { ok: true, id, enabled: t.enabled };
  }
  /** 编辑：改 cron/prompt/preset/once（未提供的字段保留），重新安排调度。 */
  update(id, patch) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'not-found' };
    if (patch && patch.cron !== undefined) t.cron = patch.cron;
    if (patch && patch.prompt !== undefined) t.prompt = patch.prompt;
    if (patch && patch.preset !== undefined) t.preset = patch.preset;
    if (patch && patch.once !== undefined) t.once = !!patch.once;
    // 模型：'model' in patch 才算本次要改（未传=保留原值，避免面板没带该字段时被清掉）；
    // 传 null / 空串 = 清空（改回「跟随默认」）；传字符串或 {provider,model} = 设值。
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'model')) {
      const m = patch.model;
      if (m === null || m === undefined || m === '') delete t.model;
      else t.model = m;
    }
    this.schedule(t);
    saveCron(this.tasks);
    return { ok: true, id };
  }
}

// ── 模块级实例存取（/api/mind/cron 路由访问当前调度器）─────────────────────
let __instance = null;
function setCronInstance(i) { __instance = i; }
function getCronInstance() { return __instance; }

module.exports = { DshCron, loadCron, saveCron, executeTask, normalizeModel, CRON_FILE, CRON_RUNS_FILE, outcomeOfTurnEnd, appendCronRun, setCronInstance, getCronInstance };
