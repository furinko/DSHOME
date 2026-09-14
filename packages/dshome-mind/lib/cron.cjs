// dshome-mind/lib/cron.cjs — cron 自治：定时拉起 agent 会话执行任务。
// 蓝图：dsh-scheduler executor.js（rc.8）。rc.2 等价 API 已确认：
//   agents.create / installModelSelection / createMessage / agent.followup。
// 存储：mind-private/tasks/cron.json（任务 + prompt + cron 表达式）。
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Cron } = require('croner');

function repoRoot() {
  if (process.env.DSH_HOME && fs.existsSync(path.join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  return path.resolve(__dirname, '../../..');
}
const CRON_FILE = () => path.join(repoRoot(), 'mind-private', 'tasks', 'cron.json');

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
  }
  start() {
    for (const t of this.tasks) this.schedule(t);
    this.watchSessions(); // 必须先接事件，再 catchUp —— 否则补跑建出的会话漏听 turn/end（闸卡死）
    this.catchUpMissed(); // 重启时补跑关机期间错过的任务
    this.timer = setInterval(() => this.reload(), 60000); // 每分钟扫新任务/改动
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
          this.release(String(session?.header?.id));
        });
        const offDisposed = sctx.on('session/disposed', (session) => this.release(String(session?.header?.id)));
        this.watching = true;
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
      }
      if (!this.isBusy()) this.drain(); // 没占上闸（failed）/ 一次性已移除 → 别让队列干等
    }).catch((e) => {
      this.active.delete(token);
      console.error('[dshome-cron] execute error', e);
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

module.exports = { DshCron, loadCron, saveCron, executeTask, normalizeModel, CRON_FILE, setCronInstance, getCronInstance };
