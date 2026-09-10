// dshome-mind-inject — 心智 R0 注入 host 插件（v3.0：运行宪法双件注入）。
//
// 职责：每个 agent 会话【开始（第一步）】时，往消息流塞一条「心智 R0 运行宪法」user 消息，
//      注入源 = mind\L0\SOUL.md + mind\L0\AGENTS.md **全文**（运行时 readFile 拼接——正文即注入源）。
//      R0 分层：人格宪法（SOUL：为什么/身份/决策原则/动机）+ 运行宪法（AGENTS：做什么/协议/边界/地图）。
//      仅注入一次（按 session 去重），不是每轮。
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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
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
    const buildPayload = () => {
      const text = composeMindL0Text(root);
      return text ? `\n【心智系统 · R0 运行宪法（SOUL + AGENTS 全文）】\n${text}` : '';
    };
    if (!composeMindL0Text(root)) {
      writeMarker(`apply: text empty (R0 files missing?) @ ${new Date().toISOString()}`);
      return;
    }
    // 每会话只注入一次（首次 agent/pre-step 触发）。
    const injectedSessions = new Set();
    writeMarker(`apply: registered hook (read-per-session) @ ${new Date().toISOString()}`);

    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      try {
        const key = sessionKey(agent);
        const isFirstStep = step === 1 && decision?.kind === 'enter';
        if (key && !injectedSessions.has(key) && isFirstStep) {
          // 「接入心智」开关：该会话被关闭时跳过 R0 宪法注入。
          // 注意：此时【不进】去重集 injectedSessions——若中途被切回「开」，
          // 下一回合首步会重新判断并补注入（否则会被去重永久挡住）。
          if (!isMindConnected(agent?.session?.header?.id)) {
            return decision;
          }
          const payload = buildPayload(); // ← 现场读盘：宪法改动**下次会话即生效**
          if (!payload) return decision;
          injectedSessions.add(key);
          // marker 记录**实际注入**的长度与两件版本号（SOUL/AGENTS）——让"这次注入的是哪一版"
          // 在磁盘上可验证（旧 marker 只记 apply 时刻的长度，无法回答"注入了什么"）。
          const vers = [...payload.matchAll(/_版本：([\d.]+)/g)].map((m) => m[1]).join('/');
          writeMarker(`inject: len=${payload.length} ver=${vers} @ ${new Date().toISOString()}`);
          const l0Message = createUserMessage({
            content: [{ type: 'text', text: payload }],
            source: { kind: 'agent-instructions', form: 'instructions', plugin: name },
          });
          return insertAfterClaimed(decision, messages, l0Message);
        }
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
