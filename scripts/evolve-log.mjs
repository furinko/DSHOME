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
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

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
} else {
  console.error('用法: node scripts/evolve-log.mjs snapshot <path> | log "<对象>|<为什么改>|<改了啥>"');
  process.exit(1);
}
