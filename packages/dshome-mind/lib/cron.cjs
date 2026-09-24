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

// ── 运行目录 / 工作区归属（2026-09-24 加：自治任务**可自选工作区**）────────────
// 为什么必须绑在一起（**上游硬约束**）：`attachSession` 会读会话 header 的 cwd，要求它
//   `realpath` 规范化后**逐字等于**工作区 path，否则抛 `its cwd resolves to '<cwd>'`
//   （`dsh-workspace/lib/types/entity.js:80`）⇒「**归到哪个工作区**」与「**在哪个目录里跑**」
//   必然**同一个路径**，不可能各自独立。
// 语义（`cron.json` 的任务字段 `workspace`）：
//   · 绝对路径（已注册工作区） ⇒ 会话 cwd = 它 ⇒ 跑在它里面 **且** 归到它（选谁归谁）
//   · `'@none'`                 ⇒ 明确**不登记**（落「未分组」是使用者的选择，**不是故障**，不告警）
//   · 缺省 / 空                 ⇒ 保持旧行为：cwd = `task.cwd ?? process.cwd()`，再按 cwd 反查匹配
//   🔴 选了工作区但目录不存在 / 不是绝对路径 ⇒ **任务 failed**（**绝不**静默落「未分组」——
//      2026-09-24 主人报的病灶形态就是"没归上还看不出为什么"）。
const WS_NONE = '@none';

// 工作区服务 = **可选依赖**（2026-09-24 真机实测订正）：
//   宿主对"未 inject 的服务"**直接抛**——实测原文 `cannot get property "workspaceRegistry" without inject`
//   （走 `hostCtx.get()` 也一样）。但把它并进 cron 的主 `inject` 列表又会让**没有工作区服务的 profile**
//   连自治本体都起不来（`inject` 要等依赖到齐才回调）⇒ 用**旁路 inject**：单独开一路只依赖它，
//   拿到引用就存模块级 ref；拿不到就降级（`workspace-registry-unavailable`），自治职责不受影响。
//   ⚠️ 因此**绝不允许**对未 inject 的 ctx 做属性访问 / `get()`（那正是本轮 500 的成因）。
let __workspaceRegistry = null;
function setWorkspaceRegistry(r) { __workspaceRegistry = r; }
function getWorkspaceRegistry() { return __workspaceRegistry; }
/** 只在**已拿到引用**时返回；没有就 null（不抛）。 */
function workspaceRegistryOf(hostCtx) {
  if (__workspaceRegistry) return __workspaceRegistry;
  if (hostCtx && typeof hostCtx.get === 'function') {
    try { return hostCtx.get('workspaceRegistry') || null; } catch { return null; } // 未 inject ⇒ 抛，吞掉
  }
  return null;
}

/** 解析"这次会话该在哪个目录跑 / 归到哪个工作区"。返回 `{cwd, workspacePath, skipAttach, declared}` 或 `{error}`。 */
async function resolveRunTarget(hostCtx, task) {
  const raw = (task && typeof task.workspace === 'string') ? task.workspace.trim() : '';
  const legacyCwd = (task && task.cwd) ? task.cwd : process.cwd();
  if (raw === WS_NONE) return { cwd: legacyCwd, workspacePath: null, skipAttach: true, declared: true };
  if (!raw) return { cwd: legacyCwd, workspacePath: null, skipAttach: false, declared: false };
  if (!path.isAbsolute(raw)) {
    return { error: `workspace 必须是绝对路径（收到 ${JSON.stringify(raw)}）——相对路径的归属会随进程 cwd 漂移` };
  }
  let canon = null;
  try { canon = await (require('@deepseek-ai/dsh-workspace').realpathNormalize)(raw); } catch { canon = null; }
  if (canon === null) return { error: `workspace 目录不存在或不可达：${raw}（先建目录，或在侧边栏「添加目录」把它注册成工作区）` };
  try {
    if (!fs.statSync(canon).isDirectory()) return { error: `workspace 不是目录：${canon}` };
  } catch { return { error: `workspace 目录不可访问：${raw}` }; }
  return { cwd: canon, workspacePath: canon, skipAttach: false, declared: true };
}

/** 把自治会话登记进工作区。**登记失败不影响任务执行**（归属是侧边栏的事），但必须**留下可查读数**。
 *
 *  ⚠️ 2026-09-24 两处"看着对、其实恒失败"的教训（都是真机探针抓出来的，不是读代码看出来的）：
 *   ① **服务名错**：原写 `ctx.get('workspace')` ⇒ 恒 `undefined`。官方 registry 的服务名是
 *      **`workspaceRegistry`**——证据＝`dsh-workspace` 的 `class WorkspaceRegistry extends Service { super(ctx, 'workspaceRegistry') }`
 *      与官方 controller 的 `static inject = ['typert', 'workspaceRegistry']`。
 *   ② **该用正规方法**：别再自己遍历 `entity.record.path` 比字符串——registry 有
 *      `resolveByPath(path)`（**不建不写**，路径由它内部 `realpath` 规范化；未注册目录返回 `undefined`），
 *      实体字段走**官方 getter**（`workspace.path` / `.id` / `.title`，见 controller 的 `workspaceView`）。
 *   ③ **未 inject 的服务取不到**：宿主直接抛 `cannot get property "workspaceRegistry" without inject`
 *      （2026-09-24 真机 500 原文）⇒ 服务只能由**声明了该 inject 的 ctx** 给；本模块走**旁路 inject**
 *      存模块级 ref（见文件上方那段注释），主 inject 列表**保持最小**，免得没工作区服务的 profile 停摆。
 *  ⇒ 教训：**mock 照自己读的 API 写，只会替错误假设背书**；服务名 / 方法名 / 取法这类事实必须回源码**取真源**，
 *     且判据只能落在**活进程**上（①②③ 全是真机探针照出来的，读代码一个也看不出来）。 */
async function attachToWorkspace(hostCtx, { taskId, sessionId, runTarget, registryWaitMs = ATTACH_REGISTRY_WAIT_MS } = {}) {
  if (!runTarget || runTarget.skipAttach) return { attached: false, reason: runTarget ? 'declared-none' : 'no-target', registryWaitedMs: 0 };
  const t0 = Date.now();
  try {
    // ① **先等"服务引用"**（2026-09-24 加）：冷启动补跑会跑在旁路 inject 之前，原实现此时**立刻放弃**
    //    ⇒ 重启后第一次补跑**必然**落「未分组」（见 ATTACH_REGISTRY_WAIT_MS 注释）。有界轮询、不无限等。
    let registry = workspaceRegistryOf(hostCtx);
    while ((!registry || typeof registry.resolveByPath !== 'function')
      && Date.now() - t0 < Math.max(0, registryWaitMs)) {
      await new Promise((r) => setTimeout(r, ATTACH_POLL_MS));
      registry = workspaceRegistryOf(hostCtx);
    }
    const registryWaitedMs = Date.now() - t0;
    if (!registry || typeof registry.resolveByPath !== 'function') {
      return { attached: false, reason: 'workspace-registry-unavailable', registryWaitedMs };
    }
    const target = runTarget.workspacePath || runTarget.cwd;
    let ws;
    try { ws = await registry.resolveByPath(target); }
    catch (e) { return { attached: false, reason: 'resolve-threw', error: e && e.message, path: target, registryWaitedMs }; }
    if (!ws) return { attached: false, reason: runTarget.declared ? 'workspace-not-registered' : 'no-matching-workspace', path: target, registryWaitedMs };
    if (typeof ws.attachSession !== 'function') return { attached: false, reason: 'entity-has-no-attachSession', path: ws.path, registryWaitedMs };
    // ② **再等"会话落盘"**（有界重试，2026-09-24 加，**保险不是猜测**）：`attachSession` 要读会话 header
    //   校验 cwd，而刚 `agents.create` 完的会话可能还没落到持久化（registry 先问 live `sessions`、拿不到就退到
    //   stored headers，两者都没有即抛 "session persistence holds no such session"）。3 次 × 400ms 足够跨过
    //   落盘窗口，且**失败仍响亮**（reason/error 原样带回，attempts 记"第几次才成"）。
    //   ⚠️ 诚实边界：本窗口**未**随 ① 一起加长——先把"失败可诊断"做出来（`lastAttach` 记 attempts），
    //   下次真机再看到 `reason:'attach-threw'` 时，才有依据决定要不要加长（不凭猜测调参）。
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        await ws.attachSession(sessionId);
        return { attached: true, path: ws.path, workspaceId: ws.id ?? null, attempts: i + 1, registryWaitedMs };
      } catch (e) { lastErr = e; if (i < 2) await new Promise((r) => setTimeout(r, 400)); }
    }
    return { attached: false, reason: 'attach-threw', error: lastErr && lastErr.message, path: ws.path, attempts: 3, registryWaitedMs };
  } catch (e) {
    return { attached: false, reason: 'attach-threw', error: e && e.message, registryWaitedMs: Date.now() - t0 };
  }
}

/** 把一次 attach 的结果**记在任务上**（2026-09-24 加）——归因盲区的补丁。
 *  为什么必须落账：2026-09-24 那次"未分组"事后**判不了**是"registry 没就绪"还是"attachSession 重试窗口不够"，
 *  根因就是 `wsOut` 只进了 console.warn（stdout 被壳消费后不留存）⇒ **没有任何持久证据**（同 `limits` L3
 *  「没有触发点的面＝没有灯的面」）。现在写进任务的 `lastAttach`：字段少而全（attached/reason/attempts/
 *  registryWaitedMs/workspaceId/cwd/declared/deferred），够回答"这次为什么没归上"，且**面板的编辑不会清掉它**
 *  （`update()` 只碰已知字段）。记账本身**不许影响自治**（写盘失败只吞掉，不阻断会话）。 */
function recordAttach(task, sessionId, wsOut, runTarget, extra = {}) {
  if (!task || typeof task !== 'object') return;
  task.lastAttach = {
    at: new Date().toISOString(),
    sessionId: String(sessionId),
    attached: !!(wsOut && wsOut.attached),
    reason: (wsOut && wsOut.reason) || null,
    attempts: (wsOut && wsOut.attempts) ?? null,
    registryWaitedMs: (wsOut && wsOut.registryWaitedMs) ?? 0,
    workspaceId: (wsOut && wsOut.workspaceId) || null,
    cwd: (runTarget && runTarget.cwd) || null,
    declared: !!(runTarget && runTarget.declared),
    ...(extra.deferred ? { deferred: true } : {}),
  };
  try {
    const inst = getCronInstance();
    // 🔴 只写**自己所属**的那个实例：`getCronInstance()` 是模块单例，`new DshCron` 多于一次的场景
    //   （itests / 未来多实例）里它可能指向**另一个实例**，其 tasks 属于别的 DSH_HOME ⇒
    //   拿它的 tasks 写当前 `CRON_FILE()` 就是**跨实例互相踩**（会把别人的任务表写进本机文件）。
    if (inst && Array.isArray(inst.tasks) && inst.tasks.includes(task)) saveCron(inst.tasks);
  } catch { /* 记账失败不阻断自治（会话已建出来，归属结果下次还会再记） */ }
}

/** 服务**晚到**时的后台补登记（2026-09-24 加）：不阻塞 `executeTask` 的返回路径（闸交棒靠它），
 *  用默认预算在后台有界重试，**成败都落账 + 失败响亮**。冷启动补跑（宿主启动 14s 就跑）走的就是这条路。 */
function deferAttachInBackground(hostCtx, task, sessionId, runTarget) {
  attachToWorkspace(hostCtx, { taskId: task.id, sessionId, runTarget })
    .then((out) => {
      recordAttach(task, sessionId, out, runTarget, { deferred: true });
      if (out.attached) {
        console.log('[dshome-cron]', task.id, `：工作区服务晚到，**后台补登记成功**（等了 ${out.registryWaitedMs}ms · attempts=${out.attempts}）`);
        return;
      }
      console.warn('[dshome-cron]', task.id, `：**后台补登记仍未成功**（${out.reason}${out.error ? ': ' + out.error : ''}；`
        + `等了 ${out.registryWaitedMs}ms）——本会话会落「未分组」；结果已记进任务 lastAttach`);
    })
    .catch((e) => { console.warn('[dshome-cron]', task.id, '：后台补登记异常（不影响自治）', e?.message ?? e); });
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
    // 运行目录 / 工作区归属（2026-09-24 加）：`workspace` 优先于 `cwd`；解析失败 ⇒ 任务直接 failed（响亮）
    const runTarget = await resolveRunTarget(hostCtx, task);
    if (runTarget.error) return { status: 'failed', error: runTarget.error };
    const modelChoice = normalizeModel(task && task.model, defaultModel); // 任务级模型优先，统一归一成 {provider, model}
    if (task && task.model && !modelChoice) {
      console.warn('[dshome-cron]', task.id, '：model 缺 provider 无法归一，本次按无模型选择运行');
    }
    const { agent } = await agents.create({
      sessionId,
      meta: { cwd: runTarget.cwd },
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
    // ── 登记进工作区（2026-09-23 加；2026-09-24 扩「工作区自选」）───────────────
    // 病根（2026-09-23 实测）：`executeTask` 走**低层 `agents.create`**，不经 GUI「新建会话」的登记路径
    //   ⇒ 自治会话**从不进入 workspace 名册**（`sessionIds`），侧边栏按 `sessionVisible()` 把它们归进
    //   「未分组」，且**每跑一次多一条**。
    // ⚠️ 2026-09-24 补一课：这段代码写了≠生效——它 09-24 08:53:28 才随 `pull` 落盘，而当天 08:50:56 的
    //   自治会话由**旧代码**创建 ⇒ 名册里 6 条自治会话**一条都没归上**（主人报「面板上显示未分组」的真因）。
    //   ⇒ 判据必须落在**活进程**上（重启后真触发一次 + 查名册），不能拿"代码在盘上"当生效。
    // 归属登记（2026-09-24 改造：**首查不等待 · 晚到转后台**）─────────────────────────────
    //   🔴 为什么**不能**在这里等 registry：`run()` 的时序是「先占 pending 闸 → `await executeTask`
    //   → 回来才交棒真实 `sessionId`」，而 `attachSession` 要读会话 header 校验 cwd ⇒ 在这里阻塞等，
    //   就会出现「会话已经 turn/end 了、闸里还没有真实 id」⇒ `release()` 找不到人 ⇒ **闸卡到
    //   `BUSY_MAX_MS`(45min)**（本改动第一版就是阻塞式，`mind-cron-serialize-itest` 的
    //   A5/A6/A8/B3 当场变红——那四条正是"闸"的回归面）。
    //   ⇒ 首查 `registryWaitMs: 0`（与旧行为逐字等价）；**只有"服务未就绪"这一种**才转后台有界重试，
    //   记账与告警都在后台完成（不占 executeTask 的返回路径）。
    const wsOut = await attachToWorkspace(hostCtx, { taskId: task.id, sessionId, runTarget, registryWaitMs: 0 });
    const lateRegistry = !wsOut.attached && !runTarget.skipAttach && wsOut.reason === 'workspace-registry-unavailable';
    if (lateRegistry) {
      deferAttachInBackground(hostCtx, task, sessionId, runTarget);
    } else {
      recordAttach(task, sessionId, wsOut, runTarget); // 归属结果**落账**（否则失败只进 stdout、事后无法归因）
      if (!wsOut.attached && !runTarget.skipAttach) {
        const why = `${wsOut.reason}${wsOut.error ? ': ' + wsOut.error : ''}`;
        if (runTarget.declared) {
          console.warn('[dshome-cron]', task.id, `：**已指定工作区但登记未成功**（${why}）——本会话会落「未分组」；目标: ${runTarget.workspacePath}`);
        } else {
          console.warn('[dshome-cron]', task.id, `：未登记工作区（${why}）——本会话会落「未分组」；会话 cwd: ${runTarget.cwd}（要指定归属请在任务里选「工作区」）`);
        }
      }
    }
    const { createMessage } = require('@deepseek-ai/dsh-llm');
    // 上工自动召回：把 mind-prime 的输出预置进任务 prompt（定时任务开机即带上下文，不靠 agent 记得）。
    let primeContext = '';
    try {
      const { execFileSync } = require('child_process');
      // 2026-09-24 加 `--cwd`：上工召回必须按**本任务的运行目录**取项目层记忆——原来恒用仓库根，
      //   于是"给别的项目干活"的自治任务会召回 **DSHOME 的**进度/待办与项目知识（跨项目串味）。
      //   `mind-prime` 的项目 key 由 `--cwd` 的祖先链 + `project-cwd-map.json` 决定（scripts/mind-prime.mjs:22-71）。
      primeContext = execFileSync(process.execPath, [path.join(repoRoot(), 'scripts', 'mind-prime.mjs'), '--cwd', runTarget.cwd], { cwd: repoRoot(), encoding: 'utf8', timeout: 15000 }).toString().trim();
    } catch (e) { primeContext = ''; console.warn('[dshome-cron] mind-prime failed:', e.message); }
    const prompt = primeContext ? `${primeContext}\n\n===== 任务 =====\n\n${task.prompt}` : task.prompt;
    const message = createMessage({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dshome-mind' },
    });
    agent.followup(message);
    return {
      status: 'created', sessionId: String(agent.id), cwd: runTarget.cwd,
      // `deferred` = 服务未就绪、补登记在后台跑（调用方别把这次当最终结论；最终结果看任务上的 `lastAttach`）
      workspace: lateRegistry ? { ...wsOut, deferred: true } : wsOut,
    };
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
// 归属登记前的**等 registry** 上限（2026-09-24 加 · 冷启动抢跑实测定位）：
//   病灶：宿主 22:22:55 启动、catch-up **22:23:09（只隔 14 秒）**就拉起会话，此刻
//     `workspaceRegistry` 的**旁路 inject 还没到** ⇒ `attachToWorkspace` 原来"拿不到引用就立刻返回"
//     ⇒ `workspace-registry-unavailable`，而 `declared=false` 时**只打一行 warn** ⇒
//     会话**静默落「未分组」**（每重启一次多一条）。
//   实证（同日 A/B 探针）：同一活进程里带/不带 `workspace` 的两次登记都 `attached:true·attempts:1`，
//     而同 cwd 的 22:23 那条没归上 ⇒ **与"任务缺 workspace 字段"无关**，就是"服务比补跑晚到"。
//   与 `GATE_WAIT_MS` **同族同款口径**（都是"服务晚到"）：**有界等待 + 界内失败留痕**，
//     不无限等、也不静默降级（等不到照样建会话、只是归属失败，且这次会记进 `lastAttach`）。
//   env 覆盖只给测试用（itest 要把 45s 压到几百毫秒才验得了"有界"）；口径同 `DSHOME_CRON_GATE_WAIT_MS`。
const ATTACH_REGISTRY_WAIT_MS = Number(process.env.DSHOME_CRON_ATTACH_WAIT_MS) > 0
  ? Number(process.env.DSHOME_CRON_ATTACH_WAIT_MS) : 45 * 1000;
const ATTACH_POLL_MS = 500; // 等 registry 的轮询间隔

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
    // 工作区（2026-09-24 加）：显式带字段才改；'' = 清空（回到「按目录自动」）；'@none' = 明确不登记
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'workspace')) {
      const w = patch.workspace;
      if (w === null || w === undefined || w === '') delete t.workspace;
      else t.workspace = String(w);
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

module.exports = { DshCron, loadCron, saveCron, executeTask, normalizeModel, CRON_FILE, CRON_RUNS_FILE, outcomeOfTurnEnd, appendCronRun, setCronInstance, getCronInstance, resolveRunTarget, attachToWorkspace, WS_NONE, setWorkspaceRegistry, getWorkspaceRegistry };
