#!/usr/bin/env node
// scripts/verify-host-plugins.mjs — host 插件「挂载面」验证（2026-09-11 建）
//
// ── 为什么需要它（真实事故，一夜两例）────────────────────────────────────────
// `node --check` **只查语法，查不出未定义标识符**。2026-09-11 同型 bug 出现两次：
//   · mind-inject.js:124      `payload.length` —— 改「每会话读盘」时变量移进内层作用域，末尾日志没跟着改
//   · mind-skill-loader.js:203 `skills.length`  —— 变量名与实际不符（历史遗留）
// 两次都因为 `apply()` 外层 try/catch 把异常吞成 `warn` 日志，**而 hook 在抛错之前就已注册** →
// **「效果面」完全正常**（R0 照常注入、Skill 卡照常触发），**只有「挂载面」是坏的**：
// 成功日志永不打印、cordis 的 host-apply 状态不正常，肉眼翻日志也难发现。
//
// ── 做什么 ──────────────────────────────────────────────────────────────────
// 对每个 host 插件：用**最小 mock ctx** 真加载并调用一次 `apply()`，断言
//   ① 不抛异常（apply 自身吞异常，故主要看下面这条）
//   ② 日志里**没有**「初始化失败 / 挂载失败 / not defined / not a function」这类告警
//   ③ 至少注册了一个钩子（ctx.on / tools.guard / effect）——证明 apply 跑到了注册点之后
// 退出码：0 = 全通过；1 = 有插件挂载异常。
//
// 用法：node scripts/verify-host-plugins.mjs
// writeFileSync 曾漏导入（2026-09-11 升级抗崩审计发现）：`restoreMarkers()` 用它恢复
// marker，但顶层没导入 → ReferenceError → 被该函数自己的空 `catch { /* 忽略 */ }` 吞掉
// → **marker 保护从未生效过**。同型 bug（未定义标识符 + 空 catch 吞掉）正是本脚本存在的
// 唯一理由，却长在它自己身上。node --check 同样查不出（语法合法）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DIR = join(repoRoot, 'packages', 'dshome', 'lib', 'host');

/** 需要验证的 host 插件：**从 cordis 挂载配置推导，不手写清单**（2026-09-11 第四轮盲评 · C2 指摘）。
 *  原版硬编码 5 个模块路径，与真实挂载配置 `cordis.patch.yml` **完全脱钩**：
 *    · `lib/host/` 有 **10** 个文件导出 apply()，原清单只覆盖 5 个 → 一半挂载面从未被验；
 *    · 从该 yml 删掉挂载行（插件根本没装）时，本脚本照样对文件本身打印 ✅（C2 的最强反例）。
 *  现在解析 `name: dshome/<x>` → 映射 `lib/host/<x>.js`（实测 10 个 dshome/* 与之逐一对应）。 */
function pluginsFromCordis() {
  const yml = join(repoRoot, 'packages', 'dshome', 'cordis.patch.yml');
  if (!existsSync(yml)) return { ok: false, list: [], why: 'packages/dshome/cordis.patch.yml 不存在' };
  const list = [];
  for (const line of readFileSync(yml, 'utf8').split('\n')) {
    const m = /^\s*name:\s*(dshome\/[A-Za-z0-9_-]+)\s*$/.exec(line);
    if (m) list.push(m[1].slice('dshome/'.length));
  }
  return { ok: list.length > 0, list, why: list.length ? '' : '未从 cordis.patch.yml 解析到任何 dshome/* 挂载项' };
}
const cordisPlugins = pluginsFromCordis();
const PLUGINS = cordisPlugins.list;

/** **架构不变式**：这几个心智插件**必须**在 cordis 挂载清单里 —— 少任何一个 = 身份/纪律/召回/门禁/开关缺一环。
 *  2026-09-11（第四轮盲评 · 应对 C2 的最强反例 B）：只"从挂载配置推导清单"有个致命副作用——
 *  **删掉挂载行时，"配置里没有"就等于"不用验" → 删掉 = 通过**（C2 原话：R0 从此消失，而两个门禁都绿）。
 *  所以必须另有一份"应有清单"来对比"实有清单"。
 *  这不是重复硬编码：`PLUGINS` 是**实际挂了什么**（易变），`REQUIRED` 是**必须挂什么**（不变式），语义不同。
 *  新增核心心智插件时请登记在此。 */
const REQUIRED = ['mind-inject', 'mind-guard', 'mind-recall', 'mind-connect', 'mind-skill-loader'];

/** **行为断言表**（应对 C2 的最强反例 A）：handler 不抛错 ≠ 行为发生了。
 *  反例 A 把 `isMindConnected` 改恒 false → `mind-inject` 的守卫**永远早退**（合法路径、不抛错），
 *  于是 R0 每会话都不注入，而"真跑 handler"也照样绿。**只有断言"效果发生了"才抓得到。**
 *  这里只对**行为最确定**的插件下断言（构造参数已知、结果唯一）；其余插件保持"不抛错 + 已注册"级。 */
const EXPECT = {
  'mind-inject': {
    desc: 'R0 双件应被注入（decision.messages 里应多出一条 agent-instructions 消息）',
    check: (r) => r.lastDecision && Array.isArray(r.lastDecision.messages)
      && r.lastDecision.messages.some((m) => m && m.source && m.source.kind === 'agent-instructions'),
  },
};

/** 挂载失败的判据：日志里出现这些字样即视为「初始化失败」。 */
const FAIL_RE = /初始化失败|挂载失败|apply failed|is not defined|not a function|未捕获|Cannot read/i;

/** 最小 mock ctx：够 host 插件走完 apply 的注册路径，且把所有日志/注册都记下来。 */
function makeCtx(record) {
  const noop = () => {};
  const logger = () => ({
    info: (...a) => record.logs.push(['info', fmt(a)]),
    warn: (...a) => record.logs.push(['warn', fmt(a)]),
    error: (...a) => record.logs.push(['error', fmt(a)]),
    debug: noop,
  });
  const ctxObj = {
    logger,
    // 2026-09-11（第四轮盲评 · C2 指摘）：原版**只记录不调用** handler → 只能证明"apply 跑到了
    // 注册那一行"，证明不了 handler 有效。C2 的反例 A：把 `mind-connect` 的 `isMindConnected`
    // 改成恒 false → `mind-inject` 的注入守卫永远早退、R0 每会话都不注入，而本脚本照样打印 ✅
    // —— 因为那个守卫**从未被执行过一次**（mock 把 handler 参数整个丢掉了）。
    // 现在：把 handler 收集起来，**apply 之后统一真跑一次**（见主循环的 handler 执行段）。
    on: (ev, handler) => {
      record.registered.push(`on(${ev})`);
      if (typeof handler === 'function') record.handlers.push({ ev, handler });
      return noop;
    },
    off: noop,
    effect: () => { record.registered.push('effect'); return noop; },
    tools: {
      guard: () => { record.registered.push('tools.guard'); return noop; },
      register: () => { record.registered.push('tools.register'); return noop; },
    },
    // `ctx.inject(deps, cb)` 是 cordis 的服务注入式注册（如 mind-connect 用它取 webServer）——
    // **必须同步调用回调**，否则回调整体不执行、插件看起来"没注册任何钩子"（首版脚本的假阳性）。
    inject: (deps, fn) => {
      record.registered.push(`inject([${[].concat(deps).join(',')}])`);
      if (typeof fn === 'function') {
        try { fn(ctxObj); } catch (e) { record.logs.push(['warn', 'inject callback: ' + (e && e.message)]); }
      }
    },
    // 常见宿主服务的最小桩（注入回调访问它们时不至于抛错）
    webServer: {
      route: () => { record.registered.push('webServer.route'); return noop; },
      register: () => { record.registered.push('webServer.register'); return noop; },
      middleware: () => noop,
      get: () => {},
    },
    timer: { setTimeout: () => 0, setInterval: () => 0, clearTimeout: noop, clearInterval: noop },
    // cordis 的服务提供/消费 API（2026-09-11 补）：`core`/`desktop` 等插件用 `ctx.provide(...)` 自供服务，
    // 缺它会抛 `ctx.provide is not a function` → 被 FAIL_RE 命中 → **假阳性**（C2 早已警告过 FAIL_RE 的这类风险）。
    provide: () => { record.registered.push('provide'); return noop; },
    consume: () => noop,
    settings: { get: () => undefined, set: () => {}, watch: () => noop },
    sessions: { get: () => undefined, list: () => [] },
    jobs: { add: () => ({ id: 'probe' }), remove: () => {} },
  };
  return ctxObj;
}
/** 把 logger 的参数压成一行（含 Error 的 name+message）。 */
function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.constructor.name}: ${a.message}`;
    if (a && typeof a === 'object') { try { return JSON.stringify(a).slice(0, 120); } catch { return String(a); } }
    return String(a);
  }).join(' ').slice(0, 200);
}

let failed = 0;
if (!existsSync(HOST_DIR)) {
  console.error(`[verify-host-plugins] ❌ 目录不存在: ${HOST_DIR}`);
  process.exit(1);
}

/** marker 保护：handler 真跑会写 `.dsh-market/*marker*.txt`（mind-inject 的 `inject:` 行就在那儿），
 *  而那个 marker 是"注入确实发生过"的**现场证据** —— 本脚本不得把它冲掉。
 *  做法：跑 handler 前备份内容、跑完原样恢复（内容恢复即可；mtime 变了不影响它作为证据的语义）。 */
const MARKET_DIR = join(repoRoot, 'profiles', 'dshome', '.dsh-market');
function snapshotMarkers() {
  const snap = new Map();
  try {
    for (const f of readdirSync(MARKET_DIR)) {
      if (!/marker/i.test(f)) continue;
      const p = join(MARKET_DIR, f);
      try { snap.set(p, readFileSync(p, 'utf8')); } catch { /* 忽略单个文件 */ }
    }
  } catch { /* 目录不存在 → 无需保护 */ }
  return snap;
}
function restoreMarkers(snap) {
  for (const [p, content] of snap) {
    try { writeFileSync(p, content, 'utf8'); } catch { /* 忽略 */ }
  }
}

console.log(`[verify-host-plugins] 真加载 host 插件（挂载清单来自 cordis.patch.yml，${PLUGINS.length} 个）`);
// 挂载清单本身不可用 ⇒ 失败（同 mind-validate 的「输入缺失即响亮失败」原则）
if (!cordisPlugins.ok) {
  failed++;
  console.log(`  ❌ 挂载清单不可用：${cordisPlugins.why} → 本次未验证任何挂载面（不可据此认为「插件都正常」）`);
} else {
  // 应对 C2 反例 B：「删掉挂载行 = 配置里没有 = 不用验 = 通过」→ 用 REQUIRED 不变式对比实有清单
  const missing = REQUIRED.filter((p) => !PLUGINS.includes(p));
  if (missing.length) {
    failed++;
    console.log(`  ❌ 挂载清单缺少核心心智插件：${missing.join(', ')} —— 身份/门禁/召回/开关/技能缺环（症状：从 cordis.patch.yml 删掉挂载行，而旧版脚本会静默通过）`);
  }
}

for (const name of PLUGINS) {
  const file = join(HOST_DIR, `${name}.js`);
  const record = { logs: [], registered: [], handlers: [] };

  // ① 缺失 = 失败（原版是"跳过"→ 删掉一个 host 插件仍打印 ✅；C2 指摘）
  if (!existsSync(file)) {
    failed++;
    console.log(`  ❌ ${name}: 已在 cordis 挂载但文件不存在（${file.replace(repoRoot, '.')}）→ 运行时挂载会失败`);
    continue;
  }
  // ② 加载 + 导出检查（同样：缺 = 失败，不是跳过）
  let mod = null, thrown = null;
  try { mod = await import(pathToFileURL(file).href); } catch (e) { thrown = e; }
  if (thrown || !mod) {
    failed++;
    console.log(`  ❌ ${name}: import 失败 ${thrown && thrown.message}`);
    continue;
  }
  if (typeof mod.apply !== 'function') {
    failed++;
    console.log(`  ❌ ${name}: 未导出 apply()（cordis 会加载失败）`);
    continue;
  }

  // ③ apply 阶段
  try { await mod.apply(makeCtx(record)); } catch (e) { thrown = e; }

  // ④ handler 阶段：**真跑一次** —— C2 的反例 A（把 isMindConnected 改恒 false，注入永远早退）
  //    只有这一步才抓得到：原版 mock 把 handler 丢掉，那个坏守卫从未被执行过一次。
  const markerSnap = snapshotMarkers();
  for (const { ev, handler } of record.handlers) {
    try {
      const decision = { kind: 'enter', messages: [] };
      // ⚠️ 断言必须看 **handler 的返回值**——它可能返回一个**新对象**而非就地改传入的 decision。
      //    首版断言看的是我传进去的那个对象 → `mind-inject` 明明注入了也被判"未注入"（**断言自身写错**，
      //    又一次"改了比较的一方、忘了另一方"）。
      const ret = await handler(
        {
          agent: { session: { header: { id: 'verify-probe', delegationDepth: 0, cwd: repoRoot } } },
          messages: [], step: 1, signal: undefined,
        },
        async () => decision,
      );
      record.lastDecision = (ret && typeof ret === 'object') ? ret : decision;
    } catch (e) {
      record.logs.push(['warn', `handler[${ev}] 抛错: ${(e && e.constructor && e.constructor.name) || 'Error'}: ${e && e.message}`]);
    }
  }
  restoreMarkers(markerSnap);

  const warns = record.logs.filter(([lv]) => lv === 'warn' || lv === 'error');
  const bad = warns.filter(([, m]) => FAIL_RE.test(m));
  // 行为断言（C2 反例 A：守卫早退**不抛错**，"没抛错"证明不了行为发生过）—— 见表 EXPECT
  let expectFail = '';
  const exp = EXPECT[name];
  if (exp) {
    try { if (!exp.check(record)) expectFail = exp.desc; }
    catch (e) { expectFail = `${exp.desc}（断言自身抛错: ${e && e.message}）`; }
  }
  // 判定分级（2026-09-11）：核心心智插件（REQUIRED）要求"注册了钩子 +（有断言时）行为断言通过"；
  // 其余 host 插件（core/shell/desktop/notify/…）只要求"不抛错"——它们可能依赖 Electron/宿主环境、
  // 在 mock 下本就不注册钩子（实测 `shell` 即如此），用同一把尺子会造**假阳性**。
  const strict = REQUIRED.includes(name);
  const ok = !thrown && bad.length === 0 && !expectFail && (!strict || record.registered.length > 0);
  if (ok) {
    console.log(`  ✅ ${name}: apply 正常（注册 ${record.registered.join(', ')}；handler 真跑 ${record.handlers.length} 个${exp ? ' + 行为断言通过' : ''}）`);
  } else {
    failed++;
    console.log(`  ❌ ${name}: 挂载异常`);
    if (thrown) console.log(`       throw: ${thrown.constructor.name}: ${thrown.message}`);
    for (const [, m] of bad) console.log(`       warn: ${m}`);
    if (!record.registered.length) console.log('       未注册任何钩子（apply 可能没跑到注册点）');
    if (expectFail) console.log(`       行为断言未通过：${expectFail}`);
  }
}

console.log(`[verify-host-plugins] ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 个插件挂载异常`}（退出码 ${failed === 0 ? 0 : 1}）`);
process.exit(failed === 0 ? 0 : 1);
