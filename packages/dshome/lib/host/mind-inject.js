// dshome-mind-inject — 心智 R0 注入 host 插件（v3.0：运行宪法双件注入）。
//
// 职责：每个 agent 会话【开始（第一步）】时，往消息流塞一条「心智 R0 运行宪法」user 消息，
//      注入源 = mind\L0\SOUL.md + mind\L0\AGENTS.md **全文**（运行时 readFile 拼接——正文即注入源）。
//      R0 分层：人格宪法（SOUL：为什么/身份/决策原则/动机）+ 运行宪法（AGENTS：做什么/协议/边界/地图）。
//      每会话一次（按 session 去重），**不是每轮**；但压缩吃掉注入后必须自愈（v3.2，见下）。
//
// v3.2（2026-09-26）在场判据**换轴**：surface 代次键（`session.surface.replaceGeneration`）。
//      背景：官方压缩器 `dsh-compaction-basic` 选范围时写死
//      `firstIdx = systemHead(surfaceNodes[0]) === void 0 ? 0 : 1`（只保护 surface 第 0 格的
//      system/message，**从第 1 格起压**），而 R0 恰好塞在第 1 格 ⇒ **每次压缩必被 shadow**
//      （实测 session-72e393d3：8 次注入全部落入 shadowedSeqs，其后 1300+ 事件零补注入）。
//      v3.1 的两条修法都被复核证伪，记在这里免得再走一遍：
//        ① 查 `decision.messages` 判「R0 在不在」= **死代码**：该数组 = claimed(inbox 抽取) +
//           runtime context，**不含会话历史**（dsh-agent-loop/lib/index.js:894-901）⇒ 恒不命中；
//        ② 按 `compaction/end` 事件摘标记 = **误摘**：commit 前失败时同样会 append 带 error 的
//           compaction/end（dsh-compaction-basic/lib/index.js:475-482），此时 surface 未收缩、
//           R0 仍在场 ⇒ 下一回合全量重注一遍（~11KB）。
//      现在：官方权威信号 = `session.surface.replaceGeneration`——**只有 replace（压缩收缩）才 +1**
//      （dsh-session/lib/index.js:410-415；getter 475-483），普通 append 不动；官方自己在
//      dsh-agent-loop/lib/index.js:1021 就用它判请求系列换代。于是：
//        · 同代次 ⇒ surface 未换代 ⇒ 我注入的那条必然还在场 ⇒ O(1) 直接返回（零扫描）；
//        · 换代次 ⇒ 照官方 dsh-agent-instructions（1212-1215）扫 `surface.nodes` + `eventAt(seq)`
//          复核在场（钉 source.kind/plugin/form，不看文本）：在 ⇒ 只补记代次；不在 ⇒ 补注入。
//      三种情形（成功压缩 / 失败压缩 / 崩溃漏网）天然覆盖，无需再订阅任何 compaction 事件。
//
// v2.5（2026-09-06）取消手写 L0_SUMMARY 摘要：摘要副本制造「权威倒挂」（生效的是摘要、正文没人读、
//      改正文不生效）。改为运行时读正文全文，单一权威、改正文即改注入、副本漂移机制性消失。
// v3.0（2026-09-06）注入面定为 R0 双件（SOUL+AGENTS）：人格与行为分开权威、一起注入——
//      决策原则/身份归 SOUL，动作纪律/风格表/地图归 AGENTS，两件互斥不重复。
//      保留各文件 H1 标题作为注入文本内的文档边界。实测双件 ~3.5-4k token / 会话一次。
//
// 机制（照官方 dsh-agent-instructions）：
//     在 ctx.on('agent/pre-step') 里，构造一条 user 消息，插进 agent 的消息流，
//     这样 R0 内容进入 agent 上下文（跟官方 AGENTS 注入同构，可靠）。
//
// 与官方 agent-instructions 的关系：
//     官方已每轮注入（本会话该 preset 已置 disabled）；本插件负责注入 R0 双件。
//
// 验证标准：以"agent 在会话开始时不用翻文件就能用上人格+纪律"为准；marker 仅作启动诊断。

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 经 upstream 层**运行时**获取（原为静态具名导入 `from '@deepseek-ai/dsh-llm'`）：
// 静态具名导入是 ESM 链接期错误，官方改名/移除该导出时模块根本没求值成功 →
// 本文件 apply() 的 try/catch 一行都执行不到 → 可能拖垮整个插件树（见 upstream.js 头注）。
import { createUserMessage } from './upstream.js';
import { sessionKey, insertAfterClaimed } from './mind-insert.js';
import { isMindConnected } from './mind-connect.js';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/mind-inject). */
export const name = 'dshome-mind-inject';

/** Services this row requires before activation. */
export const inject = ['fs'];

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

/** R0 注入件 = 人格宪法 + 运行宪法（mind\L0\SOUL.md + AGENTS.md；正文即注入源，无手写拷贝）。
 *  保留各自 H1 标题作文档边界；任一缺失则注另一件；全缺返回空不注入。 */
export function composeMindL0Text(root) {
  try {
    const dir = join(root, 'mind', 'L0');
    const parts = [];
    // ⚠️ **顺序是契约**（2026-09-11 加，补 openhanako 考古 ③）：SOUL（人格宪法）**先于** AGENTS（运行宪法）——
    //    v3.0 的设计是「人格与行为分开权威、一起注入」，顺序由此数组决定。
    //    该契约由 `scripts/verify-host-plugins.mjs` 的 `mind-inject` **顺序断言**锁住：
    //    **调换此数组顺序 → 该断言变红**（改前先想清"人格先于行为"是否仍成立）。
    for (const name of ['SOUL.md', 'AGENTS.md']) {
      const f = join(dir, name);
      if (!existsSync(f)) continue;
      const text = readFileSync(f, 'utf8').trim();
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

/** 诊断 marker（**追加式**，2026-09-11 改）。
 *  原为**单槽覆盖**：每次后端启动 apply() 都用 `apply: registered hook` 把它盖掉 →
 *  "某个会话真的注入过（`inject: len=… ver=…`）"这条现场证据会被下一次启动抹掉。
 *  第四轮盲评 · C2 实测正是如此（marker 里只剩 apply 行，而会话文件里的 R0 全文都在：
 *  **注入是好的，只是物证被覆盖机制毁了**；且全仓无任何脚本读它 → 连"被读"的机会都没有）。
 *  现在保留最近 20 行，"挂载"与"注入"两类事件都留痕、可回溯。 */
function writeMarker(content) {
  try {
    const root = repoRoot();
    const dir = join(root, 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'mind-inject-marker.txt');
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), content].slice(-20);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 诊断标记失败不影响插件 */ }
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    // ── 2026-09-11 修：R0 文本改为**每会话读盘**。──────────────────────────────
    // 病灶（盲评实测）：原实现把 composeMindL0Text 放在 apply() 里只算一次 → 整个 DSHOME 生命周期
    //   冻结在**启动时刻**的宪法版本。实测注入的 AGENTS 比磁盘旧一版（marker len=5089 = SOUL+旧版
    //   AGENTS；磁盘已是 3.6 应为 5397）→「改宪法 = 下次会话生效」不成立，身份与门禁都活在一份
    //   可能任意陈旧的自述里；而文档头部却写着"全文每次会话注入"。
    // 不用 mtime 缓存：R0 每会话仅一次、两件合计 ~11KB，读盘成本可忽略——简单正确优先于省一次 readFile。
    const buildPayload = (repair) => {
      const text = composeMindL0Text(root);
      if (!text) return '';
      // 补注入（压缩后回补）在块头挂 `inject#repair` 标记：会话日志里可肉眼区分「首注 / 补注」
      // （block 头前缀不变，scripts/verify-r0-after-compact.mjs 的文本判据仍命中）。
      return repair
        ? `\n【心智系统 · R0 运行宪法（SOUL + AGENTS 全文）· 补注入 inject#repair】\n${text}`
        : `\n【心智系统 · R0 运行宪法（SOUL + AGENTS 全文）】\n${text}`;
    };
    if (!composeMindL0Text(root)) {
      writeMarker(`apply: text empty (R0 files missing?) @ ${new Date().toISOString()}`);
      return;
    }
    // ── v3.2 在场判据：surface 代次键（见文件头 v3.2 说明；**不再订阅 compaction/*、不再扫
    //    decision.messages**——前者误摘失败压缩，后者是死代码）────────────────────────────
    const state = new Map(); // sessionKey -> { gen: number, ever: boolean }（ever 仅供 marker 区分首注/补注）
    let surfaceBroken = false; // 失败面只报一次（不许静默 return，也别每步刷屏）
    /** surface / eventAt 拿不到 = 复核面失效：**响亮报错**（marker + warn，各一次）。 */
    const warnSurfaceBroken = (why) => {
      if (surfaceBroken) return;
      surfaceBroken = true;
      writeMarker(`error: surface unavailable (${why}) — R0 在场复核停用 @ ${new Date().toISOString()}`);
      ctx.logger?.('dshome').warn(`dshome-mind-inject: session.surface 不可用（${why}）→ 无法复核 R0 在场，本进程内跳过注入`);
    };
    let insertFailed = false; // 落地校验失败也只报一次（同 surfaceBroken 的一次性闸）
    /** 注入没落地 = 静默失败面：报一次（marker + warn），且**不记代次**（下一步重试）。 */
    const warnInsertFailed = (why) => {
      if (insertFailed) return;
      insertFailed = true;
      writeMarker(`inject#failed: ${why} @ ${new Date().toISOString()}`);
      ctx.logger?.('dshome').warn(`dshome-mind-inject: 注入未落地（${why}）→ 不记代次，下一步重试`);
    };
    /** 取本会话的 surface 视图（`replaceGeneration` + `nodes` + `eventAt`）；任一缺失 → null。 */
    const surfaceViewOf = (agent) => {
      const session = agent?.session;
      const surface = session?.surface;
      if (!surface || typeof surface.replaceGeneration !== 'number') return null;
      if (!Array.isArray(surface.nodes) || typeof session.eventAt !== 'function') return null;
      return { session, surface };
    };
    /** 本插件注入的 R0 是否仍在 surface 上（压缩 replace 会把它换出去）。判据照官方
     *  dsh-agent-instructions：扫 surface.nodes + eventAt(seq)，钉 source（kind/plugin/form），不看文本。 */
    const isR0OnSurface = ({ session, surface }) => {
      for (const seq of surface.nodes) {
        const e = session.eventAt(seq);
        if (e && e.type === 'user/message' && e.data?.source?.plugin === name && e.data?.source?.form === 'instructions') return true;
      }
      return false;
    };

    writeMarker(`apply: registered hook (read-per-session) @ ${new Date().toISOString()}`);
    // 上游 createUserMessage 缺失（官方改名/移除）→ R0 注入停用，但 apply 仍判成功、
    // 宿主不受影响。marker 留痕便于诊断；运行期只看 hook 内的判空，不重复写标记。
    if (!createUserMessage) {
      writeMarker(`apply: degraded — createUserMessage unavailable, R0 injection disabled @ ${new Date().toISOString()}`);
    }

    // 会话销毁 → 清状态（避免内存随会话数长存；与姊妹插件 mind-compaction-log:182 / session-budget:401 同款）。
    ctx.on('session/disposed', (session) => {
      const id = session?.id ?? session?.header?.id;
      if (id) state.delete('session:' + String(id));
    });

    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      try {
        // 判定顺序（v3.2，按成本从低到高）：kind → key → 代次快速路径（O(1)、零扫描）→ 开关 → surface 复核。
        if (decision?.kind !== 'enter') return decision;
        const key = sessionKey(agent);
        if (!key) return decision;
        const view = surfaceViewOf(agent);
        if (!view) { warnSurfaceBroken('agent.session.surface/eventAt 缺失'); return decision; }
        const gen = view.surface.replaceGeneration;
        const rec = state.get(key);
        // 同代次 ⇒ surface 未换代 ⇒ 注入还在场（普通 append 不动 replaceGeneration）⇒ 直接返回。
        if (rec && rec.gen === gen) return decision;
        // 「接入心智」开关：该会话被关闭时跳过 R0 宪法注入。
        // 注意：此时【不进 state】——若中途被切回「开」，下一回合会重新复核并补注入。
        if (!isMindConnected(agent?.session?.header?.id)) {
          return decision;
        }
        // 换代次（压缩收缩过）⇒ 按 surface 复核：还在场就只补记代次，不在就补注入。
        if (isR0OnSurface(view)) {
          state.set(key, { gen, ever: rec?.ever === true });
          return decision;
        }
        // v3.1 删掉旧的 `step === 1` 限制后保留：压缩发生在**回合中途**，补注入必须能在任意步发生
        // （旧限制叠加一次性 Set = 压缩吃掉后永不回补，实测 session-72e393d3 跑 1300+ 事件零补注）。
        const repair = rec?.ever === true;
        const payload = buildPayload(repair); // ← 现场读盘：宪法改动**下次注入即生效**
        if (!payload) return decision;
        if (!createUserMessage) return decision; // 上游导出缺失 → 静默跳过（apply 期已留痕）
        const l0Message = createUserMessage({
          content: [{ type: 'text', text: payload }],
          // 2026-09-11 修（会话格式 v1 合规）：原写法 `kind:'agent-instructions'` 携带了该 kind
          // **不存在的** `plugin` 成员，且缺 required 的 `changes` → 新版
          // @deepseek-ai/dsh-session-format-v0-to-v1 迁移器逐成员校验直接拒收，
          // 导致 46 个历史会话在新版 dsh 下全部「历史加载失败」。改用 plugin source
          // 合法形态（required: kind+plugin；form 白名单含 instructions）。语义不变：
          // source 仅作事件溯源标签，不参与任何逻辑。
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        });
        const entered = insertAfterClaimed(decision, messages, l0Message);
        // ── v3.2 落地校验：**先验落地，再记账** ──────────────────────────────────────
        // `insertAfterClaimed`（mind-insert.js:23）在 `decision.messages` 非数组时**静默原样返回**：
        // 那时若还写 `inject:` 行 + `state.set(key,{gen})`，就等于「没落地却记了代次」⇒ 该代次内
        // 快速路径恒命中、**永不再试**（要等下次换代次才自愈）——真实的静默失败面。
        if (!Array.isArray(entered?.messages) || !entered.messages.includes(l0Message)) {
          warnInsertFailed('insertAfterClaimed 未把 R0 插进 decision.messages（messages 非数组？）');
          return entered; // 不写 state ⇒ 下一步同代次仍会重试（自愈）
        }
        // marker 记录**实际注入**的长度与两件版本号（SOUL/AGENTS）——让"这次注入的是哪一版"
        // 在磁盘上可验证（旧 marker 只记 apply 时刻的长度，无法回答"注入了什么"）。
        // ⚠️ v3.2：本行必须在 `insertAfterClaimed` **之后**且**落地校验通过之后**——否则给一次
        //    没发生的注入留证（`ever` 也只在此处置真，marker 才不会撒谎）。
        const vers = [...payload.matchAll(/_版本：([\d.]+)/g)].map((m) => m[1]).join('/');
        writeMarker(`inject${repair ? '#repair' : ''}: len=${payload.length} ver=${vers} @ ${new Date().toISOString()}`);
        state.set(key, { gen, ever: true });
        return entered;
      } catch (error) {
        // 注入失败只记日志，绝不阻断。
        ctx.logger?.('dshome').warn('dshome-mind-inject: 注入失败 %O', error);
      }
      return decision;
    });
    // 2026-09-11 修（回归审计 blocker）：此处原为 `…已挂载 (len=%d)', payload.length`——改用
    // 「每会话读盘」后 payload 已移入 buildPayload()/hook 的局部作用域 → 本行抛
    // `ReferenceError: payload is not defined`，被外层 catch 吞成「初始化失败」warn。
    // hook 在其前已注册（所以 R0 注入本身仍可用、marker 也是新格式），但 apply 永远走不到成功分支、
    // cordis 的 host-apply 状态不正常。**教训：`node --check` 只查语法，查不出未定义标识符——
    // 改 host 插件后必须真加载并调用一次 apply() 验证挂载成功，不能只看"效果上还能跑"。**
    ctx.logger?.('dshome').info('dshome-mind-inject: R0 双件注入钩子已挂载（每会话读盘，构建发生在首次注入时）');
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-inject: 初始化失败 %O', error);
  }
}
