#!/usr/bin/env node
// scripts/memory-archive.mjs — 「压缩阶梯」第 1 档：长条目**指针化**（2026-09-26 建）
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// 实测：L3 活档只有 23 篇 / 358 KB，但**单篇**很肥（`projects/DSHOME/project.md` 218 KB / 143 行，
// `Learn.md` 121 KB / 106 行）。而检索按 ~60 字分块 ⇒ **大文档的几千片近重复会吃满 top-N 配额**，
// 别的主题排不进来。所以病不是"篇数多"，是"单篇里条目太多"。
//
// 外部证据（`2026-09-26` 调研）：
//   · rate–distortion 综述：低于任务所需信息量时任何压缩都必然有损，且**可逆性（P-rev）比评分技巧重要**
//     ——"反复做不可逆摘要的系统误差随次数超线性增长，而可逆、可检索的记忆保持平坦"。
//   · Mem0 v3：主流做法是**累积 + 检索**（ADD-only，不再改写旧记忆），不是"越积越多就归并"。
// ⇒ 结论：**先做零损失、不需要"合并判断"的那几档**（冻结 / 指针化 / 字段化），归并（有损、需人判）留后面。
//
// ── 本档做什么 ──────────────────────────────────────────────────────────────
// 把某个 `##` 小节的正文**原样搬到** `L3\history\<主题或项目>\<日期>_<来源文件名>\<锚点>.md`，
// 原处只留一个**指针对话块**（原文在哪、为什么搬、怎么取回）。**零内容丢失、随时可还原**。
//
// ── 安全姿势（照 2026-09-26 立的那套）──────────────────────────────────────
//   · **默认只列候选清单**（只读）；真改必须 `--apply --only <锚点名>` **双条件**（逐次点名）。
//   · 只动 `mind-private\L3\` 下的 `.md`，且**只接受 `##` 小节**（改前打印前后行数/字节，供复核）。
//   · `--dry-run-insert`：打印"搬运后原处会长什么样"（前 N 行），不落盘。
//
// 用法：node scripts/memory-archive.mjs [--list] [--quota 30] [--apply --only <锚点>] [--file <相对路径>] [--json]
// 退出码：0＝正常；1＝参数/点名问题；2＝环境不可用。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.DSH_HOME || resolve(here, '..');
const L3 = join(repoRoot, 'mind-private', 'L3');
const HISTORY = join(L3, 'history');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const APPLY = argv.includes('--apply');
const DRY_INSERT = argv.includes('--dry-run-insert');
const qi = argv.indexOf('--quota');
const QUOTA_KB = qi >= 0 ? Number(argv[qi + 1]) : 30;
const fi = argv.indexOf('--file');
const FILE_ARG = fi >= 0 ? argv[fi + 1] : null;
const oi = argv.indexOf('--only');
const ONLY = oi >= 0 ? String(argv[oi + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];

if (!existsSync(L3)) { console.error(`[memory-archive] ❌ 环境不可用：找不到 ${L3}`); process.exit(2); }
if (!Number.isFinite(QUOTA_KB) || QUOTA_KB <= 0) { console.error(`[memory-archive] ❌ --quota 要给正数（KB）`); process.exit(1); }
if (APPLY && ONLY.length === 0) {
  console.error('[memory-archive] ❌ `--apply` 必须配 `--only <锚点名[,锚点名…]>`：先 `--list` 看候选，再逐次点名（判据只列候选，落刀要人点）。');
  process.exit(1);
}

/** 扫描 L3 活档（跳过 history/README/_index），返回 { rel, abs, kb, lines }。 */
function listDocs() {
  const out = [];
  (function walk(d) {
    let items; try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!['history', 'TRASH'].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.md') || ['README.md', '_index.md'].includes(e.name)) continue;
      const text = readFileSync(p, 'utf8');
      out.push({ abs: p, rel: relative(repoRoot, p).split(sep).join('/'), kb: statSync(p).size / 1024, lines: text.split('\n').filter((l) => l.trim()).length, text });
    }
  })(L3);
  return out;
}
/** 切出 `##` 小节：返回 [{ title, start, end, kb, lines }]（end 为下一小节起始行）。 */
function sections(text) {
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((l, i) => { const m = /^##\s+(.+?)\s*$/.exec(l); if (m) heads.push({ title: m[1], i }); });
  return heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    const body = lines.slice(h.i, end).join('\n');
    return { title: h.title, start: h.i, end, kb: Buffer.byteLength(body, 'utf8') / 1024, lines: body.split('\n').filter((l) => l.trim()).length };
  });
}

const docs = listDocs();
const oversized = docs.filter((d) => d.kb > QUOTA_KB).sort((a, b) => b.kb - a.kb);
const report = oversized.map((d) => ({
  rel: d.rel, kb: +d.kb.toFixed(1), lines: d.lines,
  sections: sections(d.text).map((s) => ({ title: s.title, kb: +s.kb.toFixed(1), lines: s.lines })).sort((a, b) => b.kb - a.kb),
}));

if (!APPLY) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, mode: 'list', quotaKB: QUOTA_KB, oversized: report }, null, 2));
  else {
    console.log(`[memory-archive] 压缩阶梯第 1 档（指针化）· 配额 ${QUOTA_KB} KB · 只列候选，不动任何文件`);
    if (!report.length) console.log(`  没有超过配额的活档 ✅`);
    for (const r of report) {
      console.log(`  ${r.rel}  ${r.kb} KB / ${r.lines} 行（超配额 ${(r.kb - QUOTA_KB).toFixed(1)} KB）`);
      for (const s of r.sections.slice(0, 5)) console.log(`      · 「${s.title}」 ${s.kb} KB / ${s.lines} 行`);
    }
    console.log('  ⇒ 要点名搬运：`--apply --only "<锚点名>"`（可多选，逗号分隔）');
  }
  process.exit(0);
}

// ── 执行：把点名的 `##` 小节搬到 history + 原处留指针 ────────────────────────
// ⚠️ 2026-09-26 自己的门禁抓到的 bug：原来"只列候选"的分支条件只看 `!APPLY`，
//   而 `--json` 被当成了它的开关之一 ⇒ `--apply --only X --json` 会**打印清单就退出、
//   什么都不搬**（还照样 exit 0）。现在行为只由 `--apply` 决定，`--json` 只决定**输出格式**
//   （"格式不该改变行为"）。
// 另：**显式 `--file` 点名时不再拿配额卡人**——点名就是意图，配额只用于"列候选"。
const target = FILE_ARG
  ? docs.find((d) => d.rel.endsWith(FILE_ARG.replace(/\\/g, '/')))
  : oversized[0];
if (!target) {
  const why = FILE_ARG ? `--file 指定的文件不存在或不在 L3：${FILE_ARG}` : `没有超配额的活档（配额 ${QUOTA_KB} KB）——用 --file 可显式点名`;
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: why }, null, 2));
  else console.error(`[memory-archive] ❌ ${why}`);
  process.exit(1);
}
const secs = sections(target.text);
const picked = secs.filter((s) => ONLY.some((k) => s.title.includes(k)));
if (!picked.length) { console.error(`[memory-archive] ❌ --only 在「${target.rel}」里没匹配到任何 ## 小节（锚点名要照抄）`); process.exit(1); }

const lines = target.text.split('\n');
// history 落点：`L3\history\<YYYY-MM-DD>_<组名>\<来源文件名去扩展>\<锚点>.md`
// ⚠️ 组名取法（2026-09-26 诊断抓到的 bug）：`rel` 形如 `mind-private/L3/projects/<项目>/…`，
//   按 `/` 切完取 `[2]` 会拿到**结构名 `projects`** 而不是项目名 ⇒ 落点跑进 `…_projects/`，
//   与"同名已存在"永远撞不上、既有归档形同虚设。正确取法（与 `evolve-log` 的 `projectKeyOf` 同口径）：
//   `L3/projects/<项目>/…` ⇒ `<项目>`；`L3/common/<主题>/…` ⇒ `<主题>`。
function groupOf(rel) {
  const seg = rel.split('/');
  const i = seg.indexOf('L3');
  const rest = i >= 0 ? seg.slice(i + 1) : seg;
  if ((rest[0] === 'projects' || rest[0] === 'common') && rest[1]) return rest[1];
  return rest[1] || rest[0] || 'misc';
}
const day = new Date().toISOString().slice(0, 10);
const destDir = join(HISTORY, `${day}_${groupOf(target.rel)}`, basename(target.rel, '.md'));
mkdirSync(destDir, { recursive: true });

// 先落 history（原文逐字节保存；**不重建**，避免改字），再改源文件
const plan = [];
for (const s of picked) {
  const body = lines.slice(s.start, s.end).join('\n');
  const safe = s.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const dest = join(destDir, `${safe}.md`);
  plan.push({ s, body, dest });
}
if (DRY_INSERT) {
  console.log('[memory-archive] 搬运后原处会变成（不落盘）：');
  for (const p of plan) console.log(`  ── 「${p.s.title}」 → ${relative(repoRoot, p.dest)}\n${p.body.split('\n').slice(0, 2).map((l) => '     ' + l).join('\n')}`);
  process.exit(0);
}
let moved = 0;
// ⚠️ 没有真正可搬的小节时**什么都不做**（同名已存在 ⇒ 不覆盖、也不留无意义的 .bak、不改源文件）：
//   门禁实测抓到的行为问题——原来照写备份 + 原子重写，等于"搬不动却把手伸进了源文件"。
const movable = plan.filter((p) => !existsSync(p.dest));
if (!movable.length) {
  const msg = `没有可搬的小节（${plan.length} 个都被跳过：history 已存在同名）——源文件未改`;
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, mode: 'apply', moved: 0, skipped: plan.length, note: msg }, null, 2));
  else console.log(`[memory-archive] ⏭ ${msg}`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// 逐字节落 history（保留原行）
for (const p of plan) {
  if (existsSync(p.dest)) { console.error(`[memory-archive] ⚠️ history 已存在同名，跳过：${relative(repoRoot, p.dest)}`); continue; }
  writeFileSync(p.dest, p.body + '\n', 'utf8');
}
// 源文件：整文件备份 → 用小节指针替换 → 原子写
const backup = `${target.abs}.bak-before-archive`;
writeFileSync(backup, target.text, 'utf8');
let newText = target.text;
for (const p of plan) {
  if (!existsSync(p.dest)) continue;
  const relHistory = relative(L3, p.dest).split(sep).join('/');
  const stub = [
    `## ${p.s.title}`,
    '',
    `> 📦 **原文已归档（指针化 · ${day}）**：\`L3/${relHistory}\``,
    `> 为什么：该小节 ${p.s.kb.toFixed(1)} KB / ${p.s.lines} 行，超出单篇配额 ${QUOTA_KB} KB，而检索按 ~60 字分块 ⇒ 片数过多会挤掉别的主题。`,
    `> 怎么取回：原地读上面那个文件（内容零丢失）；要还原到正文用 \`node scripts/memory-archive.mjs --restore\`（待建）或手工粘回。`,
    '',
  ].join('\n');
  newText = newText.replace(p.body, stub);
  moved++;
}
const tmp = `${target.abs}.tmp`;
writeFileSync(tmp, newText, 'utf8');
renameSync(tmp, target.abs);
console.log(`[memory-archive] ✅ 已指针化 ${moved} 个小节 · ${target.rel}`);
console.log(`  history 落点：${relative(repoRoot, destDir)}`);
console.log(`  源文件字节：${Buffer.byteLength(target.text, 'utf8')} → ${Buffer.byteLength(newText, 'utf8')}；备份：${relative(repoRoot, backup)}`);
console.log(`  留痕：本行 + ${backup}（可回滚：把备份改名回去即可）`);
process.exit(0);
