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
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

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
const REQUIRED = ['mind-inject', 'mind-guard', 'mind-recall', 'mind-connect', 'mind-skill-loader', 'agent-roles'];

/** **行为断言表**（应对 C2 的最强反例 A）：handler 不抛错 ≠ 行为发生了。
 *  反例 A 把 `isMindConnected` 改恒 false → `mind-inject` 的守卫**永远早退**（合法路径、不抛错），
 *  于是 R0 每会话都不注入，而"真跑 handler"也照样绿。**只有断言"效果发生了"才抓得到。**
 *  这里只对**行为最确定**的插件下断言（构造参数已知、结果唯一）；其余插件保持"不抛错 + 已注册"级。 */
/** 注入消息判据（与插件内的 isR0Present / isRecallPresent 同一把尺子：plugin source + form 双钉，
 *  不看文本——文本判据会被摘要/引用误伤）。 */
const pluginSrc = (plugin, form) => (m) => !!(m && m.source && m.source.kind === 'plugin' && m.source.plugin === plugin && m.source.form === form);
const isR0Msg = pluginSrc('dshome-mind-inject', 'instructions');
const isR1Msg = pluginSrc('dshome-mind-recall', 'recall');
/** 取 handler **返回值**里的 messages（断言只看返回值——见 runHandlers 头注的血债）。 */
const retMessages = (r) => (r?.ret && Array.isArray(r.ret.messages)) ? r.ret.messages : [];
/** 消息文本抽取（content 可能是 string 或 blocks）。 */
const msgText = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  return '';
};

/** ── 会话桩（2026-09-26 v3.2 换轴后必需）────────────────────────────────────────
 *  在场判据已从 `decision.messages` 换到 **surface 代次**，故桩必须真提供
 *  `agent.session.surface = { replaceGeneration, nodes }` 与 `agent.session.eventAt(seq)`
 *  （真 Session 上：`surface.replaceGeneration` 只在压缩 replace 时 +1，`eventAt(seq)` 读日志）。
 *  ⚠️ 探针 messages 一律给空数组：判据若还看 messages（v3.1 的死代码路径），场景 4/负例会立刻变红。 */
function makeSessionProbe({ id = 'verify-probe', gen = 0, nodes = [], events = [], depth = 0 } = {}) {
  const log = new Map(events);
  return {
    id,
    header: { id, delegationDepth: depth, cwd: repoRoot },
    surface: { replaceGeneration: gen, nodes: [...nodes] },
    eventAt: (seq) => log.get(seq),
    /** 测试用：切换到下一代的 surface（模拟压缩 replace 把注入换出去 / 换回来）。 */
    setSurface(nextGen, nextNodes) { this.surface.replaceGeneration = nextGen; this.surface.nodes = [...nextNodes]; },
    putEvent(seq, ev) { log.set(seq, ev); },
  };
}
/** 造一条「本插件注入过的 user/message」事件（与真会话日志同形：`data` 即消息本体，带 source）。 */
const injectedEvent = (seq, plugin, form) => ({
  seq,
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text: `probe ${form} injection` }], source: { kind: 'plugin', plugin, form } },
});

const EXPECT = {
  'mind-inject': {
    // 2026-09-11 加**顺序契约**（补 ③，源自 openhanako 考古）：原来只断言"注入了"，
    // **没锁内容与顺序** —— 而 v3.0 的设计是「**人格宪法先于运行宪法**」（SOUL 在前、AGENTS 在后），
    // 顺序由 `composeMindL0Text` 里的 `['SOUL.md', 'AGENTS.md']` 数组**硬编码**决定：
    // 调换一行即人格与行为权威倒序，**而旧断言照样打印 ✅**。这里把它钉成契约。
    desc: 'R0 双件应被注入，且内容含 SOUL 与 AGENTS 两件、SOUL 段在 AGENTS 段之前（顺序契约）',
    check: (r) => {
      const msgs = (r.lastDecision && Array.isArray(r.lastDecision.messages)) ? r.lastDecision.messages : [];
      // 2026-09-12 修：本断言原先只认 `source.kind === 'agent-instructions'`——而 2026-09-11 的
      // 会话格式 v1 合规修复已把它换成合法形态（原 kind 携带了不存在的 `plugin` 成员、且缺 required
      // 的 `changes`，被 v0→v1 迁移器逐成员拒收）→ 注入消息从此 shape 变了，本断言再也找不到它，
      // host 门禁恒红（pre-commit 第③步 = 提交被卡死），而报告的证据链里恰好没有 host-check 这一项。
      // 现两种形态都认：旧 kind 留给历史实现，现形态与现行 mind-inject.js 对齐（插件名 + form 双钉）。
      const m = msgs.find(
        (x) => x && x.source
          && (x.source.kind === 'agent-instructions'
            || (x.source.kind === 'plugin'
              && x.source.plugin === 'dshome-mind-inject'
              && x.source.form === 'instructions'))
      );
      if (!m) return false; // 未注入
      const c = m.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n') : '';
      const iSoul = text.indexOf('# SOUL.md');
      const iAgents = text.indexOf('# AGENTS.md');
      return iSoul >= 0 && iAgents >= 0 && iSoul < iAgents;
    },
    // 2026-09-26 加：多场景断言（「压缩后 R0 注入失效」修复的行为面）。**v3.2 换轴后重写**：
    //   旧版三场景（v3.1）被复核证明抓不住 —— 变异测试「删 event.type 守卫 / delete→clear() /
    //   isR0Present 恒 false / 复核改看形参」四项断言全绿。故现在的场景必须打在三根轴上：
    //   ① surface 代次（gen）② surface 在场复核（eventAt）③ 每会话状态（Map，不得跨会话串）。
    run: async ({ record, runHandlers, fireSessionEvent, fireEvent }) => {
      const out = [];
      const A = makeSessionProbe({ id: 'verify-probe', gen: 0, nodes: [] }); // 主会话
      const run = (session, s, extra) => runHandlers({ ev: 'agent/pre-step', step: s, messages: [], agent: { session }, ...(extra ?? {}) });
      // 场景 1：gen=0、surface 空（历史里没有 R0）→ 必须注入（首注，不带 repair 标记）。
      const r1 = await run(A, 1);
      const m1 = retMessages(r1.at(-1)).filter(isR0Msg);
      out.push({ name: '场景1 gen=0/surface 空 → 必须注入', ok: m1.length === 1, detail: `注入 ${m1.length} 条，期望 1` });
      // 场景 2：同代次（state 已记 gen=0）→ 必须不注入（代次快速路径，零扫描）。
      const r2 = await run(A, 2);
      const n2 = retMessages(r2.at(-1)).filter(isR0Msg).length;
      out.push({ name: '场景2 同代次 → 必须不注入（快速路径）', ok: n2 === 0, detail: `又注入 ${n2} 条，期望 0` });
      // 场景 3：代次 0→1（压缩 replace 把注入换出去了）→ 必须补注入，且带 inject#repair。
      A.setSurface(1, []);
      const r3 = await run(A, 3);
      const m3 = retMessages(r3.at(-1)).filter(isR0Msg);
      out.push({ name: '场景3 代次 0→1（注入被压缩换出）→ 必须补注入', ok: m3.length === 1, detail: `补注入 ${m3.length} 条，期望 1` });
      const tagged = m3.some((m) => msgText(m).includes('inject#repair'));
      out.push({ name: '场景3 补注带 inject#repair 标记', ok: m3.length === 1 && tagged, detail: tagged ? '' : '补注 payload 未带 inject#repair' });
      // 场景 4【关键负例·问题 2 的反例轴】：代次**不变**、surface 里注入**仍在**（模拟 commit 前失败的
      //   压缩：官方同样 append 带 error 的 compaction/end，但 surface 未收缩）→ 必须**不**注入。
      //   这一条同时枪毙两种旧判据：按 compaction 事件摘标记（会重注一遍 ~11KB）与查 decision.messages
      //   （探针 messages 恒空 ⇒ 恒判「不在场」⇒ 也会重注）。
      A.putEvent(20, injectedEvent(20, 'dshome-mind-inject', 'instructions'));
      A.setSurface(1, [20]);
      const compactFired = await fireSessionEvent(A, { type: 'compaction/end', data: { error: 'probe: commit-failed' } });
      const r4 = await run(A, 4);
      const n4 = retMessages(r4.at(-1)).filter(isR0Msg).length;
      out.push({
        name: '场景4 代次不变+注入仍在（失败压缩）→ 必须不注入',
        ok: n4 === 0,
        detail: `又注入 ${n4} 条，期望 0（compaction/end 订阅者 ${compactFired} 个：v3.2 起本插件不再按事件摘标记）`,
      });
      // 场景 5：**双会话隔离** —— B 会话必须照常注入，且它的 `gen` **故意取 A 当时已记下的代次（1）**：
      //   这样「把 key 写成常量单键（如 'singleton'）」的实现会让 B 命中 A 的快路径而漏注 ⇒ 变异必红
      //   （第三轮复核 F1）；正确实现下 key 不同 ⇒ B 状态为空 ⇒ 走 surface 复核 ⇒ 正常注入。
      const B = makeSessionProbe({ id: 'verify-probe-b', gen: 1, nodes: [] });
      const r5 = await run(B, 1);
      const n5 = retMessages(r5.at(-1)).filter(isR0Msg).length;
      out.push({ name: '场景5 另一会话（gen 与 A 相同）仍须注入（会话隔离）', ok: n5 === 1, detail: `注入 ${n5} 条，期望 1（A 已记 gen=1；key 若被写成单键/共用 ⇒ 这里会漏注）` });
      // 场景 6：`session/disposed` 清状态 —— 销毁 A 后同代次仍须重新复核并补注入（surface 已空）。
      A.setSurface(1, []);
      const disposedFired = await fireEvent('session/disposed', A);
      const r6 = await run(A, 5);
      const n6 = retMessages(r6.at(-1)).filter(isR0Msg).length;
      out.push({
        name: '场景6 session/disposed 清状态 → 同代次须重新复核并补注入',
        ok: disposedFired > 0 && n6 === 1,
        detail: `session/disposed 订阅者 ${disposedFired} 个（期望 >0）；补注入 ${n6} 条，期望 1`,
      });
      // 场景 7【surface 复核分支】：**换代次但注入仍在 surface**（压缩把别的东西换出去、R0 被保留）
      //   → 必须靠扫 surface 判「在场」而**不**注入（官方 dsh-agent-instructions 的同款分支）。
      //   该分支只在「状态里没记本代次」时才走到（新会话 / 状态刚被清）；少了它，
      //   「在场判据改恒 false」的变异测试会全绿 = 假绿面。
      const C = makeSessionProbe({ id: 'verify-probe-c', gen: 3, nodes: [30], events: [[30, injectedEvent(30, 'dshome-mind-inject', 'instructions')]] });
      const r7 = await run(C, 1);
      const n7 = retMessages(r7.at(-1)).filter(isR0Msg).length;
      out.push({ name: '场景7 换代次但 R0 仍在 surface → 必须不注入（复核分支）', ok: n7 === 0, detail: `又注入 ${n7} 条，期望 0（判据漏看 surface 时会变 1）` });
      // 场景 8【落地校验】：模拟 `insertAfterClaimed` **静默不落地**（`decision.messages` 非数组，
      //   见 mind-insert.js:23）⇒ 必须 (a) 留 `inject#failed` 证、(b) **不记代次**：同代次下一步
      //   仍会重试并成功注入。少了 (b)，一次没落地的注入会把该代次「钉死」，到下次换代次前永不再试。
      const D = makeSessionProbe({ id: 'verify-probe-d', gen: 0, nodes: [] });
      await run(D, 1, { decision: { messages: null } });
      const failedLogged = (() => { try { return readFileSync(join(MARKET_DIR, 'mind-inject-marker.txt'), 'utf8').includes('inject#failed'); } catch { return false; } })();
      const r8 = await run(D, 2);
      const n8 = retMessages(r8.at(-1)).filter(isR0Msg).length;
      out.push({
        name: '场景8 注入未落地 ⇒ 不记代次（+ inject#failed 留痕）',
        ok: failedLogged && n8 === 1,
        detail: `marker 含 inject#failed=${failedLogged}（期望 true）；同代次重试注入 ${n8} 条，期望 1（误记为已处理时会变 0）`,
      });
      // 场景 9【失败面】：agent 桩**没有** `session.surface`（真 agent 恒有——Session 的 getter，
      //   见 dsh-session:993/1096；这里是拿畸形桩验失败面）⇒ 必须 (a) 留 `error: surface unavailable`
      //   证、(b) 该步**不注入**、(c) surface 恢复后**仍能正常注入**（只是一步跳过，不是永久停摆）。
      //   少了它：把 `warnSurfaceBroken(...)` 调用删掉（变哑）无任何断言会红（第三轮复核 F3）。
      const F = { id: 'verify-probe-f', header: { id: 'verify-probe-f', delegationDepth: 0, cwd: repoRoot } }; // 无 surface / 无 eventAt
      const r9a = await run(F, 1);
      const n9a = retMessages(r9a.at(-1)).filter(isR0Msg).length;
      const brokenLogged = (() => { try { return readFileSync(join(MARKET_DIR, 'mind-inject-marker.txt'), 'utf8').includes('error: surface unavailable'); } catch { return false; } })();
      out.push({
        name: '场景9 surface 缺失 ⇒ 响亮留痕 + 不注入',
        ok: brokenLogged && n9a === 0,
        detail: `marker 含 error: surface unavailable=${brokenLogged}（期望 true）；该步注入 ${n9a} 条，期望 0（失败面变哑时会变 1）`,
      });
      F.surface = { replaceGeneration: 0, nodes: [] }; // 恢复成完好桩
      F.eventAt = () => undefined;
      const r9b = await run(F, 2);
      const n9b = retMessages(r9b.at(-1)).filter(isR0Msg).length;
      out.push({ name: '场景9 surface 恢复后仍能注入（不是永久停摆）', ok: n9b === 1, detail: `恢复后注入 ${n9b} 条，期望 1` });
      // 既有「SOUL 先于 AGENTS」顺序契约断言继续作用于**场景 1（首注）**的结果——与旧默认单场景同一读数。
      //   ⚠️ 必须放在所有场景**之后**：runHandlers 每跑一次都会刷新 record.lastDecision。
      record.lastDecision = r1.at(-1)?.ret;
      return out;
    },
  },
  'mind-recall': {
    // 2026-09-26 加：R1（上工召回）与 R0 同病灶、同修法——注入消息 form='recall'。
    desc: '上工召回应被注入一条 source.form=recall 的消息；压缩换代后必须补注入',
    run: async ({ record, runHandlers, fireSessionEvent, fireEvent }) => {
      const out = [];
      const asked = [{ role: 'user', content: '验证探针：压缩后召回自愈' }];
      const A = makeSessionProbe({ id: 'verify-probe', gen: 0, nodes: [] });
      const run = (session, s, extra) => runHandlers({ ev: 'agent/pre-step', step: s, messages: asked, agent: { session }, ...(extra ?? {}) });
      const n = (r) => retMessages(r.at(-1)).filter(isR1Msg).length;
      // 场景 1：gen=0、surface 空 → 必须注入（会真跑一次 mind-prime）。
      const r1 = await run(A, 1);
      out.push({ name: '场景1 gen=0/surface 空 → 必须注入', ok: n(r1) === 1, detail: `注入 ${n(r1)} 条，期望 1` });
      // 场景 2：同代次 → 不注入，**且不得再跑 mind-prime**（快速路径在 execFileSync 之前）。
      const r2 = await run(A, 2);
      out.push({ name: '场景2 同代次 → 必须不注入（不重跑 mind-prime）', ok: n(r2) === 0, detail: `又注入 ${n(r2)} 条，期望 0` });
      // 场景 3：代次 0→1 → 补注入（会再跑一次 mind-prime，可接受）+ 带 inject#repair。
      A.setSurface(1, []);
      const r3 = await run(A, 3);
      const m3 = retMessages(r3.at(-1)).filter(isR1Msg);
      out.push({ name: '场景3 代次 0→1 → 必须补注入', ok: m3.length === 1, detail: `补注入 ${m3.length} 条，期望 1` });
      out.push({ name: '场景3 补注带 inject#repair 标记', ok: m3.length === 1 && m3.some((m) => msgText(m).includes('inject#repair')), detail: '补注 payload 未带 inject#repair' });
      // 场景 4【关键负例】：代次不变 + surface 里召回仍在 + 派发 compaction/end（失败压缩）→ 必须不注入。
      A.putEvent(21, injectedEvent(21, 'dshome-mind-recall', 'recall'));
      A.setSurface(1, [21]);
      await fireSessionEvent(A, { type: 'compaction/end', data: { error: 'probe: commit-failed' } });
      const r4 = await run(A, 4);
      out.push({ name: '场景4 代次不变+召回仍在（失败压缩）→ 必须不注入', ok: n(r4) === 0, detail: `又注入 ${n(r4)} 条，期望 0` });
      // 场景 5：双会话隔离 —— B 会话必须照常注入，`gen` **故意取 A 当时已记下的代次（1）**：
      //   key 若被写成常量单键 ⇒ B 命中 A 的快路径而漏注 ⇒ 变异必红（第三轮复核 F1）。
      const B = makeSessionProbe({ id: 'verify-probe-b', gen: 1, nodes: [] });
      const r5 = await run(B, 1);
      out.push({ name: '场景5 另一会话（gen 与 A 相同）仍须注入（会话隔离）', ok: n(r5) === 1, detail: `注入 ${n(r5)} 条，期望 1（A 已记 gen=1；key 共用时会漏注）` });
      // 场景 6：session/disposed 清状态后同代次须重新复核并补注入。
      A.setSurface(1, []);
      const disposedFired = await fireEvent('session/disposed', A);
      const r6 = await run(A, 5);
      out.push({
        name: '场景6 session/disposed 清状态 → 同代次须重新复核并补注入',
        ok: disposedFired > 0 && n(r6) === 1,
        detail: `session/disposed 订阅者 ${disposedFired} 个（期望 >0）；补注入 ${n(r6)} 条，期望 1`,
      });
      // 场景 7：**没跑 mind-prime 的提前返回不得记代次** —— delegationDepth>0（子代理跳过）后，
      //   同一会话以 depth=0 再跑必须仍能召回（旧实现把 add 放在跳过之前 ⇒ 被静默挡住）。
      const subA = makeSessionProbe({ id: 'verify-probe-sub', gen: 0, nodes: [], depth: 1 });
      const r7a = await run(subA, 1);
      subA.header.delegationDepth = 0;
      const r7b = await run(subA, 1);
      out.push({
        name: '场景7 跳过的会话不得被当作「本代次已处理」',
        ok: n(r7a) === 0 && n(r7b) === 1,
        detail: `depth=1 注入 ${n(r7a)} 条（期望 0）；随后 depth=0 注入 ${n(r7b)} 条（期望 1 —— 被误标时会变 0）`,
      });
      // 场景 8【surface 复核分支】：换代次但召回仍在 surface → 必须不注入（同 mind-inject 场景 7）。
      const C = makeSessionProbe({ id: 'verify-probe-c', gen: 3, nodes: [31], events: [[31, injectedEvent(31, 'dshome-mind-recall', 'recall')]] });
      const r8 = await run(C, 1);
      out.push({ name: '场景8 换代次但召回仍在 surface → 必须不注入（复核分支）', ok: n(r8) === 0, detail: `又注入 ${n(r8)} 条，期望 0（判据漏看 surface 时会变 1）` });
      // 场景 9【落地校验】：模拟 `insertAfterClaimed` 静默不落地 ⇒ 必须留 `recall#failed` 证 +
      //   **不记代次**（同代次下一步仍会重试并注入；否则这一次白搭的 mind-prime 会把代次钉死）。
      const D = makeSessionProbe({ id: 'verify-probe-d', gen: 0, nodes: [] });
      await run(D, 1, { decision: { messages: null } });
      const failedLogged = (() => { try { return readFileSync(join(MARKET_DIR, 'mind-recall-marker.txt'), 'utf8').includes('recall#failed'); } catch { return false; } })();
      const r9 = await run(D, 2);
      out.push({
        name: '场景9 召回未落地 ⇒ 不记代次（+ recall#failed 留痕）',
        ok: failedLogged && n(r9) === 1,
        detail: `marker 含 recall#failed=${failedLogged}（期望 true）；同代次重试注入 ${n(r9)} 条，期望 1（误记为已处理时会变 0）`,
      });
      // 场景 10【失败面】：同 mind-inject 场景 9 —— 桩缺 `session.surface` ⇒ 响亮留痕 + 不注入，
      //   恢复后仍能召回（失败面不许变哑、也不许永久停摆）。
      const F = { id: 'verify-probe-f', header: { id: 'verify-probe-f', delegationDepth: 0, cwd: repoRoot } }; // 无 surface / 无 eventAt
      const r10a = await run(F, 1);
      const brokenLogged = (() => { try { return readFileSync(join(MARKET_DIR, 'mind-recall-marker.txt'), 'utf8').includes('error: surface unavailable'); } catch { return false; } })();
      out.push({
        name: '场景10 surface 缺失 ⇒ 响亮留痕 + 不注入',
        ok: brokenLogged && n(r10a) === 0,
        detail: `marker 含 error: surface unavailable=${brokenLogged}（期望 true）；该步注入 ${n(r10a)} 条，期望 0（失败面变哑时会变 1）`,
      });
      F.surface = { replaceGeneration: 0, nodes: [] };
      F.eventAt = () => undefined;
      const r10b = await run(F, 2);
      out.push({ name: '场景10 surface 恢复后仍能注入（不是永久停摆）', ok: n(r10b) === 1, detail: `恢复后注入 ${n(r10b)} 条，期望 1` });
      return out;
    },
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
  // 2026-09-23（agent-roles 上线时补）：有些 host 插件**不往宿主平面注册任何东西**，而是按 agent
  //   精确 scope 安装（`agent.ctx.tools.register` / `agent.ctx.systemPrompt.section`，范式 = 官方
  //   `dsh-experimental-tool-agent-team`）。它们需要 `agents`/`subagents` 服务才肯往下走，而注册
  //   落在假 agent 的 ctx 上 —— 上面的 `strict` 判据要求 `registered.length > 0`，缺这一块会**假红**
  //   （不是插件坏了，是 mock 不认这种安装面）。这里补最小桩：一个顶层假 agent + 两个服务桩。
  //   ⚠️ 只加"够走完注册路径"的量；`getProvider: () => undefined` 等**故意不给能力**，免得探针
  //   替真实宿主做它不该做的保证。
  const probeAgent = {
    id: 'verify-probe-agent',
    session: { header: { id: 'verify-probe-agent', delegationDepth: 0, cwd: repoRoot } },
    ctx: {
      tools: { register: () => { record.registered.push('agent.tools.register'); return noop; } },
      systemPrompt: {
        section: () => { record.registered.push('agent.systemPrompt.section'); return noop; },
        getSectionOrder: () => 0,
      },
    },
  };
  const ctxObj = {
    logger,
    agents: { list: () => [probeAgent] },
    subagents: {
      getProvider: () => undefined,
      list: () => [],
      startContinuable: async () => ({ childId: 'verify-probe-child' }),
      sendMessage: async () => 'verify-probe-message',
      listChildren: async () => [],
    },
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

/** ── handler 执行器（2026-09-26 抽成可复用，为「压缩后补注入」多场景断言做准备）──────────
 *  旧版把 handler 真跑写死在主循环里、**每个 handler 只跑一次**、固定
 *  `decision={kind:'enter',messages:[]}` + `step:1` —— 这不足以验「压缩吃掉注入后能否回补」：
 *  那条路径要**同一会话连续跑多次** pre-step（step 1 → 2 → 压缩 → 3），并且要能派发
 *  `session/event`。故抽成 `runHandlers(record, scenario)`：
 *    · scenario.ev 未给 = 跑该插件记录的**全部** handler（= 旧版默认单场景行为，逐字不变）；
 *    · scenario.ev 给 = 只跑该事件的 handler（多场景用，避免把 `session/event` 订阅者
 *      当成 pre-step handler 调用——那种误调用本身就会造出假红/假绿）。
 *  ⚠️ 断言必须看 **handler 的返回值**：它返回的是**新对象**，不是就地改传入的 decision
 *     （血债：首版断言看的是传进去的那个对象 ⇒ mind-inject 明明注入了也被判「未注入」）。 */
async function runHandlers(record, scenario = {}) {
  const results = [];
  for (const { ev, handler } of record.handlers) {
    if (scenario.ev !== undefined && ev !== scenario.ev) continue;
    try {
      const decision = { kind: 'enter', messages: [], ...(scenario.decision ?? {}) };
      const ret = await handler(
        {
          agent: scenario.agent ?? { session: { header: { id: 'verify-probe', delegationDepth: 0, cwd: repoRoot } } },
          messages: scenario.messages ?? [],
          step: scenario.step ?? 1,
          signal: undefined,
        },
        async () => decision,
      );
      const settled = (ret && typeof ret === 'object') ? ret : decision;
      results.push({ ev, ret: settled });
      record.lastDecision = settled;
    } catch (e) {
      record.logs.push(['warn', `handler[${ev}] 抛错: ${(e && e.constructor && e.constructor.name) || 'Error'}: ${e && e.message}`]);
    }
  }
  return results;
}

/** 派发一个宿主事件，只喂给该插件自己订阅的同名 handler。
 *  返回**真被调用的订阅者个数** —— 订阅被删掉/接错线时它是 0，断言据此变红（不许假绿）。 */
async function fireEvent(record, name, ...args) {
  let fired = 0;
  for (const { ev, handler } of record.handlers) {
    if (ev !== name) continue;
    fired += 1;
    await handler(...args);
  }
  return fired;
}
/** `session/event` 派发的薄封装（v3.2 起两个插件都不再订阅它——保留派发以便断言「不再按事件摘标记」）。 */
async function fireSessionEvent(record, session, event) {
  return fireEvent(record, 'session/event', session, event);
}

let failed = 0;
/** 门禁**自身**的失败（如 marker 保护未生效）——与"插件有问题"分开计数、一起拦提交。 */
const gateSelfFailures = [];
if (!existsSync(HOST_DIR)) {
  console.error(`[verify-host-plugins] ❌ 目录不存在: ${HOST_DIR}`);
  process.exit(1);
}

/** marker 保护：handler 真跑会写 `.dsh-market/*marker*.txt`（mind-inject 的 `inject:` 行就在那儿），
 *  而那个 marker 是"注入确实发生过"的**现场证据** —— 本脚本不得把它冲掉。
 *  做法：跑 handler 前备份内容、跑完原样恢复（内容恢复即可；mtime 变了不影响它作为证据的语义）。 */
const MARKET_DIR = join(repoRoot, 'profiles', 'dshome', '.dsh-market');
/** 本脚本可能弄脏的固定落点：**即使此刻不存在也要登记**（值 null = 跑前不存在 → 跑后删除）。
 *  ⚠️ `mind-guard-hints.txt` 必须**显式登记**：它名字里没有 "marker"，不在下面 `/marker/i` 的兜底扫描里
 *  （2026-09-12 分环时同步加，否则新环会被本门禁写脏且永不恢复）。 */
/** ⚠️ 2026-09-23 加 `agent-roles-marker.txt`：agent-roles 的 apply 会写自己的挂载 marker（同 mind-inject
 *  形态）。它此刻**通常不存在**（宿主还没带它启动过）⇒ 必须显式登记为 null，本门禁跑完才会删掉自己
 *  写进去的那行；否则每跑一次门禁就在真 marker 里留一条假挂载行 —— 正是本机制当初要防的污染。 */
const KNOWN_MARKERS = ['mind-guard-marker.txt', 'mind-guard-hints.txt', 'agent-roles-marker.txt'];
function snapshotMarkers() {
  const snap = new Map();
  for (const f of KNOWN_MARKERS) snap.set(join(MARKET_DIR, f), null);
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
    try {
      // 「跑前不存在」→ 跑后删掉：只有从未启动过宿主的机器才走这里（启动过必有挂载行 ⇒ content 非 null
      //  ⇒ 走回写分支），故不会误删真实证据。
      if (content === null) { if (existsSync(p)) rmSync(p, { force: true }); }
      else writeFileSync(p, content, 'utf8');
    } catch { /* 忽略 */ }
  }
}
/** 保护自检：跑完必须与跑前**逐字节相同**。
 *  机制不只要能跑，还要能自证——本仓库的老病正是"机制在、接线错"（本文件自己就栽过两次）。 */
function markerLeaks(snap) {
  const leaks = [];
  for (const [p, content] of snap) {
    let now = null;
    try { now = existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { now = '<读失败>'; }
    if (now !== content) leaks.push(basename(p));
  }
  return leaks;
}

// **进程起点基线**：拍在任何 apply 之前。为什么不能只比"每插件跑前/跑后"——
//   旧线序（快照拍在 apply 之后）下，快照里已经含本次新增行 ⇒ 跑前 == 跑后 ⇒ 自检**看不见**污染。
//   只有拿"整轮开始前"的基线比"整轮结束后"，接线错位才必然露头（终态 != 基线）。
const MARKER_BASELINE = snapshotMarkers();

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

// 🔴 2026-09-27：门禁**不得有"开窗口"的副作用**。本循环对每个 host 插件真调 apply()，
//   而 `lib/host/shell.js` 的 apply() 会 spawn 一个真 Electron 壳 ⇒ **每次 git commit 都多起
//   一个壳**：已有壳在跑时它被 second-instance 拽到前台；壳已不在则凭空开一个窗口并拉起后端。
//   主人报障「提交时 DSHOME 自动切前台」的根因即此 —— 旧版这里只把 shell 当"在 mock 下不注册
//   钩子的无害插件"（见下面 strict 分级注释）→ **"apply 不抛错"被当成了"apply 没副作用"**。
//   开关由 shell.js 认；跑完 delete（同下面 DSHOME_VERIFY_PRIME_FAIL 的写法）。
process.env.DSHOME_SHELL_NO_SPAWN = '1';
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

  // ③-pre 快照 marker —— **必须在 apply 之前**：
  //   mind-guard 的 `mounted:` 行就是在 apply 里写的。旧代码把它拍在 apply **之后** ⇒ 快照已含本次
  //   新增行 ⇒ `restoreMarkers` 把污染原样写回 ⇒ **保护从未生效**（2026-09-12 实测：每跑一次门禁
  //   就往 profiles/dshome/.dsh-market/mind-guard-marker.txt 多塞一条假挂载行，与真启动的挂载行混在一起）。
  const markerSnap = snapshotMarkers();

  // ③ apply 阶段
  try { await mod.apply(makeCtx(record)); } catch (e) { thrown = e; }

  // ④ handler 阶段：**真跑** —— C2 的反例 A（把 isMindConnected 改恒 false，注入永远早退）
  //    只有这一步才抓得到：原版 mock 把 handler 丢掉，那个坏守卫从未被执行过一次。
  //    2026-09-26：抽成 runHandlers(scenario)；EXPECT 带 `run` 的插件走多场景（压缩后自愈），
  //    不带的照旧走「默认单场景」——**默认路径行为逐字不变**。
  const exp = EXPECT[name];
  let expectFail = '';
  let scenarioInfo = '';
  if (exp?.run) {
    try {
      const scenarios = await exp.run({ record, runHandlers: (s) => runHandlers(record, s), fireSessionEvent: (session, event) => fireSessionEvent(record, session, event), fireEvent: (name, ...args) => fireEvent(record, name, ...args) });
      const badScenarios = (scenarios || []).filter((s) => !s.ok);
      scenarioInfo = `；多场景断言 ${(scenarios || []).length} 项${badScenarios.length ? `（失败 ${badScenarios.length}）` : '全通过'}`;
      if (badScenarios.length) expectFail = badScenarios.map((s) => `${s.name}${s.detail ? `（${s.detail}）` : ''}`).join('；');
    } catch (e) {
      expectFail = `多场景断言自身抛错: ${(e && e.constructor && e.constructor.name) || 'Error'}: ${e && e.message}`;
    }
  } else {
    await runHandlers(record, {});
  }
  restoreMarkers(markerSnap);

  const warns = record.logs.filter(([lv]) => lv === 'warn' || lv === 'error');
  const bad = warns.filter(([, m]) => FAIL_RE.test(m));
  // 行为断言（C2 反例 A：守卫早退**不抛错**，"没抛错"证明不了行为发生过）—— 见表 EXPECT
  if (exp?.check) {
    let checkFail = '';
    try { if (!exp.check(record)) checkFail = exp.desc; }
    catch (e) { checkFail = `${exp.desc}（断言自身抛错: ${e && e.message}）`; }
    if (checkFail) expectFail = expectFail ? `${expectFail}；${checkFail}` : checkFail;
  }
  // 判定分级（2026-09-11）：核心心智插件（REQUIRED）要求"注册了钩子 +（有断言时）行为断言通过"；
  // 其余 host 插件（core/shell/desktop/notify/…）只要求"不抛错"——它们可能依赖 Electron/宿主环境、
  // 在 mock 下本就不注册钩子（实测 `shell` 即如此），用同一把尺子会造**假阳性**。
  const strict = REQUIRED.includes(name);
  const ok = !thrown && bad.length === 0 && !expectFail && (!strict || record.registered.length > 0);
  if (ok) {
    console.log(`  ✅ ${name}: apply 正常（注册 ${record.registered.join(', ')}；handler 真跑 ${record.handlers.length} 个${exp ? ' + 行为断言通过' : ''}${scenarioInfo}）`);
  } else {
    failed++;
    console.log(`  ❌ ${name}: 挂载异常`);
    if (thrown) console.log(`       throw: ${thrown.constructor.name}: ${thrown.message}`);
    for (const [, m] of bad) console.log(`       warn: ${m}`);
    if (!record.registered.length) console.log('       未注册任何钩子（apply 可能没跑到注册点）');
    if (expectFail) console.log(`       行为断言未通过：${expectFail}`);
  }
}
delete process.env.DSHOME_SHELL_NO_SPAWN; // 开关只对本次门禁的 apply 循环有效（见循环上方注释）

// 门禁自检：整轮跑完，marker 必须与**进程起点基线**逐字节一致。
//   露头条件：① 快照线序错位（拍在 apply 之后 → 恢复把污染写回）；② 恢复写入失败；③ 有插件在 apply 里
//   写 marker 却没人保护。任一发生 → 护栏现场证据被门禁自己污染（本就是"机制在、接线错"的老病）。
markerLeaks(MARKER_BASELINE).forEach((f) => gateSelfFailures.push(`marker 未回到起点基线（${f}）→ 保护接线错位/写入失败，会污染护栏现场证据`));

// ── 包路径解析探针（2026-09-12 加 · 真实事故）────────────────────────────────
// 上面的加载段按**文件路径** import（`lib/host/<x>.js`），**绕过了 package exports**：
// 2026-09-12 实景——compaction-log 插件漏登 `packages/dshome/package.json` 的 `exports`，
// 本脚本照样全绿；可重启宿主后 cordis 按**包子路径** `dshome/mind-compaction-log` 加载时，
// ESM 直接拒收（`ERR_PACKAGE_PATH_NOT_EXPORTED`）→ 插件一行没跑、后端 boot 后必死，
// 连崩 3 次撞外壳熔断 + 模态窗阻塞主进程 → 界面掉线，靠外部救援才恢复。
// 探针只 `resolve` 不执行（零副作用），把「启动才崩」提前成「提交前就红」。
function probePackageExports() {
  const profilePkg = join(repoRoot, 'profiles', 'dshome', 'package.json');
  if (!existsSync(profilePkg)) {
    // fail-closed：缺 profile 就无法验证包解析面，不静默跳过（Invariants #14）。
    return { checked: 0, failures: [`${profilePkg} 不存在——无法验证包解析面（fail-closed）`] };
  }
  let req;
  try { req = createRequire(profilePkg); }
  catch (e) { return { checked: 0, failures: [`createRequire(${profilePkg}) 失败：${e.message}`] }; }
  const failures = [];
  let checked = 0;
  for (const p of PLUGINS) {
    const spec = `dshome/${p}`;
    try { req.resolve(spec); checked += 1; }
    catch (e) { failures.push(`${spec} → ${e.code || e.message}`); }
  }
  return { checked, failures };
}

// ── ctx 服务访问对齐探针（2026-09-12 加 · 同一天第二个真实事故）──────────────
// 事故：mind-compaction-log 写 `ctx.tokenMeter?.measure?.()`，但 inject 只有 ['fs']。
//   cordis 4.0.2 的服务解析（reflect/get）**沿祖先 fiber 链找 store**：命中即返回（不校验 inject）；
//   若提供方在**兄弟分支**（token-meter 属 base 补丁树）则走 inject 检查 → 不在 inject 里就抛
//   `cannot get property "X" without inject`。该异常被插件自己的 try/catch 吞成 null ⇒
//   审计行「释放 token」恒记 `unknown` —— **真 bug 伪装成「框架没给能力」**，白纸黑字骗了一轮。
//   修法：`ctx.get('X')`（cordis 明写的「不要求 inject 的读取通道」）。
// 口径：去注释 + 去字符串后匹配 `(?<![\w$.])ctx.<ident>`（`wctx.`/`sctx.` 不算）；
//   声明面 = 模块级 inject + 文件里所有 `ctx.inject([...])` 子作用域的 inject（取并集，避免子 ctx 误报）；
//   `ctx.get(...)` 合规不报。当前全树应**零命中**；将来新增服务访问若没声明，提交前即红。
const CORDIS_INTRINSICS = new Set([
  'logger', 'fiber', 'reflect', 'registry', 'events', 'root', 'baseUrl',
  'on', 'off', 'once', 'emit', 'parallel', 'serial', 'bail', 'waterfall',
  'effect', 'get', 'set', 'provide', 'plugin', 'inject', 'extend', 'isolate',
  'intercept', 'scope', 'start', 'stop', 'dispose', 'then', 'config',
]);
/** 例外（`文件:属性` → 理由）。当前仅 1 条；加条目前必须写清「为什么不用 inject」。
 *  probe8 实验（仓库外，同版 cordis）：**祖先 fiber 提供**的服务属性访问可用；**兄弟分支**提供
 *  的必抛 `without inject`。plugin-store 的 `snapshot(ctx)` 是**接 ctx 参数**的共享函数：
 *  loader 由插件树加载器自身提供，而插件树正是它创建的 ⇒ loader 是本插件 fiber 的**祖先**
 *  （同理 token-meter 属 base 补丁树，是**兄弟** → 必须 inject / 走 ctx.get）。 */
const ALLOW_WITHOUT_INJECT = new Map([
  ['plugin-store.js:loader', 'loader 由插件树加载器自身提供 = 祖先 fiber（插件树由它创建）；该文件的 snapshot(ctx) 是接参共享函数'],
]);

function probeContextServiceAccess() {
  const files = readdirSync(HOST_DIR).filter((f) => f.endsWith('.js'));
  const failures = [];
  const seen = new Set();
  let scanned = 0;
  let accesses = 0;
  for (const file of files) {
    const src = readFileSync(join(HOST_DIR, file), 'utf8');
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const code = noComments
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const declared = new Set();
    for (const m of noComments.matchAll(/inject\s*[:=]\s*\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) declared.add(s[1] ?? s[2]);
    }
    for (const m of code.matchAll(/(?<![\w$.])ctx\.([A-Za-z_$][\w$]*)/g)) {
      const prop = m[1];
      if (prop.startsWith('_') || CORDIS_INTRINSICS.has(prop)) continue;
      accesses += 1;
      if (declared.has(prop) || ALLOW_WITHOUT_INJECT.has(`${file}:${prop}`)) continue;
      const key = `${file}:${prop}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push(`${file}: ctx.${prop} 未在任何 inject 中声明 → cordis 会抛 \`without inject\`（补 inject，或改用 ctx.get('${prop}')）`);
    }
    scanned += 1;
  }
  return { scanned, accesses, failures };
}

// ── 插件保护语义探针（2026-09-26 加 · 「自制插件全是锁」事故）──────────────────
// 事故：isProtected 用 `startsWith('dshome')` 宽前缀兜底，而 classify() 判「自制」用的是**同一条前缀**
//   ⇒ 分类键与保护键同键：自制栏每一条都被判核心，UI 全挂 🔒、开关全灰（活进程实测读数：
//   自制 21/21 protected=true、下载 6/6 false）。前缀兜底还让白名单里 6 条 `dshome/*` 成死代码。
// 三条断言把语义钉死：
//   ① 真加载 plugin-store.js（不是读文本）+ classify 面不变；
//   ② 白名单每条都必须真命中 —— 防"名字写错、白名单条目不生效却无人发现"；
//   ③ **前缀回归探针**：白名单外的 dshome 名必须 false —— 谁把 startsWith('dshome') 加回来，本项立刻红。
async function probePluginProtection() {
  const failures = [];
  let mod;
  try { mod = await import(pathToFileURL(join(HOST_DIR, 'plugin-store.js')).href); }
  catch (e) { return { checked: 0, failures: [`plugin-store.js 真加载失败：${e?.message ?? e}`] }; }
  const { isProtected, classify, PROTECTED_MODULES } = mod;
  if (typeof isProtected !== 'function' || typeof classify !== 'function' || !(PROTECTED_MODULES instanceof Set)) {
    return { checked: 0, failures: ['plugin-store.js 未导出 isProtected/classify/PROTECTED_MODULES（探针无法取证）'] };
  }
  let checked = 0;
  // ① 白名单每条必须真命中
  for (const name of PROTECTED_MODULES) {
    checked += 1;
    if (isProtected(name) !== true) failures.push(`白名单条目永不命中：${name}（名字与 snapshot 的 entry.options.name 不一致？）`);
  }
  // ② 分类面不变 + 前缀回归探针（反例）
  const UNPROTECTED_SELF = ['dshome-mind', 'dshome/agent-roles', 'dshome-quick-phrases', 'dshome-plugin-center', 'dshome-input', 'dshome-prefix-regression-probe'];
  for (const name of UNPROTECTED_SELF) {
    checked += 1;
    if (isProtected(name)) failures.push(`白名单外的 dshome 名被判核心：${name}（前缀兜底回归了？保护面应收敛到 PROTECTED_MODULES）`);
  }
  checked += 3;
  if (classify('dshome-mind') !== '自制') failures.push(`classify 面被改动：dshome-mind → ${classify('dshome-mind')}（应仍为「自制」）`);
  if (classify('@deepseek-ai/dsh-host-webserver') !== '内置') failures.push(`classify 面被改动：@deepseek-ai/dsh-host-webserver → ${classify('@deepseek-ai/dsh-host-webserver')}`);
  if (classify('dsh-better-sidebar') !== '下载') failures.push(`classify 面被改动：dsh-better-sidebar → ${classify('dsh-better-sidebar')}`);
  return { checked, failures };
}

// ── writeToggle 往返无损探针（2026-09-26 加 · 真机真触发撞出的「孤儿条目」事故）────────
// 事故（修 isProtected 那轮把插件真停用一次时撞出，随后 git checkout 复原）：停用一个**不在
//   cordis.patch.yml 里**的插件时，writeToggle 会追加 `- id: X` + `disabled: true`，而"启用"只删
//   disabled 行、把 `- id: X` 空壳**永久留在文件里**（下次重启会被当成一条 patch 条目加载）；
//   同处恒以 `out.join(nl) + nl` 收尾 ⇒ 已有末尾换行的文件每启停一次多一个空行；内容清空时写出
//   0 字节文件（原 `[]` 丢失）。修复前实测 **6/6 例红**、修复后 6/6 全绿（判据见下）。
// 判据：**隔离 DSH_HOME**（绝不碰真 profile）真调用 writeToggle，断言一轮往返后与原始**字节一致**。
async function probeToggleRoundTrip() {
  const failures = [];
  const mod = await import(pathToFileURL(join(HOST_DIR, 'plugin-store.js')).href);
  const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
  const countLines = (s) => { const p = s.split(/\r?\n/); if (p[p.length - 1] === '') p.pop(); return p.length; };
  const BASE = [
    '- id: llm-deepseek',
    '  name: llm-deepseek',
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    '- id: dshome-palette',
    '  name: palette',
  ].join('\n');
  const cases = [
    { name: '既有条目+末尾换行', raw: BASE + '\n', id: 'dshome-palette', kind: 'roundtrip', mid: 7 },
    { name: 'yml 里没有该条目（追加型停用）', raw: BASE + '\n', id: 'dshome-quick-phrases', kind: 'roundtrip', mid: 8 },
    { name: '既有条目+无末尾换行', raw: BASE, id: 'dshome-palette', kind: 'roundtrip', mid: 7 },
    { name: 'CRLF 文件', raw: BASE.replace(/\n/g, '\r\n') + '\r\n', id: 'dshome-palette', kind: 'roundtrip', mid: 7 },
    { name: '空数组 []', raw: '[]', id: 'dshome-x', kind: 'roundtrip', mid: 2 },
    { name: '孤儿条目清理（块内只有 disabled）', raw: BASE + '\n- id: dshome-orphan\n  disabled: true\n', id: 'dshome-orphan', kind: 'orphan', mid: 8 },
  ];
  const oldHome = process.env.DSH_HOME;
  const oldProfile = process.env.DSH_PROFILE;
  const home = mkdtempSync(join(tmpdir(), 'dshome-verify-tog-'));
  let checked = 0;
  try {
    for (const c of cases) {
      const dir = join(home, 'profiles', 'test');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'cordis.patch.yml');
      writeFileSync(file, c.raw, 'utf8');
      process.env.DSH_HOME = home;
      process.env.DSH_PROFILE = 'test';
      await mod.writeToggle(c.id, false);
      const disabled = readFileSync(file, 'utf8');
      await mod.writeToggle(c.id, true);
      const after = readFileSync(file, 'utf8');
      checked += 1;
      if (!disabled.includes('disabled: true')) failures.push(`${c.name}：停用没写入 disabled: true`);
      if (countLines(disabled) !== c.mid) failures.push(`${c.name}：中间态行数 ${countLines(disabled)}（期望 ${c.mid} —— 多出来的是空行/孤儿行）`);
      if (c.kind === 'roundtrip') {
        if (after !== c.raw) failures.push(`${c.name}：往返后字节不一致（${sha(c.raw)} → ${sha(after)}）`);
      } else {
        if (after.includes(c.id)) failures.push(`${c.name}：孤儿条目未清理，文件里仍有 ${c.id}`);
        else if (after !== BASE + '\n') failures.push(`${c.name}：清理后未回到基线（${sha(BASE + '\n')} → ${sha(after)}）`);
      }
    }
  } catch (e) {
    failures.push(`探针自身异常：${e?.message ?? e}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = oldProfile;
  }
  return { checked, failures };
}

// ── recall「每代次至多一次 spawn」成本不变式探针（2026-09-26 加 · 第三轮复核 F2）──────────
// 复核的变异实测：把代次快路径挪到 `execFileSync` **之后**、或删掉「空召回 / 抛错也记代次」
//   ⇒ mind-recall 的 10 项行为断言**全绿**，而 spawn 数 1→3（每步一个同步子进程，阻塞事件循环）。
// 为什么行为断言看不见：**spawn 次数不在 handler 返回值里**（注入条数两种实现都一样）。
// ⇒ 只能在「真子进程 + 计数」这一面取证：假 `DSH_HOME` 夹具（`<tmp>/mind` + `<tmp>/scripts/mind-prime.mjs`
//   计数假脚本）＋真 apply 一个 mind-recall 实例，跑 3 步数计数文件行数。真仓库零触碰
//   （DSH_HOME 全程钉在夹具根，plugin 的 marker 也写进夹具），跑完删夹具、还原 env。
async function probeRecallSpawnBudget() {
  const failures = [];
  const home = mkdtempSync(join(tmpdir(), 'dshome-verify-spawn-'));
  const oldHome = process.env.DSH_HOME;
  let checked = 0;
  try {
    mkdirSync(join(home, 'mind'), { recursive: true });
    mkdirSync(join(home, 'scripts'), { recursive: true });
    // 假 mind-prime：每次被 spawn 就 +1 行；`DSHOME_VERIFY_PRIME_FAIL=1` 时模拟抛错（exit 1）；
    // 默认输出**不含 ■** ⇒ 走「空召回」降级路径。
    writeFileSync(join(home, 'scripts', 'mind-prime.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "import { dirname, join } from 'node:path';",
      "appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'spawns.log'), 'spawn\\n');",
      "if (process.env.DSHOME_VERIFY_PRIME_FAIL === '1') process.exit(1);",
      "console.log('（探针：空召回，无分节）');",
    ].join('\n'), 'utf8');
    process.env.DSH_HOME = home;
    const recallMod = await import(pathToFileURL(join(HOST_DIR, 'mind-recall.js')).href);
    const record = { logs: [], registered: [], handlers: [] };
    await recallMod.apply(makeCtx(record));
    const spawns = () => { try { return readFileSync(join(home, 'scripts', 'spawns.log'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const session = (id) => ({ id, header: { id, delegationDepth: 0, cwd: home }, surface: { replaceGeneration: 0, nodes: [] }, eventAt: () => undefined });
    const step = (s, n) => runHandlers(record, { ev: 'agent/pre-step', step: n, messages: [{ role: 'user', content: '探针' }], agent: { session: s } });
    // ① 空召回（无 ■ 分节）：**跑过 mind-prime 就要记代次** ⇒ 3 步只该 spawn 1 次。
    const A = session('verify-spawn-empty');
    for (const n of [1, 2, 3]) await step(A, n);
    const emptySpawns = spawns();
    checked += 1;
    if (emptySpawns !== 1) failures.push(`空召回会话连跑 3 步 spawn ${emptySpawns} 次（期望 1 —— 空召回不记代次时会是 3，即每步一个同步子进程）`);
    // ② 抛错（mind-prime exit 1）：同样只该 spawn 1 次（抛错也要记代次）。
    process.env.DSHOME_VERIFY_PRIME_FAIL = '1';
    const B = session('verify-spawn-fail');
    for (const n of [1, 2, 3]) await step(B, n);
    const failSpawns = spawns() - emptySpawns;
    checked += 1;
    if (failSpawns !== 1) failures.push(`抛错会话连跑 3 步新增 spawn ${failSpawns} 次（期望 1 —— 抛错不记代次时会是 3）`);
  } catch (e) {
    failures.push(`探针自身异常：${e?.message ?? e}`);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    delete process.env.DSHOME_VERIFY_PRIME_FAIL;
    rmSync(home, { recursive: true, force: true });
  }
  return { checked, failures };
}

const probe = probePackageExports();
if (probe.failures.length === 0) {
  console.log(`  ✅ 包路径解析：${probe.checked} 个 dshome/* 子路径全部可解析（package.json exports 齐全）`);
} else {
  for (const f of probe.failures) console.log(`  ❌ 包路径解析失败：${f}`);
  console.log('      修法：packages/dshome/package.json 的 exports 补 "./<name>": "./lib/host/<name>.js"');
}

const svc = probeContextServiceAccess();
if (svc.failures.length === 0) {
  console.log(`  ✅ ctx 服务访问：${svc.scanned} 个插件 / ${svc.accesses} 处属性访问全部已声明 inject（或走 ctx.get）`);
} else {
  for (const f of svc.failures) console.log(`  ❌ ${f}`);
}

const prot = await probePluginProtection();
if (prot.failures.length === 0) {
  console.log(`  ✅ 插件保护语义：${prot.checked} 条断言通过（白名单唯一真相 / 白名单条目真命中 / dshome 前缀回归探针 / classify 面不变）`);
} else {
  for (const f of prot.failures) console.log(`  ❌ ${f}`);
}

const trip = await probeToggleRoundTrip();
if (trip.failures.length === 0) {
  console.log(`  ✅ 启停写回无损：${trip.checked} 例往返（隔离 DSH_HOME）字节一致（既有条目 / 追加型 / 无末尾换行 / CRLF / [] / 孤儿清理）`);
} else {
  for (const f of trip.failures) console.log(`  ❌ ${f}`);
}

const spawnBudget = await probeRecallSpawnBudget();
if (spawnBudget.failures.length === 0) {
  console.log(`  ✅ recall spawn 成本不变式：${spawnBudget.checked} 例（空召回 / 抛错）连跑 3 步各只 spawn 1 次（隔离 DSH_HOME 夹具 + 计数假 mind-prime）`);
} else {
  for (const f of spawnBudget.failures) console.log(`  ❌ ${f}`);
}

const totalFailed = failed + probe.failures.length + svc.failures.length + prot.failures.length + trip.failures.length + spawnBudget.failures.length + gateSelfFailures.length;
for (const f of gateSelfFailures) console.log(`  ❌ 门禁自检失败：${f}`);
console.log(`[verify-host-plugins] ${totalFailed === 0 ? '✅ 全部通过' : `❌ ${totalFailed} 项异常（挂载异常 ${failed} + 包解析失败 ${probe.failures.length} + 服务访问失配 ${svc.failures.length} + 保护语义 ${prot.failures.length} + 启停写回 ${trip.failures.length} + recall spawn 成本 ${spawnBudget.failures.length} + 门禁自检 ${gateSelfFailures.length}）`}（退出码 ${totalFailed === 0 ? 0 : 1}）`);
process.exit(totalFailed === 0 ? 0 : 1);
