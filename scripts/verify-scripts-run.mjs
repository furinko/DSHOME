#!/usr/bin/env node
// scripts/verify-scripts-run.mjs — 工具脚本「真跑冒烟」（2026-09-11 建）
//
// ── 为什么需要它（Learn 复发第 2 次）──────────────────────────────────────────
// `syntax-check.mjs` / `node --check` **只查语法**，查不出未定义标识符与 TDZ。
// 实测两例（Learn 2026-09-11）：
//   · `mind-inject.js` 的 `payload.length` —— 变量被搬进内层作用域后留下悬空引用
//   · `search-regression.mjs` 的 `const top` —— 引用写在声明之前（TDZ）
// 两例都是「语法全过、真跑才炸」。
//
// host 插件那一面**已有**覆盖：`verify-host-plugins.mjs`（真加载 + 调 apply + handler 真跑）。
// **本脚本补另一半：`scripts/` 工具脚本** —— 这一面此前只有语法检查。
//
// ── 判据 ─────────────────────────────────────────────────────────────────────
// 跑一次该脚本，**输出里出现运行期崩溃特征**即 FAIL：
//   ReferenceError / TypeError / is not defined / before initialization / Cannot find module
// ⚠️ usage 退出（exit≠0）**不算失败** —— 无参输出用法是正常设计，不是缺陷。
//
// ── 安全白名单（宁可漏检，不可无参触发副作用）────────────────────────────────
// 只有**确知「无参=只读或自检」**的脚本才会被真跑。不在名单里的一律跳过并**显式打印**
// （不静默）：`stage-payload.mjs` 会同步 payload、`install-hooks.mjs` 会装 hook、
// `backup-settings.mjs` 会写备份、`patch-*`/`sync-version` 会改文件 —— 无参跑它们＝制造副作用。
// 需要检名单外的脚本时，用 `--file <path>` 显式点名（人工确认安全后再跑）。
//
// 用法：
//   node scripts/verify-scripts-run.mjs              # 默认：只查 git 暂存区的脚本
//   node scripts/verify-scripts-run.mjs --all        # 查白名单内全部
//   node scripts/verify-scripts-run.mjs --file X.mjs # 点名单文件（含名单外；用于自测/反例）
import { existsSync } from 'node:fs';
import { join, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');

// 崩溃特征（只认运行期错误；语法错误已被 syntax-check 覆盖）
const CRASH = /ReferenceError|TypeError|is not defined|before initialization|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/;

// 无参=只读/自检（可安全真跑）
// ⚠️ 2026-09-17：`search-regression.mjs` 已**移出**本白名单 —— 它既**有副作用**（bump `search-hit`），
//   又用**语义化退出码**（1=真退化 / 2=需重建），而本脚本只把「崩溃特征」当失败（非零码记为 ok）。
//   结果：它在此处**每次提交白跑一遍并 +9**（实测累积 343），却从来没拦过任何东西。
//   现改由 `.git/hooks/pre-commit` **显式调用**（带 `HINDSIGHT_NO_METRICS=1` 求无副作用 + 认退出码）。
const SAFE = new Set([
  'scripts/evolve-log.mjs',
  'scripts/mind-audit.mjs',
  'scripts/mind-validate.mjs',
  'scripts/syntax-check.mjs',
  'scripts/verify-boot-recall.mjs',
  'scripts/verify-guard-decisions.mjs',
  'scripts/verify-host-plugins.mjs',
  // 2026-09-23 加：自建角色 agent 的 143 条断言（无参可跑 · 只用临时目录 · PASS 退出 0 / FAIL 退出 1）
  // ⇒ 挂白名单让每次提交都真跑一次；不挂的话它谁也不在链上（= 测试写了没人跑）。
  'scripts/verify-agent-roles.mjs',
  // 2026-09-23 加：心智面板「层带登记一致性」——客户端 LAYER_ORDER 漏登记 ⇒ 整块图谱白屏
  // （2026-09-16 实录）。无参可跑、只读两个源文件、PASS 退出 0 / FAIL 退出 1。
  'scripts/verify-mind-panel-layers.mjs',
  // 2026-09-23 加：并发写者盘点探针。无参＝**一次只读盘点**（退出码 0 无风险信号 / 2 提交会撞，
  // 都是"读数"不是崩溃）；本冒烟只认运行期崩溃特征与 itest 退出码 ⇒ 挂它不会造成假红，
  // 而挂上就让它每次提交都真跑一次（不挂＝写了没人跑）。
  'scripts/git-writer-probe.mjs',
  'scripts/verify-l1-versions.mjs',
  // 2026-09-24 加：手写表格「行被吞 / 两行被黏」检查（治 `edit` 锚点粘连——同日复发 2 次）。
  // 无参＝**只读扫描** `mind/` + `mind-private/`（不写任何文件）；退出码 0/1 都是"读数"（本冒烟只认
  // 运行期崩溃特征）⇒ 挂它不会造成假红，而挂上就让它每次提交都真跑一次（不挂＝写了没人跑）。
  'scripts/check-md-tables.mjs',
  'scripts/verify-payload.mjs',
  'scripts/verify-safe-overlay.mjs',
  'scripts/verify-shell-autostart.mjs',
  'scripts/verify-shell-readiness.mjs',
  'scripts/verify-upstream-contract.mjs',
  'scripts/mind-boot-recall-itest.mjs',
  'scripts/mind-skill-loader-itest.mjs',
  'scripts/mind-cron-serialize-itest.mjs',
  'scripts/mind-cron-runs-itest.mjs',
  'scripts/mind-cron-recipes-itest.mjs',
  // 2026-09-24 加：cron 自治「工作区归属登记」——registry 晚到时有界等待 + 每次 run 落 `lastAttach`。
  // 病灶＝冷启动补跑抢跑（宿主 22:22:55 启动、catch-up 22:23:09 就拉起会话）⇒ 归属静默失败、**无人能归因**。
  // 无参可跑 · 只用临时 DSH_HOME（真仓库零触碰）· 24 项含 4 反例 · PASS 0 / FAIL 1；env 覆盖（
  // `DSHOME_CRON_ATTACH_WAIT_MS`）把 45s 预算压到 2s ⇒ 全程 ~11.2s（同 `DSHOME_CRON_GATE_WAIT_MS` 口径）。
  // K1/K2/K3（2026-09-24 复核后加）：常量导出后可**断言**（POLL=500 / 上界 10min / 预算=env 值）；
  //   `registryWaitMs: Infinity` **不再无限轮询**（K2 自带 `Promise.race` 超时 ⇒ 退化会**报红**，
  //   不会把门禁链**挂住**——挂住的测试比红的测试更坏）；**K3 另起子进程剥掉 env 断言默认 45000**
  //   （复核指出：K1 断言的是 env 覆盖值，"默认 45s"当时零覆盖，而注释却自称断言了它）。
  // F3/L1/L2（复核后加）：`attach-failed` 那行**真的落了**——能力面 F3、**内容面** L1+L2
  //   （复核："分流的意义是内容面不值得重试，**不该重试 ≠ 不该留痕**"）。
  // H 用例（2026-09-24 复核后加）专钉一条**静默丢账**：`reload()` 每 60s 整表换对象 ⇒ 后台补登记的落账
  //   会被 `inst.tasks.includes(旧对象)` 判否、再被 `catch{}` 吞掉（修复前盘上 `cron.json` 是 null、无告警）。
  'scripts/mind-cron-attach-itest.mjs',
  // 2026-09-23 加：写入归属台账（`git-writer-probe` 归属维度的**数据源**——台账错则探针把归属
  // 指错人，比"没有归属"更坏）。无参可跑 · 只用临时 DSH_HOME（真仓库零触碰）· PASS 0 / FAIL 1。
  'scripts/mind-write-log-itest.mjs',
  // 2026-09-24 加：`userRules` 排序 + 上限保护的反例表（9 组含 3 反例 + 真数据面；无参=只读自检，
  // 只 import 纯函数库并跑断言）。**不挂链它就是张纸**——将来谁改坏 `pickUserRules`，
  // 没有门禁会红（同 09-23 `git-writer-probe` 的理由）。配套纯函数在 `scripts/mind-prime-lib.mjs`。
  'scripts/mind-prime-rules-itest.mjs',
  // 视觉自检工具（2026-09-18 加）：无参只打用法 + exit 2 ⇒ 属于"usage 退出不算失败"那一类，
  // 挂白名单只是为了每次提交都真跑一次"它至少能起来"（它自身要带目标文件才有实际动作）。
  'scripts/shot.mjs',
  // 2026-09-24 加：**活 SPA** 截图探针（CDP + 真实时间）。为什么单列而不并进 shot.mjs：`shot.mjs` 走
  // `--virtual-time-budget`（虚拟时间），对 DSHOME GUI 这种 SSE 长连接、**永不 idle** 的活页面会**卡死超时**
  // （本机实测拿不到帧）。无参只打用法 + exit 2 ⇒ 同 `shot.mjs` 那一类「usage 退出不算失败」，
  // 挂白名单只是让每次提交都真跑一次"它至少能起来"。
  'scripts/gui-shot.mjs',
]);

function toRel(p) {
  if (!isAbsolute(p)) return p.replace(/\\/g, '/');
  const rel = relative(repoRoot, p);
  // 跨盘符 / 仓库外 → relative 会原样返回绝对路径 → 保留之（否则 join 会拼出错路径）
  return isAbsolute(rel) ? p : rel.replace(/\\/g, '/');
}

function stagedScripts() {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--cached', '--diff-filter=ACMR'], {
      cwd: repoRoot, encoding: 'utf8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((p) => /\.(mjs|cjs|js)$/.test(p));
  } catch {
    return null; // 非 git 环境
  }
}

function runOne(rel) {
  const abs = isAbsolute(rel) ? rel : join(repoRoot, rel);
  if (!existsSync(abs)) return { rel, status: 'missing' };
  const r = spawnSync(process.execPath, [abs], { cwd: repoRoot, encoding: 'utf8', timeout: 90000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (CRASH.test(text)) {
    const hit = text.split('\n').map((l) => l.trim()).filter((l) => CRASH.test(l))[0] || '';
    return { rel, status: 'crash', detail: hit.slice(0, 160) };
  }
  // 2026-09-18 加：**itest 必须退出码 0**。
  //   旧判据只认"运行期崩溃特征"（工具脚本 `shot.mjs` 的 usage 退出 2 是正常的，故当初放宽），
  //   但 **itest 没有 usage 模式** ⇒ 断言失败（场景变红、exit 1、**无崩溃字样**）在本冒烟里**看不见**
  //   ——与 09-18 修的两条"双重恒绿"同族：**测试全红也能算通过**。
  //   反例（变红方法）：把 `mind-boot-recall-itest.mjs` 任一期望改成必红 ⇒ 该 itest `4/5 exit 1`
  //   ⇒ 本冒烟对它的判定必须是 ❌（旧判据下是 ✅"无运行期崩溃"）；改回 ⇒ 复绿。
  if (/[-_]itest\.mjs$/.test(rel) && r.status !== 0) {
    return { rel, status: 'fail', detail: `itest 退出码 ${r.status}（断言失败＝测试没通过，不算"无崩溃"）` };
  }
  return { rel, status: 'ok', code: r.status };
}

const argv = process.argv.slice(2);
const fileArg = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;
const allMode = argv.includes('--all');

let candidates;
let skippedForeign = [];
if (fileArg) {
  const rel = toRel(fileArg);
  // 显式点名却找不到 → **响亮失败**（verify-integrity #4：无输入即响亮失败，不静默跳过）
  if (!existsSync(isAbsolute(rel) ? rel : join(repoRoot, rel))) {
    console.error(`[verify-scripts-run] ❌ --file 指定的文件不存在：${rel}（点名了却找不到＝响亮失败，不静默跳过）`);
    process.exit(1);
  }
  candidates = [rel];
} else {
  const staged = stagedScripts();
  if (staged === null) { console.log('[verify-scripts-run] 非 git 工作区 → 跳过（不算失败）'); process.exit(0); }
  const pool = allMode ? [...SAFE] : staged;
  if (!allMode) {
    for (const p of pool) if (!SAFE.has(p)) skippedForeign.push(p);
  }
  candidates = pool.filter((p) => SAFE.has(p));
  if (!allMode && staged.length && !candidates.length && !skippedForeign.length) {
    console.log('[verify-scripts-run] 暂存区无脚本改动 → 无需真跑');
    process.exit(0);
  }
}

if (!candidates.length) {
  console.log('[verify-scripts-run] 无可跑候选');
  if (skippedForeign.length) {
    console.log(`[verify-scripts-run] 跳过 ${skippedForeign.length} 个不在安全白名单（避免无参副作用）：${skippedForeign.join(', ')}`);
  }
  process.exit(0);
}

console.log(`[verify-scripts-run] 真跑冒烟 ${candidates.length} 个脚本（判据：运行期崩溃特征 + **itest 须退出码 0**；工具脚本的 usage 退出不算失败）`);
const fails = [];
for (const rel of candidates) {
  const r = runOne(rel);
  if (r.status === 'crash') { fails.push(r); console.log(`  ❌ ${rel}  → ${r.detail}`); }
  else if (r.status === 'fail') { fails.push(r); console.log(`  ❌ ${rel}  → ${r.detail}`); }
  else if (r.status === 'missing') { console.log(`  ⏭ ${rel}（不存在，跳过）`); }
  else { console.log(`  ✅ ${rel}（exit ${r.code}，无运行期崩溃）`); }
}
if (skippedForeign.length) {
  console.log(`  ⏭ 跳过 ${skippedForeign.length} 个未在安全白名单（需检时用 --file 点名）：${skippedForeign.join(', ')}`);
}
if (fails.length) {
  console.error(`[verify-scripts-run] ❌ ${fails.length} 个脚本真跑失败（崩溃 / itest 断言未过）—— 语法检查过了不等于能跑`);
  process.exit(1);
}
console.log('[verify-scripts-run] ✅ 全部通过（真跑无运行期崩溃，itest 全绿）');
