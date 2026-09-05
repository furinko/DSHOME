// dshome-mind-inject — 心智 L0 注入 host 插件（折中版：每会话开始注入一次）。
//
// 职责：每个 agent 会话【开始（第一步）】时，往消息流塞一条「心智 L0 摘要」user 消息，
//      让鱼鱼在会话开端就带着 L0 核心纪律摘要。
//      仅注入一次（按 session 去重），不是每轮；载荷为手写 L0_SUMMARY（形态A），
//      实测 ~388 token（旧版全文塞 AGENTS 约 2659 token）。
//
// 机制（照官方 dsh-agent-instructions）：
//     在 ctx.on('agent/pre-step') 里，构造一条 user 消息，插进 agent 的消息流，
//     这样 L0 内容进入 agent 上下文（跟官方 AGENTS 注入同构，可靠）。
//
// 与官方 agent-instructions 的关系：
//     官方已每轮注入（本会话该 preset 已置 disabled）；本插件负责注入 L0 纪律摘要。
//     注入的是"摘要提醒"，权威正文仍在 mind\L0\AGENTS.md（唯一权威版），不在此重复。
//
// 验证标准：以"agent 在会话开始时不用翻文件就能用上 L0 核心纪律"为准；marker 仅作启动诊断。

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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

/** 第 2 步：mind\L0\AGENTS.md 为唯一权威版（根 AGENTS.md 已于 2026-09-04 退役删除），注入源固定为 L0 摘要。 */
const USE_L0_AGENTS = true;

// ── L0/L1 注入层：手写精简摘要（形态A）──
// 不再用 extractRules 关键词抽取——旧机制脆弱、随文件措辞漂移，曾实测出
// 「HUB 抽成 4 句空壳、TOOL 被 cap 截断丢等放行/收工提醒」。手写摘要稳定、token 可控。
// 只装「每次会话都该遵守」的核心纪律；其余细则按需读 AGENTS.md / Ritual.md（行为规程）/ Power.md（能力手册）。
const L0_SUMMARY = `--- 核心纪律（每次会话都该遵守，绝凭"我记得"替代）---
诚实优先：不知道就说不知道，宁可沉默不编造，绝不表演思考长度。
本地验证：技术操作猜测，先在本机验证再给结论，把验证结果作为答案的一部分。
最低消耗：一句话能说清不用两句；省 token 优先 grep/glob。
先搜后写：改任何文件前，先 grep/读相关引用与现有实现，不凭推测写码。
指令原子性：用户每条指令是原子的，完成当前步骤停下汇报，等下一跳。
等放行：方案确定 ≠ 获准实施；改文件/构建/提交等明确"动手/开工/同意"。
隐私红线：私密数据只进 mind-private，永不写出厂区、永不推送。
双区边界：mind\\=出厂固件可推送；mind-private\\=本机隐私同名私有优先。
收工/结论自检：重要结论交付前反问：哪可能错？漏了什么？更简/更稳？发现风险先指出再交付。
--- 其余细则（不常驻）---
按需读 mind\\L0\\AGENTS.md（运行纪律·层级铁律）；细则按需读 mind\\L1\\Ritual.md（行为规程·纪律）与 mind\\L1\\Power.md（能力手册）。
本段为摘要提醒；权威正文在 mind\\L0\\AGENTS.md，改动走自我修改硬流程。`;

/** 装配 L0 注入正文（形态A：返回手写摘要；AGENTS 权威正文不全文塞入，避免 ~2600 token）。 */
export function composeMindL0Text(_root, _useL0Agents) {
  return L0_SUMMARY;
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

/**
 * 每会话只注入一次的守卫 key。
 * @returns 基于 session 的稳定 key（session 已弃则后续新会话重新注入）。
 */
function sessionKey(agent) {
  const id = agent?.session?.header?.id;
  return id ? `session:${String(id)}` : null;
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    const text = composeMindL0Text(root, USE_L0_AGENTS);
    if (!text) {
      writeMarker(`apply: text empty @ ${new Date().toISOString()}`);
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
          const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m));
          if (lastClaimedIndex >= 0) {
            return {
              kind: 'enter',
              messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, l0Message),
            };
          }
        }
      } catch (error) {
        // 注入失败只记日志，绝不阻断。
        ctx.logger?.('dshome').warn('dshome-mind-inject: 注入失败 %O', error);
      }
      return decision;
    });
    ctx.logger?.('dshome').info('dshome-mind-inject: 折中注入钩子已挂载 (len=%d)', payload.length);
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-inject: 初始化失败 %O', error);
  }
}
