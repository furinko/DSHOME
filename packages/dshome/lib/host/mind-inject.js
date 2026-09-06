// dshome-mind-inject — 心智 L0 注入 host 插件（v2.5：正文全文注入）。
//
// 职责：每个 agent 会话【开始（第一步）】时，往消息流塞一条「心智 L0 注入层」user 消息，
//      注入源 = mind\L0\AGENTS.md **全文**（运行时 readFile——正文即注入源）。
//      仅注入一次（按 session 去重），不是每轮。
//
// v2.5（2026-09-06）取消手写 L0_SUMMARY 摘要：
//      摘要副本制造「权威倒挂」——生效的是摘要、权威正文没人读、改正文不生效、
//      mind-validate 也拦不住（⑥d 只是启发式 warn）。改为运行时读正文全文：
//      单一权威、改正文即改注入、副本漂移机制性消失。实测 AGENTS 全文 ~2659 token /
//      会话一次（相对 128k 窗口可接受；执行密度由 AGENTS「全文常驻约束」写作纪律保证）。
//
// 机制（照官方 dsh-agent-instructions）：
//     在 ctx.on('agent/pre-step') 里，构造一条 user 消息，插进 agent 的消息流，
//     这样 L0 内容进入 agent 上下文（跟官方 AGENTS 注入同构，可靠）。
//
// 与官方 agent-instructions 的关系：
//     官方已每轮注入（本会话该 preset 已置 disabled）；本插件负责注入 AGENTS 全文。
//
// 验证标准：以"agent 在会话开始时不用翻文件就能用上 L0 核心纪律"为准；marker 仅作启动诊断。

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

/** 注入源 = L0 宪法权威正文全文（mind\L0\AGENTS.md，唯一权威 = 唯一注入源；读不到则空，不注入）。
 *  注入时剥掉文件首行 H1 标题（# AGENTS.md —…）：包装头「【心智系统 · L0 注入层】」已标识来源，避免双标题叠放；
 *  打包快照 payload 仍是含标题全文（validate (c) 按文件全文比对，不受注入剥行影响）。 */
export function composeMindL0Text(root) {
  try {
    const f = join(root, 'mind', 'L0', 'AGENTS.md');
    if (!existsSync(f)) return '';
    const lines = readFileSync(f, 'utf8').split('\n');
    if (lines.length && /^#\s/.test(lines[0])) lines.shift(); // 剥 H1（# AGENTS.md —…）
    return lines.join('\n').replace(/^\n+/, ''); // 去剥行后前导空行，注入从正文起
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
      writeMarker(`apply: text empty (AGENTS.md missing?) @ ${new Date().toISOString()}`);
      return;
    }
    // 每会话只注入一次（首次 agent/pre-step 触发）。
    const injectedSessions = new Set();
    const payload = `\n【心智系统 · L0 注入层】\n${text}`;
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
    ctx.logger?.('dshome').info('dshome-mind-inject: 全文注入钩子已挂载 (len=%d)', payload.length);
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-inject: 初始化失败 %O', error);
  }
}
