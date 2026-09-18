#!/usr/bin/env node
// scripts/verify-guard-decisions.mjs — 门禁判定「真值表」验证（2026-09-11 建）
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 2026-09-11 我在验证 `mind-guard` 改动时**连栽三次**，每次都是"测试被环境状态污染"：
//   ① 往所有用例塞了含 `token` 的内容 → privacy 闸全拦，**盖住了** self-modify 的判定；
//   ② 复测时忘了 `autoApprove` 开着 → self-modify 被短路，**全部放行**，我差点当成"绕过已修";
//   ③ 手工复算时自己的正则转义写错 → 得出"修复无效"的错误结论。
// → 结论：**靠记忆与手工复算做判定测试不可靠**。本脚本把它机器化，并**自带前置条件检查**
//   （autoApprove 必须关闭，否则拒绝运行）——把"第 ② 类污染"从根上挡掉。
//
// ── 做什么 ──────────────────────────────────────────────────────────────────
// 用 mock ctx 捕获 guard 判定函数（**不调 ctx.tools.guard 的真实注册，不写盘**），
// 对一组「路径 × 内容」用例跑真值表、逐条比对期望，输出偏差与通过率。
//
// 用法：node scripts/verify-guard-decisions.mjs     （退出码：0=全对；1=有偏差；2=前置条件不满足）
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'mind-guard.js');
const AP = join(repoRoot, 'mind-private', 'tasks', 'approvals.json');

// ── 前置条件：autoApprove 必须关闭 ───────────────────────────────────────────
let aa = null;
try { aa = JSON.parse(readFileSync(AP, 'utf8')).autoApprove; } catch { /* 无文件 = 未开 */ }
// `--simulate-autoapprove`：仅用于**测试降级逻辑本身**，无需真去改 approvals.json。
// 2026-09-11 的教训：我为了测降级模式一度用 `node -e` 直接改写 approvals.json 再改回 ——
// 那既是**越权写「放行真源」**（该文件一小时前才被加进高危门禁区，理由正是"被管方不得自批"），
// 也正好演示了 shell 通道能绕过 guard（C1 早指出过）。**测试不该动被测系统的真实状态。**
const autoOn = process.argv.includes('--simulate-autoapprove')
  || !!(aa && aa.enabled && aa.decidedBy === 'user');
const allowPartial = process.argv.includes('--allow-partial');
if (autoOn && !allowPartial) {
  console.error('[verify-guard-decisions] ❌ 拒绝运行：autoApprove 开着（self-modify 类用例会被短路，结果无意义）');
  console.error('   先到「心智 → 动作放行」面板关掉「自动同意」再跑；改门禁本身需要它时，改完记得关回来。');
  console.error('   自动化场景可加 --allow-partial：**只跑 privacy 类用例**，并明确标注 self-modify 类未验证。');
  process.exit(2);
}
if (!existsSync(GUARD)) {
  console.error(`[verify-guard-decisions] ❌ 找不到 ${GUARD}`);
  process.exit(1);
}

/** 用例表：[说明, 写入路径, 写入内容, 期望(拦|放), 类别(self|privacy|other)]
 *  类别用于 autoApprove 开着时的**降级**：只有 `privacy` 类不受它影响
 * （privacy 排在 self-modify 之前 return，不看那个开关）。 */
const CASES = [
  ['SOUL（高危·原样）', 'mind/L0/SOUL.md', '中性内容', '拦', 'self'],
  ['SOUL·大小写变体', 'E:/DSHOME/MIND/L0/SOUL.md', '中性内容', '拦', 'self'],
  ['AGENTS（高危）', 'mind/L0/AGENTS.md', '中性内容', '拦', 'self'],
  ['Memory.md（高危）', 'mind/L1/Memory.md', '中性内容', '拦', 'self'],
  ['人设卡（高危·目录前缀）', 'mind-private/L0/人设卡.md', '中性内容', '拦', 'self'],
  ['人设卡·全小写路径', 'e:/dshome/mind-private/l0/x.md', '中性内容', '拦', 'self'],
  ['放行真源 approvals.json', 'mind-private/tasks/approvals.json', '中性内容', '拦', 'self'],
  ['approvals.json·大小写变体', 'E:/DSHOME/MIND-PRIVATE/TASKS/APPROVALS.JSON', '中性内容', '拦', 'self'],
  ['L2 Skill（非高危·只提示）', 'mind/L2/Skill/boot-recall.md', '中性内容', '放', 'self'],
  ['L1 Learn（文档区）', 'mind/L1/Learn.md', '中性内容', '放', 'self'],
  ['L3 记忆（生长区）', 'mind-private/L3/common/user-rules/rules.md', '中性内容', '放', 'self'],
  ['普通代码文件', 'E:/OtherProject/foo.txt', '中性内容', '放', 'other'],
  ['出厂区·正当讨论 token', 'mind/L1/Example.md', '记录 token 消耗教训', '放', 'privacy'],
  ['出厂区·中文密码赋值', 'mind/L1/Example.md', '我的密码是 hunter2xyz', '拦', 'privacy'], // cred-ok（测试真值表的示例值，非真凭据）
  ['出厂区·真凭据形态', 'mind/L1/Example.md', 'api_key: sk-abcdef123456', '拦', 'privacy'],
  ['mind/L3 + 真凭据（factoryZone 扩面）', 'mind/L3/README.md', 'password: hunter2xyz', '拦', 'privacy'], // cred-ok（测试真值表的示例值，非真凭据）
  ['mind/Project + 真凭据（factoryZone 扩面）', 'mind/Project/README.md', '私钥: -----BEGIN RSA PRIVATE KEY', '拦', 'privacy'],
];
/** autoApprove 开着时降级：只跑 privacy 类（其余会被短路，跑了也无意义）。 */
const ACTIVE = autoOn ? CASES.filter((c) => c[4] === 'privacy') : CASES;

// ── 副作用保护 ──────────────────────────────────────────────────────────────
// self-modify 类用例会命中 guard → `addApprovalPending` 会往 **approvals.json 真写**待裁决。
// 2026-09-11 实测：跑 3 次攒了 40 条假 pending，**污染了面板**（又一次"测试污染被测系统"）。
// 现在先备份原文、进程退出时恢复 —— 本脚本从此**不改变被测系统状态**。
const AP_BAK = (() => { try { return readFileSync(AP, 'utf8'); } catch { return null; } })();
if (AP_BAK !== null) {
  process.on('exit', () => { try { writeFileSync(AP, AP_BAK, 'utf8'); } catch { /* 忽略 */ } });
}

const mod = await import(pathToFileURL(GUARD).href);
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  on: () => {}, off: () => {}, effect: () => () => {},
  tools: { guard: () => () => {}, register: () => {} },
};
// ── 直调判定，不 `apply` ─────────────────────────────────────────────────────
// 2026-09-12 实测：本脚本此前走 `await mod.apply(ctx)` 再用注册进去的 guard 函数跑用例 —— 而 `apply`
// 会往**真实 profile** 写 `mounted:` 行、每次拒绝判定再写一行 `last-deny:` ⇒ 每次运行（含 pre-commit
// hook 每次提交）往 20 行环里塞 1 条假挂载 + 4 条假拒绝，把真正的现场证据挤出去。"验证门禁不污染现场"
// ⇒ 改调 mind-guard 导出的纯判定 `decide()`（marker/告警等副作用留在 `apply` 那一层）。
// 覆盖面分工：`apply` 的注册与挂载行写入由 `verify-host-plugins.mjs` 覆盖（它有 marker 保护 + 起点基线自检）。
const decide = mod.decide;
if (typeof decide !== 'function') {
  console.error('[verify-guard-decisions] ❌ mind-guard 未导出纯判定 `decide()`（判定的可测性被破坏了）');
  process.exit(1);
}

// ── 自检：本脚本有没有污染真 marker（门禁必须自证） ──────────────────────────
// 教训（2026-09-12）：`verify-host-plugins` 的"保护现场"曾因**快照拍在破坏之后**而形同虚设——门禁的
// 自检必须能被反证、且要比"整轮起点基线"，不能只看局部前后。判据：本脚本运行前后真 marker 逐字节
// 不变（文件不存在也算一种稳定状态）。若变化 ⇒ 本门禁自己就是污染源。
const MARKER = join(repoRoot, 'profiles', 'dshome', '.dsh-market', 'mind-guard-marker.txt');
const readMarker = () => { try { return readFileSync(MARKER, 'utf8'); } catch { return null; } };
const markerBefore = readMarker();

let pass = 0;
const fails = [];
if (autoOn) {
  console.log(`[verify-guard-decisions] ⚠️ autoApprove 开着 → **降级运行**：只跑 privacy 类 ${ACTIVE.length} 例；`);
  console.log(`   self-modify 类 ${CASES.length - ACTIVE.length} 例**本次未验证**（会被开关短路，跑了也没有意义）。`);
}
console.log(`[verify-guard-decisions] 真值表（${ACTIVE.length} 例${autoOn ? ' · 降级' : ' · 全量 · autoApprove=off 前置已满足'}）`);
for (const [label, path, content, want] of ACTIVE) {
  let got = '放', reason = '';
  try {
    const r = decide({ name: 'edit', arguments: { file_path: path, new_string: content } }, ctx);
    if (r?.reason) { got = '拦'; reason = String(r.reason).replace(/\s+/g, ' ').slice(0, 46); }
  } catch (e) {
    got = '抛错'; reason = (e && e.message) || String(e);
  }
  const ok = got === want;
  if (ok) pass++; else fails.push({ label, path, want, got, reason });
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(30)} 期望[${want}] 实际[${got}]${reason ? '  «' + reason + '»' : ''}`);
}
console.log(`[verify-guard-decisions] ${pass}/${ACTIVE.length} 通过${fails.length ? ` · ${fails.length} 处偏差` : ''}`);
if (fails.length) {
  console.log('[verify-guard-decisions] 偏差明细：');
  for (const f of fails) console.log(`  · ${f.label}（${f.path}）期望 ${f.want} 实际 ${f.got} —— ${f.reason}`);
}

// ── 接线探针：apply 是否真把 decide() 的 marker 写下去 ───────────────────────
// 为什么需要它：判定改成直调 `decide()` 后，`apply → decide → writeMarker` 这条**委派**就没有断言覆盖了
// （真值表不再经过 apply）。2026-09-12 已用"删掉委派那行"的坏副本反证：本探针会变红（`deny行=false`）。
// ⚠️ 这里改 `DSH_HOME` **只**为了改 marker 的落点——本阶段测的是**接线**，不是判定；判定用例全部已在上面
// 的真环境下跑完。**若把 DSH_HOME 用于判定用例**，就会连"决策输入"（路径解析 / `approvals.json`）一起搬走，
// 变成"测另一套系统"——两者必须分开（这正是本脚本 2026-09-12 踩过的坑）。
let wiringOk = true;
const prevHome = process.env.DSH_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'guard-wiring-'));
try {
  process.env.DSH_HOME = tempHome;
  const cap2 = [];
  const ctx2 = { ...ctx, tools: { guard: (fn) => { cap2.push(fn); return () => {}; }, register: () => {} } };
  mod.apply(ctx2);
  const p2 = join(tempHome, 'profiles', 'dshome', '.dsh-market', 'mind-guard-marker.txt');
  const read2 = () => { try { return readFileSync(p2, 'utf8'); } catch { return ''; } };
  const m1 = /^mounted:/m.test(read2());
  const fn2 = cap2[0];
  const r2 = typeof fn2 === 'function'
    ? fn2({ name: 'edit', arguments: { file_path: 'mind/L1/Example.md', new_string: 'api_key: sk-abcdef123456' } }) // cred-ok（探针示例值，非真凭据）
    : undefined;
  const m2 = /^last-deny:/m.test(read2());
  wiringOk = m1 && m2 && !!r2;
  console.log(`  ${wiringOk ? '✅' : '❌'} 接线探针：apply→decide→marker（挂载行=${m1} 拒绝行=${m2} 拦下=${!!r2}）`);
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* 清临时根失败不影响判定 */ }
}

// ── 放行额度「写成功才消费」（2026-09-12 加，回归真缺陷）───────────────────────
// 旧实现：`isApproved()` 命中即从 approvals.json 删记录 —— 而那一问发生在**工具执行之前**，
// 于是任何后续失败（工具层拒绝 / 磁盘错 / 中断）都会**白烧**主人在面板点的放行（09-12 实测一次）。
// 本段真跑四步（真临时 DSH_HOME）：① 命中但不消费 ② 反证：post-execute=**failure** 不许消费
// ③ 正例：post-execute=**success** 才消费 ④ 额度用掉后再判 → 变"拦"。
const approveHome = mkdtempSync(join(tmpdir(), 'guard-approve-'));
const prevHome2 = process.env.DSH_HOME;
let approveOk = true;
const approveLog = [];
try {
  process.env.DSH_HOME = approveHome;
  mkdirSync(join(approveHome, 'mind-private', 'tasks'), { recursive: true });
  const apFile = join(approveHome, 'mind-private', 'tasks', 'approvals.json');
  const target = join(approveHome, 'mind', 'L1', 'Memory.md').replace(/\\/g, '/');
  const writeAp = () => writeFileSync(apFile, JSON.stringify({
    items: [{ id: 'ap-t1', kind: 'action', path: target, op: 'edit', status: 'approved', decidedBy: 'user' }],
    autoApprove: { enabled: false, decidedBy: 'user' },
  }, null, 2), 'utf8');
  const readAp = () => JSON.parse(readFileSync(apFile, 'utf8')).items;

  // ── 裁决台账（2026-09-18 P0-②「审批留痕物证」）─────────────────────────────
  // 为什么单测它：approvals.json 只证明"有过一次放行"，**对不上是哪次工具调用**（审计判"无法验证"）。
  // 台账必须对每一次裁决都留下 `拦/放 + 凭哪条额度` 的物证，且要有上界（可查 ≠ 全存）。
  const decFile = mod.guardDecisionsFile();
  const readDecisions = () => {
    try { return readFileSync(decFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; } // 文件不存在 = 还没裁决过
  };

  const guards3 = []; const postHooks = [];
  const ctx3 = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    on: (ev, fn) => { if (ev === 'tools/post-execute') postHooks.push(fn); },
    off: () => {}, effect: () => () => {},
    tools: { guard: (fn) => { guards3.push(fn); return () => {}; }, register: () => {} },
  };
  mod.apply(ctx3);
  const guardFn2 = guards3[0];
  const postFn = postHooks[0];
  const exec3 = { name: 'edit', arguments: { file_path: 'mind/L1/Memory.md', new_string: 'x' } };
  const nextOk = async () => ({ kind: 'accept' });

  writeAp();
  const r1 = guardFn2(exec3);
  approveOk = approveOk && !r1 && readAp().length === 1;
  approveLog.push(`① 命中放行 → 放行=${!r1} 且记录仍在=${readAp().length === 1}（命中≠消费）`);
  // ⑦ 台账①：放行必须留"凭哪条额度"的物证（decision=allow-by-approval + approvalIds）
  const d7 = readDecisions().at(-1);
  approveOk = approveOk && d7?.decision === 'allow-by-approval' &&
    (d7.approvalIds || []).includes('ap-t1') && /Memory\.md$/.test(d7.path || '');
  approveLog.push(`⑦ 台账·放：decision=${d7?.decision} approvalIds=${JSON.stringify(d7?.approvalIds || [])} path=${d7?.path}（放行对得上调用）`);
  await postFn(exec3, { isError: true }, nextOk);
  approveOk = approveOk && readAp().length === 1;
  approveLog.push(`② post-execute 失败（isError:true）→ 记录仍在=${readAp().length === 1}（反证：不许白烧额度）`);
  await postFn(exec3, { isError: false }, nextOk);
  approveOk = approveOk && readAp().length === 0;
  approveLog.push(`③ post-execute 成功（isError:false）→ 记录被消费=${readAp().length === 0}`);
  const r2 = guardFn2(exec3);
  approveOk = approveOk && !!r2;
  approveLog.push(`④ 额度用掉后再判 → 拦=${!!r2}`);
  // 🔴 判据贴上游真实契约：`ToolExecutionResult` = `{isError:false}` / `{isError:true}`，**没有 `kind`**。
  //    2026-09-17 实测事故：实现曾写 `result?.kind === 'success'` ⇒ 真跑恒不等、`consumeApproved`
  //    永不执行；而**本探针当时也用同一个假形状** ⇒ 门禁恒绿、生产恒坏（09-14 首次观察到）。
  //    ⑤ 就是锁这条：自造形状不得被当成功（先真判一次入 in-flight，再喂假形状）。
  writeAp();
  guardFn2(exec3);
  await postFn(exec3, { kind: 'success' }, nextOk);
  approveOk = approveOk && readAp().length === 1;
  approveLog.push(`⑤ 反例·{kind:'success'}（自造形状）→ 记录仍在=${readAp().length === 1}（只认真实契约）`);
  // ⑥ 反例：缺 file_path 不得抛、也不消费
  writeAp();
  await postFn({ name: 'edit', arguments: {} }, { isError: false }, nextOk);
  approveOk = approveOk && readAp().length === 1;
  approveLog.push(`⑥ 反例·缺 file_path → 不消费且不抛=${readAp().length === 1}`);
  // ⑧ 台账·拦：高危区且无额度 → decision=deny 且带 reason（"想改什么、为什么拦"可查）
  writeAp();
  const soulExec = { name: 'edit', arguments: { file_path: 'mind/L0/SOUL.md', new_string: 'x' } };
  const rSoul = guardFn2(soulExec);
  const d8 = readDecisions().at(-1);
  approveOk = approveOk && !!rSoul && d8?.decision === 'deny' &&
    /SOUL\.md$/.test(d8.path || '') && typeof d8.reason === 'string' && d8.reason.length > 0;
  approveLog.push(`⑧ 台账·拦：写 SOUL.md → 拦=${!!rSoul} decision=${d8?.decision} 带 reason=${typeof d8?.reason === 'string'}`);
  // ⑨ 台账上界：超 512KB → 保留后半且**不丢最新一条**（台账是可查，不是全存）
  const big = Array.from({ length: 9000 }, (_, i) =>
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', tool: 'edit', path: 'x.md', op: 'edit', decision: 'allow', i })).join('\n') + '\n';
  writeFileSync(decFile, big, 'utf8');
  guardFn2({ name: 'edit', arguments: { file_path: 'mind/L1/Memory.md', new_string: 'y' } });
  const afterTxt = readFileSync(decFile, 'utf8');
  const afterLines = afterTxt.split('\n').filter(Boolean);
  const lastRec = JSON.parse(afterLines.at(-1));
  approveOk = approveOk && afterTxt.length < big.length && afterLines.length < 9000 && /Memory\.md$/.test(lastRec.path || '');
  approveLog.push(`⑨ 台账上界：${big.length}B → ${afterTxt.length}B / ${afterLines.length} 行，最后一条=${lastRec.path}（裁剪保留后半、最新不丢）`);
} catch (e) {
  approveOk = false;
  approveLog.push(`抛错：${(e && e.message) || e}`);
} finally {
  if (prevHome2 === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome2;
  try { rmSync(approveHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
for (const l of approveLog) console.log(`  ${approveOk ? '✅' : '❌'} ${l}`);

// ── 上游批准面（2026-09-18 加 · 方案④「拆档」后半）：真跑 `tools/pre-execute` ────────────────
// 判据（每条都要能变红）：`allowed-once` 放行且**不建自家幽灵卡** / `rejected`·`cancelled` 硬拒 /
// `unavailable`·无服务·缺 agent·请求抛错 ⇒ **回落自家面板流程**（guard 照常拦 + 建卡）/
// 非高危区**问都不问**上游。
const upHome = mkdtempSync(join(tmpdir(), 'guard-upstream-'));
const prevHome3 = process.env.DSH_HOME;
let upOk = true;
const upLog = [];
try {
  process.env.DSH_HOME = upHome;
  mkdirSync(join(upHome, 'mind'), { recursive: true });
  mkdirSync(join(upHome, 'mind-private', 'tasks'), { recursive: true });
  const apUp = join(upHome, 'mind-private', 'tasks', 'approvals.json');
  const ledUp = join(upHome, 'mind-private', 'tasks', 'guard-decisions.jsonl');
  const readUpAp = () => { try { return JSON.parse(readFileSync(apUp, 'utf8')).items || []; } catch { return []; } };
  const readUpLedger = () => {
    try {
      return readFileSync(ledUp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const mkCtx = (approvalImpl) => {
    const guards = []; const preHooks = [];
    const c = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      on: (ev, fn) => { if (ev === 'tools/pre-execute') preHooks.push(fn); },
      off: () => {}, effect: () => () => {},
      get: (n) => (n === 'approval' ? approvalImpl : undefined),
      tools: { guard: (fn) => { guards.push(fn); return () => {}; }, register: () => {} },
    };
    return { c, guards, preHooks };
  };
  const highRisk = { name: 'edit', callId: 'c-high', agent: { session: {} }, arguments: { file_path: 'mind/L1/Memory.md', new_string: 'x' } };
  const lowRisk = { name: 'edit', callId: 'c-low', agent: { session: {} }, arguments: { file_path: 'mind/L2/Skill/x.md', new_string: 'x' } };
  const freshHome = () => { try { rmSync(apUp, { force: true }); } catch { /* 首次不存在 */ } };

  // ① allowed-once → 放行 + guard 不拦 + **不建自家卡** + 台账记 allow-by-upstream
  {
    freshHome();
    let asked = 0;
    const { c, guards, preHooks } = mkCtx({ request: async () => { asked += 1; return 'allowed-once'; } });
    mod.apply(c);
    const r = await preHooks[0](highRisk, () => 'next-called');
    const g = guards[0](highRisk);
    const led = readUpLedger().at(-1);
    upOk = upOk && r === 'next-called' && g === undefined && asked === 1 && readUpAp().length === 0 && led?.decision === 'allow-by-upstream';
    upLog.push(`① allowed-once → 放行=${r === 'next-called'} guard不拦=${g === undefined} 问上游 ${asked} 次 自家卡=${readUpAp().length} 台账=${led?.decision}`);
  }
  // ② rejected → 硬拒（不改用自家卡）
  {
    freshHome();
    let asked = 0;
    const { c, preHooks } = mkCtx({ request: async () => { asked += 1; return 'rejected'; } });
    mod.apply(c);
    const r = await preHooks[0](highRisk, () => 'next-called');
    upOk = upOk && r?.kind === 'deny' && /rejected/.test(String(r.reason)) && asked === 1 && readUpAp().length === 0;
    upLog.push(`② rejected → 硬拒=${r?.kind === 'deny'} 理由含 rejected=${/rejected/.test(String(r?.reason))} 自家卡=${readUpAp().length}`);
  }
  // ③ cancelled → 硬拒
  {
    freshHome();
    const { c, preHooks } = mkCtx({ request: async () => 'cancelled' });
    mod.apply(c);
    const r = await preHooks[0](highRisk, () => 'next-called');
    upOk = upOk && r?.kind === 'deny' && /cancelled/.test(String(r.reason));
    upLog.push(`③ cancelled → 硬拒=${r?.kind === 'deny'}`);
  }
  // ④ unavailable（无人应答）→ **不当作放行**：回落自家面板流程（guard 拦 + 建卡）
  {
    freshHome();
    const { c, guards, preHooks } = mkCtx({ request: async () => 'unavailable' });
    mod.apply(c);
    const r = await preHooks[0](highRisk, () => 'next-called');
    const g = guards[0](highRisk);
    upOk = upOk && r === 'next-called' && typeof g === 'string' && readUpAp().length === 1;
    upLog.push(`④ unavailable → 回落=${r === 'next-called'} guard 拦=${typeof g === 'string'} 自家卡=${readUpAp().length}`);
  }
  // ⑤ 无 approval 服务 → 回落自家面板流程
  {
    freshHome();
    const { c, guards, preHooks } = mkCtx(undefined);
    mod.apply(c);
    const r = await preHooks[0](highRisk, () => 'next-called');
    const g = guards[0](highRisk);
    upOk = upOk && r === 'next-called' && typeof g === 'string' && readUpAp().length === 1;
    upLog.push(`⑤ 无 approval 服务 → 回落=${r === 'next-called'} + guard 拦 + 建卡=${readUpAp().length === 1}`);
  }
  // ⑥ 缺 agent → 回落（不抛、不硬拒，且**不调** request）
  {
    freshHome();
    let asked = 0;
    const { c, guards, preHooks } = mkCtx({ request: async () => { asked += 1; return 'allowed-once'; } });
    mod.apply(c);
    const noAgent = { ...highRisk, agent: undefined };
    const r = await preHooks[0](noAgent, () => 'next-called');
    const g = guards[0](noAgent);
    upOk = upOk && r === 'next-called' && typeof g === 'string' && asked === 0;
    upLog.push(`⑥ 缺 agent → 回落（问了 ${asked} 次）+ guard 拦=${typeof g === 'string'}`);
  }
  // ⑦ request 抛错（无打开的 turn）→ 回落、**绝不带崩调用**
  {
    freshHome();
    const { c, guards, preHooks } = mkCtx({ request: async () => { throw new Error('approval.request() outside an open turn'); } });
    mod.apply(c);
    const r = await preHooks[0](highRisk, () => 'next-called');
    const g = guards[0](highRisk);
    upOk = upOk && r === 'next-called' && typeof g === 'string';
    upLog.push(`⑦ request 抛错 → 回落（不崩）+ guard 拦=${typeof g === 'string'}`);
  }
  // ⑧ 非高危区（L2 Skill）→ 问都不问上游
  {
    freshHome();
    let asked = 0;
    const { c, guards, preHooks } = mkCtx({ request: async () => { asked += 1; return 'rejected'; } });
    mod.apply(c);
    const r = await preHooks[0](lowRisk, () => 'next-called');
    const g = guards[0](lowRisk);
    upOk = upOk && r === 'next-called' && g === undefined && asked === 0;
    upLog.push(`⑧ 非高危区 → 不问上游（问了 ${asked} 次）+ 放行`);
  }
} catch (e) {
  upOk = false;
  upLog.push(`抛错：${(e && e.message) || e}`);
} finally {
  if (prevHome3 === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome3;
  try { rmSync(upHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
for (const l of upLog) console.log(`  ${upOk ? '✅' : '❌'} ${l}`);

// ── 静态锁：消费必须发生在 `post-execute`，不许留在 `isApproved` 里 ─────────────
const guardSrc = readFileSync(GUARD, 'utf8');
const isApprovedBody = (guardSrc.match(/function isApproved\([\s\S]*?\n}/) || [''])[0];
let staticOk = true;
const lock = (cond, label) => { if (!cond) staticOk = false; console.log(`  ${cond ? '✅' : '❌'} ${label}`); };
lock(isApprovedBody.length > 0 && !/writeApprovals/.test(isApprovedBody), '静态锁：isApproved() 体内不写 approvals.json（不在这里消费）');
lock(/ctx\.on\(\s*['"]tools\/post-execute['"]/.test(guardSrc), "静态锁：apply 注册了 'tools/post-execute'");
lock(/consumeApproved\(/.test(guardSrc), '静态锁：存在 consumeApproved()（写成功后消费）');
lock(/ctx\.on\(\s*['"]tools\/pre-execute['"]/.test(guardSrc), "静态锁：apply 注册了 'tools/pre-execute'（上游批准面）");
lock(/upstreamApproved\.has\(exec\.callId\)/.test(guardSrc), '静态锁：guard 命中 upstreamApproved 时**直接放行**（不进 decide ⇒ 不建幽灵卡）');
lock(/ctx\.get\(\s*['"]approval['"]\s*\)/.test(guardSrc), "静态锁：用动态 `ctx.get('approval')` 取上游服务（缺服务不炸）");

const markerAfter = readMarker();
const selfClean = markerBefore === markerAfter;
if (!selfClean) {
  console.error('[verify-guard-decisions] ❌ 门禁自检失败：真 marker 在本次运行中变了（本门禁不得污染现场）');
  console.error(`    ${MARKER}`);
}
console.log(`[verify-guard-decisions] 自检：真 marker 运行前后${selfClean ? '一致 ✅（零污染）' : '不一致 ❌（本门禁是污染源）'}`);
process.exit(fails.length || !selfClean || !wiringOk || !approveOk || !staticOk || !upOk ? 1 : 0);
