// dshome/upstream — 上游（@deepseek-ai/*）导出的「运行时可选获取」层。
//
// ── 为什么需要它（2026-09-11 升级抗崩审计）────────────────────────────────────
// 顶层具名导入是 ESM 的**链接期（link-time）**错误：
//     import { createUserMessage } from '@deepseek-ai/dsh-llm';
// 一旦官方新版把这个导出改名或移除，模块在**任何代码求值之前**就抛错——
// 插件里 apply() 外层那圈 try/catch **一行都执行不到**（模块根本没加载成功）。
//
// 叠加 DSH 插件树 fail-fast 的既有事实：
//   · 第三方 dsh-better-sidebar 的 cordis.patch.yml 注释原文：两个挂载点重复注册会
//     "fail the whole plugin tree at boot"（整个插件树在启动时失败）；
//   · ISSUE-002 先例：agent-teams 0.1.15 因 uiConversation 服务缺失 → 界面拒载。
// ⇒ **一个具名导出消失 = 三个核心心智插件加载失败 = 界面起不来 = 智能体不存在。**
//
// 本层把「静态具名导入」换成「动态 import + 兜住」：拿不到就返回 null，
// 由调用方降级并留下可见标记，**绝不把异常抛回模块加载期**。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   import { createUserMessage } from './upstream.js';
//   ...
//   if (!createUserMessage) return;   // 拿不到就跳过该次动作，不要抛
//
// 注意：本模块顶层使用 `await`（TLA）。ESM 会等它 settle 之后才求值调用方模块，
// 所以静态导入到这里拿到的**一定是已解析的终值**（null 或函数），不存在竞态。
//
// ── 边界（诚实标注）────────────────────────────────────────────────────────
// 本层**只治"导出消失/改名"这一类**。它治不了：官方把服务名、槽位名、hook 签名改掉
// ——那些是运行时行为契约，需要各插件自行探测（契约自检见 `scripts/verify-upstream-contract.mjs`，
//   2026-09-11 已实现；hook 签名的真跑断言归 `scripts/verify-host-plugins.mjs`）。

const failures = [];

/** 动态取一个上游**函数型**导出；导入失败或类型不符 → null（并记账）。 */
async function optionalFn(spec, exportName) {
  try {
    const mod = await import(spec);
    const value = mod?.[exportName];
    if (typeof value === 'function') return value;
    failures.push(`${spec}#${exportName} 不是函数（得到 ${typeof value}）`);
    return null;
  } catch (error) {
    failures.push(`${spec} 导入失败：${error?.message ?? error}`);
    return null;
  }
}

/** 动态取一个上游**默认导出**（如 schemastery 的 `z`）；导入失败或缺失 → null（并记账）。 */
async function optionalDefault(spec) {
  try {
    const mod = await import(spec);
    const value = mod?.default;
    if (value) return value;
    failures.push(`${spec} 无 default 导出`);
    return null;
  } catch (error) {
    failures.push(`${spec} 导入失败：${error?.message ?? error}`);
    return null;
  }
}

/** 构造一条 user 消息（官方 dsh-llm）。用途：R0 宪法注入 / 上工召回 / Skill 卡注入。 */
export const createUserMessage = await optionalFn('@deepseek-ai/dsh-llm', 'createUserMessage');

/** 设置命名空间标定（官方 dsh-settings）。用途：notify / plugin-manager 的宿主↔客户端总线。 */
export const settingsNamespace = await optionalFn('@deepseek-ai/dsh-settings', 'settingsNamespace');

/** 设置 schema 构造器（官方 schemastery，惯用名 `z`）。用途：notify / plugin-manager 的设置面。
 *  ⚠️ 消费者**必须用三元短路**判空：`z.object({ entries: z.any() })` 里的 `z.any()` 在实参求值期
 *  就先跑了，写成 `z ? z.object({...}) : null` 才拦得住；只在函数体里判空是拦不住的。 */
export const schemastery = await optionalDefault('@deepseek-ai/schemastery');

/** 上游导出缺失清单（空数组 = 全部就位）。供诊断与面板显示。 */
export const upstreamFailures = failures;

/** 一句话摘要，便于写 marker / 打日志。 */
export function upstreamSummary() {
  return failures.length === 0 ? 'upstream ok' : `upstream degraded: ${failures.join('; ')}`;
}
