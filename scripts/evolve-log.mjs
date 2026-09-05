// scripts/evolve-log.mjs — 鱼鱼进化档案：快照 + 变更日志（帧号式自我记忆）
// 模仿 CH4 的 CHANGELOG/design-status 思路：每次改"自我类"文件（AGENTS/mind 规则/技能/心智门禁）
// 前，先快照旧版 + 记一条理由——进化有据可查、可回滚。
//
// 用法：
//   node scripts/evolve-log.mjs snapshot <path> "<理由>"                    # 快照旧版 → evolution/snapshots/<ts>_<name>
//   node scripts/evolve-log.mjs log "<信号>|<对象>|<为什么改>|<改了啥>"        # 首个字段=KNOWN_METRIC 则绑定主信号+记基线
//   node scripts/evolve-log.mjs log "<对象>|<为什么改>|<改了啥>"              # 无信号（旧用法/legacy-unbound）
//   node scripts/evolve-log.mjs effect <对象> auto                          # 机器判定单个（读信号基线比对）
//   node scripts/evolve-log.mjs effect auto                                 # 机器判定全部可判（去自评）
//   node scripts/evolve-log.mjs effect "<对象>|<观察>|<verdict>"             # 兼容自评（标 自评，非机器判）
//   node scripts/evolve-log.mjs bump <信号> | metrics | health | pending-invalid
//
// P1（2026-09-05）effect 判定机械化：去掉"自评有效"——verdict 默认由机器读主信号基线得出。
//   无效 ≠ 自动回滚：机器只标记，回滚/改进化由用户拍板（收工第 9 步挂出 pending-invalid）。
//
// 存储：mind-private/tasks/evolution/（隐私，不推送）
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const EVO = join(repoRoot, 'mind-private', 'tasks', 'evolution');
const SNAP = join(EVO, 'snapshots');
const LOG = join(EVO, 'changelog.md');
const METRICS = join(EVO, 'metrics.json');
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// 可测信号（进化关联指标）——发生事件时 bump 记一笔，回填时读变化
const KNOWN_METRICS = ['repeat-mistakes', 'corrections', 'rejections', 'redos', 'search-hit'];
function readMetrics() {
  try { return JSON.parse(readFileSync(METRICS, 'utf8')).metrics || {}; }
  catch { return {}; }
}
function writeMetrics(m) {
  mkdirSync(EVO, { recursive: true });
  writeFileSync(METRICS, JSON.stringify({ metrics: m, updatedAt: new Date().toISOString() }, null, 2));
}
const metricNow = (name) => readMetrics()[name] || 0;

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

const [cmd, ...rest] = process.argv.slice(2);

// 解析 changelog 行 → { date, obj, signal, baseline }（对象格支持「name[signal=N]」绑定主信号+基线）
function parseRow(line) {
  const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
  if (!m) return null;
  const objCell = m[2].trim();
  const sm = /^(.*?)\[([a-z-]+)=(\d+)\]$/.exec(objCell);
  if (!sm) return null;
  return { date: m[1], obj: sm[1], signal: sm[2], baseline: Number(sm[3]) };
}
// 该对象是否已有 ↳回测 行（已判定过）
function hasBackfill(obj) {
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  return new RegExp(`\\|\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\|\\s*↳回测:${obj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`).test(src);
}

// 机器判定：读信号基线 → 现指标，无变化=无效(机器判)，有变化=有效(机器判)。只标不回滚。
function judgeAndRecord(parsed) {
  if (!parsed.signal) return { skipped: true, reason: 'no-signal（legacy-unbound，不机器判）' };
  const now = metricNow(parsed.signal);
  const verdict = now === parsed.baseline ? '无效' : '有效';
  const t = ts();
  const detail = `信号${parsed.signal} 基线${parsed.baseline}→现${now}`;
  appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳回测:${parsed.obj} | ${detail} | ${verdict}(机器判) | — |\n`);
  return { skipped: false, verdict, detail };
}

if (cmd === 'snapshot') {
  const p = resolve(repoRoot, rest[0] || '');
  if (!existsSync(p)) { console.error('[evolve-log] 不存在:', p); process.exit(1); }
  const name = basename(p).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const t = ts();
  const dst = join(SNAP, `${t}_${name}`);
  writeFileSync(dst, readFileSync(p, 'utf8'));
  const reason = (rest[1] || '').trim();
  if (reason) appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳快照:${basename(p)} | ${reason} | 快照旧版 | snapshots/${t}_${name} |\n`);
  console.log(`[evolve-log] 已快照 → ${dst}${reason ? '（理由:' + reason + '）' : ''}`);
} else if (cmd === 'log') {
  const parts = (rest[0] || '').split('|');
  const t = ts();
  const today = t.slice(0, 10);
  // 首字段若为 KNOWN_METRIC → 绑定主信号 + 记基线（对象格：name[signal=base]）
  const head = (parts[0] || '').trim();
  let objCell = parts[0] || 'x';
  if (KNOWN_METRICS.includes(head) && parts[1]) {
    const base = metricNow(head);
    objCell = `${parts[1]}[${head}=${base}]`;
  }
  const safe = (objCell.split('[')[0] || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const why = parts[KNOWN_METRICS.includes(head) ? 2 : 1] || '';
  const what = parts[KNOWN_METRICS.includes(head) ? 3 : 2] || '';
  appendFileSync(LOG, `| ${today} | ${objCell} | ${why} | ${what} | snapshots/${t}_${safe} |\n`);
  console.log(`[evolve-log] 已记录: ${objCell}${KNOWN_METRICS.includes(head) ? '（绑定主信号+记基线）' : ''}`);
} else if (cmd === 'effect') {
  // auto=<对象> 单判；auto=全部可判；否则为自评（标 自评，非机器判）
  const arg0 = (rest[0] || '').trim();
  const arg1 = (rest[1] || '').trim();
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  if (arg0 === 'auto' || arg1 === 'auto') {
    const rows = src.split('\n').map(parseRow).filter(Boolean);
    const target = arg0 === 'auto' ? rows : rows.filter((r) => r.obj === arg0);
    let done = 0, skipped = 0;
    const seen = new Set();
    for (const r of target) {
      if (seen.has(r.obj)) continue; // 同名对象只判首个
      seen.add(r.obj);
      if (hasBackfill(r.obj)) { console.log(`  ⏭ ${r.obj} 已有回测，跳过`); continue; }
      const res = judgeAndRecord(r);
      if (res.skipped) { skipped++; console.log(`  ⏭ ${r.obj}: ${res.reason}`); }
      else { done++; console.log(`  ${res.verdict === '无效' ? '❌' : '✅'} ${r.obj}: ${res.verdict}(机器判) — ${res.detail}`); }
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
  for (const k of KNOWN_METRICS) console.log(`  ${k}: ${m[k] || 0}`);
} else if (cmd === 'pending-invalid') {
  // 机器判「无效」但未定夺的条目 → 供收工第 9 步人拍（留观/回滚/改进化）。机器只标，不自动回滚。
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const rows = src.split('\n').filter((l) => /↳回测:[^\n]*无效\(机器判\)/.test(l));
  if (!rows.length) { console.log('[evolve-log] pending-invalid: 无（本周期无机器判「无效」待人拍）'); }
  else {
    console.log(`[evolve-log] pending-invalid（机器判「无效」待人拍 → 收工第9步:留观/回滚/改进化）:`);
    for (const l of rows) console.log(`  📌 ${l.trim()}`);
  }
} else if (cmd === 'health') {
  // 自主元进化自检：鱼鱼做事/进化中自己跑它，命中信号 → 自主触发元进化（不等收工/用户）
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const rows = src.split('\n').filter((l) => l.startsWith('|') && !l.includes('时间') && !l.startsWith('|---') && !l.startsWith('| ---'));
  const snapRows = rows.filter((l) => /\|\s*↳快照:/.test(l)).length;
  const objectRows = rows.filter((l) => !/\|\s*↳(快照|回测):/.test(l)); // 真正的进化对象行（非快照/非回测）
  const backfilledObjs = new Set(rows.map((l) => (/\|\s*↳回测:([^|\s]+)/.exec(l) || [])[1]).filter(Boolean));
  // 机判可判 = 对象行带 [signal= 绑定（机器判依据主信号）；无绑定 = 旧行（legacy-unbound，封存不追——不洗存量）
  const isSignalBound = (l) => /\[[a-z-]+=\d+\]/.test(l);
  const machineRows = objectRows.filter(isSignalBound);
  const legacyUnbound = objectRows.length - machineRows.length;
  const logRows = objectRows.length;
  const unwrapped = machineRows.filter((l) => {
    const m = /^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*([^|\[]+)/.exec(l); // 对象名（去 [signal=N] 后缀）
    const n = m ? m[1].trim() : null;
    return n && !backfilledObjs.has(n);
  }).length;
  const invalid = (src.match(/↳回测:[^\n]*无效[^\n]*/g) || []).length;
  const machineInvalid = (src.match(/↳回测:[^\n]*无效\(机器判\)[^\n]*/g) || []).length;
  const selfInvalid = invalid - machineInvalid;
  const m = readMetrics();
  const backfilled = (src.match(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*↳回测:/gm) || []).length;
  console.log('[evolve-log] 元进化自检（自主信号）:');
  console.log(`  进化记录 ${logRows} 条（另 ↳快照存档 ${snapRows} 行不计）· 已回填 ${backfilled} 条 · 未回填 ${Math.max(0, unwrapped)} 条(机判可判) · 封存 legacy-unbound ${legacyUnbound} 条(不追不洗) · 无效 ${invalid} 条(机器判 ${machineInvalid}/自评 ${selfInvalid}) · 信号 ${JSON.stringify(m)}`);
  let hit = false;
  if (Math.max(0, unwrapped) >= 5) { console.log('  ⚠️ 未回填 ≥5 条 → 该回填 effect（机器判，见 `effect auto`），别只记不改'); hit = true; }
  if (invalid >= 2) { console.log('  ⚠️ 机制连续无效(≥2) → 自主元进化：回滚/换思路（回滚由用户拍板）'); hit = true; }
  if (logRows >= 15) { console.log('  ⚠️ 进化记录偏多 → 审视是否僵化/该深度体检'); hit = true; }
  if ((m.corrections || 0) >= 3) { console.log('  ⚠️ 被纠正 ≥3 次 → 审视我的行为/判断机制'); hit = true; }
  if (logRows >= 8 && (m['repeat-mistakes'] || 0) >= 2) { console.log('  ⚠️ 改得多却重复踩坑 → 审视进化是否有效'); hit = true; }
  if (!hit) console.log('  ✅ 机制健康，无需元进化');
} else {
  console.error('用法: snapshot <path> | log "<[信号]|对象|why|what>" | effect <对象> auto | effect auto | effect "<对象>|<观察>|<verdict>" | bump <信号> | metrics | health | pending-invalid');
  process.exit(1);
}
