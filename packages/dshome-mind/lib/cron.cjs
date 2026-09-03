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

// ── 到点执行：新建 agent 会话 + 注入 prompt + followup 驱动 ────────────────
async function executeTask(hostCtx, task) {
  try {
    const agents = hostCtx.get('agents');
    if (agents === undefined || typeof agents.create !== 'function') {
      return { status: 'failed', error: 'agents 服务不可用（dsh-agent 未组合）' };
    }
    const sessionId = randomUUID();
    const defaultModel = hostCtx.get('agentDefaultModel')?.currentSelection?.();
    const modelChoice = task.model || defaultModel; // 任务可指定便宜模型跑自治会话（省 token）
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
  }
  start() {
    for (const t of this.tasks) this.schedule(t);
    this.catchUpMissed(); // 重启时补跑关机期间错过的任务
    this.timer = setInterval(() => this.reload(), 60000); // 每分钟扫新任务/改动
  }
  schedule(task) {
    this.unschedule(task.id);
    // 停用任务：保留在 tasks（可再启用），但不建 job（不触发）
    if (task.enabled === false) return true;
    try {
      const tz = typeof task.timezone === 'string' ? { timezone: task.timezone } : {};
      const job = new Cron(task.cron, { protect: true, ...tz }, () => {
        executeTask(this.hostCtx, task).then((r) => {
          console.log('[dshome-cron]', task.id, r.status, r.error || `session=${r.sessionId || ''}`);
          // 记录实际触发时间（供 missed 补跑判定）
          if (r.status === 'created') {
            task.lastRunAt = new Date().toISOString();
            saveCron(this.tasks);
          }
          // 一次性任务：跑完自动移除 + 停表
          if (task.once && r.status === 'created') {
            this.unschedule(task.id);
            this.tasks = this.tasks.filter((x) => x.id !== task.id);
            saveCron(this.tasks);
          }
        }).catch((e) => console.error('[dshome-cron] execute error', e));
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
        executeTask(this.hostCtx, t).then((r) => {
          console.log('[dshome-cron] catch-up', t.id, r.status);
          t.lastRunAt = new Date().toISOString();
          saveCron(this.tasks);
        }).catch((e) => console.error('[dshome-cron] catch-up error', e));
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
  }
  clear() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    if (this.timer) clearInterval(this.timer);
  }
  // ── 面板管理：增/删/启停/列表 ──────────────────────────────────────────────
  nextRunFor(id) {
    const job = this.jobs.get(id);
    return job ? (job.nextRun() ? job.nextRun().toISOString() : null) : null;
  }
  list() {
    return this.tasks.map((t) => ({ ...t, enabled: t.enabled !== false, nextRun: this.nextRunFor(t.id) }));
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
    this.schedule(t);
    saveCron(this.tasks);
    return { ok: true, id };
  }
}

// ── 模块级实例存取（/api/mind/cron 路由访问当前调度器）─────────────────────
let __instance = null;
function setCronInstance(i) { __instance = i; }
function getCronInstance() { return __instance; }

module.exports = { DshCron, loadCron, saveCron, executeTask, CRON_FILE, setCronInstance, getCronInstance };
