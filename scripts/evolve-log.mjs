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
//   node scripts/evolve-log.mjs rollback <path> [<快照时间戳前缀>]            # 回滚到最近/指定快照（回滚前自动留档当前版本）
//   node scripts/evolve-log.mjs rollback --list <path>                       # 列出该文件全部快照（新→旧）
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
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const EVO = join(repoRoot, 'mind-private', 'tasks', 'evolution');
const SNAP = join(EVO, 'snapshots');
const LOG = join(EVO, 'changelog.md');
const METRICS = join(EVO, 'metrics.json');
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

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
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');
  const token = (base.split(/[^a-zA-Z0-9_.-]+/).filter((s) => s.length >= 4)[0] || '');
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
  // 自主元进化自检：鱼鱼做事/进化中自己跑它，命中信号 → 自主触发元进化（不等收工/用户）
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
  console.log('[evolve-log] 元进化自检（自主信号）:');
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
  if (!hit) console.log('  ✅ 机制健康，无需元进化');
  // 2026-09-11 修（第四轮盲评 · C2）：本工具此前**永远 exit 0**（无任何失败路径）——
  // 典型"看起来在检查、实际不阻塞"。现在有真报警时置 exitCode=1，让调用方
  // （agent 自主巡检 / 脚本 / 未来的 hook）能感知"自检要求元进化"。
  if (hit) process.exitCode = 1;
} else {
  console.error('用法: snapshot <path> | rollback <path> [<快照时间戳前缀>] | rollback --list <path> | log "<[信号]|对象|why|what>" | effect <对象> auto | effect auto | effect "<对象>|<观察>|<verdict>" | decide <对象> <留观|回滚|改进化> "<理由>" | bump <信号> | metrics | health | pending-invalid');
  process.exit(1);
}
