// mind-l0-injector-itest.mjs — L0 宪法注入器集成测试（固化版）
// 验证：dshome-mind 的 L0 子插件（inject:['systemPrompt']）在 systemPrompt 服务 ready 后
//       注册 SOUL/USER/TOOL 三个 prompt section，且 text() 动态读到 L0 文件全文。
// 用法：node scripts/mind-l0-injector-itest.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Context, Service } = require('E:/DSHOME/profiles/node_modules/@deepseek-ai/cordis/lib/index.js');
const mindMod = require('E:/DSHOME/packages/dshome-mind/lib/index.cjs');

const registered = [];
class FakeSystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt'); }
  section(s) { registered.push({ name: s.name, order: s.order, text: s.text }); return () => {}; }
}
const ctx = new Context();
ctx.plugin(FakeSystemPrompt); // 先注册 service（cordis 保证 inject 子插件在其后 apply）
try { mindMod.apply(ctx); } catch (e) { console.log('[itest] apply throw:', e.message); }
await new Promise((r) => setTimeout(r, 50));

console.log('[itest] L0 sections:', registered.map((s) => s.name).join(', ') || '(无)');
for (const s of registered) {
  const text = typeof s.text === 'function' ? s.text() : s.text;
  const mark = s.name.includes('soul') ? '鱼鱼' : s.name.includes('user') ? '主人' : 'TOOL';
  console.log(`  [order ${s.order}] ${s.name}: 含「${mark}」=${(text || '').includes(mark)} (${(text || '').length}c)`);
}
const soul = registered.some((s) => s.name === 'dshome:l0-soul' && (s.text() || '').includes('鱼鱼'));
const user = registered.some((s) => s.name === 'dshome:l0-user' && (s.text() || '').includes('主人'));
const tool = registered.some((s) => s.name === 'dshome:l0-tool' && (s.text() || '').includes('TOOL'));
console.log(soul && user && tool ? '✅ L0 注入器：3 sections 经 cordis inject 注册 + 文本可读' : '❌ 注入器未完全工作');
process.exit(soul && user && tool ? 0 : 1);
