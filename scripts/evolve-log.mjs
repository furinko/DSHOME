// scripts/evolve-log.mjs — 鱼鱼进化档案：快照 + 变更日志（帧号式自我记忆）
// 模仿 CH4 的 CHANGELOG/design-status 思路：每次改"自我类"文件（AGENTS/mind 规则/技能/心智门禁）
// 前，先快照旧版 + 记一条理由——进化有据可查、可回滚。
//
// 用法：
//   node scripts/evolve-log.mjs snapshot <path>           # 快照旧版 → evolution/snapshots/<ts>_<name>
//   node scripts/evolve-log.mjs log "<对象>|<为什么改>|<改了啥>"  # 追加一条 changelog
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

if (cmd === 'snapshot') {
  const p = resolve(repoRoot, rest[0] || '');
  if (!existsSync(p)) { console.error('[evolve-log] 不存在:', p); process.exit(1); }
  const name = basename(p).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const t = ts();
  const dst = join(SNAP, `${t}_${name}`);
  writeFileSync(dst, readFileSync(p, 'utf8'));
  // 快照说明逐条 append：为什么拍/拍了什么（借鉴外部体系快照说明的"规则-实态对齐"）
  const reason = (rest[1] || '').trim();
  if (reason) appendFileSync(LOG, `| ${t.slice(0, 10)} | ↳快照:${basename(p)} | ${reason} | 快照旧版 | snapshots/${t}_${name} |\n`);
  console.log(`[evolve-log] 已快照 → ${dst}${reason ? '（理由:' + reason + '）' : ''}`);
} else if (cmd === 'log') {
  const [obj, why, what] = (rest[0] || '').split('|');
  const t = ts();
  const today = t.slice(0, 10);
  const safe = (obj || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_');
  appendFileSync(LOG, `| ${today} | ${obj || ''} | ${why || ''} | ${what || ''} | snapshots/${t}_${safe} |\n`);
  console.log(`[evolve-log] 已记录: ${obj}`);
} else if (cmd === 'effect') {
  // 进化回测：改动后观察效果，回填结论（好则沉淀/坏则回滚）
  const [obj, observed, verdict] = (rest[0] || '').split('|');
  const t = ts();
  const today = t.slice(0, 10);
  appendFileSync(LOG, `| ${today} | ↳回测:${obj || ''} | ${observed || ''} | ${verdict || ''} | — |\n`);
  console.log(`[evolve-log] 已回填: ${obj} → ${verdict}`);
} else if (cmd === 'bump') {
  // 可测事件计数（重复踩坑/用户纠正/拒绝/返工/检索命中）
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
} else if (cmd === 'health') {
  // 自主元进化自检：鱼鱼做事/进化中自己跑它，命中信号 → 自主触发元进化（不等收工/用户）
  const src = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const logRows = src.split('\n').filter((l) => l.startsWith('|') && !l.includes('时间')).length;
  const invalid = (src.match(/↳回测:[^\n]*无效[^\n]*/g) || []).length;
  const m = readMetrics();
  console.log('[evolve-log] 元进化自检（自主信号）:');
  console.log(`  进化记录 ${logRows} 条 · 无效回测 ${invalid} 条 · 信号 ${JSON.stringify(m)}`);
  let hit = false;
  if (invalid >= 2) { console.log('  ⚠️ 机制连续无效(≥2) → 自主元进化：回滚/换思路'); hit = true; }
  if (logRows >= 15) { console.log('  ⚠️ 进化记录偏多 → 审视是否僵化/该深度体检'); hit = true; }
  if ((m.corrections || 0) >= 3) { console.log('  ⚠️ 被纠正 ≥3 次 → 审视我的行为/判断机制'); hit = true; }
  if (logRows >= 8 && (m['repeat-mistakes'] || 0) >= 2) { console.log('  ⚠️ 改得多却重复踩坑 → 审视进化是否有效'); hit = true; }
  if (!hit) console.log('  ✅ 机制健康，无需元进化');
} else {
  console.error('用法: node scripts/evolve-log.mjs snapshot <path> | log "<对象>|<为什么改>|<改了啥>"');
  process.exit(1);
}
