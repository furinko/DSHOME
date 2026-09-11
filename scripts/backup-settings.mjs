#!/usr/bin/env node
// scripts/backup-settings.mjs — `settings.yaml` 定期留档（2026-09-11 建）
//
// ── 为什么需要它（真实缺口）──────────────────────────────────────────────────
// `settings.yaml` 是 DSH 运行时配置：`.gitignore` 忽略、**本机唯一一份**、且 DSH 启动
// 可能整份重写（2026-09-10 写入的显式 `models` 被清空成 `{}`，归因至今未查明）。
// 它既不在 git 里、也没有任何备份 → 一次误清空 = 配置从此不可追溯。
//
// ── 做什么 ──────────────────────────────────────────────────────────────────
//   ① 把 `$DSH_HOME/settings.yaml` 复制到 `mind-private/backup/settings/`
//      （私有区：永不推送，符合双区红线；脚本只打印路径，从不打印内容）
//   ② 内容 SHA256 与最新一份相同 → 跳过（幂等，不产生重复档）
//   ③ 只保留最近 `--keep N`（默认 20）份，更旧的自动清理
//   ④ `--list` 列出留档；`--force` 跳过去重
//
// 用法：
//   node scripts/backup-settings.mjs              # 备份（去重）
//   node scripts/backup-settings.mjs --list       # 看留档
//   node scripts/backup-settings.mjs --keep 30    # 自定义保留份数
//
// 触发点：① `scripts/hooks/pre-commit` 每次提交前自动跑（确定性，不靠 agent 记得；
//   失败**不阻塞提交**——备份是辅助、不是门禁）② 升级 DSH / 手工改 settings 前后手动跑
//   （那两个时刻未必有 git 提交）。
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(repoRoot, 'settings.yaml');
const PRIVATE = join(repoRoot, 'mind-private');
const BACKUP_DIR = join(PRIVATE, 'backup', 'settings');
const NAME_RE = /^settings-\d{8}-\d{9}\.yaml$/;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const keep = Math.max(1, parseInt(valueOf('--keep', '20'), 10) || 20);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
};
/** 现有留档（按文件名 = 时间序）。 */
const existing = () => (existsSync(BACKUP_DIR)
  ? readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)).sort()
  : []);

if (has('--list')) {
  const list = existing();
  if (!list.length) { console.log('[settings-backup] 暂无留档'); process.exit(0); }
  for (const f of list) {
    const st = statSync(join(BACKUP_DIR, f));
    console.log(`${f}  ${String(st.size).padStart(8)}B  ${sha(readFileSync(join(BACKUP_DIR, f))).slice(0, 12)}`);
  }
  console.log(`[settings-backup] 共 ${list.length} 份 → ${BACKUP_DIR}`);
  process.exit(0);
}

if (!existsSync(PRIVATE)) {
  console.log('[settings-backup] 无 mind-private/（非本机开发布局）→ 跳过留档');
  process.exit(0);
}
if (!existsSync(SRC)) {
  console.error('[settings-backup] ❌ 找不到源文件:', SRC);
  process.exit(1);
}

const buf = readFileSync(SRC);
const digest = sha(buf);
const list = existing();
const latest = list.length ? list[list.length - 1] : null;
if (latest && !has('--force')) {
  if (sha(readFileSync(join(BACKUP_DIR, latest))) === digest) {
    console.log(`[settings-backup] = 内容与最新留档一致（${latest}），跳过`);
    process.exit(0);
  }
}

mkdirSync(BACKUP_DIR, { recursive: true });
let name = `settings-${stamp()}.yaml`;
for (let i = 2; existsSync(join(BACKUP_DIR, name)); i++) name = `settings-${stamp()}-${i}.yaml`;
copyFileSync(SRC, join(BACKUP_DIR, name));

const after = existing();
const drop = after.slice(0, Math.max(0, after.length - keep));
for (const f of drop) { try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* 清理失败不影响留档结果 */ } }
console.log(`[settings-backup] ✅ 已留档 → mind-private/backup/settings/${name}（共 ${after.length - drop.length} 份，清理 ${drop.length} 份，sha256 ${digest.slice(0, 12)}）`);
