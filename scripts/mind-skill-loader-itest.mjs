// 集成测试：真实 cordis ctx 加载 dshome-mind-skill-loader host 插件，验证 pre-step 触发注入
// 用法：node scripts/mind-skill-loader-itest.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Context } = require('E:/DSHOME/profiles/node_modules/@deepseek-ai/cordis/lib/index.js');
const mod = await import('file:///E:/DSHOME/packages/dshome/lib/host/mind-skill-loader.js');

function fakeAgent(id) {
  return { id, session: { id: 'session-' + id, header: { id: 'session-' + id, delegationDepth: 0 } } };
}
function contentTextOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  return '';
}
async function dispatchPreStep(ctx, agent, userMsgs) {
  const payload = { agent, messages: userMsgs, step: 1, signal: { aborted: false, throwIfAborted() {} } };
  return ctx.waterfall({}, 'agent/pre-step', payload, () => Promise.resolve({ kind: 'enter', messages: [...userMsgs] }));
}

const ctx = new Context();
try {
  mod.apply(ctx);
  console.log('[itest] apply 成功');
} catch (e) { console.log('[itest] apply 失败:', e.message); process.exit(1); }
await new Promise((r) => setTimeout(r, 50));

const results = [];
// 场景1：消息含 "后端崩了 exit1" → 应命中 dshome-diagnostics
const a1 = fakeAgent('t1');
const d1 = await dispatchPreStep(ctx, a1, [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '后端崩了 exit1 频繁重启，怎么办' }] }]);
const texts1 = (d1.messages || []).map((m) => contentTextOf(m));
const hit1 = texts1.find((t) => t.includes('dshome-diagnostics'));
results.push(['触发注入(diagnostics)', hit1 ? '✅ 命中' : '❌ 未命中', hit1 ? hit1.split('\n')[1] : '']);

// 场景2：同 agent 二次含同触发词 → 不重复注入
const d2 = await dispatchPreStep(ctx, a1, [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '后端又 exit1 了' }] }]);
const hit2 = (d2.messages || []).some((m) => contentTextOf(m).includes('dshome-diagnostics'));
results.push(['防重复(同session)', hit2 ? '❌ 重复' : '✅ 未重复注入']);

// 场景3：消息含 "做个插件 cordis" → 应命中 dshome-plugin-dev
const a3 = fakeAgent('t3');
const d3 = await dispatchPreStep(ctx, a3, [{ id: 'm3', role: 'user', content: [{ type: 'text', text: '我要做个 cordis 插件，slot 注册失败' }] }]);
const hit3 = (d3.messages || []).some((m) => contentTextOf(m).includes('dshome-plugin-dev'));
results.push(['触发注入(plugin-dev)', hit3 ? '✅ 命中' : '❌ 未命中']);

// 场景4：普通消息无触发词 → 不注入
const a4 = fakeAgent('t4');
const d4 = await dispatchPreStep(ctx, a4, [{ id: 'm4', role: 'user', content: [{ type: 'text', text: '今天天气不错，帮我写首诗' }] }]);
const extra4 = (d4.messages || []).length;
results.push(['无触发不注入', extra4 === 1 ? '✅ 无多余注入' : '❌ 多出 ' + extra4 + ' 条']);

for (const [n, v, extra] of results) console.log(`[itest] ${n}: ${v}${extra ? ' (' + extra + ')' : ''}`);
process.exit(0);
