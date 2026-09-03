// 临时集成测试：真实 cordis ctx 加载 dshome-mind 插件，验证组件B pre-step hook
// 用法：node scripts/_tmp-boot-recall-itest.mjs（跑完即删，不入库）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Context } = require('E:/DSHOME/profiles/node_modules/@deepseek-ai/cordis/lib/index.js');
const mindMod = require('E:/DSHOME/packages/dshome-mind/lib/index.cjs');

// 构造顶层 agent 伪对象（delegationDepth=0），模拟官方 agentEvents 注入的 agent 载荷
function fakeAgent(id, depth = 0) {
  return { id, session: { id: 'session-' + id, header: { delegationDepth: depth } } };
}
function contentTextOf(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  return '';
}
async function dispatchPreStep(ctx, agent, claimed = []) {
  // 模拟 agent-loop preStep：dispatch.waterfall('agent/pre-step', payload, default)
  const carrier = {}; // 无 scope filter → root hook 全收
  const payload = { agent, messages: claimed, step: 1, signal: { aborted: false, throwIfAborted() {} } };
  const ctxWaterfall = ctx.waterfall.bind(ctx);
  return ctxWaterfall(carrier, 'agent/pre-step', payload, () => Promise.resolve({ kind: 'enter', messages: [...claimed] }));
}

const ctx = new Context();
// 直接同步 apply（routesPlugin 依赖 webServer 会因缺服务被 cordis 懒挂/跳过，boot hook 同步注册）
try {
  mindMod.apply(ctx);
  console.log('[itest] 直接 apply 成功');
} catch (e) {
  console.log('[itest] apply 失败:', e.message);
  process.exit(1);
}
// 等一帧确保内部 effect 完成注册
await new Promise((r) => setTimeout(r, 50));

const results = [];
// 场景1：顶层 agent、无 claimed → 应注入 prime（本机有 Learn 正文）
const agentTop = fakeAgent('top-1', 0);
const d1 = await dispatchPreStep(ctx, agentTop, []);
const injectedMsg = (d1.messages || []).find((m) => /【上工自动召回/.test(contentTextOf(m)));
results.push(['顶层注入', injectedMsg ? '✅ 注入成功' : '❌ 未注入', (d1.messages || []).length]);

// 场景2：同 agent 二次 pre-step → 幂等不重复（d2 不应再含 prime；claimed 空 → 0 条）
const d2 = await dispatchPreStep(ctx, agentTop, []);
const d2HasPrime = (d2.messages || []).some((m) => /【上工自动召回/.test(contentTextOf(m)));
results.push(['幂等(同agent二次)', d2HasPrime ? '❌ 重复注入' : '✅ 无重复（' + d2.messages.length + ' 条）']);

// 场景3：子代理 depth>0 → 跳过
const child = fakeAgent('child-1', 2);
const d3 = await dispatchPreStep(ctx, child, [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '子任务' }] }]);
results.push(['子代理跳过', (d3.messages || []).filter((m) => /【上工自动召回/.test(contentTextOf(m))).length === 0 ? '✅ 未注入' : '❌ 误注入']);

// 场景4：已含召回块（如 cron 前置）→ skip 防双份
const cronAgent = fakeAgent('cron-1', 0);
const d4 = await dispatchPreStep(ctx, cronAgent, [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '【上工自动召回 · cron】...任务' }] }]);
results.push(['cron防双份', (d4.messages || []).filter((m) => /【上工自动召回/.test(contentTextOf(m))).length === 1 ? '✅ 仅原有1份' : '❌ 出现多份']);

// 场景5：注入位置 —— prime 应紧跟 claimed 之后
const posAgent = fakeAgent('pos-1', 0);
const claimedMsg = { id: 'c1', role: 'user', content: [{ type: 'text', text: '用户首问' }] };
const d5 = await dispatchPreStep(ctx, posAgent, [claimedMsg]);
const texts = (d5.messages || []).map((m) => contentTextOf(m));
const primeIdx = texts.findIndex((t) => t.includes('【上工自动召回'));
results.push(['注入位置', primeIdx === 1 ? '✅ claimed后第2位' : '❌ 位置=' + primeIdx]);

for (const [name, verdict, extra] of results) console.log(`[itest] ${name}: ${verdict}${extra !== undefined ? ' (' + extra + ')' : ''}`);
process.exit(0);
