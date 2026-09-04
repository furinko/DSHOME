// dshome-mind-guard — 心智护栏 host 插件（执行面：行为约束的真拦，不是提示）。
//
// 职责：在"鱼鱼正要 write/edit 文件"的那一刻，用官方 `ctx.tools.guard()` 在真正写入前
//       判一次。它只做拦，不做注入（注入归 dshome-mind-inject）——单一职责。
//
// 护栏（极窄内核，其余写入放行——不侵入生长空间）：
//   ① 隐私红线（真硬拦）— 往出厂区 mind\ 写【私密数据】时拦截。私密数据只进 mind-private。
//   ② 自我修改门禁（软闸）— 改"自我类"文件（AGENTS / mind 规则 / 技能 / 自身记忆）时仅记日志+提示，
//                           真实把关交给 node scripts/mind-validate.mjs（不重复硬拦，避免双闸矛盾）。
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
 * 目标是否落在"出厂区 mind\"（可推送固件区）。
 * 裸 mind\ 是固件模板（可维护），不是"私密"；只有【含私密数据】的写入才作为红线拦。
 */
function inFactoryZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = [p, normalizePath(resolve(repoRoot(), p))];
  return candidates.some((abs) =>
    /\/(mind)\/(L0|L1|L2|README\.md)/.test(abs) || /\/(mind)\/README\.md$/.test(abs)
  );
}

/**
 * 目标是否落在"自我修改门禁区"（规则/宪法/门禁/技能/自我记忆）。
 * 拦这类写的是【改"怎么做事"的规则】——放行 mind-private\L3 与 Project（生长区，拦会压死生长）。
 */
function inSelfModifyZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = [p, normalizePath(resolve(repoRoot(), p))];
  const zones = [
    '/mind/L0/', '/mind/L1/', '/mind/L2/', '/mind/README.md',
    '/mind-private/L1/'   // 行为规则/教训层（Learn.md），属"自我修改"
  ];
  return candidates.some((abs) => zones.some((z) => abs.includes(z)));
}

/** 内容是否带"私密数据"迹象（凭据/密钥/密码/私钥等）。用于隐私红线判定——只有真私密才拦。 */
function contentHasSecrets(content) {
  if (!content) return false;
  const s = String(content);
  // 命中任一即视为私密数据进出厂区。常见凭据字段名 + 密钥/私钥/令牌字样。
  return /(api[\s_-]?key|secret|token|passwd|password|private[\s_-]?key|access[\s_-]?key|client[\s_-]?secret|\.pem|-----BEGIN)/i.test(s);
}

/** 从工具参数中取出将要写入的内容（write→content；edit→new_string；str_replace_editor→content）。 */
function contentOf(args) {
  return args?.content ?? args?.new_string ?? args?.str ?? '';
}

/** 
 * 护栏判定表。每个条目 check(filePath, content, ctx) 返回：
 *   非空 string  → 拦截（把该 string 作为 reason 抛给模型）
 *   undefined    → 放行
 * 顺序执行：先命中 privacy（真红线）才拦；self-modify 只记录+提示，不拦（validate 兜底）。
 */
const GUARDS = [
  {
    id: 'privacy',
    // ① 隐私红线（真硬拦）：往出厂区写【私密数据】。修正：不再按"出厂区任何写入"拦（会锁死固件维护）。
    check: (filePath, content) =>
      inFactoryZone(filePath) && contentHasSecrets(content)
        ? `[mind-guard] 隐私红线：检测到往出厂区 ${filePath} 写入疑似私密数据（凭据/密钥/密码/私钥）。` +
          `私密数据只进 mind-private\\（gitignore），永不写入 mind\\ 出厂区（可推送 GitHub）。`
        : undefined
  },
  {
    id: 'self-modify',
    // ② 自我修改门禁（软闸，不拦）：改规则/宪法/技能/自我记忆时记录一条提示并放行。
    // 依据唯一：validate（node scripts/mind-validate.mjs）才是这道闸；guard 不重复硬拦，
    // 避免"过了 validate 仍被拦"的双闸矛盾，也避免把正常固件维护当红线压死生长。
    check: (filePath, _content, ctx) => {
      if (!inSelfModifyZone(filePath)) return undefined;
      ctx?.logger?.('dshome').warn(
        `[mind-guard] 自我修改门禁（提示，不拦）：改"自我类"文件 ${filePath}。` +
        `确保已按 AGENTS §五 硬流程：用户放行 + 快照 + node scripts/mind-validate.mjs 通过。`
      );
      return undefined; // 放行——validate 负责真实把关。
    }
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

      const content = contentOf(args);
      for (const g of GUARDS) {
        const reason = g.check(filePath, content, ctx);
        if (reason) return reason; // 命中隐私红线 → 拦截；self-modify 返回 undefined 即放行
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
