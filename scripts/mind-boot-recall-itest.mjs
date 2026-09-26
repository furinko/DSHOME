// 集成测试：真实 cordis ctx 加载 dshome-mind-recall host 插件，验证 pre-step hook
// （上工自动召回：顶层注入/幂等/跳子代理/cron防双份/注入位置/空机降级）
// 用法：node scripts/mind-boot-recall-itest.mjs（插件源码改动后跑，验证 host 行为）
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
// 2026-09-11 修（第四轮盲评 · C1）：原来硬编码 `E:/DSHOME/...`（**正斜杠写法**，且已入 git 会被推送）——
// 换盘符 / 换布局（安装版 payload）即 MODULE_NOT_FOUND。改成与其它脚本同款：DSH_HOME 优先，否则上溯仓库根。
const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const { Context } = require(join(repoRoot, 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'));
// 2026-09-18 修（真实缺陷：本 itest 自 2026-09-11 起**根本跑不起来**）：`packages/dshome/package.json`
//   是 `"type": "module"` ⇒ `mind-recall.js` 是 **ESM**，`require()` 它会抛
//   `ERR_REQUIRE_ASYNC_MODULE`（实测 exit 1）——而 `verify-scripts-run` 只跑**本次暂存的**脚本
//   ⇒ 依赖侧（host 插件）改动导致本 itest 失效，门禁**看不见**（盲区）。改动态 `import()` 加载。
const recallMod = await import(pathToFileURL(join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'mind-recall.js')).href);

// 构造顶层 agent 伪对象（delegationDepth=0），模拟官方 agentEvents 注入的 agent 载荷
// 2026-09-27 修（v3.2 换轴后本 itest 变 2/5 红）：桩原先**只有 `header`**，缺真 Session 恒有的两样能力——
//   真 agent 的 `session` 是 Session 实例：`get surface()` 是**无条件 getter**
//   （dsh-session/lib/index.js:993）、`eventAt(seq)` 是方法（同文件 :1096）；官方
//   `dsh-agent-instructions:1212` 也无条件访问 `agent.session.surface.nodes`。
//   而 v3.2 判据走「surface.replaceGeneration 代次快路径 + surface 在场复核」⇒ 假桩缺这两样即被判
//   "能力不可用"（按规格：报一次 + 不注入）⇒ 场景1/5 红。
//   **修桩，而不是改生产判据**：为了让一个不完整的假桩变绿去弱化生产判据，是本末倒置
//   （本仓血债同族：改坏了比较的一方，断言照样绿）。
//   空 surface（nodes: []）恰好模拟"上下文里还没有召回块"⇒ 走注入路径，与本 itest 的意图一致。
function fakeAgent(id, depth = 0) {
  const sid = 'session-' + id;
  return {
    id,
    session: {
      id: sid,
      header: { id: sid, delegationDepth: depth },
      surface: { replaceGeneration: 0, nodes: [] }, // 真 Session 的无条件 getter 投影
      eventAt: () => undefined,                     // 真 Session 方法；空 surface 下不会被命中
    },
  };
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
// 直接同步 apply（mind-recall 为纯 host 插件，boot hook 同步注册）
try {
  recallMod.apply(ctx);
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
// 2026-09-18 修（同族缺陷：**写死 `exit 0`** ⇒ 五个场景全红也退 0，任何门禁挂上去都是空转；
//   与 09-18 修好的 `mind-skill-loader-itest` 完全同型）。收口改「任一 ❌ 即失败」。
const failed = results.filter(([, v]) => String(v).startsWith('❌')).length;
console.log(`[itest] ${results.length - failed}/${results.length} 通过${failed ? ' ⇒ exit 1' : ''}`);
process.exit(failed ? 1 : 0);
