#!/usr/bin/env node
// scripts/mind-cron-attach-itest.mjs — cron 自治「工作区归属登记」行为自测（2026-09-24 建）
//
// 验什么：`attachToWorkspace` 在**工作区服务晚到**时不再立刻放弃（有界等待），且**每次 run 的 attach
//   结果都落在任务上**（`lastAttach`）——把"静默落未分组"变成"可诊断"。
// 病灶背景（2026-09-24 每日自维护 A/B 实测定位）：
//   宿主 22:22:55 启动、catch-up **22:23:09（只隔 14 秒）**就拉起会话，此刻 `workspaceRegistry` 的
//   旁路 inject 还没到 ⇒ `attachToWorkspace` 立刻返回 `workspace-registry-unavailable`，而
//   `declared=false` 时只打一行 warn ⇒ **会话静默落「未分组」**（每重启一次多一条）。
//   实证：同一活进程里两条探针（带/不带 `workspace`）都 `attached:true·attempts:1`，
//   而同 cwd 的 22:23 那条没归上 ⇒ 与"缺字段"无关，就是**抢跑**。
//   副产物：那次判不了"registry 没就绪"还是"attachSession 重试窗口不够"，因为 attach 结果**不落任何台账**。
//
// 判据（正例 + **反例**都要断言；只证"能归上"会假绿）：
//   A 正例·registry 600ms 后才到 → **等到了**：attached=true / attempts=1 / registryWaitedMs ≥ 500
//   B 反例·registry **永不**就绪 + 预算 800ms → attached=false / reason=workspace-registry-unavailable
//       / **有界**（总耗时 < 3s，不无限等）
//   C 回归·`@none`（skipAttach）→ 立刻返回 declared-none，**registryWaitedMs=0**（不许白等）
//   D 回归·registry 即时可用 → attached=true 且 **registryWaitedMs=0**（正常路径零开销）
//   E 端到端·`cron.trigger` 真跑 → 任务上落 `lastAttach`（attached/attempts/registryWaitedMs/sessionId）
//       且**真落盘**（cron.json 里也读得到）——这是"记账"那一半的判据
//   F 反例·登记失败时 → `lastAttach.attached = false` 且 reason 可读（**绝不许把失败记成成功**）
//
// 隔离：`DSH_HOME` 指向临时目录（不碰真仓库），跑完删除；临时根必须含 `mind/`（否则 cron.cjs 回落真仓库）。
// 用法：node scripts/mind-cron-attach-itest.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// 覆盖"等 registry"上限（只给测试用；同 `DSHOME_CRON_GATE_WAIT_MS` 的口径）——必须在 require 之前设。
process.env.DSHOME_CRON_ATTACH_WAIT_MS = '2000';

const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, extra) => results.push([name, ok ? 'PASS' : 'FAIL', extra]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshome-cronattach-'));
  mkdirSync(join(home, 'mind'), { recursive: true });
  mkdirSync(join(home, 'mind-private', 'tasks'), { recursive: true });
  mkdirSync(join(home, 'scripts'), { recursive: true });
  writeFileSync(join(home, 'scripts', 'mind-prime.mjs'), "console.log('# stub prime（itest 用）');\n");
  writeFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), JSON.stringify({
    tasks: [
      { id: 'itest-attach', cron: '0 0 * * *', prompt: 'attach', cwd: home, catchUp: false, enabled: true },
      // G 用**独立任务**：`lastAttach` 挂在任务对象上，共用一条会被上一个用例的旧账污染（本用例第一版就中招）
      { id: 'itest-attach-g', cron: '0 0 * * *', prompt: 'attach-g', cwd: home, catchUp: false, enabled: true },
    ],
  }, null, 2));
  return home;
}

function makeHost() {
  const st = { created: [] };
  const sessions = { on() { return () => {}; } };
  const hostCtx = {
    get(name) {
      if (name === 'agents') return { create: async ({ sessionId }) => { st.created.push(sessionId); return { agent: { id: sessionId, followup() {} } }; } };
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
    inject: (names, cb) => { if (names.includes('sessions')) cb(sessions); return () => {}; },
  };
  return { hostCtx, st };
}

/** 假工作区实体：只实现 attach 路径用到的两个方法。 */
function fakeWs(path) {
  const st = { attached: [] };
  const entity = {
    id: 'ws-' + path, path,
    async attachSession(sid) { st.attached.push(sid); },
    st,
  };
  return entity;
}
function fakeRegistry(ws) {
  return { list: () => [ws], resolveByPath: async (p) => (String(p).toLowerCase() === String(ws.path).toLowerCase() ? ws : null) };
}

const { attachToWorkspace, DshCron, setWorkspaceRegistry, setCronInstance } = require('../packages/dshome-mind/lib/cron.cjs');

// ── A/B/C/D：直接打 attachToWorkspace（参数级控制预算，不在生产面加旋钮）──────
{
  const home = makeHome();

  // A 正例：registry 600ms 后才出现 ⇒ 必须**等**到它
  setWorkspaceRegistry(null);
  const wsA = fakeWs(home);
  setTimeout(() => setWorkspaceRegistry(fakeRegistry(wsA)), 600);
  const tA = Date.now();
  const a = await attachToWorkspace({}, { taskId: 'itest-attach', sessionId: 'sid-A', runTarget: { cwd: home, workspacePath: null, skipAttach: false, declared: false }, registryWaitMs: 3000 });
  const aMs = Date.now() - tA;
  check('A1 registry 600ms 后到 → 等到并登记成功', a.attached === true && a.attempts === 1, JSON.stringify(a));
  check('A2 → registryWaitedMs ≥ 500（真等了，不是碰巧）', a.registryWaitedMs >= 500, `registryWaitedMs=${a.registryWaitedMs} total=${aMs}ms`);
  check('A3 → 会话真交给实体（attachSession 被调）', wsA.st.attached.includes('sid-A'), JSON.stringify(wsA.st.attached));

  // B 反例：registry 永不到 ⇒ 有界失败，绝不无限等
  setWorkspaceRegistry(null);
  const tB = Date.now();
  const b = await attachToWorkspace({}, { taskId: 'itest-attach', sessionId: 'sid-B', runTarget: { cwd: home, workspacePath: null, skipAttach: false, declared: false }, registryWaitMs: 800 });
  const bMs = Date.now() - tB;
  check('B1 反例·registry 永不到 → attached=false 且 reason=workspace-registry-unavailable',
    b.attached === false && b.reason === 'workspace-registry-unavailable', JSON.stringify(b));
  check('B2 → **有界**（预算 800ms，总耗时 < 3000ms）', bMs < 3000, `total=${bMs}ms`);

  // C 回归：@none（skipAttach）不许白等
  setWorkspaceRegistry(null);
  const tC = Date.now();
  const c = await attachToWorkspace({}, { taskId: 'itest-attach', sessionId: 'sid-C', runTarget: { cwd: home, workspacePath: null, skipAttach: true, declared: true } });
  const cMs = Date.now() - tC;
  check('C1 回归·skipAttach → declared-none 且 registryWaitedMs=0（不白等）',
    c.attached === false && c.reason === 'declared-none' && c.registryWaitedMs === 0, JSON.stringify(c));
  check('C2 → 立即返回（< 100ms）', cMs < 100, `total=${cMs}ms`);

  // D 回归：registry 即时可用 ⇒ 零等待，语义不变
  const wsD = fakeWs(home);
  setWorkspaceRegistry(fakeRegistry(wsD));
  const d = await attachToWorkspace({}, { taskId: 'itest-attach', sessionId: 'sid-D', runTarget: { cwd: home, workspacePath: home, skipAttach: false, declared: true } });
  check('D1 回归·registry 即时可用 → attached=true / registryWaitedMs=0',
    d.attached === true && d.registryWaitedMs === 0 && d.workspaceId === wsD.id, JSON.stringify(d));

  // D2 回归·路径不匹配 → 仍响亮报 no-matching-workspace（不许悄悄"成功"）
  const d2 = await attachToWorkspace({}, { taskId: 'itest-attach', sessionId: 'sid-D2', runTarget: { cwd: 'E:\\别的目录', workspacePath: null, skipAttach: false, declared: false } });
  check('D2 回归·无匹配工作区 → attached=false / reason=no-matching-workspace',
    d2.attached === false && d2.reason === 'no-matching-workspace', JSON.stringify(d2));

  setWorkspaceRegistry(null);
  rmSync(home, { recursive: true, force: true });
}

// ── E/F：端到端走 `cron.trigger` → 任务上必须留下 lastAttach（且落盘）──────────
{
  const home = makeHome();
  process.env.DSH_HOME = home;
  const { hostCtx, st } = makeHost();
  const cron = new DshCron(hostCtx);
  setCronInstance(cron); // 生产路径：index.cjs 起 cron 时也这么设 ⇒ 记账才落盘
  cron.start();

  // E 正例：registry 400ms 后才到（复刻冷启动抢跑的形状）→ 首查不等、后台等到 + 记账
  setWorkspaceRegistry(null);
  const wsE = fakeWs(home);
  setTimeout(() => setWorkspaceRegistry(fakeRegistry(wsE)), 400);
  const task = cron.tasks.find((t) => t.id === 'itest-attach');
  task.cwd = home;
  const tE = Date.now();
  cron.trigger(task, 'itest');
  await sleep(900); // 必须 > 后台首轮：registry 延迟(400ms) + 一轮轮询(500ms)
  const la = task.lastAttach;
  check('E1 端到端·任务上落了 lastAttach（attached=true）', !!la && la.attached === true, JSON.stringify(la));
  check('E2 → 记了 attempts / registryWaitedMs / sessionId（可诊断的三要素）',
    !!la && la.attempts >= 1 && typeof la.registryWaitedMs === 'number' && typeof la.sessionId === 'string',
    JSON.stringify(la));
  const onDisk = existsSync(join(home, 'mind-private', 'tasks', 'cron.json'))
    ? JSON.parse(readFileSync(join(home, 'mind-private', 'tasks', 'cron.json'), 'utf8')).tasks.find((t) => t.id === 'itest-attach')
    : null;
  check('E3 → **真落盘**（cron.json 里读得到 lastAttach，不是只在内存）', !!onDisk?.lastAttach?.attached, JSON.stringify(onDisk?.lastAttach));

  // G 回归（本改动**第一版就是在这里翻车**的）：绝不阻塞 `executeTask` —— `run()` 的时序是
  //   「占 pending 闸 → await executeTask → 交棒真实 sessionId」，一旦阻塞到"会话已 turn/end"之后，
  //   `release()` 就找不到人、闸卡到 `BUSY_MAX_MS`(45min)（实测：`mind-cron-serialize-itest` A5/A6/A8/B3 变红）。
  //   判据＝**闸里不许长时间留着 `pending:` 占位**。
  cron.active.clear();
  setWorkspaceRegistry(null);
  const taskG = cron.tasks.find((t) => t.id === 'itest-attach-g');
  taskG.cwd = home;
  setTimeout(() => setWorkspaceRegistry(fakeRegistry(fakeWs(home))), 400); // "晚到"必须真晚到
  cron.trigger(taskG, 'itest');
  await sleep(150); // registry 400ms 才到 ⇒ 此刻若在阻塞等，闸里必是 pending:
  const keysG = [...cron.active.keys()];
  check('G1 回归·registry 未就绪时 executeTask **不阻塞**（闸里不许留 pending: 占位）',
    keysG.length === 1 && !keysG[0].startsWith('pending:'), JSON.stringify(keysG));
  check('G2 → 结论未定时**不先记一笔失败**（deferred 期间 lastAttach 应为空）',
    taskG.lastAttach === undefined, JSON.stringify(taskG.lastAttach));
  await sleep(1100);
  check('G3 → 后台补登记把归属补上（deferred=true 且 attached=true）',
    taskG.lastAttach?.attached === true && taskG.lastAttach?.deferred === true, JSON.stringify(taskG.lastAttach));

  // F 反例：registry 拿不到（预算已压到 2s）→ 必须记成**失败**，不许记成成功
  // （E 的会话没结束 ⇒ 闸还占着，同一任务会被 skip:already-running；测试里手动放闸）
  cron.active.clear();
  setWorkspaceRegistry(null);
  const task2 = cron.tasks.find((t) => t.id === 'itest-attach');
  await cron.trigger(task2, 'itest');
  await sleep(3000);
  const la2 = task2.lastAttach;
  check('F1 反例·登记失败 → lastAttach.attached=false 且 reason 可读（绝不记成成功）',
    !!la2 && la2.attached === false && la2.reason === 'workspace-registry-unavailable', JSON.stringify(la2));
  check('F2 → 会话照常建出来（归属失败**不阻断**自治）', st.created.length >= 2, `created=${JSON.stringify(st.created)}`);

  cron.clear();
  setWorkspaceRegistry(null);
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter(([, v]) => v === 'FAIL').length;
for (const [name, verdict, extra] of results) {
  console.log(`[itest] ${name}: ${verdict}${extra && verdict === 'FAIL' ? ' (' + extra + ')' : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
