// dshome-mind-recall — 上工自动召回 host 插件（每会话首步机械注入 mind-prime 产物）。
//
// 职责：每次主会话【第一步】时，机器自动跑 scripts/mind-prime.mjs 并把产物
//      （project 进度/待办 + L3 相关记忆 + Learn 教训 + user-rules）作为一条 user 消息
//      塞进会话开头——不靠 agent 记得跑（AGENTS「不靠下次记住」铁律的机器实现）。
//
// 机制：与 dshome-mind-inject 同构（ctx.on('agent/pre-step') + 每会话一次 + user 消息通道），
//     但注入的是「动态召回产物」而非「静态纪律摘要」。设计取舍：
//   - 用公司骨架：独立 host 插件 / fails-open / 可独立启停 / 与注入器解耦
//   - 留凌晨灵魂：delegationDepth 跳子代理、cron 前置召回跳过、空机优雅降级、claimed 后插入
//   - token 可控：只注一次、空机不注（mind-prime 空输出无 ■ 分节 → 跳过）
//
// 与 dshome-mind-inject 的关系：
//   inject 管「L0 纪律摘要」（每会话都该遵守的核心纪律，静态）；
//   recall 管「上工记忆召回」（当前项目/任务的进度+相关记忆，动态）。
//   两者互补：纪律常驻、记忆按需——本插件只做召回，纪律归注入器。
//
// 验证：marker 仅启动诊断；集成测试 scripts/mind-boot-recall-itest.mjs 与
//      scripts/verify-boot-recall.mjs 对本插件做行为验收（改测本插件后重启 DSHOME 再跑）。

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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

/** 每会话只注入一次的守卫 key（与 mind-inject 同款，session 弃后新会话重新注入）。 */
function sessionKey(agent) {
  const id = agent?.session?.header?.id;
  return id ? `session:${String(id)}` : null;
}

/** 消息文本抽取（content 可能是 string 或 blocks）。 */
function contentText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  return '';
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
    const injectedSessions = new Set();
    writeMarker(`apply: registered hook @ ${new Date().toISOString()}`);

    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      try {
        const key = sessionKey(agent);
        const isFirstStep = step === 1 && decision?.kind === 'enter';
        if (!key || injectedSessions.has(key) || !isFirstStep) return decision;
        injectedSessions.add(key);

        // 只注入顶层会话（delegationDepth=0）：子代理父上下文已带召回，避免重复 exec/噪音。
        const depth = agent?.session?.header?.delegationDepth;
        if (typeof depth === 'number' && depth > 0) return decision;

        // cron 等已在 prompt 前置【上工自动召回】→ 跳过，避免双份。
        const joined = [...(messages || []), ...(decision.messages || [])].map(contentText).join('\n');
        if (joined.includes('【上工自动召回')) return decision;

        // 跑 mind-prime（15s 超时；失败静默跳过——fails-open，绝不阻塞会话）。
        let primeText = '';
        try {
          primeText = execFileSync(process.execPath, [primeScript], { cwd: root, encoding: 'utf8', timeout: 15000 }).toString().trim();
        } catch (e) {
          ctx.logger?.('dshome')?.warn?.('dshome-mind-recall: mind-prime failed, skip inject', e?.message ?? e);
          return decision;
        }
        // 空机降级：无 ■ 分节（无 project 进度/待办/L3/Learn/user-rules）→ 不注入空壳。
        if (!primeText.includes('■')) return decision;

        const payload = `\n【上工自动召回 · 会话记忆】\n${primeText}`;
        const recallMessage = createUserMessage({
          content: [{ type: 'text', text: payload }],
          source: { kind: 'plugin', plugin: name, form: 'recall' },
        });
        // 插到 claimed 用户消息之后（指令类上下文不被稀释），无 claimed 则放最前。
        const claimedSet = new Set(messages || []);
        const lastClaimed = (decision.messages || []).findLastIndex((m) => claimedSet.has(m));
        if (lastClaimed >= 0) {
          return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, recallMessage) };
        }
        return { ...decision, messages: [recallMessage, ...(decision.messages || [])] };
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
