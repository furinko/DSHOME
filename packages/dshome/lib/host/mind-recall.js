// dshome-mind-recall — 上工自动召回 host 插件（每会话首步机械注入 mind-prime 产物）。
//
// 职责：每次主会话【首次】时，机器自动跑 scripts/mind-prime.mjs 并把产物
//      （project 进度/待办 + L3 相关记忆 + Learn 教训 + user-rules）作为一条 user 消息
//      塞进会话开头——不靠 agent 记得跑（AGENTS「不靠下次记住」铁律的机器实现）。
//
// v3.2（2026-09-26）在场判据换轴（与 mind-inject 同构）：surface 代次键
//      （`agent.session.surface.replaceGeneration`，只有 replace/压缩收缩才 +1）。
//      背景：官方压缩器只保护 surface 第 0 格的 system/message、**从第 1 格起压** ⇒ 塞在第 2 格的
//      R1 召回同样每次压缩必被 shadow（实测 session-72e393d3：R1 注入 seq 11/1642/…/11316 与
//      R0 成对落入 shadowedSeqs）。
//      v3.1 的两条修法都被复核证伪：① 查 `decision.messages` 判在场 = 死代码（该数组不含会话历史，
//      dsh-agent-loop:894-901）；② 按 compaction/end 摘标记 = 误摘（失败压缩也 append end，
//      dsh-compaction-basic:475-482）⇒ 白跑一次 mind-prime。
//      ⚠️ mind-prime 是 execFileSync 子进程（15s 超时），本插件**不得**把它变成每步执行：
//        代次快速路径（同代次直接返回）+ **跑过 mind-prime 就记代次**（空召回 / 抛错也记）
//        保证「每会话每代次至多 spawn 一次」。
//
// 机制：与 dshome-mind-inject 同构（ctx.on('agent/pre-step') + 每会话一次 + user 消息通道），
//     但注入的是「动态召回产物」而非「静态纪律全文」。设计取舍：
//   - 用公司骨架：独立 host 插件 / fails-open / 可独立启停 / 与注入器解耦
//   - 留凌晨灵魂：delegationDepth 跳子代理、cron 前置召回跳过、空机优雅降级、claimed 后插入
//   - token 可控：只注一次、空机不注（mind-prime 空输出无 ■ 分节 → 跳过）
//
// 与 dshome-mind-inject 的关系：
//   inject 管「R0 宪法」（mind\L0\SOUL.md 人格 + AGENTS.md 运行，双件全文注入，静态，v3.0 起）；
//   recall 管「上工记忆召回」（当前项目/任务的进度+相关记忆，动态）。
//   两者互补：纪律常驻、记忆按需——本插件只做召回，纪律归注入器。
//   注：不再加「上工自动召回 · 会话记忆」包层头——mind-prime 首行「【上工自动召回 · <query>】」
//       已自带块头，两层同义头是冗余（2026-09-06 A4 收敛）。
//
// 验证：marker 仅启动诊断；集成测试 scripts/mind-boot-recall-itest.mjs 与
//      scripts/verify-boot-recall.mjs 对本插件做行为验收（改测本插件后重启 DSHOME 再跑）。

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 经 upstream 层运行时获取（原为静态具名导入）——理由见 upstream.js 头注：
// 静态具名导入若在官方新版消失会在模块链接期抛错，apply 的兜底够不着。
import { createUserMessage } from './upstream.js';
import { sessionKey, insertAfterClaimed } from './mind-insert.js';
import { isMindConnected } from './mind-connect.js';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/mind-recall). */
export const name = 'dshome-mind-recall';

/** Services this row requires before activation. */
export const inject = ['fs'];

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

/** 诊断 marker（仅启动确认，不以它作为"注入成功"的标准）。 */
function writeMarker(content) {
  try {
    const root = repoRoot();
    const dir = join(root, 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mind-recall-marker.txt'), content, 'utf8');
  } catch (e) { /* 诊断标记失败不影响插件 */ }
}

/** 消息文本抽取（content 可能是 string 或 blocks）。 */
function contentText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  return '';
}

/** 提取当前任务作召回 query：取该会话消息流里最后一条用户消息文本（截断、去空）。 */
function taskQuery(userMessages, decisionMessages) {
  const all = [...(userMessages || []), ...(decisionMessages || [])];
  let q = '';
  for (const m of all) {
    if (m && m.role === 'user') {
      const t = contentText(m).trim();
      if (t) q = t;
    }
  }
  return q.slice(0, 120).trim();
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    const primeScript = join(root, 'scripts', 'mind-prime.mjs');
    if (!existsSync(primeScript)) {
      writeMarker(`apply: mind-prime.mjs missing @ ${new Date().toISOString()}`);
      return;
    }
    // ── v3.2 在场判据：surface 代次键（同 mind-inject；不再订阅 compaction/*）──────────────
    const state = new Map(); // sessionKey -> { gen: number, ever: boolean }（ever 仅供 marker 区分首注/补注）
    let surfaceBroken = false; // 失败面只报一次（不许静默 return，也别每步刷屏）
    const warnSurfaceBroken = (why) => {
      if (surfaceBroken) return;
      surfaceBroken = true;
      writeMarker(`error: surface unavailable (${why}) — R1 在场复核停用 @ ${new Date().toISOString()}`);
      ctx.logger?.('dshome').warn(`dshome-mind-recall: session.surface 不可用（${why}）→ 无法复核 R1 在场，本进程内跳过召回`);
    };
    let insertFailed = false; // 落地校验失败也只报一次（同 surfaceBroken 的一次性闸）
    /** 召回没落地 = 静默失败面：报一次（marker + warn），且**不记代次**（下一步重试）。 */
    const warnInsertFailed = (why) => {
      if (insertFailed) return;
      insertFailed = true;
      writeMarker(`recall#failed: ${why} @ ${new Date().toISOString()}`);
      ctx.logger?.('dshome').warn(`dshome-mind-recall: 召回未落地（${why}）→ 不记代次，下一步重试`);
    };
    /** 取本会话的 surface 视图；任一缺失 → null。 */
    const surfaceViewOf = (agent) => {
      const session = agent?.session;
      const surface = session?.surface;
      if (!surface || typeof surface.replaceGeneration !== 'number') return null;
      if (!Array.isArray(surface.nodes) || typeof session.eventAt !== 'function') return null;
      return { session, surface };
    };
    /** 本插件注入的 R1 是否仍在 surface 上（判据照官方：扫 surface.nodes + eventAt，钉 source，不看文本）。 */
    const isRecallOnSurface = ({ session, surface }) => {
      for (const seq of surface.nodes) {
        const e = session.eventAt(seq);
        if (e && e.type === 'user/message' && e.data?.source?.plugin === name && e.data?.source?.form === 'recall') return true;
      }
      return false;
    };

    writeMarker(`apply: registered hook @ ${new Date().toISOString()}`);
    // 上游 createUserMessage 缺失 → 上工召回停用（apply 仍成功、不拖垮宿主）；marker 留痕。
    if (!createUserMessage) {
      writeMarker(`apply: degraded — createUserMessage unavailable, recall disabled @ ${new Date().toISOString()}`);
    }

    // 会话销毁 → 清状态（与姊妹插件 mind-compaction-log:182 / session-budget:401 同款）。
    ctx.on('session/disposed', (session) => {
      const id = session?.id ?? session?.header?.id;
      if (id) state.delete('session:' + String(id));
    });

    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      try {
        // 判定顺序（v3.2，按成本从低到高）：kind → key → 代次快速路径（O(1)、**不跑 mind-prime**）
        //   → 开关 → surface 复核（真在就不重复召回，只补记代次）。
        if (decision?.kind !== 'enter') return decision;
        const key = sessionKey(agent);
        if (!key) return decision;
        const view = surfaceViewOf(agent);
        if (!view) { warnSurfaceBroken('agent.session.surface/eventAt 缺失'); return decision; }
        const gen = view.surface.replaceGeneration;
        const rec = state.get(key);
        // 同代次 ⇒ surface 未换代 ⇒ 召回还在场 ⇒ 直接返回（这一步是「不许每步 spawn」的保证）。
        if (rec && rec.gen === gen) return decision;
        // 「接入心智」开关：该会话被关闭时跳过上工召回；**不进 state**（切回「开」时下回合照常复核）。
        if (!isMindConnected(agent?.session?.header?.id)) {
          return decision;
        }
        if (isRecallOnSurface(view)) {
          state.set(key, { gen, ever: rec?.ever === true });
          return decision;
        }

        // 只注入顶层会话（delegationDepth=0）：子代理父上下文已带召回，避免重复 exec/噪音。
        // ⚠️ 下面两条**提前返回不记代次**——它们根本没跑 mind-prime（没跑就不该被当成「本代次已处理」，
        //    否则切回顶层 / 换 cron 场景时会漏召回）。
        const depth = agent?.session?.header?.delegationDepth;
        if (typeof depth === 'number' && depth > 0) return decision;

        // cron 等已在 prompt 前置【上工自动召回】→ 跳过，避免双份。
        const joined = [...(messages || []), ...(decision.messages || [])].map(contentText).join('\n');
        if (joined.includes('【上工自动召回')) return decision;

        // 跑 mind-prime（15s 超时；失败静默跳过——fails-open，绝不阻塞会话）。
        // ① 当前任务作召回 query（会话触发的用户消息）；② 项目记忆隔离：传 --cwd。
        // 结果导向：query 命中/歧义/落空的处理在 mind-prime（搜索侧），这里只透传任务 + 工作区。
        let primeText = '';
        try {
          const primeArgs = [primeScript];
          const childCwd = agent?.session?.header?.cwd;
          const task = taskQuery(messages, decision.messages);
          if (task) primeArgs.push(task);
          if (childCwd) primeArgs.push('--cwd', childCwd);
          primeText = execFileSync(process.execPath, primeArgs, { cwd: root, encoding: 'utf8', timeout: 15000 }).toString().trim();
        } catch (e) {
          ctx.logger?.('dshome')?.warn?.('dshome-mind-recall: mind-prime failed, skip inject', e?.message ?? e);
          // 抛错也记代次（v3.2）：否则失败会话**每步**一次 execFileSync（实测 71ms/次、同步阻塞事件循环）。
          state.set(key, { gen, ever: rec?.ever === true });
          return decision;
        }
        // 空机降级：无 ■ 分节（无 project 进度/待办/L3/Learn/user-rules）→ 不注入空壳。
        // 同样**记代次**（空召回也跑过了 mind-prime，不许每步重跑）。
        if (!primeText.includes('■')) {
          state.set(key, { gen, ever: rec?.ever === true });
          return decision;
        }

        // 块头由 mind-prime 首行自带（【上工自动召回 · <query>】），不再包一层同义头（A4）；
        // 仅**补注入**时前置一行 `inject#repair` 标记（会话日志取证：区分首注与压缩后补注）。
        const repair = rec?.ever === true;
        const payload = repair ? `\n【补注入 · inject#repair】\n${primeText}` : `\n${primeText}`;
        if (!createUserMessage) return decision; // 上游导出缺失 → 静默跳过（apply 期已留痕）
        const recallMessage = createUserMessage({
          content: [{ type: 'text', text: payload }],
          source: { kind: 'plugin', plugin: name, form: 'recall' },
        });
        // 插到 claimed 用户消息之后（指令类上下文不被稀释），无 claimed 则放最前。
        const entered = insertAfterClaimed(decision, messages, recallMessage);
        // ── v3.2 落地校验：**先验落地，再记账**（同 mind-inject）────────────────────────
        // `insertAfterClaimed`（mind-insert.js:23）在 `decision.messages` 非数组时**静默原样返回**：
        // 那时若还写 `recall:` 行 + `state.set(key,{gen})`，就是「没落地却记了代次」⇒ 该代次内
        // 快速路径恒命中、**永不再试**（且白搭一次 mind-prime 的产物）——真实静默失败面。
        if (!Array.isArray(entered?.messages) || !entered.messages.includes(recallMessage)) {
          warnInsertFailed('insertAfterClaimed 未把 R1 插进 decision.messages（messages 非数组？）');
          return entered; // 不写 state ⇒ 下一步同代次仍会重试（自愈）
        }
        state.set(key, { gen, ever: true });
        writeMarker(`recall${repair ? '#repair' : ''}: len=${payload.length} @ ${new Date().toISOString()}`);
        return entered;
      } catch (error) {
        // 注入失败只记日志，绝不阻断。
        ctx.logger?.('dshome').warn('dshome-mind-recall: 注入失败 %O', error);
      }
      return decision;
    });
    ctx.logger?.('dshome').info('dshome-mind-recall: 上工自动召回钩子已挂载');
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-recall: 初始化失败 %O', error);
  }
}
