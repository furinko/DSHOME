// dshome-mind-guard — 心智护栏 host 插件（执行面：行为约束的真拦，不是提示）。
//
// 职责：在"鱼鱼正要 write/edit 文件"的那一刻，用官方 `ctx.tools.guard()` 在真正写入前
//       判一次，命中"护栏"就拒绝，从而把"隐私红线 / 自我修改门禁"从"靠鱼鱼想起"
//       升级成"机器拦截"。它只做拦，不做注入（注入归 dshome-mind-inject）——单一职责。
//
// 护栏（极窄内核，只这两条，其余放行——不侵入生长空间）：
//   ① 隐私红线    — 禁止写入出厂区 `mind\`（可推送固件）。私密数据只进 mind-private。
//   ② 自我修改门禁 — 改"自我类"文件（AGENTS / mind 规则 / 自身记忆）前须过 mind-validate。
//
// 设计原则（fail-open，参照 core.js / mind-inject）：
//   整个 apply 包 try/catch，任何失败只记日志、绝不 rethrow——护栏失效 ≠ host 崩溃。
//   宁可"护栏没生效"，也不因护栏 bug 带崩运行中的 GUI。可回滚：插件卸载即解绑（guard 有 disposer）。
//
// ③ 等放行：不做硬拦——程序判不了"用户意图"，硬拦易误伤（违背"别把花朵压死"）。保留提示+记录。

import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/mind-guard). */
export const name = 'dshome-mind-guard';

/** Services required before activation (tools = 工具注册表，提供 guard()；fs 供路径解析参照)。 */
export const inject = ['tools', 'fs'];

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根。 */
function repoRoot() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(join(here, '..', '..', '..', '..'));
}

/** 归一化路径为平台无关形式（统一 / 分隔符）。 */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 判断一次 write/edit 是否触碰"自我修改门禁"目标 —— 只拦"规则/宪法/门禁/技能/自我记忆"，不拦"记忆沉淀"。
 * 护栏边界（关键）：自我修改门禁拦的是【改"怎么做事"的规则】，不是【往记忆库里加一条新记忆】。
 * 所以：拦 mind\L0/L1/L2（宪法/法律/能力）与 AGENTS 等规则；但【放行】mind-private\L3、Project、
 *       私有 Learn —— 那是鱼鱼正常生长记忆的地方，拦它会压死生长（违背"生长面不能碰"）。
 * @param {string} filePath - 模型传的 file_path（相对或绝对）
 */
function isSelfFile(filePath) {
  const p = normalizePath(filePath);
  // 相对路径兜底：拼成相对仓库根看其是否落在这些目录下。
  const absoluteCandidates = [p, normalizePath(resolve(repoRoot(), p))];
  // 只含"规则/宪法/门禁"区，不含 mind-private/L3 与 Project（记忆生长区，需放行）。
  // mind-private/L1 是行为规则/教训层（如 Learn.md），属"自我修改"，该拦。
  const zones = [
    '/mind/L0/', '/mind/L1/', '/mind/L2/',
    '/mind/README.md',
    '/mind-private/L1/'
  ];
  return absoluteCandidates.some((abs) =>
    zones.some((z) => abs.includes(z))
  );
}

/**
 * 判断一次 write/edit 是否触碰"隐私红线"：写入出厂区 mind\（可推送固件，不含私有 override）。
 * 私有区 mind-private\ 是隐私（gitignore），不是"隐私红线"要拦的写入——那是该进的去处。
 */
function touchesFactoryZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = [p, normalizePath(resolve(repoRoot(), p))];
  return candidates.some((abs) =>
    /\/(mind)\/(L0|L1|L2)\//.test(abs) || /\/(mind)\/README\.md$/.test(abs)
  );
}

/** 用户可读的护栏命中说明。 */
const GUARDS = [
  {
    id: 'privacy',
    check: (filePath) => touchesFactoryZone(filePath),
    reason: (filePath) =>
      `[mind-guard] 隐私红线：写入出厂区 ${filePath} 被拦。私密数据只进 mind-private\\（gitignore），` +
      `永不写入 mind\\ 出厂区（可推送 GitHub）。若要写出厂固件模板请先在对话中说明。`
  },
  {
    id: 'self-modify',
    check: (filePath) => isSelfFile(filePath),
    reason: (filePath) =>
      `[mind-guard] 自我修改门禁：改"自我类"文件 ${filePath} 被拦。改 AGENTS / mind 规则 / 自身记忆` +
      `前须先跑 node scripts/mind-validate.mjs 通过，且已有用户放行 + 快照；未过校验勿提交。`
  }
];

/** 宿主插件主体（fail-open）。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    // 只对"写/改文件"工具设闸；read 等读操作放行。
    const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

    const disposer = ctx.tools.guard((exec) => {
      const tool = exec?.name;
      if (!MUTATING_TOOLS.has(tool)) return undefined; // 非写改工具 → 放行

      const args = exec?.arguments;
      const filePath = args?.file_path ?? args?.path ?? '';
      if (!filePath) return undefined; // 无路径 → 放行（保守）

      for (const g of GUARDS) {
        if (g.check(filePath)) return g.reason(filePath);
      }
      return undefined; // 其余写入一律放行（不侵入生长空间）
    });

    // 记录挂载成功 + 暴露 disposer 供卸载。
    ctx.logger?.('dshome').info(
      'dshome-mind-guard: 护栏已挂载（隐私红线 + 自我修改门禁）@ root=%s',
      root
    );
    ctx.dshomeGuardDisposer = disposer;
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-guard: 初始化失败（护栏未生效，勿因此中断）: %O', error);
  }
}
