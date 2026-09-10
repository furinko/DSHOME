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
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  ['普通代码文件', 'E:/DSH/foo.txt', '中性内容', '放', 'other'],
  ['出厂区·正当讨论 token', 'mind/L1/Example.md', '记录 token 消耗教训', '放', 'privacy'],
  ['出厂区·中文密码赋值', 'mind/L1/Example.md', '我的密码是 hunter2xyz', '拦', 'privacy'],
  ['出厂区·真凭据形态', 'mind/L1/Example.md', 'api_key: sk-abcdef123456', '拦', 'privacy'],
  ['mind/L3 + 真凭据（factoryZone 扩面）', 'mind/L3/README.md', 'password: hunter2xyz', '拦', 'privacy'],
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
const captured = [];
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  on: () => {}, off: () => {}, effect: () => () => {},
  tools: { guard: (fn) => { captured.push(fn); return () => {}; }, register: () => {} },
};
await mod.apply(ctx);
const guardFn = captured[0];
if (typeof guardFn !== 'function') {
  console.error('[verify-guard-decisions] ❌ 未捕获到 guard 判定函数（apply 没注册成功？）');
  process.exit(1);
}

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
    const r = guardFn({ name: 'edit', arguments: { file_path: path, new_string: content } });
    if (r) { got = '拦'; reason = String(r).replace(/\s+/g, ' ').slice(0, 46); }
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
process.exit(fails.length ? 1 : 0);
