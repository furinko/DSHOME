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

/** 诊断 marker（仅启动确认，不以它作为"注入成功"的标准）。 */
function writeMarker(content) {
  try {
    const root = repoRoot();
    const dir = join(root, 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mind-inject-marker.txt'), content, 'utf8');
  } catch (e) { /* 诊断标记失败不影响插件 */ }
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    const text = composeMindL0Text(root);
    if (!text) {
      writeMarker(`apply: text empty (R0 files missing?) @ ${new Date().toISOString()}`);
      return;
    }
    // 每会话只注入一次（首次 agent/pre-step 触发）。
    const injectedSessions = new Set();
    const payload = `\n【心智系统 · R0 运行宪法（SOUL + AGENTS 全文）】\n${text}`;
    writeMarker(`apply: registered hook (len=${payload.length}) @ ${new Date().toISOString()}`);

    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      try {
        const key = sessionKey(agent);
        const isFirstStep = step === 1 && decision?.kind === 'enter';
        if (key && !injectedSessions.has(key) && isFirstStep) {
          injectedSessions.add(key);
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
    ctx.logger?.('dshome').info('dshome-mind-inject: R0 双件注入钩子已挂载 (len=%d)', payload.length);
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-inject: 初始化失败 %O', error);
  }
}
