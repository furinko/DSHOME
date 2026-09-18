#!/usr/bin/env node
// scripts/mind-cron-runs-itest.mjs — cron 自治「run 结果记录」行为自测（2026-09-17 建 · P0-①）
//
// 验什么：`cron.cjs` 不再把「会话被创建」当成成功 —— 每次自治 run 的**真实结果**
//   （turn/end 的 `reason.kind` / 拉会话直接失败 / 占闸超时）都落
//   `mind-private/tasks/cron-runs.jsonl`，并写进任务上的 `lastResult`；非成功**响亮告警**。
// 病灶背景（2026-09-12 三参照物清单 P0-①）：`run()` 原来只看 `r.status === 'created'` 就写
//   `lastRunAt` ⇒ 09-09/09-10 自治会话连崩两天，账面全是"成功"，靠主人手动重试才发现。
//
// 判据（正例 + **反例**都要断言；只证"成功会记"会假绿）：
//   A 正例：turn/end=completed → 台账 status=ok + lastResult.status=ok
//   B 反例：turn/end=error      → status=error（**绝不许记成 ok**）
//   C 反例：turn/end 无 reason（上游形状变了）→ status=unknown（响亮，不当 ok）
//   D 反例：拉会话直接失败（agents 不可用）→ 台账 status=error / source=create
//   E 追加语义：多次 run → 台账累加、每行合法 JSON（不覆盖历史）
//   F 反例：非自治会话的 turn/end → **不记账**（不污染）
//   G 超时：占闸超 BUSY_MAX_MS → status=timeout（"跑了但没结果"也算非成功）
//   H 上界：台账超 512KB → 保留后半，**最新一条不丢**（可查 ≠ 全存；无界增长会撑爆磁盘）
//
// 隔离：`DSH_HOME` 指向临时目录（不碰真仓库任何文件），跑完删除。
// 用法：node scripts/mind-cron-runs-itest.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, extra) => results.push([name, ok ? 'PASS' : 'FAIL', extra]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshome-cronruns-'));
  mkdirSync(join(home, 'mind'), { recursive: true });
  mkdirSync(join(home, 'mind-private', 'tasks'), { recursive: true });
  mkdirSync(join(home, 'scripts'), { recursive: true });
  writeFileSync(join(home, 'scripts', 'mind-prime.mjs'), "console.log('# stub prime（itest 用）');\n");
  // catchUp:false ⇒ start() 不会自动补跑，测试全程由我们手动 trigger，时序可控。
  writeFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), JSON.stringify({
    tasks: [
      { id: 'itest-ok', cron: '0 0 * * *', prompt: 'ok', cwd: home, catchUp: false, enabled: true },
      { id: 'itest-err', cron: '0 0 * * *', prompt: 'err', cwd: home, catchUp: false, enabled: true },
      { id: 'itest-noreason', cron: '0 0 * * *', prompt: 'nr', cwd: home, catchUp: false, enabled: true },
    ],
  }, null, 2));
  return home;
}

function makeHost(withAgents) {
  const st = { created: [], handlers: {} };
  const sessions = {
    on(type, fn) { (st.handlers[type] ||= []).push(fn); return () => {}; },
    emit(type, session, event) { for (const f of st.handlers[type] || []) f(session, event); },
  };
  const hostCtx = {
    get(name) {
      if (name === 'agents') {
        if (!withAgents) return undefined; // 反例 D：agents 服务缺失
        return { create: async ({ sessionId }) => { st.created.push(sessionId); return { agent: { id: sessionId, followup() {} } }; } };
      }
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
    inject: (names, cb) => { if (names.includes('sessions')) cb(sessions); return () => {}; },
  };
  return { hostCtx, st, endSession: (id, event) => sessions.emit('session/event', { header: { id } }, event) };
}

const runsFile = (home) => join(home, 'mind-private', 'tasks', 'cron-runs.jsonl');
function readRuns(home) {
  if (!existsSync(runsFile(home))) return [];
  return readFileSync(runsFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const taskOf = (home, id) => JSON.parse(readFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), 'utf8')).tasks.find((t) => t.id === id);

const { DshCron, CRON_RUNS_FILE } = require('../packages/dshome-mind/lib/cron.cjs');

/** 把 `DSH_HOME` 切到临时根，并**断言沙箱真的生效**（2026-09-18 加，实伤驱动）。
 *  根因：`cron.cjs` 的 `repoRoot()` 只在 `DSH_HOME` **含 `mind/` 子目录**时才认它，否则**回落真仓库根**
 *  （该回落本身是安全设计，只是静默）⇒ 一个只建了 `mind-private/` 的探针把**生产** `cron-runs.jsonl`
 *  写成 4500 行垃圾、真记录被覆盖且不可恢复。本断言把那次的教训变成**每次跑都会执行的检查**：
 *  临时根若没建 `mind/`，这里**当场响亮失败**（exit 9），而不是默默写生产账。 */
function useHome(home) {
  process.env.DSH_HOME = home;
  const file = CRON_RUNS_FILE();
  if (!file.startsWith(home)) {
    console.error(`[itest] ❌ 沙箱失效：run 台账解析到 ${file}（**生产**路径）——临时根必须同时含 mind/ 子目录`);
    process.exit(9);
  }
  return file;
}

// ── A/B/C/E/F：turn/end 三种形状 + 追加语义 + 不污染 ─────────────────────────
{
  const home = makeHome();
  useHome(home);
  const { hostCtx, st, endSession } = makeHost(true);
  const cron = new DshCron(hostCtx);
  cron.start();

  // A 正例：completed
  cron.trigger(cron.tasks.find((t) => t.id === 'itest-ok'), 'itest');
  await sleep(400);
  const sidOk = st.created[0];
  check('A0 会话已建立且占了闸', typeof sidOk === 'string' && cron.active.has(sidOk), `sid=${sidOk}`);
  endSession(sidOk, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await sleep(100);
  const a = readRuns(home);
  check('A1 turn/end=completed → 台账 status=ok', a.length === 1 && a[0].status === 'ok', JSON.stringify(a[0]));
  check('A2 → 任务 lastResult.status=ok', taskOf(home, 'itest-ok')?.lastResult?.status === 'ok', JSON.stringify(taskOf(home, 'itest-ok')?.lastResult));

  // B 反例：error（绝不许记成 ok）
  cron.trigger(cron.tasks.find((t) => t.id === 'itest-err'), 'itest');
  await sleep(400);
  const sidErr = st.created[1];
  endSession(sidErr, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } });
  await sleep(100);
  const b = readRuns(home).at(-1);
  check('B1 反例·turn/end=error → status=error 且带 errorCode（**不是 ok**）',
    b.status === 'error' && b.errorCode === 'error', JSON.stringify(b));
  check('B2 → 任务 lastResult 也标 error', taskOf(home, 'itest-err')?.lastResult?.status === 'error', JSON.stringify(taskOf(home, 'itest-err')?.lastResult));

  // C 反例：reason 缺失（上游形状变了）→ 响亮 unknown，不许静默当 ok
  cron.trigger(cron.tasks.find((t) => t.id === 'itest-noreason'), 'itest');
  await sleep(400);
  const sidNr = st.created[2];
  endSession(sidNr, { type: 'turn/end', data: { turn: 1 } });
  await sleep(100);
  const c = readRuns(home).at(-1);
  check('C1 反例·无 reason.kind → status=unknown（不静默、不当 ok）',
    c.status === 'unknown' && c.errorCode === 'no-reason-kind', JSON.stringify(c));

  // F 反例：非自治会话的 turn/end 不记账
  const before = readRuns(home).length;
  endSession('session-别人的会话', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await sleep(100);
  check('F1 反例·非自治会话 turn/end → 不记账（不污染）', readRuns(home).length === before, `before=${before} after=${readRuns(home).length}`);

  // E 追加语义
  const all = readRuns(home);
  check('E1 台账累加（3 条 turn/end 结果，追加不覆盖）', all.length === 3, `lines=${all.length}`);
  check('E2 每行含 ts/taskId/status 且是合法 JSON', all.every((r) => r.ts && r.taskId && r.status), JSON.stringify(all.map((r) => r.status)));

  // G 超时路径：手造一条"远古占闸"再触发 isBusy()
  const stale = 'session-stale';
  cron.active.set(stale, { id: 'itest-ok', since: Date.now() - 46 * 60 * 1000 });
  cron.isBusy();
  await sleep(50);
  const g = readRuns(home).at(-1);
  check('G1 占闸超时 → status=timeout（"跑了没结果"也算非成功）',
    g.status === 'timeout' && String(g.errorCode).startsWith('no-turn-end>'), JSON.stringify(g));

  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── D 反例：拉会话这一步就失败（agents 服务缺失）→ 必须落台账 ────────────────
{
  const home = makeHome();
  useHome(home);
  const { hostCtx } = makeHost(false); // 不给 agents
  const cron = new DshCron(hostCtx);
  cron.start();
  cron.trigger(cron.tasks[0], 'itest');
  await sleep(300);
  const d = readRuns(home);
  check('D1 反例·agents 不可用 → 台账 status=error / source=create（不再只打一行日志）',
    d.length === 1 && d[0].status === 'error' && d[0].source === 'create', JSON.stringify(d[0]));
  check('D2 → lastResult 标 error（而非"跑过了"）', taskOf(home, 'itest-ok')?.lastResult?.status === 'error', JSON.stringify(taskOf(home, 'itest-ok')?.lastResult));
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

// ── H 上界：台账超 512KB → 保留后半 + 最新一条仍在 ────────────────────────────
{
  const home = makeHome();
  useHome(home);
  // 先灌 9000 条旧记录（≈900KB，远超 512KB 上界）——模拟"任务被配成每分钟型"
  const old = Array.from({ length: 9000 }, (_, i) =>
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', taskId: `old-${i}`, status: 'ok', source: 'schedule' })).join('\n') + '\n';
  writeFileSync(runsFile(home), old, 'utf8');
  const { hostCtx, st, endSession } = makeHost(true);
  const cron = new DshCron(hostCtx);
  cron.start();
  cron.trigger(cron.tasks.find((t) => t.id === 'itest-ok'), 'itest');
  await sleep(400);
  endSession(st.created[0], { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await sleep(100);
  const sizeNow = readFileSync(runsFile(home), 'utf8').length;
  const linesNow = readRuns(home);
  check('H1 超上界 → 已裁剪（体量与行数都下降）', sizeNow < old.length && linesNow.length < 9000,
    `before=${old.length}B/9000 行 after=${sizeNow}B/${linesNow.length} 行`);
  check('H2 裁剪保留后半 → 最新一条（本次 run）仍在，未把新证据裁掉',
    linesNow.at(-1)?.taskId === 'itest-ok' && linesNow.at(-1)?.status === 'ok', JSON.stringify(linesNow.at(-1)));
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

let failed = 0;
for (const [name, verdict, extra] of results) {
  if (verdict === 'FAIL') failed++;
  console.log(`[itest] ${name}: ${verdict}${extra && verdict === 'FAIL' ? ' (' + extra + ')' : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
