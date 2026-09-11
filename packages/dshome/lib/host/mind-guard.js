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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  //   ① 原版只认 `KEY[:=]值` → 中文自然语言赋值漏网（实测「我的密码是 hunter2xyz」**放行**）→ 补键名与赋值符的中文形态；
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
/** 是否已有"approved"的放行记录覆盖 目标路径+操作（一次性消费）。
 *  "每次都要问"：放行记录命中即删除，用完作废——下次改该文件需重新放行，不永久放行。
 *  记录 path 以 "/" 结尾 → 视为目录前缀，覆盖其下所有同类文件；否则视为单文件，精确匹配。 */
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
function writeMarker(line) {
  try {
    const dir = join(repoRoot(), 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'mind-guard-marker.txt');
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), line].slice(-20);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch { /* 诊断标记失败不影响护栏 */ }
}

/** 宿主插件主体（fail-open）。 */
export function apply(ctx) {
  try {
    const root = repoRoot();
    // 只对"写/改文件"工具设闸；read 等读操作放行。
    const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

    const disposer = ctx.tools.guard((exec) => {
      const tool = exec?.name;
      const args = exec?.arguments;

      // ① shell 通道：**只告警不拦**（见 SHELL_TOOLS / shellWriteHint 注释）——
      //    工具层拦不住 shell，但至少能让"绕道写心智区"留下痕迹（marker + 日志）。
      if (SHELL_TOOLS.has(tool)) {
        const script = String(args?.command ?? args?.script ?? args?.cmd ?? '');
        const hint = shellWriteHint(script);
        if (hint) {
          writeMarker(`shell-write-hint: [${tool}] 「${hint}」 @ ${new Date().toISOString()}`);
          ctx.logger?.('dshome')?.warn?.(
            `[mind-guard] shell 通道疑似写入心智区（**仅告警，已放行**）：${tool} 脚本里出现「${hint}」+ 写入类动作。` +
            `工具层护栏拦不住 shell —— 请自行确认这次改动走了 §四 硬流程（放行 / 快照 / validate）。`
          );
        }
        return undefined; // 只告警
      }

      if (!MUTATING_TOOLS.has(tool)) return undefined; // 非写改工具 → 放行

      const filePath = args?.file_path ?? args?.path ?? '';
      if (!filePath) return undefined; // 无路径 → 放行（保守）

      const content = contentOf(args);
      for (const g of GUARDS) {
        const reason = g.check(filePath, content, ctx, exec);
        if (reason) {
          writeMarker(`last-deny: ${new Date().toISOString()} [${g.id}] ${tool} ${normalizePath(filePath)}`);
          return reason; // 命中（未接入禁写/隐私红线/自我修改门禁）→ 拦截
        }
      }
      return undefined; // 其余写入一律放行（不侵入生长空间）
    });

    // 记录挂载成功 + 暴露 disposer 供卸载。
    mountInfo = `mounted: ${new Date().toISOString()} | autoApprove=${readAutoApprove() ? 'ON' : 'off'}`
      + ` | mutatingTools=${[...MUTATING_TOOLS].join('/')} | root=${root}`;
    writeMarker(mountInfo);
    ctx.logger?.('dshome').info(
      'dshome-mind-guard: 护栏已挂载（隐私红线 + 自我修改门禁）@ root=%s',
      root
    );
    ctx.dshomeGuardDisposer = disposer;
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-guard: 初始化失败（护栏未生效，勿因此中断）: %O', error);
  }
}
