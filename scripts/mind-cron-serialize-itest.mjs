#!/usr/bin/env node
// scripts/mind-cron-serialize-itest.mjs — cron 串行闸行为自测（2026-09-14 建）
//
// 验什么：自治会话**同时只跑一个**（到点却忙 → 入队；当前会话 turn/end 后依序补跑）。
// 病灶背景：2026-09-14 实测 `catchUpMissed()` 一次 for 把两条错过任务几乎同时发出去
//   （self-clean .045s / self-feed .126s，差 80ms）⇒ 多个自治会话并发写同一批文件。
//
// 判据（两向都断言 —— 只断言"不并发"会假绿，必须同时证明"闸真的接上了"）：
//   A 正例：两条 catchUp 同时到期 → 只建 1 个会话、另一条入队；turn/end 后才建第 2 条；
//           **全程 maxLive 恒 1**（从来没有两个自治会话同时活着）
//   B 反例（降级面）：宿主无 `inject`（拿不到 sessions）→ 两条立刻都建 ⇒ maxLive === 2
//           ⇒ 证明 A 的"只跑一个"是**闸接上了**的结果，不是测试自己没触发
//
// 隔离：`DSH_HOME` 指向临时目录（不碰真仓库的任何文件），跑完删除。
// 用法：node scripts/mind-cron-serialize-itest.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 把"等闸上限"压到 400ms（**必须在 require cron.cjs 之前**：常量在模块顶层求值）。
// 不压的话"等满上限则放行"这条失败面要跑 30s，且 B/C 用例会超时。
process.env.DSHOME_CRON_GATE_WAIT_MS = '400';
// 同理压"等工作区 registry"上限（2026-09-24 加 · 必须同样在 require 之前）：服务未就绪时
//   `executeTask` 会**转后台**有界重试；不压的话一个用例留下的 45s 后台重试会**飘进后面的用例**
//   （实测：E6 的 attach 计数器被前一个用例的后台重试用掉一次 ⇒ `attempts` 从 2 变 1、假红）。
process.env.DSHOME_CRON_ATTACH_WAIT_MS = '400';
const results = [];
const check = (name, ok, extra) => results.push([name, ok ? 'PASS' : 'FAIL', extra]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 「2 天前」的固定哨兵：catchUpMissed 用它必判「错过」；断言里当**旧值**用——
 *  新语义（2026-09-28）下"未推进"就该**仍是它**，推进了就该是"近 60s 内"。 */
const PAST = new Date(Date.now() - 2 * 86400000).toISOString();

/** 建临时根。`tasks` 可省（= A/B 两条默认任务），也可传**数组**或 **`(home) => 数组`**（N 用例要按 home 拼路径）。 */
function makeHome(tasks) {
  const home = mkdtempSync(join(tmpdir(), 'dshome-cron-itest-'));
  mkdirSync(join(home, 'mind'), { recursive: true });
  mkdirSync(join(home, 'mind-private', 'tasks'), { recursive: true });
  //   ⚠️ 夹具给个空桩，既保证隔离，也避免"找不到文件"的报错栈把测试输出刷成噪声。
  mkdirSync(join(home, 'scripts'), { recursive: true });
  // 桩同时**记录收到的 argv**（2026-09-24 加）：用来断言"上工召回按任务运行目录取"（E1c）。
  writeFileSync(join(home, 'scripts', 'mind-prime.mjs'),
    "import { writeFileSync } from 'node:fs';\n"
    + "writeFileSync(new URL('./prime-argv.json', import.meta.url), JSON.stringify(process.argv.slice(2)));\n"
    + "console.log('# stub prime（itest 用）');\n");
  // 每日 00:00 的 cron + 上次跑在 2 天前 ⇒ catchUpMissed 必判「错过」，且测试期间不会真到点 tick
  const list = typeof tasks === 'function' ? tasks(home) : (tasks || [
    { id: 'itest-a', cron: '0 0 * * *', prompt: 'A', cwd: home, catchUp: true, lastRunAt: PAST, enabled: true },
    { id: 'itest-b', cron: '0 0 * * *', prompt: 'B', cwd: home, catchUp: true, lastRunAt: PAST, enabled: true },
  ]);
  writeFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), JSON.stringify({ tasks: list }, null, 2));
  return home;
}

/** @param injectMode
 *   'sync'  —— 回调**同步**执行（第一版夹具的形状；**不忠实**，见下）
 *   'async' —— 回调在下一 tick 执行（**真宿主的形状**）
 *   'never' —— 注册了 inject 但永不回调（sessions 始终不就绪）
 *   'none'  —— 连 inject 都没有
 *  🔴 为什么必须改（2026-09-23 实测）：`cron.cjs` 的 `watching = true` 写在 inject 的**回调里**，
 *     而真宿主该回调**不是同步调用** ⇒ 原 `start()` 里"先接事件、再 catchUp"的顺序保证**不成立**
 *     ⇒ 补跑走 fail-open 降级分支（**不查 isBusy，直接 run**）⇒ 两条自治会话 2ms 内并发创建
 *     （本机实测 self-clean / self-feed 的 `createdAt` 差 2ms，并发跑了 3m51s）。
 *     旧夹具用 'sync' ⇒ `watching` 在 `start()` 内立刻为 true ⇒ 这条路径**永远测不到**（假绿）。 */
function makeHost(injectMode) {
  const st = { created: [], live: 0, maxLive: 0, handlers: {} };
  const sessions = {
    on(type, fn) {
      (st.handlers[type] ||= []).push(fn);
      return () => { st.handlers[type] = (st.handlers[type] || []).filter((f) => f !== fn); };
    },
    emit(type, session, event) { for (const f of st.handlers[type] || []) f(session, event); },
  };
  const hostCtx = {
    get(name) {
      if (name === 'agents') {
        return {
          create: async ({ sessionId }) => {
            st.created.push(sessionId);
            st.live++;
            st.maxLive = Math.max(st.maxLive, st.live);
            return { agent: { id: sessionId, followup() { /* 会话跑起来了 */ } } };
          },
        };
      }
      return undefined; // agentDefaultModel 等一律缺省（走无模型选择路径）
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  if (injectMode === 'sync') hostCtx.inject = (names, cb) => { if (names.includes('sessions')) cb(sessions); return () => {}; };
  if (injectMode === 'async') hostCtx.inject = (names, cb) => { if (names.includes('sessions')) setImmediate(() => cb(sessions)); return () => {}; };
  if (injectMode === 'never') hostCtx.inject = () => () => {};
  return {
    hostCtx, st,
    endSession(id) {
      st.live--;
      sessions.emit('session/event', { header: { id } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    },
  };
}

const { DshCron, CATCHUP_RETRY_MAX } = require('../packages/dshome-mind/lib/cron.cjs');

// ── 断言用的读数帮手（N 用例加）─────────────────────────────────────────────
const tasksOf = (home) => JSON.parse(readFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), 'utf8')).tasks;
const taskOf = (home, id) => tasksOf(home).find((t) => t.id === id);
/** run 台账（JSONL）：失败重试/giveup 是"事件流"，断言落没落账靠它。 */
function runsOf(home) {
  const p = join(home, 'mind-private', 'tasks', 'cron-runs.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** 有界等待（不用固定 sleep 赌时序：失败记账跨 `executeTask` 的异步路径）。 */
async function waitFor(pred, timeoutMs = 4000, stepMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(stepMs);
  }
}
/** "近 60s 内"判据（推进类断言统一用它，避免各处各写一遍）。 */
const isFresh = (iso) => typeof iso === 'string' && Date.now() - new Date(iso).getTime() < 60000;

// ── A 正例：串行闸生效（**夹具忠实**：inject 回调异步 = 真宿主的形状）──────────────
//   ⚠️ 这条在旧夹具（同步 inject）下**恒绿**，恰是本次病灶的藏身之处：把 'async' 换回 'sync'
//      就等于"闸在 start() 内已就绪"，那条"补跑抢在闸前面"的路径**再也测不到**。
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st, endSession } = makeHost('async');
  const cron = new DshCron(hostCtx);
  cron.start();
  await sleep(600);
  check('A1 两条同时到期 → 只建 1 个自治会话', st.created.length === 1, `created=${st.created.length}`);
  check('A2 另一条入队（不丢）', cron.queue.length === 1, `queue=[${cron.queue.map((q) => q.id).join(',')}]`);
  check('A3 全程无并发（maxLive=1）', st.maxLive === 1, `maxLive=${st.maxLive}`);
  check('A4 闸真接上了（watching=true）', cron.watching === true, `watching=${cron.watching}`);
  endSession(st.created[0]);
  await sleep(600);
  check('A5 放闸后补跑第 2 条', st.created.length === 2, `created=${st.created.length}`);
  check('A6 队列已清空', cron.queue.length === 0, `queue=${cron.queue.length}`);
  check('A7 补跑期间仍无并发（maxLive=1）', st.maxLive === 1, `maxLive=${st.maxLive}`);
  // 🔴 A8 **2026-09-28 合法改写**（病灶 184 · 新语义钉进断言）：
  //   旧断言是"两条都写了 lastRunAt"，它依赖**旧语义**（`run()` 一创建成功就写）。
  //   新语义＝`lastRunAt` = **上次成功结束的时刻**，唯一推进点是 `recordRun` 的成功分支
  //   ⇒ 只有"已 turn/end(completed)"的那条会推进；仍在跑的那条**必须还是旧值**。
  //   反例（写不出反例＝没验过）：把 `run()` created 分支改回写 `lastRunAt` ⇒ **A8b 必红**
  //   （仍在跑的那条也会被推进）；把 `recordRun` 的 ok 分支删掉 ⇒ A8a 必红。
  const after = tasksOf(home);
  const heldNow = [...cron.active.values()].map((v) => v.id); // 现在占闸的那条 = 第 2 条（尚未 turn/end）
  const runningTask = after.find((t) => t.id === heldNow[0]);
  const endedTask = after.find((t) => t.id !== heldNow[0]);
  check('A8a 已 turn/end(completed) 的那条 ⇒ lastRunAt 推进到近 60s 内',
    heldNow.length === 1 && !!endedTask && isFresh(endedTask.lastRunAt) && endedTask.lastRunAt !== PAST,
    `ended=${endedTask && endedTask.id} lastRunAt=${endedTask && endedTask.lastRunAt}（旧值 ${PAST}）`);
  check('A8b 仍未结束的那条 ⇒ lastRunAt **仍是旧值（未推进）**',
    heldNow.length === 1 && !!runningTask && runningTask.lastRunAt === PAST,
    `running=${runningTask && runningTask.id} lastRunAt=${runningTask && runningTask.lastRunAt}`);
  check('A8c 仍在跑的那条 ⇒ 只写了新字段 lastStartedAt（纯观测"上次何时开始跑"）',
    !!runningTask && isFresh(runningTask.lastStartedAt), `lastStartedAt=${runningTask && runningTask.lastStartedAt}`);
  cron.clear();
  check('A9 clear() 放掉订阅与队列', cron.queue.length === 0 && cron.active.size === 0 && cron.watching === false, '');
  rmSync(home, { recursive: true, force: true });
}

// ── B 反例：宿主无 inject ⇒ 按设计降级（不并发保证），但绝不卡死 ──────────────
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost('none'); // 连 inject 都没有
  const cron = new DshCron(hostCtx);
  cron.start();
  await sleep(900); // 跨过 GATE_WAIT_MS(400ms) + 一轮 GATE_POLL_MS(500ms)
  check('B1 无 sessions 服务 → 退回旧行为（两条都发）', st.created.length === 2, `created=${st.created.length}`);
  check('B2 降级面确实会并发（证明 A 非假绿）', st.maxLive === 2, `maxLive=${st.maxLive}`);
  check('B3 降级不卡死（队列空、未占闸）', cron.queue.length === 0 && cron.active.size === 0, '');
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── C 正例（2026-09-23 加）：闸**没接上**时不许抢跑；等满上限必须放行（"不并发"不能以"不跑"为代价）
//   反例：把 `deferCatchUp` 的等待去掉（直接 `catchUpMissed()`）⇒ C1 必红；
//        把超时放行那段删掉 ⇒ C2 必红（补跑永久卡死）；把 GATE_WAIT_MS 当 0 ⇒ C1 必红。
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost('never'); // inject 注册了但**永不回调**（sessions 始终不就绪）
  const cron = new DshCron(hostCtx);
  cron.start();
  await sleep(150);
  check('C1 闸未接上时不抢跑（等，而不是降级直发）', st.created.length === 0, `created=${st.created.length}`);
  await sleep(900); // 跨过 GATE_WAIT_MS(400ms)
  check('C2 等满上限 → 仍补跑（不卡死）', st.created.length === 2, `created=${st.created.length}`);
  check('C3 降级确实会并发（证明"等闸"不是白等）', st.maxLive === 2, `maxLive=${st.maxLive}`);
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── D 正例（2026-09-23 加 · **本轮 itest 自己抓出来的真 bug**）──────────────────
//   现象（日志实证）：`串行闸已接上（等了 0ms）→ 补跑` 之后，**又**出现 `已接上（等了 500ms）→ 补跑`
//     ⇒ `catchUpMissed()` 被调了**两次**。
//   成因：tick 里只写 `this._gateTimer = null`（**丢引用**），**没有 `clearTimeout`** ⇒
//     setImmediate 里"主动叫醒"跑完 tick 后，那个待触发的轮询**仍在**，500ms 后照跑第二遍。
//   危害：本次靠"已入队/已在跑"去重侥幸没发重复会话，但"补跑只许一次"**本身没有被守**——
//     若第二次 tick 落在 `lastRunAt` 更新之前，同一个任务就会被补跑两遍。
//   反例：去掉 tick 里的 `clearTimeout` + `done` 守卫 ⇒ D1 必红（`calls=2`）。
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost('async');
  const cron = new DshCron(hostCtx);
  let calls = 0;
  const orig = cron.catchUpMissed.bind(cron);
  cron.catchUpMissed = () => { calls++; return orig(); }; // 记账（deferCatchUp 走 this.xxx ⇒ 动态派发，patch 生效）
  cron.start();
  await sleep(1200); // 跨过 GATE_POLL_MS(500ms)：旧实现会在这里再补一遍
  check('D1 补跑只跑一次（主动叫醒后，轮询不许再补一遍）', calls === 1, `catchUpMissed calls=${calls}`);
  check('D2 且只建 1 个会话（第二条在队列里等放闸）', st.created.length === 1, `created=${st.created.length}`);
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── E 工作区自选（2026-09-24 加 · 主人「自治任务不一定为 DSHOME 服务」）──────────
//   语义（**上游硬约束**：`attachSession` 要求会话 header 的 cwd 规范化后逐字等于工作区 path ⇒
//   「归到谁」与「在哪个目录跑」必然同一路径）：`workspace` = 路径 ⇒ cwd 用它 + attach 到它；
//   `'@none'` ⇒ 明确不登记；缺省 ⇒ 旧行为（cwd + 按 cwd 反查）。
//   夹具忠实性：mock 的 workspace 实体**照运行期形状**给（`{record:{path}, attachSession}`——
//   `dsh-workspace` 的 entity.js 里 `record` 是**公开类字段**，TS 的 private 只是编译期）。
//   ⚠️ 本 itest 只证"我们这侧的接线与判据"；**真实 attach 成功与否必须在活进程上验**
//   （09-24 教训：代码在盘上 ≠ 生效，见 `cron.cjs` 那段 ⚠️ 注释）。
//   反例（写不出反例＝没验过）：① 把 `meta.cwd` 改回 `task.cwd ?? process.cwd()` ⇒ E1 必红；
//                              ② 把「目录不存在 ⇒ failed」删掉 ⇒ E3 必红；③ 让 `@none` 照常 attach ⇒ E2 必红。
{
  const { realpathNormalize } = require('@deepseek-ai/dsh-workspace');
  const { executeTask, WS_NONE, setWorkspaceRegistry } = require('../packages/dshome-mind/lib/cron.cjs');
  const home = makeHome();
  process.env.DSH_HOME = home;
  const canonHome = await realpathNormalize(home);
  const missing = join(home, 'nope-does-not-exist');

  function makeWsHost(registered) {
    const seen = { created: [], attached: [] };
    // 实体的形状照官方 controller 的 `workspaceView`：**getter path/title/id**，不暴露 `.record`。
    const entities = registered.map((p, i) => ({
      id: 'ws-' + i, title: 'T' + i, path: p,
      attachSession: async (id) => { seen.attached.push({ path: p, id }); },
    }));
    const registry = {
      list: () => entities,
      resolveByPath: async (target) => {
        let want = null;
        try { want = await realpathNormalize(target); } catch { return undefined; }
        for (const e of entities) {
          let c = null;
          try { c = await realpathNormalize(e.path); } catch { c = null; }
          if (c !== null && c === want) return e;
        }
        return undefined;
      },
    };
    const hostCtx = {
      get(name) {
        if (name === 'agents') {
          return { create: async ({ sessionId, meta }) => { seen.created.push({ sessionId, cwd: meta && meta.cwd }); return { agent: { id: sessionId, followup() {} } }; } };
        }
        // ⚠️ 真宿主对**未 inject 的服务**是**抛**（2026-09-24 真机 500 原文：
        //   `cannot get property "workspaceRegistry" without inject`）⇒ mock 同形。
        //   于是"从 hostCtx 取服务"这条路在测试里**必红**，只有走 inject 存下的引用才对——
        //   这正是本轮第三个真缺陷（名字对了、取法错了）的守。
        if (name === 'workspaceRegistry') throw new Error('cannot get property "workspaceRegistry" without inject');
        return undefined;
      },
      logger: { info() {}, warn() {}, error() {} },
    };
    // 真宿主里服务由**声明了该 inject 的 ctx**交给插件（`ctx.inject(['workspaceRegistry'], …)`）
    // ⇒ 测试用**同一入口**注入引用（与 index.cjs 的接线一致）。
    setWorkspaceRegistry(registry);
    return { hostCtx, seen };
  }

  // E1 正例：workspace = 已注册路径 ⇒ cwd 切到它 + attach 到它
  {
    const { hostCtx, seen } = makeWsHost([canonHome]);
    const out = await executeTask(hostCtx, { id: 'E1', prompt: 'x', cron: '0 0 * * *', workspace: canonHome });
    check('E1a 选了工作区 ⇒ 会话 cwd 就是它', out.status === 'created' && seen.created[0] && seen.created[0].cwd === canonHome, `status=${out.status} cwd=${seen.created[0] && seen.created[0].cwd}`);
    check('E1b 且登记到它（attach 被调、id 一致）', out.workspace && out.workspace.attached === true && seen.attached.length === 1 && seen.attached[0].id === out.sessionId, `attached=${JSON.stringify(out.workspace)}`);
    // E1c：上工召回必须按**本任务运行目录**取（否则"给别的项目干活"会召回 DSHOME 的项目记忆）
    const argvFile = join(home, 'scripts', 'prime-argv.json');
    const argv = existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) : null;
    check('E1c 上工召回也按所选工作区取（--cwd = 它）', !!argv && argv.includes('--cwd') && argv[argv.indexOf('--cwd') + 1] === canonHome, `argv=${JSON.stringify(argv)}`);
  }

  // E2 正例：'@none' ⇒ 明示不登记（**静默**，不是故障）
  {
    const { hostCtx, seen } = makeWsHost([canonHome]);
    const out = await executeTask(hostCtx, { id: 'E2', prompt: 'x', cron: '0 0 * * *', cwd: canonHome, workspace: WS_NONE });
    check('E2 明确「不登记」⇒ 不 attach、也不报错', out.status === 'created' && seen.attached.length === 0 && out.workspace && out.workspace.reason === 'declared-none', `reason=${out.workspace && out.workspace.reason} attached=${seen.attached.length}`);
  }

  // E3 反例：选了不存在的目录 ⇒ **任务 failed**（绝不静默落未分组）
  {
    const { hostCtx, seen } = makeWsHost([canonHome]);
    const out = await executeTask(hostCtx, { id: 'E3', prompt: 'x', cron: '0 0 * * *', workspace: missing });
    check('E3 目录不存在 ⇒ failed 且不建会话（不静默落未分组）', out.status === 'failed' && seen.created.length === 0 && /不存在|不可达/.test(String(out.error)), `status=${out.status} created=${seen.created.length}`);
  }

  // E4 反例：相对路径 ⇒ 拒绝（归属会随进程 cwd 漂移）
  {
    const { hostCtx, seen } = makeWsHost([canonHome]);
    const out = await executeTask(hostCtx, { id: 'E4', prompt: 'x', cron: '0 0 * * *', workspace: 'relative/dir' });
    check('E4 相对路径 ⇒ failed（拒绝随进程 cwd 漂移的归属）', out.status === 'failed' && seen.created.length === 0, `status=${out.status} error=${out.error}`);
  }

  // E5 旧行为不回退：无 workspace 字段 ⇒ 仍按 cwd 反查登记
  {
    const { hostCtx, seen } = makeWsHost([canonHome]);
    const out = await executeTask(hostCtx, { id: 'E5', prompt: 'x', cron: '0 0 * * *', cwd: canonHome });
    check('E5 老任务（无 workspace）⇒ 保持旧行为：按 cwd 自动匹配', out.status === 'created' && seen.attached.length === 1 && out.workspace.attached === true, `attached=${JSON.stringify(out.workspace)}`);
  }

  // E6 正例（2026-09-24 加 · 针对**真机上还没验过的那一格**）：attach 首次抛（模拟"刚建的会话
  //   header 还没落到持久化"）⇒ **有界重试**要能兜住，并如实把"第几次才成"记进返回值。
  //   反例：把重试那圈删掉 ⇒ E6 必红（attached=false, reason=attach-threw）。
  {
    const seen = { calls: 0 };
    const entity = {
      id: 'ws-r', title: 'R', path: canonHome,
      attachSession: async () => {
        seen.calls++;
        if (seen.calls === 1) throw new Error('cannot validate session: session persistence holds no such session');
      },
    };
    const hostCtx = {
      get(n) {
        if (n === 'agents') return { create: async ({ sessionId }) => ({ agent: { id: sessionId, followup() {} } }) };
        if (n === 'workspaceRegistry') throw new Error('cannot get property "workspaceRegistry" without inject');
        return undefined;
      },
      logger: { info() {}, warn() {}, error() {} },
    };
    setWorkspaceRegistry({ list: () => [entity], resolveByPath: async () => entity });
    const out = await executeTask(hostCtx, { id: 'E6', prompt: 'x', cron: '0 0 * * *', workspace: canonHome });
    check('E6 attach 首次抛 ⇒ 有界重试兜住（attempts=2）', out.status === 'created' && out.workspace && out.workspace.attached === true && out.workspace.attempts === 2, `ws=${JSON.stringify(out.workspace)} calls=${seen.calls}`);
  }

  setWorkspaceRegistry(null); // 收尾：别把引用漏给后面的用例（与真宿主 effect 清理同义）
  rmSync(home, { recursive: true, force: true });
}

// ══ N 组（2026-09-28 加 · 病灶 184/232）══════════════════════════════════════════
//   专门为两处修复写的回归面（A8 只是"顺手钉住"）。每条都带**反例说明**——写不出反例＝没验过。

// ── N1：**失败不推进 `lastRunAt`**（病灶 184 的核心）────────────────────────────
//   造一条 catchUp 任务 + `workspace` 指向不存在目录 ⇒ `executeTask` 必 `failed`（判据见 E3）。
//   反例：把 `recordRun` 的非成功分支改回"也写 `lastRunAt`" ⇒ **N1a 必红**；
//        把失败计数（`retryCount`）删掉 ⇒ N1b/N1f 必红。
{
  const home = makeHome((h) => [
    { id: 'itest-n1', cron: '0 0 * * *', prompt: 'N1', cwd: h, catchUp: true, lastRunAt: PAST, enabled: true,
      workspace: join(h, 'nope-does-not-exist') },
  ]);
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost('async');
  const cron = new DshCron(hostCtx);
  cron.start();
  const settled = await waitFor(() => taskOf(home, 'itest-n1').retryCount === 1);
  const t1 = taskOf(home, 'itest-n1');
  check('N1a 失败**不推进** lastRunAt（仍是旧值）', settled && t1.lastRunAt === PAST,
    `lastRunAt=${t1.lastRunAt}（旧值 ${PAST}）`);
  check('N1b 失败累计 retryCount=1', settled && t1.retryCount === 1, `retryCount=${t1.retryCount}`);
  check('N1c 失败确实落了台账（status=error · 不再静默）',
    runsOf(home).some((r) => r.taskId === 'itest-n1' && r.status === 'error'),
    JSON.stringify(runsOf(home).filter((r) => r.taskId === 'itest-n1')));
  check('N1d 失败面不建会话（workspace 不存在 ⇒ 直接 failed）', st.created.length === 0, `created=${st.created.length}`);
  // 前置断言：没接上闸的话本用例验的是"降级面"，结论不可比 ⇒ 必须钉住闸真接上了（同 A4/B3 的口径）
  check('N1e 前置·闸真接上了（watching=true）', cron.watching === true, `watching=${cron.watching}`);
  check('N1f `list()` 带出 retryCount（A6：`...t` 展开）',
    cron.list().find((t) => t.id === 'itest-n1')?.retryCount === 1,
    `list().retryCount=${cron.list().find((t) => t.id === 'itest-n1')?.retryCount}`);
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── N2：**只有成功结束才推进 + 清零**（新语义的另一半）─────────────────────────
//   种子给 `retryCount: 1`（模拟"上一轮失败过"）⇒ 成功 turn/end 后必须清零。
//   反例：把 `run()` created 分支改回写 `lastRunAt` ⇒ **N2a 必红**（会话一建成就推进了）；
//        把 `recordRun` ok 分支的两行删掉 ⇒ N2d/N2e 必红。
{
  const home = makeHome((h) => [
    { id: 'itest-n2', cron: '0 0 * * *', prompt: 'N2', cwd: h, catchUp: true, lastRunAt: PAST, retryCount: 1, enabled: true,
      workspace: '@none' }, // 明确不登记 ⇒ 掐掉 attach 面，本用例只验"推进语义"
  ]);
  process.env.DSH_HOME = home;
  const { hostCtx, st, endSession } = makeHost('async');
  const cron = new DshCron(hostCtx);
  cron.start();
  // 等到"创建分支真的落盘了"（`st.created` 只证 agents.create 被调，早于 run() 的 .then 写入）
  await waitFor(() => isFresh(taskOf(home, 'itest-n2').lastStartedAt));
  const mid = taskOf(home, 'itest-n2');
  check('N2a 会话建成但**未 turn/end** ⇒ lastRunAt 仍未推进（仍是旧值）',
    st.created.length === 1 && mid.lastRunAt === PAST, `created=${st.created.length} lastRunAt=${mid.lastRunAt}`);
  check('N2b → 只写了 lastStartedAt（新字段，近 60s 内）', isFresh(mid.lastStartedAt), `lastStartedAt=${mid.lastStartedAt}`);
  check('N2c `list()` 也带出 lastStartedAt（A6：`...t` 展开）',
    isFresh(cron.list().find((t) => t.id === 'itest-n2')?.lastStartedAt), '');
  endSession(st.created[0]);
  const advanced = await waitFor(() => taskOf(home, 'itest-n2').lastRunAt !== PAST);
  const after2 = taskOf(home, 'itest-n2');
  check('N2d turn/end(completed) ⇒ lastRunAt 推进到近 60s 内', advanced && isFresh(after2.lastRunAt),
    `lastRunAt=${after2.lastRunAt}（旧值 ${PAST}）`);
  check('N2e 成功 ⇒ retryCount 被**清零**', after2.retryCount === undefined, `retryCount=${after2.retryCount}`);
  check('N2f 成功 ⇒ lastResult.status=ok（与推进同源）', after2.lastResult?.status === 'ok', JSON.stringify(after2.lastResult));
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── N3：**重试上限 → giveup**（防"补跑风暴"的主闸）─────────────────────────────
//   连续失败到 `CATCHUP_RETRY_MAX + 1` 次尝试（启动补跑 1 次 + reload 兜底 2 次）：
//   ① 台账出现 `status:'giveup'` ② `lastRunAt` **账面归位**（近 60s 内 ⇒ 不再被判「错过」）
//   ③ `retryCount` 清零 ④ 之后再 reload **不再发起**（风暴真的停了）。
//   反例：把 giveup 分支里的 `task.lastRunAt = rec.ts` 删掉 ⇒ **N3b/N3f 必红**（永远"错过"⇒ 每分钟重试）；
//        把 giveup 那条 `appendCronRun` 删掉 ⇒ N3a 必红；把它改成递归调 `recordRun` ⇒ 栈溢出/台账刷屏。
{
  const home = makeHome((h) => [
    { id: 'itest-n3', cron: '0 0 * * *', prompt: 'N3', cwd: h, catchUp: true, lastRunAt: PAST, enabled: true,
      workspace: join(h, 'nope-does-not-exist') },
  ]);
  process.env.DSH_HOME = home;
  const { hostCtx } = makeHost('async');
  const cron = new DshCron(hostCtx);
  cron.start();
  check('N3⓪ 常量冻结值 = 2（⇒ 同一轮最多 3 次尝试）', CATCHUP_RETRY_MAX === 2, `CATCHUP_RETRY_MAX=${CATCHUP_RETRY_MAX}`);
  const errRows = () => runsOf(home).filter((r) => r.taskId === 'itest-n3' && r.status === 'error').length;
  const hasGiveup = () => runsOf(home).some((r) => r.taskId === 'itest-n3' && r.status === 'giveup');
  const a1 = await waitFor(() => errRows() === 1);   // 第 1 次尝试：启动窗口补跑
  cron.reload();                                     // 兜底重试 #1（A4 的那条触发面）
  const a2 = a1 && await waitFor(() => errRows() === 2);
  cron.reload();                                     // 兜底重试 #2 ⇒ 第 3 次尝试 ⇒ 超上限 ⇒ giveup
  const a3 = a2 && await waitFor(() => hasGiveup());
  const t3 = taskOf(home, 'itest-n3');
  const gRow = runsOf(home).find((r) => r.taskId === 'itest-n3' && r.status === 'giveup');
  check('N3a 超上限 ⇒ 台账 giveup（errorCode=retry-exhausted · lastErrorCode · retryCount=3）',
    a3 && !!gRow && gRow.errorCode === 'retry-exhausted' && typeof gRow.lastErrorCode === 'string'
    && gRow.retryCount === CATCHUP_RETRY_MAX + 1, JSON.stringify(gRow));
  check('N3b giveup ⇒ lastRunAt **账面归位**到近 60s 内（不再被判「错过」）', a3 && isFresh(t3.lastRunAt),
    `lastRunAt=${t3.lastRunAt}（旧值 ${PAST}）`);
  check('N3c giveup ⇒ retryCount 被清掉', a3 && t3.retryCount === undefined, `retryCount=${t3.retryCount}`);
  check('N3d giveup **不递归**（台账里 giveup 只有一条）',
    runsOf(home).filter((r) => r.taskId === 'itest-n3' && r.status === 'giveup').length === 1,
    `giveup 行数=${runsOf(home).filter((r) => r.taskId === 'itest-n3' && r.status === 'giveup').length}`);
  check('N3e `lastResult` 记 status=giveup', t3.lastResult?.status === 'giveup', JSON.stringify(t3.lastResult));
  const rowsBefore = runsOf(home).length;
  cron.reload();                                     // 再兜一次：账面已归位 ⇒ 不该再发起
  await sleep(400);
  check('N3f 归位后再 reload **不再发起**（补跑风暴真的停了）', runsOf(home).length === rowsBefore,
    `台账行数 ${rowsBefore}→${runsOf(home).length}`);
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── N4：**reload 兜底只在闸接上时补**（否则降级面会"每分钟飙会话"）─────────────
//   降级面（`makeHost('none')`：连 inject 都没有）⇒ 启动窗口那一次 fail-open 补跑照旧（现有行为不动），
//   但**每一次 `reload()` 都不许再补**（不占闸、也无法保证串行）。
//   反例：把 `reload()` 里 `if (this.watching === true)` 的守卫删掉 ⇒ **N4b/N4c 必红**
//   （3 次 reload ⇒ 会话 +6、degraded 台账 +6）。
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost('none');
  const cron = new DshCron(hostCtx);
  cron.start();
  await sleep(900); // 跨过 GATE_WAIT_MS(400) + 一轮 GATE_POLL_MS(500)：启动窗口那次降级补跑
  const base = st.created.length;
  const degBefore = runsOf(home).filter((r) => r.status === 'degraded').length;
  check('N4a 前置·降级面启动窗口仍补跑（2 条）且闸确实没接上',
    base === 2 && cron.watching === false, `created=${base} watching=${cron.watching}`);
  cron.reload(); cron.reload(); cron.reload(); // 模拟 3 次"每分钟 tick"
  await sleep(400);
  check('N4b 降级面 reload **不补跑**（会话数不增）', st.created.length === base, `created ${base}→${st.created.length}`);
  check('N4c → 也没有新的 degraded 台账行（证明 reload 真没发起触发）',
    runsOf(home).filter((r) => r.status === 'degraded').length === degBefore,
    `degraded ${degBefore}→${runsOf(home).filter((r) => r.status === 'degraded').length}`);
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── N5（病灶 232）：`trigger()` 的**返回值语义**（面板文案与面板走闸都靠它）──────
//   B1 的五个分支逐个钉住：started / running / queued(忙) / queued(已在队列) / unserialized。
//   反例：把某个分支的 `return` 删掉 ⇒ 面板拿到 `undefined` ⇒ 该条必红（旧实现就是全都 `undefined`）。
{
  const home = makeHome((h) => [
    { id: 'n5-a', cron: '0 0 * * *', prompt: 'A', cwd: h, catchUp: false, enabled: true, workspace: '@none' },
  ]);
  process.env.DSH_HOME = home;
  const { hostCtx } = makeHost('sync'); // 'sync' ⇒ `watching` 在 watchSessions() 内立刻为 true（本用例只验分支语义）
  const cron = new DshCron(hostCtx);
  cron.watchSessions();
  check('N5⓪ 前置·闸接上了', cron.watching === true, `watching=${cron.watching}`);
  const taskA = cron.tasks.find((t) => t.id === 'n5-a');

  // ① 闸空 ⇒ 立刻跑
  cron.active.clear(); cron.queue = [];
  const r0 = cron.trigger(taskA, 'panel-run');
  check('N5a 闸空 ⇒ mode=started', r0?.ok === true && r0.mode === 'started', JSON.stringify(r0));

  // ② 该任务已在跑 ⇒ 不重复发起
  cron.active.clear(); cron.queue = [];
  cron.active.set('sid-n5', { id: 'n5-a', since: Date.now() });
  const r1 = cron.trigger(taskA, 'panel-run');
  check('N5b 已在跑 ⇒ mode=running / dedup=already-running',
    r1?.ok === true && r1.mode === 'running' && r1.dedup === 'already-running', JSON.stringify(r1));

  // ③ 忙（别的任务占闸）⇒ 入队
  const other = { ...taskA, id: 'n5-b' };
  const r2 = cron.trigger(other, 'panel-run');
  check('N5c 忙 ⇒ mode=queued / queueLength=1', r2?.ok === true && r2.mode === 'queued' && r2.queueLength === 1 && !r2.dedup,
    JSON.stringify(r2));

  // ④ 已在队列 ⇒ 去重（不重复入队）
  const r3 = cron.trigger(other, 'panel-run');
  check('N5d 已在队列 ⇒ mode=queued / dedup=already-queued',
    r3?.ok === true && r3.mode === 'queued' && r3.dedup === 'already-queued', JSON.stringify(r3));

  // ⑤ 降级面（闸没接上）⇒ 照发，但**如实**标 unserialized
  cron.watching = false;
  const r4 = cron.trigger(taskA, 'panel-run');
  check('N5e 降级面 ⇒ mode=unserialized', r4?.ok === true && r4.mode === 'unserialized', JSON.stringify(r4));
  check('N5f → 降级照样留痕（degraded 台账，不静默）',
    runsOf(home).some((r) => r.taskId === 'n5-a' && r.status === 'degraded'),
    JSON.stringify(runsOf(home).filter((r) => r.taskId === 'n5-a')));
  await sleep(200); // 让⑤那条降级 run 落定，别飘到下个进程/用例
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── N6（2026-09-28 加）：A5 的**双保险守卫**真拦得住（否则那一行**零覆盖**）───────
//   正路里盘上的 `retryCount` 只会停在 1/2（第 3 次尝试当场 giveup + 清零）⇒ 守卫那行平时跑不到。
//   本用例**手造** `retryCount = CATCHUP_RETRY_MAX + 1`（模拟"计数因故没被清零/归位"）⇒ 补跑必须被跳过。
//   反例：把 `catchUpMissed()` 里那段 `retryCount > CATCHUP_RETRY_MAX` 守卫删掉 ⇒ **N6b/N6d 必红**
//   （守卫没了就会照常发起会话）。
{
  const home = makeHome((h) => [
    { id: 'itest-n6', cron: '0 0 * * *', prompt: 'N6', cwd: h, catchUp: true, lastRunAt: PAST,
      retryCount: CATCHUP_RETRY_MAX + 1, enabled: true },
  ]);
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost('async');
  const cron = new DshCron(hostCtx);
  cron.start();
  await sleep(700); // 跨过"闸接上 + 启动窗口那次补跑"
  check('N6a 前置·闸接上了', cron.watching === true, `watching=${cron.watching}`);
  check('N6b 账面 retryCount 超上限 ⇒ 补跑被**跳过**（不发起会话）', st.created.length === 0, `created=${st.created.length}`);
  const t6 = taskOf(home, 'itest-n6');
  check('N6c → 守卫只"跳过"、**不动账**（lastRunAt 仍旧值 · retryCount 仍残留）',
    t6.lastRunAt === PAST && t6.retryCount === CATCHUP_RETRY_MAX + 1, JSON.stringify({ lastRunAt: t6.lastRunAt, retryCount: t6.retryCount }));
  cron.reload(); // A4 的兜底面也要受同一守卫约束
  await sleep(300);
  check('N6d reload 兜底同样跳过（不因 reload 而飙会话）', st.created.length === 0, `created=${st.created.length}`);
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

let failed = 0;
for (const [name, verdict, extra] of results) {
  if (verdict === 'FAIL') failed++;
  console.log(`[itest] ${name}: ${verdict}${extra ? ' (' + extra + ')' : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
