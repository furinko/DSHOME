// dshome-mind-guard — 心智护栏 host 插件（执行面：行为约束的真拦，不是提示）。
//
// 职责：在"鱼鱼正要 write/edit 文件"的那一刻，用官方 `ctx.tools.guard()` 在真正写入前
//       判一次。它只做拦，不做注入（注入归 dshome-mind-inject）——单一职责。
//
// 护栏（极窄内核，其余写入放行——不侵入生长空间）：
//   ① 未接入心智禁写（硬拦）— 「接入心智」已关的会话写心智区（mind\ 或 mind-private\）一律拦。
//   ② 隐私红线（真硬拦）— 往出厂区 mind\ 写【私密数据】时拦截。私密数据只进 mind-private。
//   ③ 自我修改门禁（软闸）— 改"自我类"文件（AGENTS / mind 规则 / 技能 / 自身记忆）时仅记日志+提示，
//                           真实把关交给 node scripts/mind-validate.mjs（不重复硬拦，避免双闸矛盾）。
//
// 设计原则（fail-open，参照 core.js / mind-inject）：
//   整个 apply 包 try/catch，任何失败只记日志、绝不 rethrow——护栏失效 ≠ host 崩溃。
//   宁可"护栏没生效"，也不因护栏 bug 带崩运行中的 GUI。可回滚：插件卸载即解绑（guard 有 disposer）。
//
// ④ 等放行：不做硬拦——程序判不了"用户意图"，硬拦易误伤（违背"别把花朵压死"）。保留提示+记录。

import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { isMindConnected } from './mind-connect.js';

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

/** 判定用候选路径（含**小写归一**）。
 *  2026-09-11 修（盲评实测）：本模块各判定用的 `includes`/正则都是**大小写敏感**的，而 Windows 路径
 *  大小写不敏感 → 写 `E:\DSHOME\MIND-PRIVATE\L0\人设卡.md`（或全小写 `e:/dshome/…`）命中的是**同一文件**，
 *  却**绕过全部三道闸**（实测两种变体均返回"放行"）。统一由此生成候选：
 *  原样 + resolve 后 + 两者的小写形式——判定因此对大小写变体免疫。
 *  注意：`normalizePath` 本身仍返回原样（供展示/存盘可读），不在此处破坏路径可读性。 */
function pathCandidates(filePath) {
  const p = normalizePath(filePath);
  const abs = normalizePath(resolve(repoRoot(), p));
  return [...new Set([p, abs, p.toLowerCase(), abs.toLowerCase()])];
}

/**
 * 目标是否落在"心智区"（mind\ 出厂区 或 mind-private\ 私有区）。
 * 用于「未接入心智会话禁写硬拦」——关状态的会话既不该读也不该写心智，写一律拦。
 */
function inMindZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = pathCandidates(p);
  // `i` 标志（2026-09-11 补修）：候选含小写变体，正则应同样大小写不敏感，否则 `MIND-PRIVATE\…` 仍绕过。
  return candidates.some((abs) => /\/(mind|mind-private)(\/|$)/i.test(abs));
}

/** 目标是否落在"出厂区 mind\"（可推送固件区）。
 * 裸 mind\ 是固件模板（可维护），不是"私密"；只有【含私密数据】的写入才作为红线拦。
 */
function inFactoryZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = pathCandidates(p);
  // 2026-09-11 扩面（第四轮盲评 · C1）：原来只认 mind/{L0,L1,L2,README.md}，而 `mind/L3/README.md`、
  // `mind/Project/README.md` **也在 git 跟踪内（会被推送）** 却恒 factoryZone=false →
  // 往这两处写凭据不受隐私红线管。补上 L3/Project/TRASH（出厂模板层，均为可推送内容）。
  return candidates.some((abs) =>
    /\/(mind)\/(L0|L1|L2|L3|Project|TRASH|README\.md)/i.test(abs)
  );
}

/**
 * 目标是否落在"自我修改门禁区"（规则/宪法/门禁/技能/自我记忆）。
 * 拦这类写的是【改"怎么做事"的规则】——放行 mind-private\L3（生长区，拦会压死生长）。
 */
function inSelfModifyZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = pathCandidates(p);
  const zones = [
    '/mind/L0/', '/mind/L1/', '/mind/L2/', '/mind/README.md',
    '/mind-private/L1/',  // 行为规则/教训层（Learn.md），属"自我修改"
    // 人设卡（2026-09-11 补漏）：mind-private\L0\人设卡.md 是 SOUL 指定的「人格演绎唯一权威源」，
    // 属身份维度——此前不在任何 zone → 改它零门禁（盲评实测）。与 SOUL 同级保护，否则
    // "改人设 = 改我是谁"可绕过全部自我修改流程。
    '/mind-private/L0/',
    // 放行真源（2026-09-11 补 · 第四轮 C1）：`approvals.json` 是**放行判定的唯一真源**，却不在任何
    // zone → agent 用 write/edit 直接写一条 `{status:'approved',decidedBy:'user'}` 即可自批
    //（"被管方不得自批"在机器上原本毫无阻碍）。⚠️ 必须**同时**加进 inHighRiskyZone 的 rules——
    // 只加 zones 会落到"提示不拦"分支、静默放行（这正是 2026-09-11 人设卡那次的错法）。
    // 面板放行走 API（不经 guard），不受影响。
    '/mind-private/tasks/approvals.json',
  ];
  // 大小写归一（2026-09-11 **补修**）：候选与规则**两侧**都必须小写。首版只让 `pathCandidates`
  // 带小写候选，而规则字面量含大写（如 '/mind-private/L0/'），`includes` 大小写敏感 →
  // 小写候选匹配不上，**绕过依然存在**（改了比较的一方、忘了另一方）。
  return candidates.some((abs) => zones.some((z) => abs.includes(z.toLowerCase())));
}

/** 内容是否带"私密数据"迹象（凭据/密钥/密码/私钥等）。用于隐私红线判定——只有真私密才拦。
 *  2026-09-11 修（盲评实测）：原来**只匹配词**——出厂区写「记录 token 消耗教训」「password 管理」
 *  这类**正当讨论**也会被硬拦，而 privacy 排在 self-modify **之前** return → **面板放行也解不开**
 *  （Learn 2026-09-06 已记此坑："隐私类拦截无面板通道"）。实测：连 `mind/L1/Learn.md` 这种文档区、
 *  内容只是提到该词，也被判隐私红线。
 *  现改为要求**赋值/凭据形态**：`KEY=值` / `KEY: 值`（值 ≥6 位非空白）/ PEM 私钥块。
 *  权衡（明示）：裸写的、不带 key 名的孤立凭据灵敏度下降；但"拦词"的误报代价更高——它把正常写作
 *  拦死且**无解除通道**，等于把门禁退化成"别写这些词"的写作禁忌。 */
function contentHasSecrets(content) {
  if (!content) return false;
  const s = String(content);
  // 2026-09-11 二次修（第四轮盲评 · C1 实测）：
  //   ① 原版只认 `KEY[:=]值` → 中文自然语言赋值漏网（实测「我的密码是 hunter2xyz」**放行**）→ 补键名与赋值符的中文形态；  cred-ok（示例值，非真凭据）
  //   ② 原版 `\.pem\b` 会把"提到 .pem 文件"也判成凭据，而 privacy **无解除通道**（排在 self-modify 之前 return）
  //      → 误报代价过高，改为只认 **PEM 内容块**本身。
  const KEY = '(?:api[\\s_-]?key|secret|token|passwd|password|private[\\s_-]?key|access[\\s_-]?key|client[\\s_-]?secret|密码|口令|密钥|私钥|令牌)';
  const ASSIGN = new RegExp(KEY + '[\\s"\']*(?:[:=]|是|为)[\\s"\']*\\S{6,}', 'i');
  return ASSIGN.test(s) || /-----BEGIN[ A-Z]*PRIVATE KEY/.test(s);
}

/** 从工具参数中取出将要写入的内容（write→content；edit→new_string；str_replace_editor→content）。 */
function contentOf(args) {
  return args?.content ?? args?.new_string ?? args?.str ?? '';
}

// ── 动作放行记录（与 dshome-mind API 共用同一文件：mind-private\tasks\approvals.json）──
// 护栏独立读写该文件，不 require index.cjs（那是 cordis 插件对象，重引用会循环）。
// 放行粒度 = 路径前缀 + 操作（op）：一条 approved 覆盖其下所有文件同类操作。
const approvalsFile = () => join(repoRoot(), 'mind-private', 'tasks', 'approvals.json');

// ── 护栏裁决台账（2026-09-18 加 · 三参照物清单 P0-②「审批留痕物证」的物证半）──────────────
// 为什么：`approvals.json` 只记"有过这么一次放行"，**判不出它对应哪次工具调用、也判不出
// 一次裁决到底发生过没有**（审计判"无法验证"）。本台账 append-only 记下每一次护栏裁决：
// `{ts,tool,path,op,decision,approvalIds?,reason?}` ⇒ 「谁在什么时候想改什么、是拦是放、
// 放行凭哪条额度」全部可查。上界 512KB 保留后半（台账是可查，不是全存）。
const DECISIONS_MAX_BYTES = 512 * 1024;
export function guardDecisionsFile() { return join(repoRoot(), 'mind-private', 'tasks', 'guard-decisions.jsonl'); }
export function appendDecision(rec) {
  try {
    const f = guardDecisionsFile();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(rec) + '\n');
    if (statSync(f).size > DECISIONS_MAX_BYTES) {
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      writeFileSync(f, lines.slice(-Math.max(1, Math.floor(lines.length / 2))).join('\n') + '\n');
    }
    return true;
  } catch { return false; } // 留痕失败绝不影响裁决本身
}

// ── 写入归属台账（2026-09-23 加 · 补 `git-writer-probe` 自己承认的「判不了归属」缺口）──────
// 为什么：`scripts/git-writer-probe.mjs` 的诚实边界写着——它只**列**在飞面、**判不了归属**
//   （`### 归属待核` 那段：2026-09-23 实测 index 被第三方从 2 件扩到 6 件而它仍报 ✅）。
//   同日晚实测撞车：`cron.cjs` 被另一会话 23:06:22 改（+37 行「自治会话登记工作区」），
//   而我**只能靠 mtime 猜**"这是不是别人在写"——裁决台账（guard-decisions）当时够不着它，
//   因为那是**降噪设计**：只在"有裁决意义"时记（拦 / 放行额度 / 心智区），**普通代码文件不记**。
// 本台账补这一维：`MUTATING_TOOLS` **写成功**后记一条 `{ts,session,tool,path}`（append-only）。
//   带 session ⇒ 「谁在什么时候写了哪个文件」可查；探针据此给在飞面标归属，并检出
//   「**同一文件被 ≥2 个会话在短窗口内写**」——那才是"同时修改同一个东西"的可检出信号
//   （并发会话本身不是问题；同时改同一个东西才是，见 L2 技能 `concurrent-writers`）。
// ⚠️ 定位（不许当闸卖）：它是**记录**，不改判定、不拦写入。拦写在 `GUARDS` 的决策面。
//   记成功不记尝试：`post-execute` 报 `isError === false` 才记（同"写成功才消费额度"的纪律）。
const WRITE_LOG_MAX_BYTES = 512 * 1024; // 与裁决台账同量级；超了保留后半（可查 ≠ 全存）
export function writeLogFile() { return join(repoRoot(), 'mind-private', 'tasks', 'write-log.jsonl'); }
/** 归一成 `仓库相对路径`（探针的 `git status` 给的就是相对路径，两边必须同口径才对得上）。
 *  落在仓库外 → 原样返回（不假装它在仓里）。失败不抛（留痕绝不能带崩写入）。 */
export function repoRelPath(p) {
  try {
    const abs = normalizePath(resolve(repoRoot(), p));
    const root = normalizePath(repoRoot()).replace(/\/+$/, '');
    return abs.toLowerCase().startsWith(root.toLowerCase() + '/') ? abs.slice(root.length + 1) : abs;
  } catch { return normalizePath(p); }
}
/** 追加一条写入归属。@returns 是否落账（失败只返回 false，绝不影响写入本身）。 */
export function appendWriteClaim(exec, filePath) {
  try {
    const sid = exec?.agent?.session?.header?.id;
    const f = writeLogFile();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify({
      ts: new Date().toISOString(),
      // 拿不到会话（agent-less 执行）→ null：**归属未知**要如实留空，不许拿"最近一个会话"顶上。
      session: sid === undefined || sid === null ? null : String(sid),
      tool: String(exec?.name ?? ''),
      path: repoRelPath(filePath),
    }) + '\n');
    if (statSync(f).size > WRITE_LOG_MAX_BYTES) {
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      writeFileSync(f, lines.slice(-Math.max(1, Math.floor(lines.length / 2))).join('\n') + '\n');
    }
    return true;
  } catch { return false; }
}

function readApprovals() {
  try { return JSON.parse(readFileSync(approvalsFile(), 'utf8')).items || []; }
  catch { return []; }
}
function writeApprovals(items) {
  try {
    mkdirSync(dirname(approvalsFile()), { recursive: true }); // mind-private\tasks\ 可能未初始化：先建目录再写，否则写入静默失败、放行/待裁决全丢
    let aa = null;
    try { aa = JSON.parse(readFileSync(approvalsFile(), 'utf8')).autoApprove || null; } catch { /* 无既有文件 */ }
    writeFileSync(approvalsFile(), JSON.stringify(aa ? { items, autoApprove: aa } : { items }, null, 2));
  } catch { /* 忽略 */ }
}
/** 面板「自动同意」开关——`enabled && decidedBy==='user'` 时生效：高危改动免逐条面板确认。
 *  ⚠️ 诚实标注（2026-09-11 盲评订正）：decidedBy 只是**来源标注**，不是防伪机制——本函数直接在
 *  approvals.json 上做字符串比对，agent 直写 `{"enabled":true,"decidedBy":"user"}` 同样生效。
 *  原注释声称"agent 直写文件伪造同 decidedBy 校验，不生效"，与实现不符（**承诺了不存在的校验**）。
 *  定位不变：行为约束层（同 approved 记录），**不当安全边界**；真兜底是"被管方不得自批"这条纪律
 *  + 面板复核（见 Learn 2026-09-06 护栏自批）。
 *  本机已于 2026-09-11 关闭：开启期间 §四 自我修改硬流程（放行→快照→validate）实际失效。 */
function readAutoApprove() {
  try {
    const d = JSON.parse(readFileSync(approvalsFile(), 'utf8'));
    const aa = d.autoApprove;
    return aa && aa.enabled && aa.decidedBy === 'user' ? aa : null;
  } catch { return null; }
}
/** 是否已有"approved"的放行记录覆盖 目标路径+操作。
 *  **一次性**语义保留，但**消费时机改到"写成功之后"**（2026-09-12 修）：
 *  旧实现命中即从 `approvals.json` 删除，而这一问发生在**工具真正执行之前** ⇒ 后续任何失败
 *  （工具层拒绝 / 磁盘错 / 中断）都会**白烧**主人在面板点的那一次放行（09-12 实测一次）。
 *  新实现：命中只记入 in-flight，等 `tools/post-execute` 报**成功**才真删（见 `consumeApproved`）。
 *  记录 path 以 "/" 结尾 → 视为目录前缀，覆盖其下所有同类文件；否则视为单文件，精确匹配。 */
/** in-flight 放行（key = `路径|op` → 记录 id[]）：命中过、但还没等到"写成功"的额度。 */
const approvedInFlight = new Map();
/** 批准通道权威值：仅「心智 → 动作放行」面板点✓时写入的 decidedBy。
 *  agent 自批 / 绕过写入的批准，只要 decidedBy 非此值 → 视为伪造、不生效（L2 防"糊涂自批"）。 */
const APPROVAL_CHANNEL_USER = 'user';

function isApproved(filePath, op) {
  const p = normalizePath(filePath);
  const items = readApprovals();
  // 与 zone 判断（inSelfModifyZone/inHighRiskyZone/inFactoryZone）保持一致的双候选口径：
  // 那些判断用 [原始路径, resolve(repoRoot, p)] 命中相对/绝对路径；此处若只用原始 p，
  // 当 write/edit 传来相对路径（如 mind/L1/Power.md）时 match 不上 stored 的绝对路径，
  // 就会"拦得住但仍把放行记录留在文件里、永不消费"——本修复把候选对齐为绝对/相对都能匹配。
  const targets = pathCandidates(p);
  const matched = items.filter((a) =>
    a.status === 'approved' && a.decidedBy === APPROVAL_CHANNEL_USER && a.op === op &&
    // rp 小写化（2026-09-11 补修）：targets 已含小写候选，而存储的 a.path 可能含大写 → 两侧都小写才比得上。
    (() => { const rp = normalizePath(a.path).toLowerCase(); return rp.endsWith('/') ? targets.some((t) => t.startsWith(rp)) : targets.some((t) => t === rp); })()
  );
  if (matched.length) {
    const key = `${p.toLowerCase()}|${op}`;
    const prev = approvedInFlight.get(key) || [];
    approvedInFlight.set(key, [...new Set([...prev, ...matched.map((a) => a.id)])]);
    return true; // ← 命中 ≠ 消费：等 `tools/post-execute` 报成功才删（2026-09-12 修）
  }
  return false;
}

/** **写成功才消费**（由 `tools/post-execute` 的成功分支调用）：删掉 in-flight 里那几条放行记录。
 *  失败 / 拒绝 / 中断时**不调用** ⇒ 主人在面板点的那一次额度留着，可重试。
 *  @returns 实际消费条数（0 = 本次没有待消费的额度） */
function consumeApproved(filePath, op) {
  const key = `${normalizePath(filePath).toLowerCase()}|${op}`;
  const ids = approvedInFlight.get(key);
  if (!ids || !ids.length) return 0;
  const items = readApprovals();
  const keep = items.filter((a) => !ids.includes(a.id));
  if (keep.length !== items.length) writeApprovals(keep);
  approvedInFlight.delete(key);
  return items.length - keep.length;
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

/** autoApprove 开启时的**自动放行留痕**（2026-09-11 加，主人要求「可以先拦再放，但不能静默」）。
 *  三态语义：`pending`=待人拍（拦）· `approved`=人已放行 · `auto-approved`=**开关代放，不拦但必留痕**。
 *  ⚠️ 它**不构成授权**：`isApproved` 要求 `status==='approved' && decidedBy==='user'`，
 *  故 auto-approved 记录不会被当成放行依据——留痕就是留痕。
 *  用途：事后可回溯「哪些宪法/规则/门禁改动是在自动同意下过的」（P0 批次关 autoApprove 的关切正是"硬流程被整体绕过"）。 */
function addApprovalAuto(filePath, op, content) {
  const items = readApprovals();
  const p = normalizePath(filePath);
  const label = p.includes('mind/L0/') ? '宪法/人格/纪律'
    : /\/?(HUB|Wisdom|Memory|Power|Invariants|Design-Philosophy|Ritual|Concepts)\.md$/.test(p) ? '规则/宪法/门禁'
    : '自我类文件';
  const snippet = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const what = snippet ? `；改动内容≈「${snippet}${content && String(content).length > 48 ? '…' : ''}」` : '';
  const now = new Date().toISOString();
  items.push({
    id: 'ap-' + Date.now(), kind: 'action',
    path: p, op,
    reason: `改${label}：${p}${what}（**autoApprove 自动放行**：未逐条人拍，留痕供审计）`,
    status: 'auto-approved',
    requestedAt: now, decidedAt: now, decidedBy: 'autoApprove',
  });
  writeApprovals(items);
}
/**
 * 高危规则/宪法/门禁区（只有这里才真拦，需面板放行）。
 * 判据 = 改这个文件是否【改变智能体的行为逻辑】。
 * 高危名单（精确到文件/模式）：
 *   mind\L0\SOUL.md / AGENTS.md                      （人格/纪律——行为宪法级）
 *   mind\L0\TOOL.md 不进高危（2026-09-06 降：只改工具操作细则，非行为逻辑；留自修改区正常放行）
 *   mind\L1\HUB.md / Wisdom.md / Memory.md / Power.md / Invariants.md / Design-Philosophy.md
 *   mind\L1\Ritual.md                             （行为规程·元进化·收工·自省——AGENTS 声明的行为唯一权威）
 *   mind\L1\Concepts.md                           （概念注册表·意图路由——确定性枢纽，非文档）
 * 放行（文档/索引/记录，非行为规则）：README.md / Tree.md / Dream.md / Learn.md
 *   （Concepts 2026-09-05 升为高危：改它=改全局落点语义，且声明有后端对应——须面板裁决防纸面/实现漂移）
 */
function inHighRiskyZone(filePath) {
  const p = normalizePath(filePath);
  const candidates = pathCandidates(p);
  const rules = [
    '/mind/L0/SOUL.md', '/mind/L0/AGENTS.md',
    '/mind/L1/HUB.md', '/mind/L1/Wisdom.md', '/mind/L1/Memory.md',
    '/mind/L1/Power.md', '/mind/L1/Invariants.md', '/mind/L1/Design-Philosophy.md',
    '/mind/L1/Ritual.md', '/mind/L1/Concepts.md',
    // 人设卡（2026-09-11 **真修**）：`mind-private\L0\人设卡.md` 是 SOUL 指定的「人格演绎唯一权威源」，
    // 属身份通道，与 SOUL 同级。用**目录前缀**匹配而非精确文件名（抗改名——历史文件名漂移过一次）。
    // ⚠️ 上一版只把它写进 inSelfModifyZone 的 zones，那只决定"进不进自我修改区"；**本名单才决定
    // "进区之后硬拦还是静默放行"**——盲评实测：只加 zones 的人设卡仍是零门禁（check() 先判本名单，
    // 不中则落到提示分支，而该分支只认 /L2/ 与 /mind-private/L1/，两条都不中 → return undefined）。
    '/mind-private/L0/',
    // 放行真源（2026-09-11 补 · 第四轮 C1）：与 inSelfModifyZone 的 zones 成对——只加 zones 会落到
    // "提示不拦"分支静默放行，**必须同时进本名单**才真拦。堵住「agent 直写一条 approved 记录即自批」
    // 这条机器通道。注意：面板放行走 API（不经 guard），因此正常放行流程不受影响。
    '/mind-private/tasks/approvals.json',
  ];
  // 两侧小写（同 inSelfModifyZone 的补修理由）：规则字面量含大写 L0/SOUL… 而 includes 大小写敏感。
  return candidates.some((abs) => rules.some((r) => abs.includes(r.toLowerCase())));
}

/** shell 类工具（工具层拿不到"目标文件"，只能对**脚本文本**做启发式判断）。
 *  2026-09-11 加（第四轮盲评 · C1 指出的"覆盖率洞"）：guard 只挂在 `write/edit/str_replace_editor`
 *  三个工具上 → **shell（pwsh/node/…）写入零门禁**（我当晚就亲手用 `node -e` 绕过一次）。
 *  ⚠️ 为什么这里**只告警不拦**：`pwsh` 的参数是一整段脚本，解析不出"到底要写哪个文件"——
 *  粗粒度拦截会误伤大量正常诊断命令（我每天都在用 pwsh 读文件、跑脚本）。
 *  所以本步做的是**可发现性**：脚本里同时出现「心智区路径」+「写入类动作」→ 记 marker 告警 + 放行。
 *  这是 C1「门禁应收敛到文件系统层」的**降级实现**：先让 shell 通道可被审计，再谈能不能真拦。
 *  真正的文件系统层收口需要上游支持（只读挂载/ACL/写入钩子），超出本插件能力。 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'exec', 'run_command']);

/** 脚本里是否同时出现「心智区路径」与「写入类动作」→ 命中则返回路径片段（否则空串）。启发式，宁可漏报不误拦。 */
function shellWriteHint(script) {
  const s = String(script || '');
  if (!s) return '';
  const inMind = /\b(?:mind|mind-private)[\\/][\w\\/.-]*/i.exec(s);
  if (!inMind) return '';
  const WRITEISH = /(Set-Content|Out-File|Add-Content|writeFileSync|appendFileSync|Remove-Item|New-Item|Copy-Item|Move-Item|Rename-Item|\bcp\b|\bmv\b|\brm\b|\bdel\b|>\s*[^=|])/i;
  return WRITEISH.test(s) ? inMind[0] : '';
}

/** 
 * 护栏判定表。每个条目 check(filePath, content, ctx) 返回：
 *   非空 string  → 拦截（把该 string 作为 reason 抛给模型）
 *   undefined    → 放行
 * 顺序执行：先命中 mind-disconnect-write（未接入会话禁写心智区）才拦；
 * 再命中 privacy（真红线）才拦；self-modify 只拦【高危规则区】，且凭放行记录。
 */
const GUARDS = [
  {
    id: 'mind-disconnect-write',
    // ③ 未接入心智（「接入心智」开关已关）的会话：既不该读也不该写心智——
    //    写心智区（mind\ 或 mind-private\）一律硬拦。这样"关"= 双向断开（不注入/不召回/不写记忆）。
    //    没有 agent（agent-less 执行）→ 判不了会话，fail-open 放行（不误伤）。
    check: (filePath, _content, ctx, exec) => {
      const agent = exec?.agent;
      if (agent === void 0) return undefined;
      const sid = agent?.session?.header?.id;
      if (isMindConnected(sid)) return undefined; // 接入态 → 交给后续 privacy / self-modify
      if (!inMindZone(filePath)) return undefined; // 非心智区 → 放行（不波及普通文件）
      return `[mind-guard] 该会话「接入心智」已关闭，禁止写入心智区 ${filePath}（mind\\ 与 mind-private\\）。` +
        `如需把内容存入记忆，请先在输入框打开「接入心智」。`;
    }
  },
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
        if (isApproved(filePath, op)) return undefined; // 已逐条放行 → 放行
        if (readAutoApprove()) {
          // 2026-09-11 修（主人要求：「可以先拦再放，但不能静默」）——原实现**直接 `return undefined`**：
          //   高危改动**零留痕**，面板无记录、事后无法回溯"哪些宪法/规则改动没经人过目"
          //   （P0 批次当初「关 autoApprove」的理由正是"§四 硬流程被整体绕过"，那是治标未治本）。
          // 现在：**先记账再放行** —— 写一条 `status:'auto-approved'` 留痕（累积、可审计），
          //   与 `pending`（待人拍）/`approved`（人已放行）三态分明。**开关代放 ≠ 没发生过。**
          addApprovalAuto(filePath, op, _content);
          ctx?.logger?.('dshome').warn(
            `[mind-guard] 自我修改门禁：**自动放行**高危区改动 ${normalizePath(filePath)}` +
            `（autoApprove 开着）——已写留痕（status=auto-approved）供审计，未逐条人拍。`
          );
          return undefined;
        }
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

/** 诊断 marker（2026-09-11 补）：本插件此前是**唯一不写 marker** 的 mind 插件 →
 *  "护栏在运行时到底挂载没有、拦过什么"在磁盘上**无任何证据**（两轮盲评都因此判"无法核实"）。
 *  两行固定格式，挂载行保留、拦截行覆盖：
 *    mounted:   <启动时刻> | autoApprove=<ON/off> | zones=...
 *    last-deny: <时刻> [护栏 id] <工具> <目标路径>
 *  只作诊断，失败不影响护栏。 */
let mountInfo = '';
/** 诊断 marker（**追加式**，2026-09-11 改）：原来是「mounted 行 + 覆盖式 deny 行」→
 *  **拒绝历史只留最后一次**，且每次启动把上一条 deny 冲掉（C1 指摘：拒绝历史不可审计）。
 *  现在按时间累积、保留最近 20 行；挂载行也进同一流（它标识"这一轮进程"）。 */
/** 环状写入（最近 20 条）。 */
function writeRing(fileName, line) {
  try {
    const dir = join(repoRoot(), 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, fileName);
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), line].slice(-20);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch { /* 诊断标记失败不影响护栏 */ }
}

/** 护栏**证据**（`mounted` / `last-deny`）→ `mind-guard-marker.txt`。 */
function writeMarker(line) { writeRing('mind-guard-marker.txt', line); }

/** 提示类（`shell-write-hint`）→ **独立环** `mind-guard-hints.txt`（2026-09-12 加）。
 *  为什么分环：提示噪声大（我自己跑 pwsh，命令文本里带上心智区路径 + 写动词就会命中），
 *  与证据同环时会把 `mounted` / `last-deny` **挤出 20 行窗口**——实景：一次会话之后
 *  证据环里只剩 1 条 `mounted`，提示占了多数。分环后各自保留最近 20 条。 */
function writeHint(line) { writeRing('mind-guard-hints.txt', line); }

/** 只对"写/改文件"工具设闸；read 等读操作放行。 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** 判定主体（**纯判定：不写 marker、不写日志**）。
 *  为什么抽出来（2026-09-12 实测）：真值表门禁 `verify-guard-decisions.mjs` 原先走 `apply`、再拿注册进去的
 *  guard 函数跑用例——而 `apply` 会往**真实 profile** 写 `mounted:` 行，每次拒绝判定还会再写一行 `last-deny:`
 *  ⇒ 「验证门禁」自己就是**现场污染源**：每跑一次（含 pre-commit hook 每次提交）往 20 行环里塞
 *  1 条假挂载 + N 条假拒绝，把真正的现场证据挤出去。判定抽成纯函数后门禁可直接调它，真 marker 零触碰。
 *  @param exec 形如 `{ name, arguments }` 的工具调用
 *  @returns {{ reason?: string, marker?: string, hint?: string }} 副作用（写 marker / 告警）一律由 apply 执行 */
export function decide(exec, ctx) {
  const tool = exec?.name;
  const args = exec?.arguments;

  // ① shell 通道：**只告警不拦**（见 SHELL_TOOLS / shellWriteHint 注释）——
  //    工具层拦不住 shell，但至少能让"绕道写心智区"留下痕迹（marker + 日志）。
  if (SHELL_TOOLS.has(tool)) {
    const script = String(args?.command ?? args?.script ?? args?.cmd ?? '');
    const hint = shellWriteHint(script);
    if (!hint) return {};
    return {
      marker: `shell-write-hint: [${tool}] 「${hint}」 @ ${new Date().toISOString()}`,
      hint,
    };
  }

  if (!MUTATING_TOOLS.has(tool)) return {}; // 非写改工具 → 放行

  const filePath = args?.file_path ?? args?.path ?? '';
  if (!filePath) return {}; // 无路径 → 放行（保守）

  const content = contentOf(args);
  for (const g of GUARDS) {
    const reason = g.check(filePath, content, ctx, exec);
    if (reason) {
      return {
        reason, // 命中（未接入禁写/隐私红线/自我修改门禁）→ 拦截
        marker: `last-deny: ${new Date().toISOString()} [${g.id}] ${tool} ${normalizePath(filePath)}`,
      };
    }
  }
  return {}; // 其余写入一律放行（不侵入生长空间）
}

// ── 工具级副作用标记（2026-09-18 加 · P0-② 最小半，主人「清」）────────────────────────────
// 为什么：护栏此前只认 `MUTATING_TOOLS` 这个**名字名单**（名单驱动 = 新工具静默绕过，pkg-guard 同款老病）。
//  这里给每条裁决标一个 `effect`，并对「**不在名单里、却带着心智区路径**」的工具**响亮告警一次**——
//  不假装能识别一切，而是让"我不认识这个工具"变成可查、可喊的事实。
// 语义：`read_only`（只读白名单）/ `side_effect`（写类名单：改文件）/ `destructive`（shell —— 能删能改，
//  且**护栏看不进脚本内容**，这是已知的洞）/ `unknown`（我不认识的工具 —— 记进台账并告警）。
const KNOWN_READ_TOOLS = new Set([
  'read', 'glob', 'grep', 'read_image', 'list_agents', 'job_list', 'job_output', 'web_search', 'web_fetch',
]);
function toolEffect(toolName) {
  const n = String(toolName ?? '');
  if (MUTATING_TOOLS.has(n)) return 'side_effect';
  if (/^(pwsh|bash|terminal|sh)/.test(n)) return 'destructive';
  if (KNOWN_READ_TOOLS.has(n)) return 'read_only';
  return 'unknown';
}
let unknownEffectWarned = false;

// ── 上游批准面接线（2026-09-18 加 · 方案④「拆档」后半）─────────────────────────────────
// 为什么：自家 `approvals.json` 面板能放行，但"谁点的、对应哪次调用"由**我们自己记**（审计判可伪造）。
//  上游 `@deepseek-ai/dsh-user-approval` 提供真通道：服务名 `approval`，`request()` 异步返回
//  `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（**唯一同意值 `allowed-once`**），
//  且 `request()` 会在**会话日志**里留一对**由服务自己写入**的 `approval/asked` + `approval/decided`
//  （`node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:135-145`）——这对事件 agent 用 write 伪造不了。
//  前提：会话批准策略须为 `ask`（策略 `never` 时其 `decide()` **不问任何人**直接 `rejected`，见 `:178`）；
//  本机已由方案④拆分档位落地（`mind-guard` = `{sandbox: danger-full-access, approval: ask}`）。
// 判据（fail-closed，但不把系统锁死）：
//  · `allowed-once` → 记 `callId` 放行（guard 侧不再重复拦，也**不建自家卡**）
//  · `rejected` / `cancelled` → **硬拒**（主人明确说不 / 被中断）
//  · `unavailable`（无人应答）· 无服务 · 无 agent · 请求抛错 → **回落自家面板流程**（guard 照常拦 + 建卡），
//    并**响亮告警一次** —— "上游问不到人" 绝不等于 "放行"
const upstreamApproved = new Set();
let upstreamWarned = false;
function warnUpstreamOnce(ctx, msg) {
  if (upstreamWarned) return;
  upstreamWarned = true;
  try { ctx.logger?.('dshome')?.warn?.(`[mind-guard] ${msg}`); } catch { /* 记不上日志不影响裁决 */ }
}
/** 上游裁决的台账记录（与 guard 侧同一条物证流；上游本身另有一对会话审计事件）。 */
function recordUpstreamDecision(exec, filePath, decision, reason) {
  return appendDecision({
    ts: new Date().toISOString(),
    tool: String(exec?.name ?? ''),
    path: normalizePath(filePath),
    op: MUTATING_TOOLS.has(String(exec?.name ?? '')) ? 'edit' : 'other',
    effect: toolEffect(String(exec?.name ?? '')),
    decision,
    reason,
  });
}

/** 宿主插件主体（fail-open）。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    // 返回值不另存：guard 经 ctx.tools.guard → layers.effect(this.ctx) 注册，**随本插件 fiber 卸载自动解绑**。
    // （旧代码把返回值写到 `ctx.dshomeGuardDisposer`：cordis 里未 provide 就写 ctx 属性必抛
    //  `cannot set property "dshomeGuardDisposer" without provide`，又被下面的 catch 接住 ——
    //  于是每次「挂载成功」都会多打一条自相矛盾的「初始化失败（护栏未生效）」告警，且该属性全仓无读者。）
    ctx.tools.guard((exec) => {
      // 上游批准面已放行的这次调用：**直接放行且不进 decide**——decide 的高危分支会 `addApprovalPending`
      // 建一张自家卡，若在这里放行就会留下一张**永远没人点的幽灵卡**。一次性消费 `callId`（防集合无界增长）。
      if (exec?.callId !== undefined && upstreamApproved.has(exec.callId)) {
        upstreamApproved.delete(exec.callId);
        return undefined;
      }
      const { reason, marker, hint } = decide(exec, ctx);
      // 分环：提示（shell-write-hint）走 `mind-guard-hints.txt`，证据（mounted/last-deny）走 marker。
      if (marker) (hint ? writeHint : writeMarker)(marker);
      if (hint) {
        ctx.logger?.('dshome')?.warn?.(
          `[mind-guard] shell 通道疑似写入心智区（**仅告警，已放行**）：${exec?.name} 脚本里出现「${hint}」+ 写入类动作。` +
          `工具层护栏拦不住 shell —— 请自行确认这次改动走了 §四 硬流程（放行 / 快照 / validate）。`
        );
      }
      // P0-② 留痕物证（2026-09-18 加）：把裁决写成 append-only 一条 —— 拦/放、放行凭哪条额度、
      // 针对哪个文件，全部可查（此前只有 approvals.json 的"有过一次放行"，对应不上调用，审计判"无法验证"）。
      // **降噪（2026-09-18 · 主人「清」）**：此前对**每次** guard 调用都写一条 ⇒ `pwsh`/`read` 这类
      // 无路径调用一天刷出上百行（`op:'edit'` 还是写死的、根本不真）。现在只在**有裁决意义**时记：
      //   ① 被拦（reason）② 走放行额度（ids）③ **改**心智区（路径落 `mind\` / `mind-private\` **且不是只读工具**）
      // 其余不记 —— 普通代码文件、无路径的工具调用由各自门禁/日志负责；**心智区的"读"也不记**。
      // 最后这条是量出来的：第一版降噪后实测"新增 4 行里 3 行是读"（读心智文件的次数远超改它），
      // 而审计关心的是"谁改了什么、是拦是放"，不是"谁看了一眼"。`effect` 分类照旧保留。
      try {
        const fp = exec?.arguments?.file_path ?? exec?.arguments?.path ?? '';
        const ids = approvedInFlight.get(`${normalizePath(fp).toLowerCase()}|edit`) ?? [];
        const toolName = String(exec?.name ?? '');
        const effect = toolEffect(toolName);
        if (reason || ids.length > 0 || (fp && inMindZone(fp) && effect !== 'read_only')) {
          appendDecision({
            ts: new Date().toISOString(),
            tool: toolName,
            path: normalizePath(fp),
            op: MUTATING_TOOLS.has(toolName) ? 'edit' : 'other',
            effect,
            decision: reason ? 'deny' : (ids.length > 0 ? 'allow-by-approval' : 'allow'),
            ...(ids.length > 0 ? { approvalIds: ids } : {}),
            ...(reason ? { reason: String(reason).split('\n')[0].slice(0, 140) } : {}),
          });
        }
        // 名单外工具带心智区路径 ⇒ **响亮告警一次**（不当作已护栏；把"不认识"变成可查事实）。
        if (fp && effect === 'unknown' && inMindZone(fp)) {
          if (!unknownEffectWarned) {
            unknownEffectWarned = true;
            try {
              ctx.logger?.('dshome')?.warn?.(
                `[mind-guard] 名单外工具带心智区路径：「${toolName}」→ ${normalizePath(fp)}；它不在写类名单里`
                + `（写面无护栏）。若它是写类工具，请把名字加进 \`MUTATING_TOOLS\`；若只读，请加进 \`KNOWN_READ_TOOLS\`。`
                + `本次已按 effect:"unknown" 记入裁决台账。`
              );
            } catch { /* 记不上日志不影响裁决，台账已留痕 */ }
          }
        }
      } catch { /* 留痕失败不影响裁决 */ }
      return reason; // 命中 → 拦截；undefined → 放行（不侵入生长空间）
    });

    // ── 上游批准面：命中「心智高危区」的写类调用 → 先向上游 `approval` 服务要一次真批准 ──────────
    // 为什么放 `tools/pre-execute`（不塞进 guard）：上游 `ToolGuard` 是**同步**契约，只能返回
    //   `string`(拒) / `undefined`(放行)、**没有 allow**（`dsh-tools/lib/types/index.d.ts:481-489`）
    //   ⇒ 想在写入前"等主人点一下"，只能走能在 waterfall 里 await 的 pre-execute。
    // 与 guard 的关系：本钩子只在拿到 `allowed-once` 时放行并标记 callId（让 guard 不重复拦）；
    //   **其余情况一律 `next()` 交回原流程**（守卫照常拦 + 建自家卡）——两道闸**叠加**，不是替换。
    ctx.on('tools/pre-execute', async (exec, next) => {
      // 同 post-execute 的纪律：不假设 `next` 一定存在（`verify-host-plugins` 会真跑注册的 handler）。
      const proceed = typeof next === 'function' ? next : () => undefined;
      try {
        const fp = exec?.arguments?.file_path ?? exec?.arguments?.path ?? '';
        if (!fp || !MUTATING_TOOLS.has(String(exec?.name ?? '')) || !inHighRiskyZone(fp)) return proceed();
        if (isApproved(fp, 'edit')) return proceed(); // 自家额度已放行 ⇒ 照旧走原流程（写成功后才消费）
        const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
        if (!approval || typeof approval.request !== 'function' || !exec?.agent) {
          warnUpstreamOnce(ctx, `上游批准面不可用（${approval ? '本次调用缺 agent' : '无 approval 服务'}）⇒ 回落自家面板流程：${normalizePath(fp)}`);
          return proceed();
        }
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: String(exec.name),
          ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
          reason: `心智高危区写入需放行：${normalizePath(fp)}`,
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        });
        if (outcome === 'allowed-once') {
          if (exec.callId !== undefined) upstreamApproved.add(exec.callId);
          recordUpstreamDecision(exec, fp, 'allow-by-upstream', 'approval/allowed-once');
          return proceed();
        }
        if (outcome === 'rejected' || outcome === 'cancelled') {
          recordUpstreamDecision(exec, fp, 'deny', `upstream:${outcome}`);
          return { kind: 'deny', reason: `心智高危区写入未获批准（上游批准面：${outcome}）——已拦下，未落盘` };
        }
        // 'unavailable'（无人应答）或上游返回了词表外的值：**不当作放行**，回落自家面板流程。
        warnUpstreamOnce(ctx, `上游批准面返回 ${outcome}（无人应答）⇒ 回落自家面板流程：${normalizePath(fp)}`);
        return proceed();
      } catch (e) {
        // `request()` 在"无打开的 turn"时会抛（其 `:133`）——自治/后台会话可能如此 ⇒ 绝不能带崩调用。
        warnUpstreamOnce(ctx, `上游批准面请求失败 ⇒ 回落自家面板流程：${e?.message ?? e}`);
        return proceed();
      }
    });

    // 放行额度**写成功才消费**（2026-09-12 修）：`tools/post-execute` 报成功才真删 approvals.json 里那条。
    // 失败 / 拒绝 / 中断 ⇒ 额度留着 —— 主人在面板点的那一次不会被一次"未落盘的尝试"白烧。
    ctx.on('tools/post-execute', async (exec, result, next) => {
      // ⚠️ 不假设 `next` 一定存在：`verify-host-plugins` 会**真跑每个注册的 handler**，而它只传
      //    两个参数（C2 反例 A 的机械化）⇒ 直接 `await next()` 会抛错并被判"挂载异常"。
      //    hook 的最小可用签名假设：拿不到 next 就按"没有下游"处理，绝不能抛。
      const decision = typeof next === 'function' ? await next() : undefined;
      try {
        // 🔴 判据必须贴上游**真实契约**：`ToolExecutionResult` = `{isError:false}`（成功）/
        //   `{isError:true}`（失败），见 `@deepseek-ai/dsh-tools` 的 `ToolExecutionSuccess/Failure`
        //   —— 结果里**没有 `kind` 字段**。2026-09-17 实测事故：这里原写 `result?.kind === 'success'`，
        //   真跑时**恒不等** ⇒ `consumeApproved` 永不执行 ⇒ 放行额度永不消费、对该文件永久放行
        //   （09-14 首次观察到；今天它把 ④ 门禁判红、堵住了所有人的提交）。当时本门禁自己的探针
        //   也用同一个假形状 `{kind:'success'}`，所以探针恒绿——桩与实现共享了同一个错误假设。
        const p = exec?.arguments?.file_path ?? exec?.arguments?.path ?? '';
        if (result?.isError === false && MUTATING_TOOLS.has(exec?.name) && p) {
          const n = consumeApproved(p, 'edit'); // 高危分支统一 op='edit'（与上方 check 口径一致）
          if (n) ctx.logger?.('dshome')?.info?.(`[mind-guard] 放行额度已消费（写成功）：${normalizePath(p)}（${n} 条）`);
          // 写入归属台账（2026-09-23 加）：**写成功**才记 —— 被 guard 拦下 / 工具报错的调用不是写者。
          appendWriteClaim(exec, p);
        }
      } catch { /* 消费失败不影响执行 */ }
      return decision;
    });

    // 记录挂载成功（解绑随插件 fiber 卸载，无需另存 disposer）。
    mountInfo = `mounted: ${new Date().toISOString()} | autoApprove=${readAutoApprove() ? 'ON' : 'off'}`
      + ` | mutatingTools=${[...MUTATING_TOOLS].join('/')} | root=${root}`;
    writeMarker(mountInfo);
    ctx.logger?.('dshome').info(
      'dshome-mind-guard: 护栏已挂载（隐私红线 + 自我修改门禁）@ root=%s',
      root
    );
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-guard: 初始化失败（护栏未生效，勿因此中断）: %O', error);
  }
}
