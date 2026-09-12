// verify-compaction-log.mjs — mind-compaction-log 的行为验收（Item 2；2026-09-12 升级为真框架）
//
// ── 为什么必须用**真 cordis**（2026-09-12 教训，真事故）──────────────────────
// 上一版用「把 tokenMeter 当普通属性挂上去的 mock ctx」，9 条断言全绿——**却漏掉了真 bug**：
// 插件当时写的是 `ctx.tokenMeter?.measure?.(session)`，而 token-meter 在 **base 补丁树的兄弟分支**
// fiber 上，cordis 的属性访问会抛 `cannot get property "tokenMeter" without inject`；异常被插件自己的
// try/catch 吞成 null → 审计行「释放 token」恒为 `unknown`。mock ctx 没有 inject 门 ⇒ 测试走了旁路。
// 这与同日的 F1 事故同族（那次是「按文件路径 import 绕过 package exports」）。
// ⇒ 现在：**服务经真 fiber 提供，插件经真 inject 激活，事件经真 ctx emit**；
//    另加「兄弟分支 + 未 inject 属性访问必抛」的反例断言，把这条框架规则钉成回归锁。
//
// ── 断言（每条可机器判；直接对落盘文本 + logger 记录判，不看内部状态）──────
//   A 无压缩事件        → 日志文件**不存在**（零写入）
//   B start→summary→end → 恰 1 行（summary 是中间事件），含释放量 600 与「成功」（真框架端到端）
//   C tokenMeter 缺失   → 仍落 1 行、释放量记 `unknown`，且 logger.warn 被调用（响亮失败）
//   D end 带 error      → 该行「失败：」开头
//   E 缺 compactionId   → compactionId 列记 `unknown`（#14 不假装有）
//   F 门禁反例          → 兄弟分支 + 未 inject 的**属性访问**必抛 `without inject`（旧 bug 的源）
//   G 静态锁            → 源码里不得出现真·`ctx.tokenMeter` 属性访问，且必须用 `ctx.get('tokenMeter')`
//   H turn 口径         → `turn: null`（手动压缩）记 `manual`；字段缺失才记 `unknown`
//
  //   · 另一个坑：cordis exporter 的级别阈值默认 **1（info）**，而 warn=2 → **warn 会被直接丢弃**
  //     （node_modules/@deepseek-ai/cordis/lib/index.js:474；DSHOME 全栈无人声明 levels ⇒ 线上 warn
  //     其实落不到任何 sink）。本脚本要验「能力缺失是否响亮」，必须自己把阈值放到 3。
  //     ⇒ 「释放量记 unknown」这条**落盘**证据是主凭据，warn 只是候选通道。
//
// 反向测试（证明本脚本有牙）：DSH_COMPACTION_LOG_PLUGIN=<旧版快照路径> 跑本脚本 →
//   B/G 应当**失败**（旧实现属性访问被框架拒绝 ⇒ 释放量 unknown）。快照见
//   mind-private/tasks/evolution/snapshots/*_mind-compaction-log.js。
//
// 用法：node scripts/verify-compaction-log.mjs   （exit 0 = 全绿）

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

const DEFAULT_PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'dshome', 'lib', 'host', 'mind-compaction-log.js');
const PLUGIN_PATH = process.env.DSH_COMPACTION_LOG_PLUGIN || DEFAULT_PLUGIN;
const PLUGIN_SOURCE = readFileSync(PLUGIN_PATH, 'utf8');
const mod = await import(pathToFileURL(PLUGIN_PATH).href);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/** 造一个隔离环境：临时 DSH_HOME（含 mind/ 以通过 repoRoot 判定）+ **真 cordis Context**。
 *  服务由**兄弟分支** fiber 提供（模拟 base 补丁树里的 token-meter / fs），故 inject 门真实生效。 */
async function harness({ tokenMeter } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-compaction-log-'));
  mkdirSync(join(rootDir, 'mind'), { recursive: true });
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = rootDir;

  const ctx = new Context();
  const logs = [];
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export: (msg) => logs.push(JSON.stringify(msg)) });

  // 提供方：独立 fiber（与受测插件互为兄弟分支）
  await ctx.plugin({
    name: 'provider-services',
    apply(c) {
      c.provide('fs', {});
      if (tokenMeter !== undefined) c.provide('tokenMeter', tokenMeter);
    },
  });

  // 受测插件：真模块 + 真 inject 声明 → 与线上加载路径一致
  let pluginCtx;
  await ctx.plugin({
    name: 'compaction-log-under-test',
    inject: mod.inject,
    apply(c) {
      pluginCtx = c;
      mod.apply(c);
    },
  });

  const logPath = join(rootDir, 'mind-private', 'tasks', 'evolution', 'compaction-log.md');
  const emit = (session, event) => pluginCtx.emit('session/event', session, event);
  const read = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : null);
  const rows = () => (read() || '').split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 时间') && !l.startsWith('|---'));
  return {
    root: rootDir,
    ctx,
    logPath,
    emit,
    read,
    rows,
    logs,
    warns: () => logs.filter((l) => l.includes('"type":"warn"')),
    cleanup: () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

const SESSION = { id: 'sess-1' };

// ── A 无压缩事件 → 零写入 ────────────────────────────────────────────────
{
  const h = await harness({ tokenMeter: { measure: () => ({ totalTokens: 100 }) } });
  check('A 无 compaction 事件 → 日志文件不存在（零写入）', h.read() === null, h.logPath);
  h.cleanup();
}

// ── B 正常事务（真框架端到端）：start→summary→end，释放 600 ───────────────
{
  let tokens = 1000;
  const h = await harness({ tokenMeter: { measure: () => ({ totalTokens: tokens }) } });
  h.emit(SESSION, { type: 'compaction/start', data: { compactionId: 'c-1', turn: 3 } });
  tokens = 800;
  h.emit(SESSION, { type: 'compaction/summary', data: { compactionId: 'c-1' } }); // 中间事件
  tokens = 400;
  h.emit(SESSION, { type: 'compaction/end', data: { compactionId: 'c-1', turn: 3 } });
  const rows = h.rows();
  const line = rows[0] || '';
  check('B 恰 1 行（summary 不入行）', rows.length === 1, `rows=${rows.length}`);
  check('B 释放量 = before − after = 600（真 cordis：服务经兄弟 fiber 提供）', line.includes(' 600 '), line.slice(0, 160));
  check('B 结果列 = 成功 + id 落表', line.includes('成功') && line.includes('c-1'), '');
  h.cleanup();
}

// ── C tokenMeter 缺失 → 记 unknown + 响亮告警 ───────────────────────────
{
  const h = await harness({ tokenMeter: undefined });
  h.emit(SESSION, { type: 'compaction/start', data: { compactionId: 'c-2', turn: 1 } });
  h.emit(SESSION, { type: 'compaction/end', data: { compactionId: 'c-2', turn: 1 } });
  const rows = h.rows();
  check('C 计量缺失仍落行（不静默跳过）', rows.length === 1, `rows=${rows.length}`);
  check('C 释放量记 unknown', (rows[0] || '').includes('unknown'), (rows[0] || '').slice(0, 160));
  check('C 同时留下 warn（能力缺失响亮）', h.warns().some((w) => w.includes('释放量不可得')), `warns=${h.warns().length}`);
  h.cleanup();
}

// ── D 失败路径带 error ──────────────────────────────────────────────────
{
  const h = await harness({ tokenMeter: { measure: () => ({ totalTokens: 500 }) } });
  h.emit(SESSION, { type: 'compaction/start', data: { compactionId: 'c-3', turn: 2 } });
  h.emit(SESSION, { type: 'compaction/end', data: { compactionId: 'c-3', turn: 2, error: 'summarize timeout' } });
  check('D error → 结果列「失败：…」', (h.rows()[0] || '').includes('失败：summarize timeout'), (h.rows()[0] || '').slice(0, 160));
  h.cleanup();
}

// ── E 字段缺失 → unknown（不假装有）──────────────────────────────────────
{
  const h = await harness({ tokenMeter: { measure: () => ({ totalTokens: 100 }) } });
  h.emit(SESSION, { type: 'compaction/start', data: {} });
  h.emit(SESSION, { type: 'compaction/end', data: { turn: 4 } });
  const line = h.rows()[0] || '';
  check('E 缺 compactionId → 记 unknown', line.split('|').map((s) => s.trim()).includes('unknown'), line.slice(0, 160));
  h.cleanup();
}

// ── F 门禁反例：兄弟分支 + 未 inject 的属性访问必抛（旧 bug 的源）──────────
{
  const h = await harness({ tokenMeter: { measure: () => ({ totalTokens: 100 }) } });
  let threw = null;
  await h.ctx.plugin({
    name: 'property-access-without-inject',
    apply(c) {
      try {
        void c.tokenMeter;
      } catch (e) {
        threw = e.message;
      }
    },
  });
  check('F 兄弟分支 + 未 inject 的属性访问 → 抛 `without inject`（旧实现即栽在此）', /without inject/.test(threw || ''), String(threw));
  h.cleanup();
}

// ── G 静态锁：源码里不得有真·ctx.tokenMeter 属性访问 ─────────────────────
{
  // 去注释 / 去字符串字面量（保行结构），再匹配真正的属性访问——避免把注释与说明文字判成代码。
  const noComments = PLUGIN_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const stripped = noComments
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const bareAccess = [...stripped.matchAll(/(?<![\w$.])ctx\.tokenMeter\b/g)].map((m) => m.index);
  check('G 源码无 `ctx.tokenMeter` 裸属性访问（须走 ctx.get）', bareAccess.length === 0, `命中 ${bareAccess.length} 处`);
  // 这条要在**保留字符串**的版本上判（上面去字符串是为了防误报，会把参数 'tokenMeter' 也抹掉）。
  check("G 源码确实使用 ctx.get('tokenMeter')", /ctx\.get\(\s*['"]tokenMeter['"]\s*\)/.test(noComments), '');
}

// ── H turn 口径：null = 手动压缩 → manual；缺失 → unknown ────────────────
{
  const h = await harness({ tokenMeter: { measure: () => ({ totalTokens: 700 }) } });
  h.emit(SESSION, { type: 'compaction/start', data: { compactionId: 'c-4', turn: null } });
  h.emit(SESSION, { type: 'compaction/end', data: { compactionId: 'c-4', turn: null } });
  const manualLine = h.rows()[0] || '';
  h.emit(SESSION, { type: 'compaction/start', data: { compactionId: 'c-5' } });
  h.emit(SESSION, { type: 'compaction/end', data: { compactionId: 'c-5' } });
  const missingLine = h.rows()[1] || '';
  check('H turn:null（手动压缩）→ 记 manual', manualLine.includes(' manual '), manualLine.slice(0, 160));
  check('H turn 字段缺失 → 记 unknown', missingLine.includes(' unknown '), missingLine.slice(0, 160));
  h.cleanup();
}

const failed = results.filter((r) => !r.ok);
const target = process.env.DSH_COMPACTION_LOG_PLUGIN ? `（受测：${process.env.DSH_COMPACTION_LOG_PLUGIN}）` : '';
console.log(`\n${failed.length === 0 ? '✅' : '❌'} verify-compaction-log${target}: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
