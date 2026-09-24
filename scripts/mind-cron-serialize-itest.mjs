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

function makeHome() {
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
  const past = new Date(Date.now() - 2 * 86400000).toISOString();
  writeFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), JSON.stringify({
    tasks: [
      { id: 'itest-a', cron: '0 0 * * *', prompt: 'A', cwd: home, catchUp: true, lastRunAt: past, enabled: true },
      { id: 'itest-b', cron: '0 0 * * *', prompt: 'B', cwd: home, catchUp: true, lastRunAt: past, enabled: true },
    ],
  }, null, 2));
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

const { DshCron } = require('../packages/dshome-mind/lib/cron.cjs');

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
  const after = JSON.parse(readFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), 'utf8')).tasks;
  check('A8 两条都写了 lastRunAt', after.every((t) => t.lastRunAt && Date.now() - new Date(t.lastRunAt).getTime() < 60000),
    after.map((t) => t.id + '=' + (t.lastRunAt ? 'yes' : 'no')).join(' '));
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

let failed = 0;
for (const [name, verdict, extra] of results) {
  if (verdict === 'FAIL') failed++;
  console.log(`[itest] ${name}: ${verdict}${extra ? ' (' + extra + ')' : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
