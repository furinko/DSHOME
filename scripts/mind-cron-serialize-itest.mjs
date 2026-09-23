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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 把"等闸上限"压到 400ms（**必须在 require cron.cjs 之前**：常量在模块顶层求值）。
// 不压的话"等满上限则放行"这条失败面要跑 30s，且 B/C 用例会超时。
process.env.DSHOME_CRON_GATE_WAIT_MS = '400';
const results = [];
const check = (name, ok, extra) => results.push([name, ok ? 'PASS' : 'FAIL', extra]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshome-cron-itest-'));
  mkdirSync(join(home, 'mind'), { recursive: true });
  mkdirSync(join(home, 'mind-private', 'tasks'), { recursive: true });
  // 桩：executeTask 会 execFileSync(repoRoot()/scripts/mind-prime.mjs)。给个空桩，
  // 既保证隔离，也避免"找不到文件"的报错栈把测试输出刷成噪声。
  mkdirSync(join(home, 'scripts'), { recursive: true });
  writeFileSync(join(home, 'scripts', 'mind-prime.mjs'), "console.log('# stub prime（itest 用）');\n");
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

let failed = 0;
for (const [name, verdict, extra] of results) {
  if (verdict === 'FAIL') failed++;
  console.log(`[itest] ${name}: ${verdict}${extra ? ' (' + extra + ')' : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
