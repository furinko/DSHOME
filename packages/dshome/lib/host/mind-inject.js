// dshome-mind-inject — 心智 L0 注入 host 插件（折中版：每会话开始注入一次）。
//
// 职责：每个 agent 会话【开始（第一步）】时，往消息流塞一条「心智 L0 摘要」user 消息，
//      让鱼鱼在会话开端就带着 L0（AGENTS/SOUL/TOOL/HUB/Wisdom 关键决策规则摘要）。
//      仅注入一次（按 session 去重），不是每轮，从而把成本从"每轮 600-700 token"
//      降到"每会话约 600-700 token"。
//
// 机制（照官方 dsh-agent-instructions）：
//     在 ctx.on('agent/pre-step') 里，构造一条 user 消息，插进 agent 的消息流，
//     这样 L0 内容进入 agent 上下文（跟官方 AGENTS 注入同构，可靠）。
//
// 与官方 agent-instructions 的关系：
//     官方已每轮注入根 AGENTS.md；本插件只补 L0 其余部分（SOUL/TOOL/HUB/Wisdom），
//     不重复 AGENTS（AGENTS 保持官方式）。真正的 AGENTS 内容后续第 2 步迁到 mind/L0/AGENTS.md。
//
// 验证标准：以"agent 在会话开始时不用翻文件就能用上 L0"为准；marker 仅作启动诊断。

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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

/** 第 2 步：L0/AGENTS.md 已变真，切为读 L0 版（根版待删，交接期）。 */
const USE_L0_AGENTS = true;

// ── L0/L1 注入层：文件 + 关键决策规则关键词（复用 scripts/mind-prime.mjs）──
const INJECT_LAYER = [
  ['mind/L0/SOUL.md', 'SOUL 人格·决策规则',
    ['诚实优先', '本地验证', '最低消耗', '语境适配', '记忆习惯'], 5],
  ['mind/L0/TOOL.md', 'TOOL 工具纪律',
    ['先搜后写', '省 token', 'write 前先 read', 'edit 用唯一锚点', '改动前一句话说明', '隐私', '等放行', '收工提醒'], 6],
  ['mind/L1/HUB.md', 'HUB 加载模型·跨层红线',
    ['注入层', '强制层', '查询层', '跨层红线'], 4],
  ['mind/L1/Wisdom.md', 'Wisdom 思维·元认知',
    ['深度思考', '执行', '汇报', '闲聊', '诚实优先', '先搜后写', '本地验证', '最低消耗', '拆解问题'], 6],
];

function cleanRule(line) {
  return String(line)
    .replace(/^\s*(?:-|\*|\d+\.)\s*/, '')
    .replace(/[*#|`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function extractRules(text, keys, cap) {
  const lines = String(text).split('\n');
  const seen = new Set();
  const keep = [];
  for (const l of lines) {
    if (/^\s*(?:版本|加载|定位|作用|说明|author|license|metadata|description|version|tags|related|>)/i.test(l)) continue;
    if (l.includes('|')) continue;
    for (const k of keys) {
      if (l.includes(k)) {
        const r = cleanRule(l);
        if (r && !seen.has(r)) { seen.add(r); keep.push(r); }
        break;
      }
    }
    if (keep.length >= cap) break;
  }
  return keep;
}

/** 装配 L0 注入正文（AGENTS 读根版还是 L0 版由 USE_L0_AGENTS 决定）。 */
export function composeMindL0Text(root, useL0Agents) {
  const out = [];
  for (const [rel, title, keys, cap] of INJECT_LAYER) {
    // rel 形如 'mind/L0/SOUL.md'；root 是仓库根，路径需含 mind/ 前缀（勿去掉）。
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    const rules = extractRules(readFileSync(full, 'utf8'), keys, cap);
    if (rules.length) out.push(`\n--- ${title} ---\n${rules.join('；')}`);
  }
  const agentsPath = useL0Agents ? join(root, 'mind/L0/AGENTS.md') : join(root, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const text = readFileSync(agentsPath, 'utf8');
    out.push(`\n--- AGENTS 运行纪律 ---\n${text.trim()}`);
  }
  if (!out.length) return '';
  return out.join('\n');
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
