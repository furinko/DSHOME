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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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

// ── 动作放行记录（与 dshome-mind API 共用同一文件：mind-private\tasks\approvals.json）──
// 护栏独立读写该文件，不 require index.cjs（那是 cordis 插件对象，重引用会循环）。
// 放行粒度 = 路径前缀 + 操作（op）：一条 approved 覆盖其下所有文件同类操作。
const approvalsFile = () => join(repoRoot(), 'mind-private', 'tasks', 'approvals.json');
function readApprovals() {
  try { return JSON.parse(readFileSync(approvalsFile(), 'utf8')).items || []; }
  catch { return []; }
}
function writeApprovals(items) {
  try {
    mkdirSync(dirname(approvalsFile()), { recursive: true }); // mind-private\tasks\ 可能未初始化：先建目录再写，否则写入静默失败、放行/待裁决全丢
    writeFileSync(approvalsFile(), JSON.stringify({ items }, null, 2));
  } catch { /* 忽略 */ }
}
/** 是否已有"approved"的放行记录覆盖 目标路径+操作（一次性消费）。
 *  "每次都要问"：放行记录命中即删除，用完作废——下次改该文件需重新放行，不永久放行。
 *  记录 path 以 "/" 结尾 → 视为目录前缀，覆盖其下所有同类文件；否则视为单文件，精确匹配。 */
function isApproved(filePath, op) {
  const p = normalizePath(filePath);
  const items = readApprovals();
  // 与 zone 判断（inSelfModifyZone/inHighRiskyZone/inFactoryZone）保持一致的双候选口径：
  // 那些判断用 [原始路径, resolve(repoRoot, p)] 命中相对/绝对路径；此处若只用原始 p，
  // 当 write/edit 传来相对路径（如 mind/L1/Power.md）时 match 不上 stored 的绝对路径，
  // 就会"拦得住但仍把放行记录留在文件里、永不消费"——本修复把候选对齐为绝对/相对都能匹配。
  const targets = [p, normalizePath(resolve(repoRoot(), p))];
  const matched = items.filter((a) =>
    a.status === 'approved' && a.op === op &&
    (() => { const rp = normalizePath(a.path); return rp.endsWith('/') ? targets.some((t) => t.startsWith(rp)) : targets.some((t) => t === rp); })()
  );
  if (matched.length) {
    writeApprovals(items.filter((a) => !matched.includes(a))); // 消费即删，作废该放行
    return true;
  }
  return false;
}
/** 高危区未放行时往 approvals.json 追加一条待裁决（存完整文件路径；匹配按目录/文件区分）。 */
/** reason 说明"改什么文件 + 改了什么内容摘要"，让面板卡片有信息（而非空洞死字符串）。 */
function addApprovalPending(filePath, op, content) {
  const items = readApprovals();
  const p = normalizePath(filePath);
  const label = p.includes('mind/L0/') ? '宪法/人格/纪律'
    : /\/?(HUB|Wisdom|Memory|Power|Invariants|Design-Philosophy|Ritual|Concepts)\.md$/.test(p) ? '规则/宪法/门禁'
    : '自我类文件';
  const snippet = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const what = snippet ? `；改动内容≈「${snippet}${content && String(content).length > 48 ? '…' : ''}」` : '';
  items.push({
    id: 'ap-' + Date.now(), kind: 'action',
    path: p, op,
    reason: `改${label}：${p}${what}（未放行，需面板确认；高危规则改动会影响系统行为）`,
    status: 'pending',
    requestedAt: new Date().toISOString(), decidedAt: null, decidedBy: '',
  });
  writeApprovals(items);
}
/**
 * 高危规则/宪法/门禁区（只有这里才真拦，需面板放行）。
 * 判据 = 改这个文件是否【改变鱼鱼的行为逻辑】。
 * 高危名单（精确到文件/模式）：
 *   mind\L0\SOUL.md / AGENTS.md / TOOL.md        （人格/纪律/工具规则）
 *   mind\L1\HUB.md / Wisdom.md / Memory.md / Power.md / Invariants.md / Design-Philosophy.md
 *   mind\L1\Ritual.md                             （行为规程·元进化·收工·自省——AGENTS 声明的行为唯一权威）
 *   mind\L1\Concepts.md                           （概念注册表·意图路由——确定性枢纽，非文档）
 * 放行（文档/索引/记录，非行为规则）：README.md / Tree.md / Dream.md / Learn.md
 *   （Concepts 2026-09-05 升为高危：改它=改全局落点语义，且声明有后端对应——须面板裁决防纸面/实现漂移）
 */
function inHighRiskyZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = [p, normalizePath(resolve(repoRoot(), p))];
  const rules = [
    '/mind/L0/SOUL.md', '/mind/L0/AGENTS.md', '/mind/L0/TOOL.md',
    '/mind/L1/HUB.md', '/mind/L1/Wisdom.md', '/mind/L1/Memory.md',
    '/mind/L1/Power.md', '/mind/L1/Invariants.md', '/mind/L1/Design-Philosophy.md',
    '/mind/L1/Ritual.md', '/mind/L1/Concepts.md',
  ];
  return candidates.some((abs) => rules.some((r) => abs.includes(r)));
}

/** 
 * 护栏判定表。每个条目 check(filePath, content, ctx) 返回：
 *   非空 string  → 拦截（把该 string 作为 reason 抛给模型）
 *   undefined    → 放行
 * 顺序执行：先命中 privacy（真红线）才拦；self-modify 只拦【高危规则区】，且凭放行记录。
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
    // ② 自我修改门禁（高危规则区真拦 / 技能·自身记忆提示不拦 / 文档索引直接放行）。
    // 高危=改"行为规则/宪法/门禁"（HUB/Wisdom/Memory/Power/Invariants/Design-Philosophy/Ritual/Concepts + L0 纪律三件）→ 需面板放行；
    // 技能(L2)/自身记忆(mind-private\L1) → 只提示不拦；README/Tree/Dream/Learn(文档·索引·记录) → 直接放行。
    // 放行记录(approvals.json)：已在【路径前缀+op】approved → 放行；否则拦 + 写 pending 供面板裁决。
    check: (filePath, _content, ctx) => {
      if (!inSelfModifyZone(filePath)) return undefined; // 非自我区（生长区/普通代码）→ 放行

      // 高危规则区（HUB/Wisdom/Memory/Power/Invariants/Design-Philosophy + L0 纪律三件）：凭放行记录，否则拦。
      if (inHighRiskyZone(filePath)) {
        const op = 'edit'; // write/edit 统一按 edit 粒度（区分意义不大）
        if (isApproved(filePath, op)) return undefined; // 已放行 → 放行
        addApprovalPending(filePath, op, _content); // 未放行 → 追加待裁决（带改动内容摘要）供面板
        const p = normalizePath(filePath);
        const label = p.includes('mind/L0/') ? '宪法/人格/纪律'
          : /\/?(HUB|Wisdom|Memory|Power|Invariants|Design-Philosophy|Ritual|Concepts)\.md$/.test(p) ? '规则/宪法/门禁'
          : '自我类文件';
        const sn = String(_content || '').replace(/\s+/g, ' ').trim().slice(0, 48);
        const what = sn ? `；改动内容≈「${sn}${_content && String(_content).length > 48 ? '…' : ''}」` : '';
        return `[mind-guard] 自我修改门禁（高危规则区）：要改 ${label} ${p}${what}，此改动会影响系统行为——` +
          `需要你先在「心智 → 动作放行」面板点「✓ 放行」。已生成一条待裁决，放行后重试即可。`;
      }

      // 技能(L2)/自身记忆(mind-private\L1)：只提示，不拦（日常生长，validate 兜底）。
      // 文档/索引/记录（README/Tree/Dream/Learn 模板）→ 命中上方 inSelfModifyZone 但非高危，
      // 属日常维护，直接放行（不打扰）。Concepts 已升为高危(确定性枢纽)，不在此放行列。
      if (/\/(L2)\//.test(normalizePath(filePath)) || /\/mind-private\/L1\//.test(normalizePath(filePath))) {
        ctx?.logger?.('dshome').warn(
          `[mind-guard] 自我修改门禁（提示，不拦）：改"自我类"文件 ${filePath}（技能/自身记忆）。` +
          `确保已按 AGENTS §五 硬流程：用户放行 + 快照 + node scripts/mind-validate.mjs 通过。`
        );
      }
      return undefined;
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
