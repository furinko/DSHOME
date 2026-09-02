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
import { join, basename, resolve } from 'node:path';
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
  console.log(`[evolve-log] 已快照 → ${dst}`);
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
} else {
  console.error('用法: node scripts/evolve-log.mjs snapshot <path> | log "<对象>|<为什么改>|<改了啥>"');
  process.exit(1);
}
