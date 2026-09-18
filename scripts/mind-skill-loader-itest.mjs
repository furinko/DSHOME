// 集成测试：真实 cordis ctx 加载 dshome-mind-skill-loader host 插件，验证 pre-step 触发注入
// 用法：node scripts/mind-skill-loader-itest.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
// 2026-09-11 修（第四轮盲评 · C1）：去硬编码 `E:/DSHOME`（**正斜杠 + file:/// URL 两种写法都硬编码**，
// 且已入 git 会被推送）—— 换盘符/换布局即 MODULE_NOT_FOUND。改成 DSH_HOME 优先、否则上溯仓库根。
const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const { Context } = require(join(repoRoot, 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'));
const mod = await import(pathToFileURL(join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'mind-skill-loader.js')).href);

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

// 场景5：私有区 skill 触发 —— **自带夹具**（2026-09-18 修）。
// 原实现依赖"真私有区里恰好有一个 `whaletest-private`"，缺了就打印「⏳ 跳过」**仍计通过** ⇒
// **恒绿空转**（与 `verify-integrity`「输入缺失即响亮失败」正相反）。现改为：临时在私有 Skill 区落一份
// 夹具（唯一名，跑完即删）⇒ 这一格**永远真跑**；顺带实证「加载器按目录指纹懒扫 ⇒ 运行中新增 skill 即时生效」。
const FIXTURE = join(repoRoot, 'mind-private', 'L2', 'Skill', 'zz-itest-whaletest-private.md');
const fixtureBody = [
  '---',
  'name: whaletest-private',
  'description: （集成测试夹具，跑完即删）私有区 skill 触发探针。触发：鲸鱼私有测试流程。',
  'version: 0.0.1',
  'author: itest',
  'license: internal',
  'contract:',
  '  id: whaletest-private',
  '  triggers: [鲸鱼私有测试流程]',
  '---',
  '',
  '# whaletest-private — itest 夹具',
  '',
  '## 一、使用流程',
  '1. 本文件由 `scripts/mind-skill-loader-itest.mjs` 临时创建，验证**私有区 skill 能否被触发注入**；跑完即删。',
  '',
  '## 二、核心规则',
  '- 只存在于 `mind-private/`（gitignore），不得提交。',
  '',
  '## 三、行为准则',
  '- 无（夹具）。',
  '',
  '## 四、踩坑记录',
  '- 无（夹具）。',
  '',
  '## 五、关联索引',
  '- `mind/L2/Skill/verify-integrity.md`（"输入缺失即响亮失败"——本场景原实现正违反它）。',
  '',
].join('\n');
try {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, fixtureBody, 'utf8');
  const a5 = fakeAgent('t5');
  const d5 = await dispatchPreStep(ctx, a5, [{ id: 'm5', role: 'user', content: [{ type: 'text', text: '帮我跑一下鲸鱼私有测试流程' }] }]);
  const t5 = (d5.messages || []).map((m) => contentTextOf(m)).find((t) => t.includes('whaletest-private'));
  const privatePath = Boolean(t5) && String(t5).includes('mind-private');
  results.push(['私有skill触发（自带夹具·运行中新增免重启）', t5 && privatePath ? '✅ 命中且卡片指私有路径' : `❌ 未命中或路径异常（hit=${Boolean(t5)} privatePath=${privatePath}）`]);
} catch (e) {
  results.push(['私有skill触发（自带夹具）', `❌ 夹具写入/执行失败：${(e && e.message) || e}`]);
} finally {
  try { rmSync(FIXTURE, { force: true }); } catch { /* 清理失败不掩盖主结论 */ }
}

// 判据收口（2026-09-18 修）：**任一 ❌ 或 ⏳ 都算失败**。原实现末尾写死 `process.exit(0)`
// ⇒ 就算五个场景全红也退 0，挂到任何门禁上都是空转（与 `verify-guard-decisions` 09-17 那次同型）。
const failed = results.filter(([, v]) => String(v).includes('❌') || String(v).includes('⏳')).length;
for (const [n, v, extra] of results) console.log(`[itest] ${n}: ${v}${extra ? ' (' + extra + ')' : ''}`);
console.log(`[itest] ${results.length - failed}/${results.length} 通过${failed ? '（有 ❌/⏳ ⇒ exit 1；跳过不算通过）' : ''}`);
process.exit(failed ? 1 : 0);
