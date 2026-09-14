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

function makeHost(withInject) {
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
  if (withInject) hostCtx.inject = (names, cb) => { if (names.includes('sessions')) cb(sessions); return () => {}; };
  return {
    hostCtx, st,
    endSession(id) {
      st.live--;
      sessions.emit('session/event', { header: { id } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    },
  };
}

const { DshCron } = require('../packages/dshome-mind/lib/cron.cjs');

// ── A 正例：串行闸生效 ───────────────────────────────────────────────────────
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st, endSession } = makeHost(true);
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
  const { hostCtx, st } = makeHost(false); // 不给 inject
  const cron = new DshCron(hostCtx);
  cron.start();
  await sleep(600);
  check('B1 无 sessions 服务 → 退回旧行为（两条都发）', st.created.length === 2, `created=${st.created.length}`);
  check('B2 降级面确实会并发（证明 A 非假绿）', st.maxLive === 2, `maxLive=${st.maxLive}`);
  check('B3 降级不卡死（队列空、未占闸）', cron.queue.length === 0 && cron.active.size === 0, '');
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
