// scripts/evolve-log.mjs — 鱼鱼进化档案：快照 + 变更日志（帧号式自我记忆）
// 模仿 CH4 的 CHANGELOG/design-status 思路：每次改"自我类"文件（AGENTS/mind 规则/技能/心智门禁）
// 前，先快照旧版 + 记一条理由——进化有据可查、可回滚。
//
// 用法：
//   node scripts/evolve-log.mjs snapshot <path> "<理由>"                    # 快照旧版 → evolution/snapshots/<ts>_<name>
//   node scripts/evolve-log.mjs log "<信号>|<对象>|<为什么改>|<改了啥>"        # 首个字段=KNOWN_METRIC 则绑定主信号+记基线
//   node scripts/evolve-log.mjs log "<对象>|<为什么改>|<改了啥>"              # 无信号（legacy-unbound）
//   node scripts/evolve-log.mjs effect <对象> auto                          # 机器判定单个（读信号基线比对）
//   node scripts/evolve-log.mjs effect auto                                 # 机器判定全部可判（去自评）
//   node scripts/evolve-log.mjs effect "<对象>|<观察>|<verdict>"             # 兼容自评（标 自评，非机器判）
//   node scripts/evolve-log.mjs decide <对象> <留观|回滚|改进化> "<理由>"      # 转录【主人】对无效/恶化的裁决 → 闭环消费端
//   node scripts/evolve-log.mjs lesson-scan                                # 教训复发扫描（Learn.md 自述复发计数 → 蒸馏阈值的数据源）
//   node scripts/evolve-log.mjs batch <名> <file...>                       # 写前记账：批量快照 + 批次 journal（多文件改动可续跑）
//   node scripts/evolve-log.mjs batch-status [<名>]                        # 批次进度：按 mtime 判「已改/未改」
//   node scripts/evolve-log.mjs entry-log <file> <anchor> "<why>"          # 条目级账本：写前把该小节原文入账
//   node scripts/evolve-log.mjs entry-mark <id|last>                       # 标记改完（记 after，启用冲突保护）
//   node scripts/evolve-log.mjs entry-list                                 # 列账目
//   node scripts/evolve-log.mjs entry-rollback <id|last> [--dry-run]       # 按条目回滚（回滚自身也入账）
//   node scripts/evolve-log.mjs rollback <path> [<快照时间戳前缀>]            # 回滚到最近/指定快照（回滚前自动留档当前版本）
//   node scripts/evolve-log.mjs rollback --list <path>                       # 列出该文件全部快照（新→旧）
//   node scripts/evolve-log.mjs trash <path...> --reason "<为什么>"          # 移入 TRASH 回收站（不删只移；§十一 硬约束 4-5）
//   node scripts/evolve-log.mjs trash --list                                # 看回收站索引
//   node scripts/evolve-log.mjs trash --restore <名|原路径>                   # 从回收站移回原路径
//   node scripts/evolve-log.mjs bump <信号> | metrics | health | pending-invalid
//
// P1（2026-09-05）effect 判定机械化：去掉"自评有效"——verdict 默认由机器读主信号基线得出。
//   无效 ≠ 自动回滚：机器只标记，回滚/改进化由用户拍板（收工第 9 步挂出 pending-invalid）。
//
// P0/P1 修复（2026-09-10 元进化深度体检，见 changelog 同日）：
//   ① 信号名归一化校验：`log "[corrections]|…"` 这类误写不再"静默成功"（原来对象名被写成 [corrections]、
//      绑定丢失、无基线，还被自评成"已绑信号"）→ 自动纠正 + 大声告警；未绑信号时打印 ⚠️ 提醒本条无法判效。
//   ② 判定带方向：search-hit 越高越好(up)，corrections/repeat-mistakes/rejections/redos 越低越好(down)。
//      原来 `now === baseline ? 无效 : 有效` 只看"变没变"→ 信号变坏也判"有效"（方向盲）。
//   ③ 回测去重键从「对象名」改为「对象+信号+基线」→ 同一对象的第二次进化不再被判"已有回测，跳过"。
//   ④ 新增 decide：人拍裁决留痕 → pending-invalid 跳过已裁决对象（原来 09-08 已人拍"留观"的条目至今仍列）。
//   ⑤ health 口径重做：绝对条数阈值(≥15 恒亮 6 天)降为信息行；真报警改为"判效空转 / 未裁决积压 /
//      未回填"，并把无自动采集点的手动信号标为信息行（恒红=没报警）。
//      覆盖率**按新账算**（BINDING_SINCE 之后；全库分母含封存旧账，按那个算阈值永远达不到=又一盏恒亮灯）；
//      且新账覆盖率**只作信息行**——多数进化天生没有可测信号，绑满 50% 不是能可靠做到的动作（判据①）。
//   ⑥ 「快照」列不再写合成路径：log 行原来指向不存在的文件（老档案 60/68 悬空），改为解析真实快照文件，
//      找不到就记 — 并告警提醒先 snapshot（真实快照索引另见 ↳快照 行，108/108 有效）。
//
// P0（2026-09-10 补，用户放行）：log 参数校验——参数为空 / 字段不足 / 首字段为空时，原来会**静默写垃圾行**
//   `| 2026-09-10 | x |  |  | …`（实测：不带参数直接跑 `log` 会回「已记录: x」）→ 改为报用法并 `exit 1`。
//   机制原则：**宁可响亮失败，不要静默写坏数据**（同类教训：① 信号名静默降级）。
//
// 存储：mind-private/tasks/evolution/（隐私，不推送）
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, statSync, renameSync, rmSync, cpSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, basename, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const EVO = join(repoRoot, 'mind-private', 'tasks', 'evolution');
const SNAP = join(EVO, 'snapshots');
const LOG = join(EVO, 'changelog.md');
const BATCH_DIR = join(EVO, 'batches'); // 写前记账：多文件批次 journal（2026-09-11）
const METRICS = join(EVO, 'metrics.json');
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 条目级账本（2026-09-12 加，借灵枢 `evolution.py` 的 ledger.md 形状）──────────────
// 与**文件级** snapshot 的分工：snapshot 记「整个文件改前版本」；本账本记「**某个锚点小节的原文**」——
// 一次改 7 个文件里的 7 个小节，其中一节要退，不必整文件回滚。
// **三条纪律**（抄灵枢）：① **回滚自身也入账**（撤销不可静默）② **冲突即跳过**（当前 hash ≠ after → 拒绝，防覆盖人工修改）
//                          ③ **记录自带 not_covered**（写清本机制**不覆盖什么**）。
// ⚠️ **独立文件** `ledger.md`，不塞 changelog.md —— 后者有既存正则解析（health/effect），混入会污染判定。
const LEDGER = join(EVO, 'ledger.md');
// ── TRASH 回收站（2026-09-12 建）──────────────────────────────────────────────
// 「不删只移、可恢复」此前**只是口号**：`mind-private\TRASH\` 从建立起**一次都没被用过**（空目录），
// 而 `Memory §十一` 硬约束 4-5 要求**裁剪 / 退役动作必须移入 TRASH 并留痕**。
// 本组把那句话变成**机器动作**：`trash <path...> --reason "…"` / `trash --list` / `trash --restore <名>`。
const TRASH = join(repoRoot, 'mind-private', 'TRASH');
const TRASH_INDEX = join(TRASH, '_index.md');
const entrySha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8);
function entryId() {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return `evo-${t}-${randomBytes(2).toString('hex')}`;
}
/** 取「## <锚点>」到下一个同级（或更高级）标题之间的整段（含标题行）。
 *  找不到返回 **null**（不返回空串）——记空段落会让回滚把内容删掉。 */
function extractAnchor(text, anchor) {
  const lines = String(text).split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{2,6})\s+(.*)$/.exec(lines[i]);
    if (m && m[2].trim() === anchor) { start = i; break; }
  }
  if (start < 0) return null;
  const level = /^(#{2,6})/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{2,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
/** 解析账本 → [{id, rec}]。**解析失败即抛错**（不静默跳过——Invariants #14）。 */
function readLedger() {
  if (!existsSync(LEDGER)) return [];
  const src = readFileSync(LEDGER, 'utf8');
  const out = [];
  const re = /## (evo-[0-9]{14}-[0-9a-f]{4}) · `([^`]+)`[^\n]*\n[\s\S]*?```json state\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(src))) out.push({ id: m[1], target: m[2], rec: JSON.parse(m[3]) });
  return out;
}
/** 追加一条账目（append-only；md 人可读 + 内嵌 json 机可读）。 */
function appendLedger(rec) {
  mkdirSync(EVO, { recursive: true });
  const body = [
    `## ${rec.id} · \`${rec.file}#${rec.anchor}\``,
    `- 规律：${rec.why || '—'}`,
    `- 动作：${rec.kind === 'entry_rollback' ? '回滚段落到 before' : rec.kind === 'entry_mark' ? '标记改后状态' : '段落替换（写前记账）'}`,
    `- 状态：before ${rec.before ? rec.before.hash : '—'} → after ${rec.after ? rec.after.hash : '（未标记）'}`,
    `- 来源：${rec.source || 'entry-log'} · 时间：${rec.at}`,
    '',
    '```json state',
    JSON.stringify({
      kind: rec.kind, file: rec.file, anchor: rec.anchor,
      before: rec.before || null, after: rec.after || null,
      writeId: rec.writeId || null, rollbackOf: rec.rollbackOf || null,
    }, null, 2),
    '```',
    '',
    '> not_covered: 本账本只管**该锚点小节的整段替换**——不覆盖正文之外的结构（frontmatter / 索引 / `_index.md` 引用）、',
    '> 不覆盖跨节移动、不覆盖加密内容。回滚前若当前段 hash ≠ after → **拒绝并计 conflict**（防覆盖人工修改）；要强行丢弃加 `--force`。',
    '',
  ].join('\n');
  const header = '# 条目级账本（entry ledger）\n\n'
    + '> append-only（不删只增）。形状借灵枢 `evolution.py` 的 `_evolution/ledger.md`。\n'
    + '> 用法：`entry-log <文件> <锚点> "<理由>"`（写前）→ 改 → `entry-mark <id|last>`（启用冲突保护）→ 需要时 `entry-rollback <id|last> [--dry-run] [--force]`。\n\n';
  const prev = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : header;
  writeFileSync(LEDGER, prev + body + '\n', 'utf8');
}

// 可测信号（进化关联指标）——方向很重要：up=越高越好，down=越低越好。
// 判定读"基线→现"，朝好方向=有效、朝坏方向=恶化、没动=无效（修方向盲，2026-09-10）。
const METRIC_DIRECTION = {
  'repeat-mistakes': 'down',
  'corrections': 'down',
  'rejections': 'down',
  'redos': 'down',
  'search-hit': 'up',
};
const KNOWN_METRICS = Object.keys(METRIC_DIRECTION);
// 有自动采集点（有脚本会 bump）的信号；其余靠人工记账 → health 只作信息行，不报警（避免恒红噪声）
const AUTO_COLLECTED = ['search-hit'];
// 绑主信号从这天起成为要求（此前存量封存不追）——覆盖率报警只看这之后的新账，保证报警"可熄灭"
const BINDING_SINCE = '2026-09-10';
function readMetrics() {
  try { return JSON.parse(readFileSync(METRICS, 'utf8')).metrics || {}; }
  catch { return {}; }
}
function writeMetrics(m) {
  mkdirSync(EVO, { recursive: true });
  writeFileSync(METRICS, JSON.stringify({ metrics: m, updatedAt: new Date().toISOString() }, null, 2));
}
const metricNow = (name) => readMetrics()[name] || 0;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── TRASH 回收站 helper（2026-09-12）─────────────────────────────────────────
const relOf = (abs) => relative(repoRoot, abs).split(sep).join('/');
/** 读 `_index.md` 表行 → [{at, orig, size, why}]。**解析失败即抛**（不静默跳过，Invariants #14）。 */
function readTrashIndex() {
  if (!existsSync(TRASH_INDEX)) return [];
  const out = [];
  for (const line of readFileSync(TRASH_INDEX, 'utf8').split('\n')) {
    const m = /^\|\s*(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/.exec(line);
    if (m) out.push({ at: m[1], orig: m[2], size: m[3].trim(), why: m[4].trim() });
  }
  return out;
}
/** 追加一行到 `_index.md`（懒创建——`Memory §六` 的"首次移入时若无则建"）。 */
function appendTrashIndex(at, orig, size, why) {
  if (!existsSync(TRASH_INDEX)) {
    mkdirSync(TRASH, { recursive: true });
    writeFileSync(TRASH_INDEX, [
      '# TRASH 回收站索引',
      '',
      '> 「不删只移、可恢复」的落点（`Memory §六` / `§十一` 硬约束 4-5）。',
      '> **恢复 = 移回「原路径」**；本索引是唯一权威（`trash --restore <名>` 依它定位）。',
      '',
      '| 移入时间 | 原路径 | 体积 | 理由 |',
      '|---|---|---|---|',
      '',
    ].join('\n'));
  }
  appendFileSync(TRASH_INDEX, `| ${at} | \`${orig}\` | ${size} | ${why} |\n`);
}
function dirSize(p) {
  if (!existsSync(p)) return 0;
  if (!statSync(p).isDirectory()) return statSync(p).size;
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, e.name);
    n += e.isDirectory() ? dirSize(q) : statSync(q).size;
  }
  return n;
}
const humanSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
/** 移动文件 / 目录；跨盘 rename 抛 EXDEV → 退回 copy + rm。 */
function movePath(src, dst) {
  try { renameSync(src, dst); }
  catch (e) {
    if (e && e.code === 'EXDEV') { cpSync(src, dst, { recursive: true }); rmSync(src, { recursive: true, force: true }); }
    else throw e;
  }
}

const [cmd, ...rest] = process.argv.slice(2);

// 2026-09-11 修（第四轮盲评 · C2 的诚实指摘）：下面两步原来是**模块顶层无条件执行** —— 连
// `health` / `metrics` / `pending-invalid` / `rollback --list` 这些"只读子命令"也会 mkdirSync(SNAP)
// 并在 changelog 缺失时**新建**它，所谓"只读"并不成立。改为**按需**：只在真正要写盘的子命令上准备存储。
function ensureStore() {
  mkdirSync(SNAP, { recursive: true });
  if (!existsSync(LOG)) {
    writeFileSync(LOG, [
      '# 鱼鱼进化档案',
      '',
      '> 帧号式自我记忆：每次改「自我类」文件（AGENTS / mind 规则 / 技能 / 心智门禁）前，先快照旧版 + 记一条「为什么改 / 想解决什么」，改完观察效果，好则沉淀、坏则回滚。',
      '',
      '| 时间 | 对象 | 为什么改 | 改了啥 | 快照 |',
      '|---|---|---|---|---|',
      '',
    ].join('\n'));
  }
}
/** 只读子命令白名单（不建库、不写盘）。无参数 = 打印用法，同样不该建库。 */
const READ_ONLY_CMDS = new Set(['health', 'metrics', 'pending-invalid']);
const isReadOnlyRun = READ_ONLY_CMDS.has(cmd)
  || (cmd === 'rollback' && (rest[0] === '--list' || rest[0] === '-l'))
  || (cmd === 'trash' && (rest[0] === '--list' || rest[0] === '-l'))
  || cmd === undefined;
if (!isReadOnlyRun) ensureStore();

// 解析 changelog 行 → { date, obj, signal, baseline }（对象格支持「name[signal=N]」绑定主信号+基线）
function parseRow(line) {
  const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
  if (!m) return null;
  const objCell = m[2].trim();
  const sm = /^(.*?)\[([a-z-]+)=(\d+)\]$/.exec(objCell);
  if (!sm) return null;
  return { date: m[1], obj: sm[1], signal: sm[2], baseline: Number(sm[3]) };
}
// 该「对象+信号+基线」是否已判定过（去重键含基线 → 同对象可多次进化、多次判效）
function hasBackfill(obj, signal, baseline) {
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  return new RegExp(`\\|\\s*↳回测:${esc(obj)}\\s*\\|\\s*信号${esc(signal)} 基线${baseline}→`).test(src);
}
// 机器判定：读信号基线 → 现指标，按方向判有效/无效/恶化。只标不回滚。
function judge(parsed) {
  const now = metricNow(parsed.signal);
  const dir = METRIC_DIRECTION[parsed.signal] || 'up';
  let verdict;
  if (now === parsed.baseline) verdict = '无效';
  else if (dir === 'up') verdict = now > parsed.baseline ? '有效' : '恶化';
  else verdict = now < parsed.baseline ? '有效' : '恶化';
  return { now, dir, verdict };
}
function judgeAndRecord(parsed) {
  if (!parsed.signal) return { skipped: true, reason: 'no-signal（legacy-unbound，不机器判）' };
  // 2026-09-11（元进化·判据口径统一）：**人工记账信号（无自动采集点）不参与机器判效**。
  // 其值"不变"只说明没人记账，推不出"改动无效"——直接判会造假阴性（实测 3 条：
  // repeat-mistakes 1→1、redos 2→2 被判「无效/恶化」，实际信号根本没有采集点）。
  // health 早已定案「这类事件只作信息行、不参与报警」（2026-09-10），本条把**判效口径**与报警口径统一。
  if (!AUTO_COLLECTED.includes(parsed.signal)) {
    return { skipped: true, reason: `人工记账信号${parsed.signal}（无自动采集点）→ 不参与机器判效（口径同 health 报警）` };
  }
  const { now, verdict } = judge(parsed);
  const t = ts();
  const detail = `信号${parsed.signal} 基线${parsed.baseline}→现${now}`;
  appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳回测:${parsed.obj} | ${detail} | ${verdict}(机器判) | — |\n`);
  return { skipped: false, verdict, detail };
}
const verdictIcon = (v) => (v === '有效' ? '✅' : v === '恶化' ? '🔻' : '❌');
// 「快照」列解析（2026-09-10 修）：原来写的是**合成路径**（log 时刻 + 对象名清洗），
// 与 snapshot 实际落盘的文件名不同 → 老档案 60/68 行指向不存在的文件（悬空=号称可回滚实则无据）。
// 现在改为：按对象名（或首个标识词）在 snapshots\ 里找**真实快照文件**，找不到就写 —（诚实留空，不编路径）。
function snapshotRef(objName) {
  const base = String(objName).split('[')[0].trim();
  // 2026-09-13 修（假锚）：**匹配用 basename，与 snapshot 落盘口径（<ts>_<name>）对齐**。
  //   旧实现拿全路径做 safe（`mind/L1/Ritual.md` → `mind_L1_Ritual.md`）⇒ 永不命中快照名；
  //   回退 token 取"首个 ≥4 片段"又得到 `mind` ⇒ 撞上目录里 `*_mind-*.js` 的旧快照，
  //   写出**看似有据、实则无关**的锚点（比留空"—"更坏）。实测：带路径对象名 7/7 失效（4 假锚 + 3 留空）。
  const leaf = base.split(/[\\/]/).pop() || base;
  const safe = leaf.replace(/[\\/:*?"<>|]/g, '_');
  const token = (leaf.split(/[^a-zA-Z0-9_.-]+/).filter((s) => s.length >= 4)[0] || '');
  try {
    const files = readdirSync(SNAP).sort(); // 时间戳前缀 → 升序即时间序
    const hit = [...files].reverse().find((f) => f.includes(safe))
      || (token ? [...files].reverse().find((f) => f.includes(token)) : null);
    return hit ? `snapshots/${hit}` : '—';
  } catch { return '—'; }
}
// 解析「↳回测」行（对象/信号/基线/现值/判定）——pending-invalid 与 health 共用
function parseBackfills(src) {
  return src.split('\n').map((l) => {
    const m = /↳回测:([^|]+)\|\s*信号([a-z-]+)\s*基线(\d+)→现(\d+)\s*\|\s*(有效|无效|恶化)\(机器判\)/.exec(l);
    return m ? { obj: m[1].trim(), signal: m[2], baseline: +m[3], now: +m[4], verdict: m[5] } : null;
  }).filter(Boolean);
}
// 已人拍裁决的对象集合（↳裁决:<对象>）——裁决过的不再列为待裁决（闭环消费端）
function decidedObjects(src) {
  return new Set(src.split('\n').map((l) => (/↳裁决:([^|]+)\|/.exec(l) || [])[1]).filter(Boolean).map((s) => s.trim()));
}

if (cmd === 'snapshot') {
  const p = resolve(repoRoot, rest[0] || '');
  if (!existsSync(p)) { console.error('[evolve-log] 不存在:', p); process.exit(1); }
  const name = basename(p).replace(/[\\/:*?"<>|]/g, '_');
  const t = ts();
  const dst = join(SNAP, `${t}_${name}`);
  writeFileSync(dst, readFileSync(p, 'utf8'));
  const reason = (rest[1] || '').trim();
  if (reason) appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳快照:${basename(p)} | ${reason} | 快照旧版 | snapshots/${t}_${name} |\n`);
  console.log(`[evolve-log] 已快照 → ${dst}${reason ? '（理由:' + reason + '）' : ''}`);
} else if (cmd === 'rollback') {
  // ── 回滚（2026-09-11 新增；此前「无 rollback 子命令」= 号称可回滚实则手工拷回）──
  // 设计要点：① 回滚前**先给当前版本快照**——否则回滚动作本身不可回滚（"坏则回滚"必须对称，
  //   退错了还能再退回来）；② 只认 snapshots\ 里真实存在的文件，不合成路径（与 snapshotRef 同口径）；
  //   ③ 恢复即写入 + changelog 留痕 + 明确提示复验（回滚后必须 mind-validate，失败可再回滚）。
  const listOnly = rest[0] === '--list' || rest[0] === '-l';
  const target0 = (listOnly ? rest[1] : rest[0]) || '';
  const stamp = ((listOnly ? rest[2] : rest[1]) || '').trim();
  if (!target0) {
    console.error('用法: rollback <path> [<快照时间戳前缀>] | rollback --list <path>（不带时间戳 = 最近一次快照）');
    process.exit(1);
  }
  const p = resolve(repoRoot, target0);
  const name = basename(p).replace(/[\\/:*?"<>|]/g, '_');
  // 兼容 2026-09-11 之前的旧命名（非 ASCII 一律换成 _）：两种口径都试，避免老快照找不到
  const legacyName = basename(p).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const names = [...new Set([name, legacyName])];
  let snaps = [];
  try { snaps = readdirSync(SNAP).filter((f) => names.some((n) => f.endsWith(`_${n}`))).sort(); } catch { /* 无快照目录 */ }
  if (!snaps.length) {
    console.error(`[evolve-log] 未找到 ${basename(p)} 的快照（snapshots/ 下无 *_${name}）→ 无法回滚（快照只对 snapshot 过的文件可用）`);
    process.exit(1);
  }
  if (listOnly) {
    console.log(`[evolve-log] ${basename(p)} 的快照（新→旧）：`);
    for (const f of [...snaps].reverse()) console.log(`  ${f.slice(0, 19)}  snapshots/${f}`);
    process.exit(0);
  }
  const pick = stamp ? snaps.filter((f) => f.startsWith(stamp)).pop() : snaps[snaps.length - 1];
  if (!pick) {
    console.error(`[evolve-log] 无匹配时间戳「${stamp}」的快照 → 用 rollback --list ${target0} 看可用快照`);
    process.exit(1);
  }
  if (!existsSync(p)) {
    console.error(`[evolve-log] 目标文件当前不存在: ${p}（快照仍在 snapshots/${pick}，可手工恢复）`);
    process.exit(1);
  }
  const before = `${ts()}_${name}`;
  writeFileSync(join(SNAP, before), readFileSync(p, 'utf8'));   // ① 回滚前留档当前版本
  writeFileSync(p, readFileSync(join(SNAP, pick), 'utf8'));      // ② 恢复目标快照
  appendFileSync(LOG, `| ${ts().slice(0, 10)} | ↳回滚:${basename(p)} | 回滚到 snapshots/${pick} | 已恢复（回滚前版本留档 snapshots/${before}） | snapshots/${before} |\n`);
  console.log(`[evolve-log] 已回滚 ${basename(p)} ← snapshots/${pick}`);
  console.log(`[evolve-log] 回滚前版本已留档 → snapshots/${before}`);
  console.log(`[evolve-log] 反悔可再退：node scripts/evolve-log.mjs rollback ${target0} ${before.slice(0, 19)}`);
  console.log('[evolve-log] 下一步必做：node scripts\\mind-validate.mjs（回滚后复验，失败可再回滚）');
} else if (cmd === 'batch') {
  // 写前记账（2026-09-11，吸收 openhanako ②）：**多文件批次先记账再动手**。
  // 病灶：`snapshot` 是文件级的——一次改 7 个文件中途崩，"改到哪"没有记录，只能整批退。
  // 本命令 = 批量快照 + 写 journal（文件清单 + 每件快照名 + 起始时刻）；
  // 配 `batch-status` 按 mtime 判「已改/未改」，崩溃后可**续跑**或**逐件回滚**（rollback <file>）。
  const batchName = (rest[0] || '').trim();
  const batchFiles = rest.slice(1).map((s) => s.trim()).filter(Boolean);
  if (!batchName || !batchFiles.length) {
    console.error('[evolve-log] 用法: batch <批次名> <file1> [file2 ...]（先记账再动手）');
    process.exit(1);
  }
  const safeBatch = batchName.replace(/[\\/:*?"<>|]/g, '_');
  const startedAt = ts();
  mkdirSync(SNAP, { recursive: true });
  const entries = [];
  for (const rel of batchFiles) {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) { console.warn(`  ⚠️ 跳过（不存在）: ${rel}`); continue; }
    const nm = basename(abs).replace(/[\\/:*?"<>|]/g, '_');
    const snapFile = `${startedAt}_${nm}`;
    writeFileSync(join(SNAP, snapFile), readFileSync(abs, 'utf8'));
    entries.push({ path: rel.replace(/\\/g, '/'), snapshot: snapFile, mtime: statSync(abs).mtime.toISOString() });
    console.log(`  📸 ${rel} → snapshots/${snapFile}`);
  }
  if (!entries.length) { console.error('[evolve-log] 无有效文件，批次未建立'); process.exit(1); }
  mkdirSync(BATCH_DIR, { recursive: true });
  writeFileSync(join(BATCH_DIR, `${safeBatch}.json`),
    JSON.stringify({ name: batchName, startedAt, files: entries }, null, 2), 'utf8');
  console.log(`[evolve-log] 批次已记账: ${batchName}（${entries.length} 个文件）→ tasks/evolution/batches/${safeBatch}.json`);
  console.log(`[evolve-log] 中断后查进度: node scripts/evolve-log.mjs batch-status ${batchName}`);
} else if (cmd === 'batch-status') {
  // 判「改到哪」：文件 mtime 晚于**快照时刻**即视为已改（快照存的是改前版本，故 mtime 变化＝动过）。
  const want = (rest[0] || '').trim();
  if (!existsSync(BATCH_DIR)) { console.log('[evolve-log] 无批次记录（batches/ 尚未创建）'); process.exit(0); }
  const all = readdirSync(BATCH_DIR).filter((f) => f.endsWith('.json')).sort();
  const picks = want ? all.filter((f) => f === `${want.replace(/[\\/:*?"<>|]/g, '_')}.json`) : all;
  if (!picks.length) {
    console.error(`[evolve-log] 未找到批次「${want}」（可用: ${all.join(', ') || '无'}）`);
    process.exit(1);
  }
  for (const f of picks) {
    const rec = JSON.parse(readFileSync(join(BATCH_DIR, f), 'utf8'));
    console.log(`[evolve-log] 批次 ${rec.name}（${rec.startedAt} 起 · ${rec.files.length} 个文件）`);
    let done = 0;
    for (const e of rec.files) {
      const abs = resolve(repoRoot, e.path);
      if (!existsSync(abs)) { console.log(`  ❓ 已不存在  ${e.path}`); continue; }
      const now = statSync(abs).mtime.toISOString();
      const changed = now > e.mtime;
      if (changed) done++;
      console.log(`  ${changed ? '✅ 已改' : '⏳ 未改'}  ${e.path}${changed ? `  （mtime ${now.slice(11, 19)} > 快照 ${e.mtime.slice(11, 19)}）` : ''}`);
    }
    console.log(`  进度 ${done}/${rec.files.length}${done === rec.files.length ? ' ✅ 全部动过（可进入复核）' : ' ⏳ 中断可续跑：未改的从头做、已改的先复核'}`);
  }
} else if (cmd === 'entry-log') {
  const rel = (rest[0] || '').trim();
  const anchor = (rest[1] || '').trim();
  const why = (rest[2] || '').trim();
  if (!rel || !anchor) { console.error('用法: entry-log <文件相对路径> <锚点(小节标题)> "<理由>"'); process.exit(1); }
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) { console.error(`[evolve-log] 文件不存在: ${rel}`); process.exit(1); }
  const seg = extractAnchor(readFileSync(abs, 'utf8'), anchor);
  if (seg === null || !seg.trim()) {
    console.error(`[evolve-log] 锚点「${anchor}」在 ${rel} 里找不到（或为空）→ **拒绝记账**（记空段落会让回滚删内容）`);
    process.exit(1);
  }
  const id = entryId();
  appendLedger({
    id, kind: 'entry_replace', file: rel.replace(/\\/g, '/'), anchor, why,
    at: new Date().toISOString(), source: 'entry-log',
    before: { hash: entrySha(seg), text: seg }, after: null, writeId: `log:${id}`,
  });
  console.log(`[evolve-log] 已入账 ${id} → ${rel}#${anchor}（${seg.length} 字 · hash ${entrySha(seg)}）`);
  console.log(`[evolve-log] 改完后: node scripts/evolve-log.mjs entry-mark ${id}（启用冲突保护）`);
} else if (cmd === 'entry-mark') {
  const id = (rest[0] || '').trim();
  const all = readLedger();
  const hit = id === 'last' ? all[all.length - 1] : all.find((x) => x.id === id);
  if (!hit) { console.error(`[evolve-log] 未找到账目「${id}」（用 entry-list 看有哪些）`); process.exit(1); }
  const abs = resolve(repoRoot, hit.rec.file);
  const seg = existsSync(abs) ? extractAnchor(readFileSync(abs, 'utf8'), hit.rec.anchor) : null;
  if (seg === null) { console.error(`[evolve-log] 锚点「${hit.rec.anchor}」现在找不到了 → 拒绝标记（可能被删/改名）`); process.exit(1); }
  appendLedger({
    ...hit.rec, id: hit.id, kind: 'entry_mark', source: 'entry-mark',
    after: { hash: entrySha(seg), text: seg }, writeId: `mark:${hit.id}`, at: new Date().toISOString(),
  });
  console.log(`[evolve-log] 已标记 ${hit.id}：after hash ${entrySha(seg)}（此后当前段 ≠ 该值 → 拒绝回滚）`);
} else if (cmd === 'entry-list') {
  const all = readLedger();
  console.log(`[evolve-log] 账本 ${all.length} 条 → tasks/evolution/ledger.md`);
  for (const x of all) {
    console.log(`  ${x.id}  [${x.rec.kind}]  ${x.rec.file}#${x.rec.anchor}  before=${x.rec.before ? x.rec.before.hash : '—'} after=${x.rec.after ? x.rec.after.hash : '—'}`);
  }
} else if (cmd === 'entry-rollback') {
  const arg = (rest[0] || '').trim();
  const dry = rest.includes('--dry-run');
  const force = rest.includes('--force');
  const all = readLedger();
  const hit = arg === 'last' ? all[all.length - 1] : all.find((x) => x.id === arg);
  if (!hit) { console.error(`[evolve-log] 未找到账目「${arg}」（用 entry-list）`); process.exit(1); }
  if (hit.rec.kind === 'entry_rollback') {
    console.error('[evolve-log] 拒绝回滚一条**回滚记录**（灵枢纪律：撤销不可叠撤销）');
    process.exit(1);
  }
  if (!hit.rec.before) { console.error('[evolve-log] 该账目无 before 快照 → 不可回滚'); process.exit(1); }
  const abs = resolve(repoRoot, hit.rec.file);
  if (!existsSync(abs)) { console.error(`[evolve-log] 目标文件不存在: ${hit.rec.file}`); process.exit(1); }
  const cur = readFileSync(abs, 'utf8');
  const seg = extractAnchor(cur, hit.rec.anchor);
  if (seg === null) { console.error(`[evolve-log] 锚点「${hit.rec.anchor}」找不到 → 拒绝回滚`); process.exit(1); }
  const curHash = entrySha(seg);
  if (curHash === hit.rec.before.hash) {
    console.log(`[evolve-log] ⏭ 跳过：当前段 hash ${curHash} 已等于 before（无事可做 / 已回滚过）`);
    process.exit(0);
  }
  if (hit.rec.after && curHash !== hit.rec.after.hash && !force) {
    console.error(`[evolve-log] ❌ 冲突：当前段 hash ${curHash} ≠ after ${hit.rec.after.hash} → **拒绝回滚**（防覆盖后续人工修改）`);
    console.error('[evolve-log] 确认要丢弃这些改动就加 --force。');
    process.exit(1);
  }
  console.log(`[evolve-log] ${dry ? '[dry-run] ' : ''}将回滚 ${hit.id}：${hit.rec.file}#${hit.rec.anchor}`);
  console.log(`  当前 ${curHash} → 目标 ${hit.rec.before.hash}（${hit.rec.before.text.length} 字）`);
  if (dry) process.exit(0);
  const next = cur.replace(seg, hit.rec.before.text);
  if (next === cur) { console.error('[evolve-log] 替换未产生变化 → 中止（防写坏）'); process.exit(1); }
  writeFileSync(abs, next, 'utf8');
  appendLedger({
    ...hit.rec, id: entryId(), kind: 'entry_rollback', source: 'entry-rollback',
    before: { hash: curHash, text: seg }, after: hit.rec.before,
    rollbackOf: hit.id, writeId: `rollback:${hit.id}:${hit.rec.before.hash}`, at: new Date().toISOString(),
  });
  console.log(`[evolve-log] ✅ 已回滚 ${hit.rec.file}#${hit.rec.anchor}（**回滚自身也入账**）`);
  console.log('[evolve-log] 下一步必做：node scripts\\mind-validate.mjs');
} else if (cmd === 'log') {
  // ── 参数校验（2026-09-10 修）：参数为空 / 字段不足 / 首字段为空 → 原来会静默写一条垃圾行 `| x | | |`
  //    （实测踩到：`node scripts/evolve-log.mjs log` 无参数时直接回「已记录: x」）→ 改为报用法并拒绝写入。──
  const rawLog = (rest[0] || '').trim();
  const parts = rawLog.split('|').map((s) => s.trim());
  if (!rawLog || !parts[0] || parts.length < 3) {
    console.error('[evolve-log] 用法: log "<信号>|<对象>|<为什么改>|<改了啥>"（不绑信号则 "<对象>|<为什么改>|<改了啥>"）；当前参数为空或字段不足 → 拒绝写入（防静默写垃圾记录）');
    process.exit(1);
  }
  const t = ts();
  const today = t.slice(0, 10);
  // ── 信号名归一化校验（2026-09-10：原来是静默降级，误写 [corrections] → 记录"成功"但绑定全丢）──
  const rawHead = (parts[0] || '').trim();
  const normHead = rawHead.replace(/^[\[【(（\s]+|[\]】)）\s]+$/g, '').toLowerCase();
  let head = rawHead;
  if (KNOWN_METRICS.includes(normHead) && rawHead !== normHead) {
    head = normHead;
    console.warn(`[evolve-log] ⚠️ 信号名「${rawHead}」不规范 → 已自动纠正为「${head}」（历史事故：写成 [corrections] 会静默丢绑定，记录看起来像成功）`);
  } else if (rawHead && !KNOWN_METRICS.includes(rawHead) && !parts[1]) {
    // 单字段（无对象）：疑似把信号写成了别的样子
    console.warn(`[evolve-log] ⚠️ 首字段「${rawHead}」不是已知信号（可用: ${KNOWN_METRICS.join(', ')}）——按普通对象名记录。`);
  }
  let objCell = head || 'x';
  const signalBound = KNOWN_METRICS.includes(head) && !!parts[1];
  if (signalBound) {
    const base = metricNow(head);
    objCell = `${parts[1]}[${head}=${base}]`;
  }
  const why = parts[signalBound ? 2 : 1] || '';
  const what = parts[signalBound ? 3 : 2] || '';
  const snapRef = snapshotRef(objCell);
  appendFileSync(LOG, `| ${today} | ${objCell} | ${why} | ${what} | ${snapRef} |\n`);
  console.log(`[evolve-log] 已记录: ${objCell}${signalBound ? '（绑定主信号+记基线）' : ''}`);
  if (snapRef === '—') console.warn('[evolve-log] ⚠️ 未找到对应快照文件 → 「快照」列记 —（改自我类文件前请先 `snapshot <file> "<理由>"`，否则这条不可回滚）');
  if (!signalBound) {
    console.warn('[evolve-log] ⚠️ 本条未绑主信号 → 后续 `effect` 无法机器判效（只会自评）。能绑就绑：log "<信号>|<对象>|<为什么改>|<改了啥>"');
  }
} else if (cmd === 'effect') {
  // auto=<对象> 单判；auto=全部可判；否则为自评（标 自评，非机器判）
  const arg0 = (rest[0] || '').trim();
  const arg1 = (rest[1] || '').trim();
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  if (arg0 === 'auto' || arg1 === 'auto') {
    const rows = src.split('\n').map(parseRow).filter(Boolean);
    const target = arg0 === 'auto' ? rows : rows.filter((r) => r.obj === arg0);
    const today = ts().slice(0, 10);
    let done = 0, skipped = 0;
    for (const r of target) {
      // 观察期守卫（2026-09-10 收工 step8 实测）：同日记录的进化**还没到能看出效果的时候**——
      // 直接判会造出"无效(机器判)"的假阴性（实测 dshome-diagnostics repeat-mistakes 1→1）。
      // 进化改完至少要跨一天再判，否则机器判分不清"没效果"和"还看不出效果"。
      if (r.date >= today) { skipped++; console.log(`  ⏳ ${r.obj}: 观察期未到（${r.date} 当日记录，至少隔日再判）`); continue; }
      if (hasBackfill(r.obj, r.signal, r.baseline)) { console.log(`  ⏭ ${r.obj}（信号${r.signal} 基线${r.baseline}）已有回测，跳过`); continue; }
      const res = judgeAndRecord(r);
      if (res.skipped) { skipped++; console.log(`  ⏭ ${r.obj}: ${res.reason}`); }
      else { done++; console.log(`  ${verdictIcon(res.verdict)} ${r.obj}: ${res.verdict}(机器判) — ${res.detail}`); }
    }
    console.log(`[evolve-log] effect 机器判定完成：判定 ${done} 条 · 跳过 ${skipped} 条`);
  } else {
    // 旧式自评（保留兼容，但标记自评——非机器判，不计入"机器判无效"口径）
    const [obj, observed, verdict] = (arg0 || '').split('|');
    const t = ts();
    const detail = (observed || '') ? `(自评) ${observed}` : '(自评) 人工判定';
    appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳回测:${obj || ''} | ${detail} | ${verdict || ''} | — |\n`);
    console.log(`[evolve-log] 已回填(自评): ${obj} → ${verdict}（标 自评，非机器判）`);
  }
} else if (cmd === 'decide') {
  // 人拍裁决留痕（闭环消费端）。agent 只【转录主人】的决定，不得自裁。
  const obj = (rest[0] || '').trim();
  const verdict = (rest[1] || '').trim();
  const reason = (rest[2] || '').trim();
  const ALLOWED = ['留观', '回滚', '改进化'];
  if (!obj || !ALLOWED.includes(verdict)) {
    console.error(`[evolve-log] 用法: decide <对象> <${ALLOWED.join('|')}> "<理由>"（裁决由主人拍板，本命令只转录）`);
    process.exit(1);
  }
  const t = ts();
  appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳裁决:${obj} | ${reason || '—'} | ${verdict}(人拍) | — |\n`);
  console.log(`[evolve-log] 已记录人拍裁决: ${obj} → ${verdict}（此后 pending-invalid 不再列为待裁决）`);
} else if (cmd === 'lesson-scan') {
  // 教训复发扫描（2026-09-11 元进化）：给 repeat-mistakes 提供**可跑的采集点**。
  // 背景：Memory §五 要求「同主题踩坑 ≥3 → 触发蒸馏」，但 repeat-mistakes 属人工记账信号
  // （health 自述"无自动采集点"）→ 复发次数从来没被数过 → 阈值永不触发 → 蒸馏机制形同虚设。
  // 口径：只数**自述复发**的条目（第N次/同类/复发/重蹈/再次），**不假装能语义判定"同主题"**。
  const LEARN = join(repoRoot, 'mind-private', 'L1', 'Learn.md');
  if (!existsSync(LEARN)) { console.error('[evolve-log] 找不到 Learn.md:', LEARN); process.exit(1); }
  const learnLines = readFileSync(LEARN, 'utf8').split('\n');
  const entries = learnLines.filter((l) => /^\s*-\s*\[20\d\d-\d\d-\d\d\]/.test(l));
  const RELAPSE = /第\s*\d+\s*[次例]|同类|复发|重蹈|再次/;
  const relapsed = entries.filter((l) => RELAPSE.test(l));
  console.log(`[evolve-log] 教训复发扫描（Learn.md 共 ${entries.length} 条）`);
  console.log(`  ↗ 自述复发 ${relapsed.length} 条（口径：第N次/同类/复发/重蹈/再次；只数自述，不做语义判定）`);
  for (const l of relapsed) {
    const m = /^\s*-\s*\[(20\d\d-\d\d-\d\d)\]\s*(.*)$/.exec(l);
    const txt = (m ? m[2] : l).replace(/\*\*/g, '').trim();
    console.log(`    [${m ? m[1] : '?'}] ${txt.slice(0, 86)}${txt.length > 86 ? '…' : ''}`);
  }
  if (relapsed.length >= 3) {
    console.log('  ⚠️ 自述复发 ≥3 → 按 Memory §五 应触发**蒸馏**（同主题踩坑 ≥3 → 落 L3 / 提炼 Skill）');
    process.exitCode = 1;
  } else {
    console.log('  ✅ 自述复发 <3，未到蒸馏阈值');
  }
} else if (cmd === 'bump') {
  const metric = (rest[0] || '').trim();
  if (!KNOWN_METRICS.includes(metric)) {
    console.error(`[evolve-log] 未知指标: ${metric}（可用: ${KNOWN_METRICS.join(', ')}）`);
    process.exit(1);
  }
  const m = readMetrics();
  m[metric] = (m[metric] || 0) + 1;
  writeMetrics(m);
  console.log(`[evolve-log] bump ${metric} → ${m[metric]}`);
} else if (cmd === 'metrics') {
  const m = readMetrics();
  console.log('[evolve-log] 可测信号（发生事件时 bump 记账）:');
  for (const k of KNOWN_METRICS) {
    console.log(`  ${k}: ${m[k] || 0}（方向:${METRIC_DIRECTION[k] === 'up' ? '越高越好' : '越低越好'}${AUTO_COLLECTED.includes(k) ? '·自动采集' : '·人工记账'}）`);
  }
} else if (cmd === 'pending-invalid') {
  // 机器判「无效/恶化」且【未人拍】的条目 → 收工第 9 步裁决（留观/回滚/改进化）。机器只标，不自动回滚。
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const decided = decidedObjects(src);
  const rows = parseBackfills(src).filter((r) => (r.verdict === '无效' || r.verdict === '恶化') && !decided.has(r.obj));
  if (!rows.length) {
    // 2026-09-11 修（第四轮盲评 · C2 的实测指摘）：原来无条件打印「无（无未裁决…）」——
    // 而实测 `health` 报「已回填 **0** 条」，即**判效从来没产出过任何裁决**。两者都显示"无"，
    // 看着像"全清"，实际是"机制没跑起来"。现在把这两种状态分开说。
    const verdictCount = parseBackfills(src).length;
    console.log(verdictCount === 0
      ? '[evolve-log] pending-invalid: ⚠️ **从未有过机器判效**（回测行 0 条）—— 这不是"没有待裁决"，而是"判效机制没跑起来"：先 `effect auto` 判一批，或给进化补绑主信号'
      : '[evolve-log] pending-invalid: 无（无未裁决的机器判「无效/恶化」）');
  }
  else {
    console.log('[evolve-log] pending-invalid（未裁决 → 收工第9步人拍：留观/回滚/改进化）:');
    for (const r of rows) console.log(`  📌 ${r.obj} | 信号${r.signal} 基线${r.baseline}→现${r.now} | ${r.verdict}(机器判)`);
    console.log('  裁决后记账：node scripts/evolve-log.mjs decide "<对象>" <留观|回滚|改进化> "<理由>"');
  }
} else if (cmd === 'health') {
  // 自主元进化：智能体做事/进化中自己跑它，命中信号 → 自主触发元进化（不等收工/用户）
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const rows = src.split('\n').filter((l) => l.startsWith('|') && !l.includes('时间') && !l.startsWith('|---') && !l.startsWith('| ---'));
  const snapRows = rows.filter((l) => /\|\s*↳快照:/.test(l)).length;
  // 真正的进化对象行：排除一切 ↳ 派生行（快照/回测/纠偏/裁决——原来只排前两种，↳纠偏 被误算成进化）
  const objectRows = rows.filter((l) => !/\|\s*↳/.test(l));
  const isSignalBound = (l) => /\[[a-z-]+=\d+\]/.test(l);
  const machineRows = objectRows.filter(isSignalBound);
  const legacyUnbound = objectRows.length - machineRows.length;
  const logRows = objectRows.length;
  const backfills = parseBackfills(src);
  const decided = decidedObjects(src);
  // 未回填 = 绑了信号但还没有对应回测行（去重键 对象+信号+基线）
  const unwrapped = machineRows.filter((l) => {
    const r = parseRow(l);
    if (!r) return false;
    return !new RegExp(`\\|\\s*↳回测:${esc(r.obj)}\\s*\\|\\s*信号${esc(r.signal)} 基线${r.baseline}→`).test(src);
  }).length;
  const invalidAll = backfills.filter((r) => r.verdict === '无效').length;
  const worsenedAll = backfills.filter((r) => r.verdict === '恶化').length;
  const pending = backfills.filter((r) => (r.verdict === '无效' || r.verdict === '恶化') && !decided.has(r.obj)).length;
  const selfInvalid = (src.match(/↳回测:[^\n]*\|[^\n]*\|[^\n]*无效\|/g) || []).length;
  const m = readMetrics();
  const backfilled = backfills.length;
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const recentRows = objectRows.filter((l) => {
    const d = (/^\|\s*(\d{4}-\d{2}-\d{2})/.exec(l) || [])[1];
    return d && d >= cutoff;
  }).length;
  const coverage = logRows ? Math.round((machineRows.length / logRows) * 100) : 0;
  // 新账口径（2026-09-10）：绑主信号从这天起成为要求；此前的存量按 legacy-unbound 政策封存不追。
  // 覆盖率若按全库存量算（分母含 68 条封存旧账）会**永远低于阈值**=又造一盏恒亮灯——所以报警只看新账。
  const newRows = objectRows.filter((l) => {
    const d = (/^\|\s*(\d{4}-\d{2}-\d{2})/.exec(l) || [])[1];
    return d && d >= BINDING_SINCE;
  });
  const newBound = newRows.filter(isSignalBound).length;
  const newCoverage = newRows.length ? newBound / newRows.length : 1;
  console.log('[evolve-log] 元进化（自主信号）:');
  console.log(`  进化记录 ${logRows} 条（近7天 ${recentRows} 条 · 另 ↳快照 ${snapRows} 行不计）· 判效覆盖 ${machineRows.length}/${logRows} = ${coverage}%（其中新账 ≥${BINDING_SINCE}：${newBound}/${newRows.length}）· 已回填 ${backfilled} 条 · 未回填 ${unwrapped} 条 · 封存 legacy-unbound ${legacyUnbound} 条(不追不洗)`);
  console.log(`  机器判 无效 ${invalidAll} / 恶化 ${worsenedAll}（未裁决 ${pending}·已人拍 ${invalidAll + worsenedAll - pending}）· 自评回填 ${selfInvalid} 条`);
  const manualMetrics = KNOWN_METRICS.filter((k) => !AUTO_COLLECTED.includes(k));
  console.log(`  ℹ️ 信号：${KNOWN_METRICS.map((k) => `${k}=${m[k] || 0}${AUTO_COLLECTED.includes(k) ? '' : '(人工)'}`).join(' · ')}`);
  console.log(`  ℹ️ 无自动采集点（人工记账·不参与报警）：${manualMetrics.join(', ')}——2026-09-10 定案：这类事件无机器可测信号（只能自报），故只作信息行；发生当下 bump 一笔即可（依据见 limits.md）`);
  // 新账覆盖率只作信息行（2026-09-10 自检，判据①"报警必须能熄灭"）：大量进化（文档/UX/结构类）
  // **天生没有可测信号**，"绑满 50%"不是能可靠做到的动作 → 当 ⚠️ 会退化成又一盏恒亮灯。⚠️ 只留"判效空转"。
  if (newRows.length && newCoverage < 0.5) {
    console.log(`  ℹ️ 新账判效覆盖 ${newBound}/${newRows.length}（<50%）——多数进化天生无信号，绑得上的就绑，绑不上属正常（不报警）`);
  }
  let hit = false;
  if (machineRows.length === 0 && logRows >= 8) { console.log('  ⚠️ 判效空转：一条信号绑定都没有 → 机器判效形同虚设，改自我类文件时请绑主信号'); hit = true; }
  if (unwrapped >= 5) { console.log(`  ⚠️ 未回填 ${unwrapped} 条（≥5）→ 该回填 effect（机器判），别只记不改`); hit = true; }
  if (pending >= 2) { console.log(`  ⚠️ 未裁决 无效/恶化 ≥2（现 ${pending} 条）→ 元进化：人拍留观/回滚/改进化`); hit = true; }
  if (logRows >= 8 && (m['repeat-mistakes'] || 0) >= 2) { console.log('  ⚠️ 改得多却重复踩坑 → 审视进化是否有效'); hit = true; }
  if (!hit) console.log('  ✅ 机制健康，无需自省');
  // 2026-09-11 修（第四轮盲评 · C2）：本工具此前**永远 exit 0**（无任何失败路径）——
  // 典型"看起来在检查、实际不阻塞"。现在有真报警时置 exitCode=1，让调用方
  // （agent 自主巡检 / 脚本 / 未来的 hook）能感知"自检要求元进化"。
  if (hit) process.exitCode = 1;
} else if (cmd === 'trash') {
  // 三种形态：trash <path...> --reason "…"（移入）| trash --list（看）| trash --restore <名>（移回）
  const sub = rest[0];
  if (sub === '--list' || sub === '-l') {
    const rows = readTrashIndex();
    if (!rows.length) console.log(`[evolve-log] TRASH 为空（${TRASH}）——「不删只移」尚无动作。`);
    else {
      console.log(`[evolve-log] TRASH 索引 ${rows.length} 条（${TRASH}）：`);
      for (const r of rows) console.log(`  · ${r.at}  ${r.size}  ${r.orig}  ← ${r.why}`);
    }
  } else if (sub === '--restore' || sub === '-r') {
    const key = rest[1];
    if (!key) { console.error('[evolve-log] ❌ --restore 需要 <名|原路径>（先用 --list 看）'); process.exit(1); }
    const rows = readTrashIndex();
    const hits = rows.filter((r) => r.orig === key || basename(r.orig) === key || r.orig.endsWith('/' + key));
    // 不猜：找不到就响亮失败；命中多条也拒绝（歧义不替用户选）
    if (!hits.length) { console.error(`[evolve-log] ❌ TRASH 索引里找不到「${key}」——不做模糊恢复，先 --list`); process.exit(1); }
    if (hits.length > 1) { console.error(`[evolve-log] ❌ 命中 ${hits.length} 条，名字有歧义，请给完整原路径：\n  ${hits.map((h) => h.orig).join('\n  ')}`); process.exit(1); }
    const r = hits[0];
    const src = join(TRASH, `${r.at}__${basename(r.orig)}`);
    const dst = join(repoRoot, r.orig);
    if (!existsSync(src)) { console.error(`[evolve-log] ❌ 回收站里没有实体：${src}（索引与磁盘不一致）`); process.exit(1); }
    if (existsSync(dst)) { console.error(`[evolve-log] ❌ 原路径已被占用，拒绝覆盖：${dst}`); process.exit(1); }
    mkdirSync(dirname(dst), { recursive: true });
    movePath(src, dst);
    // 索引不删行：划掉 + 记恢复时刻（留痕；「撤销不可静默」口径同 entry-rollback）
    const before = readFileSync(TRASH_INDEX, 'utf8');
    writeFileSync(TRASH_INDEX, before.replace(`| ${r.at} | \`${r.orig}\` |`, `| ${r.at} | ~~\`${r.orig}\`~~（已恢复 ${ts()}） |`));
    appendFileSync(LOG, `| ${ts().slice(0, 10)} | ↳恢复:${basename(r.orig)} | 从 TRASH 移回原路径 | ${r.orig} | — |\n`);
    console.log(`[evolve-log] ↩️ 已恢复 → ${r.orig}（${r.size}）`);
  } else {
    // 移动模式：解析 --reason（缺理由 = 拒绝，硬约束 5）
    const ri = rest.indexOf('--reason');
    const reason = ri >= 0 ? rest[ri + 1] : null;
    // ⚠️ 只有**真的给了** --reason 才排除它的值：`ri = -1`（没给）时 `i !== ri+1` 等价于 `i !== 0`
    //    → 会把 rest[0] 的路径也吃掉，于是报"用法"而不是"必须给 --reason"（A2 测试 T2 实测抓到的 bug）。
    const paths = rest.filter((a, i) => !(ri >= 0 && (i === ri || i === ri + 1)) && !a.startsWith('-'));
    if (!paths.length) { console.error('用法: trash <path...> --reason "<为什么>" | trash --list | trash --restore <名>'); process.exit(1); }
    if (!reason || !String(reason).trim()) { console.error('[evolve-log] ❌ 必须给 --reason "<为什么>"（§十一 硬约束 5：裁剪 / 退役动作要留痕）'); process.exit(1); }
    mkdirSync(TRASH, { recursive: true });
    let ok = 0;
    for (const p of paths) {
      const abs = resolve(repoRoot, p);
      if (!existsSync(abs)) { console.error(`[evolve-log] ❌ 不存在，拒绝静默跳过：${p}`); process.exitCode = 1; continue; }
      const at = ts();
      const dst = join(TRASH, `${at}__${basename(abs)}`);
      if (existsSync(dst)) { console.error(`[evolve-log] ❌ 回收站已存在同名，拒绝覆盖：${dst}`); process.exitCode = 1; continue; }
      const size = dirSize(abs);
      movePath(abs, dst);
      appendTrashIndex(at, relOf(abs), humanSize(size), reason);
      appendFileSync(LOG, `| ${at.slice(0, 10)} | ↳退役:${basename(abs)} | ${reason} | 移入 TRASH（不删只移） | — |\n`);
      console.log(`  🗑 ${relOf(abs)}  →  TRASH/${basename(abs)}  (${humanSize(size)})`);
      ok++;
    }
    console.log(`[evolve-log] 已移入 TRASH ${ok}/${paths.length} 项 · 理由：${reason}`);
  }
} else {
  console.error('用法: snapshot <path> | rollback <path> [<快照时间戳前缀>] | rollback --list <path> | log "<[信号]|对象|why|what>" | effect <对象> auto | effect auto | effect "<对象>|<观察>|<verdict>" | decide <对象> <留观|回滚|改进化> "<理由>" | bump <信号> | metrics | health | pending-invalid | lesson-scan | batch <名> <file...> | batch-status [<名>] | entry-log <file> <anchor> "<why>" | entry-mark <id|last> | entry-list | entry-rollback <id|last> [--dry-run] [--force] | trash <path...> --reason "<为什么>" | trash --list | trash --restore <名>');
  process.exit(1);
}
