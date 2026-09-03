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

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const PRIV = join(repoRoot, 'mind-private');
const args = process.argv.slice(2);
const query = args[0] && !args[0].startsWith('--') ? args[0] : 'DSHOME 心智';
const asJson = args.includes('--json');
const limit = Number((args.find((a) => a.startsWith('--limit')) || '--limit 5').split(' ')[1] || 5);

// ── 词/二元组 + Jaccard（与 dshome-mind search 同思路）────────────────────
function tokenize(text) {
  const s = String(text).toLowerCase();
  const tokens = new Set();
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1]);
  (s.match(/[a-z0-9][a-z0-9_\-./]+/g) || []).forEach((w) => tokens.add(w));
  return tokens;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
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
  const q = tokenize(query);
  const hits = [];
  for (const f of files) {
    let content = '';
    try { content = readFileSync(f.full, 'utf8'); } catch { continue; }
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const sections = body.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
    let best = null;
    for (const sec of sections) {
      const sc = jaccard(q, tokenize(sec));
      if (!best || sc > best.score) best = { score: sc, sec };
    }
    if (best && best.score >= 0.03) {
      hits.push({ score: Math.round(best.score * 100), rel: f.rel, section: ((best.sec.split('\n')[0] || '').replace(/^#+/, '')).slice(0, 40), snippet: best.sec.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit2);
}

// ── project.md：进度状态 + 下一步（待办）───────────────────────────────────
function project() {
  const f = join(PRIV, 'Project', 'DSHOME', 'project.md');
  if (!existsSync(f)) return { progress: '', todos: [] };
  const body = readFileSync(f, 'utf8');
  let progress = '';
  let todos = [];
  const lines = body.split('\n');
  let inProgress = false, inTodo = false;
  for (const line of lines) {
    if (/^##\s+进度状态/.test(line)) { inProgress = true; inTodo = false; continue; }
    if (/^##\s+下一步/.test(line)) { inTodo = true; inProgress = false; continue; }
    if (/^##\s+/.test(line)) { inProgress = false; inTodo = false; }
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

const p = project();
const memories = search(limit);
const lrn = learn();
const rules = userRules();

if (asJson) {
  console.log(JSON.stringify({ query, project: p, memories, learn: lrn, userRules: rules }, null, 2));
  process.exit(0);
}

// ── 纯文本注入块 ─────────────────────────────────────────────────────────
const out = [];
out.push(`【上工自动召回 · ${query}】`);
if (p.progress) out.push(`\n■ project.md「进度状态」\n${p.progress}`);
if (p.todos.length) out.push(`\n■ project.md「下一步」待办（未勾选 ${p.todos.filter((t) => !t.done).length}）\n${p.todos.filter((t) => !t.done).slice(0, 8).map((t) => `- [ ] ${t.text}`).join('\n')}`);
if (memories.length) out.push(`\n■ L3 相关记忆（top${memories.length}）\n${memories.map((m) => `- [${m.score}] ${m.rel} :: ${m.section}\n  ${m.snippet}`).join('\n')}`);
if (lrn.length) out.push(`\n■ Learn 最近教训\n${lrn.join('\n')}`);
if (rules) out.push(`\n■ user-rules（用户偏好/铁律）\n${rules}`);
console.log(out.join('\n'));
