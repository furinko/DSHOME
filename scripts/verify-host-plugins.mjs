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
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DIR = join(repoRoot, 'packages', 'dshome', 'lib', 'host');

/** 需要验证的 host 插件（新增 mind-* host 插件请登记在此）。 */
const PLUGINS = ['mind-inject', 'mind-recall', 'mind-skill-loader', 'mind-guard', 'mind-connect'];

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
    on: (ev) => { record.registered.push(`on(${ev})`); return noop; },
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
console.log(`[verify-host-plugins] 真加载 host 插件（目录 ${HOST_DIR.replace(repoRoot, '.')}）`);

for (const name of PLUGINS) {
  const file = join(HOST_DIR, `${name}.js`);
  if (!existsSync(file)) { console.log(`  ⚠️ ${name}: 文件不存在，跳过`); continue; }
  const record = { logs: [], registered: [] };
  let thrown = null;
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.apply !== 'function') { console.log(`  ⚠️ ${name}: 未导出 apply()，跳过`); continue; }
    await mod.apply(makeCtx(record));
  } catch (e) {
    thrown = e;
  }
  const warns = record.logs.filter(([lv]) => lv === 'warn' || lv === 'error');
  const bad = warns.filter(([, m]) => FAIL_RE.test(m));
  const ok = !thrown && bad.length === 0 && record.registered.length > 0;
  if (ok) {
    console.log(`  ✅ ${name}: apply 正常（注册 ${record.registered.join(', ')}）`);
  } else {
    failed++;
    console.log(`  ❌ ${name}: 挂载异常`);
    if (thrown) console.log(`       throw: ${thrown.constructor.name}: ${thrown.message}`);
    for (const [, m] of bad) console.log(`       warn: ${m}`);
    if (!record.registered.length) console.log('       未注册任何钩子（apply 可能没跑到注册点）');
  }
}

console.log(`[verify-host-plugins] ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 个插件挂载异常`}（退出码 ${failed === 0 ? 0 : 1}）`);
process.exit(failed === 0 ? 0 : 1);
