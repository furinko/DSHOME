// scripts/mind-prime.mjs — 启动预热（boot recall）上下文 provider
// 用途：会话/任务开始时，把"该带上的记忆"装配成一段可注入上下文的文本。
//      这是「上工自动召回」的【机器实现】——不靠 agent 记得去搜索，而是确定性生成。
//
// 用法：
//   node scripts/mind-prime.mjs [query] [--json] [--limit N]
//   默认 query = "DSHOME 心智"（项目主线）；输出一段精简上下文。
//   --json 输出结构化 {project, todos, memories, learn, userRules}。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// L3 检索共享库（§十 权威排序单一实现——F3 修复：自动召回不再走纯相似度简化版）
const require2 = createRequire(import.meta.url);
const { searchL3 } = require2('./mind-search-lib.cjs');

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const PRIV = join(repoRoot, 'mind-private');
const args = process.argv.slice(2);
const hasExplicitQuery = !!args[0] && !args[0].startsWith('--');
const query = hasExplicitQuery ? args[0] : 'DSHOME 心智';
const asJson = args.includes('--json');
// --limit N：--limit 是独立 arg，值在它后面一个；支持 "--limit=5" 与 "--limit 5" 两种写法。
let limit = 5;
{
  const idx = args.findIndex((a) => a === '--limit' || a.startsWith('--limit='));
  if (idx >= 0) {
    const raw = args[idx] === '--limit' ? args[idx + 1] : args[idx].split('=')[1];
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) limit = n;
  }
}

// ── L3 记忆遍历 + 检索（排序走共享库 §十 权威实现）──────────────────────
function walkMd(dir, out, rel = '') {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    if (statSync(full).isDirectory()) walkMd(full, out, r);
    else if (e.endsWith('.md') && !/README|_index/.test(basename(r))) out.push({ full, rel: r });
  }
  return out;
}
function search(limit2) {
  const files = walkMd(join(PRIV, 'L3', 'index'), [], 'L3/index');
  // §十 权威排序（conf→scope→importance→score）——共享库单一实现，与 /api/mind/search 一致（F3 修复）
  return searchL3(query, files, limit2);
}

// ── project.md（体系主线档）：进度状态 + 下一步（待办）─────────────────────
// 标题匹配容忍序号前缀与括号后缀（如「## 二、进度状态」「## 下一步（待办）」），
// 跨设备/不同写法都能装配；todo/progress 权威源语义见 mind/L1/Concepts.md。
function project() {
  const f = join(PRIV, 'Project', 'DSHOME', 'project.md');
  if (!existsSync(f)) return { progress: '', todos: [] };
  const body = readFileSync(f, 'utf8');
  let progress = '';
  let todos = [];
  const lines = body.split('\n');
  let inProgress = false, inTodo = false;
  // 容忍标题前可有序号前缀（一二三…/数字/顿号/点）与标题后括号注
  const isHeading = (l) => /^##\s/.test(l);
  const headingIs = (l, kw) => new RegExp('^##\\s*[一二三四五六七八九十0-9、.．]*\\s*' + kw).test(l);
  for (const line of lines) {
    if (headingIs(line, '进度状态')) { inProgress = true; inTodo = false; continue; }
    if (headingIs(line, '下一步')) { inTodo = true; inProgress = false; continue; }
    if (isHeading(line)) { inProgress = false; inTodo = false; }
    if (inProgress && line.startsWith('|')) progress += line.trim() + '\n';
    if (inTodo) {
      const m = /^\s*-\s*\[( |x)\]\s*(.*)$/.exec(line);
      if (m) todos.push({ done: m[1] === 'x', text: m[2] });
    }
  }
  return { progress: progress.trim(), todos };
}

// ── Learn + user-rules ────────────────────────────────────────────────────
function learn() {
  const f = join(PRIV, 'L1', 'Learn.md');
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => /^-\s*\[/.test(l));
  return lines.slice(-4); // 最近 4 条教训
}
function userRules() {
  const f = join(PRIV, 'L3', 'index', 'user-rules', 'rules.md');
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').split('\n').filter((l) => /^##\s+\[/.test(l)).join('\n');
}
// ── 注：L0 注入摘要（核心纪律）由宿主插件 dshome-mind-inject 唯一维护，mind-prime 不再重复生成 ──
// （旧版曾在这里重复一份 INJECT_LAYER 关键词抽取，与 mind-inject 漂移；已删——依据唯一）
// 本脚本只装配：project 进度/待办 + L3 相关记忆 + Learn 最近教训 + user-rules。

// ── 撞名消歧（组件D）：query 命中 Concepts 歧义表 → 提示钉身份再动手 ──────
function disambiguationFor(query) {
  const p = join(repoRoot, 'mind', 'L1', 'Concepts.md');
  if (!existsSync(p)) return [];
  const q = String(query || '').toLowerCase();
  const hits = [];
  let inTable = false;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (/^##\s*撞名消歧表/.test(line)) { inTable = true; continue; }
    if (inTable && /^##\s+/.test(line)) break;
    if (!inTable) continue;
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/.exec(line);
    if (!m) continue;
    const word = m[1].trim().toLowerCase();
    const candidates = m[2].trim();
    const clues = m[3].trim();
    if (!word || !candidates) continue;
    // 精确词或词位于 query 中（含 q 的歧义词），排除"词是 q 的子串但语义不符"的粗配：词长≥3 或完全等于
    if (q === word || (word.length >= 3 && q.includes(word))) {
      hits.push({ word: m[1].trim(), candidates, clues });
    }
  }
  return hits;
}

const p = project();
const memories = search(limit);
const lrn = learn();
const rules = userRules();
// 歧义检测只对显式传入的 query 生效（用户/调用方给的搜索词）；内部默认装配关键词不提示
const ambiguous = hasExplicitQuery ? disambiguationFor(query) : [];

if (asJson) {
  console.log(JSON.stringify({ query, project: p, memories, learn: lrn, userRules: rules, ambiguous }, null, 2));
  process.exit(0);
}

// ── 纯文本注入块 ─────────────────────────────────────────────────────────
const out = [];
out.push(`【上工自动召回 · ${query}】`);
const _d = new Date();
out.push(`⏱【系统日期】${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}（机器时钟——写文档/记教训/落 Learn 以此为准，勿沿用旧文件日期）`);
if (ambiguous.length) {
  // 撞名消歧：先钉身份再动手（不阻塞召回，只是提示候选）
  out.push(`\n⚠️ 歧义词检测：「${query}」可能指——\n${ambiguous.map((a) => `- ${a.word}：${a.candidates}（判定：${a.clues}）`).join('\n')}\n请先钉身份（指哪个）再进入任务；若已明确可不理会本条。`);
}
if (p.progress) out.push(`\n■ project.md「进度状态」\n${p.progress}`);
if (p.todos.length) out.push(`\n■ project.md「下一步」待办（未勾选 ${p.todos.filter((t) => !t.done).length}）\n${p.todos.filter((t) => !t.done).slice(0, 8).map((t) => `- [ ] ${t.text}`).join('\n')}`);
if (memories.length) out.push(`\n■ L3 相关记忆（top${memories.length}）\n${memories.map((m) => `- [${m.score}] ${m.file} :: ${m.section}\n  ${m.snippet}`).join('\n')}`);
if (lrn.length) out.push(`\n■ Learn 最近教训\n${lrn.join('\n')}`);
if (rules) out.push(`\n■ user-rules（用户偏好/铁律）\n${rules}`);
console.log(out.join('\n'));
