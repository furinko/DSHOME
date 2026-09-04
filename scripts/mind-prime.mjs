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
const MIND = join(repoRoot, 'mind');
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

// ── 注入层（README「三层加载模型」：L0 四文件 + L1/HUB + L1/Wisdom）──────────
// 注入层=出厂固件、随每轮携带。为省 token，只提取各文件的【关键决策规则】
// （按关键词抓取包含该规则的行，去掉 markdown 强调），而非全文。
// AGENTS.md 由宿主作为系统提示词单独注入，此处以一行指针对齐 L0 四件。
const INJECT_LAYER = [
  // [文件相对路径, 摘要标题, 关键词数组, 最多行数]
  ['mind/L0/SOUL.md', 'SOUL 人格·决策规则',
    ['诚实优先', '本地验证', '最低消耗', '语境适配', '记忆习惯'], 5],
  ['mind/L0/TOOL.md', 'TOOL 工具纪律',
    ['先搜后写', '省 token', 'write 前先 read', 'edit 用唯一锚点', '改动前一句话说明', '隐私', '等放行', '收工提醒'], 6],
  ['mind/L1/HUB.md', 'HUB 加载模型·跨层红线',
    ['注入层', '强制层', '查询层', '跨层红线'], 4],
  ['mind/L1/Wisdom.md', 'Wisdom 思维·元认知',
    ['深度思考', '执行', '汇报', '闲聊', '诚实优先', '先搜后写', '本地验证', '最低消耗', '拆解问题'], 6],
];
function cleanRule(line) {
  return String(line)
    .replace(/^\s*(?:-|\*|\d+\.)\s*/, '')
    .replace(/[*#|`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
function extractRules(text, keys, cap) {
  const lines = String(text).split('\n');
  const seen = new Set();
  const keep = [];
  for (const l of lines) {
    // 跳过 frontmatter / 文档头 metadata / 表格行（规则条目都不是表格行）
    if (/^\s*(?:版本|加载|定位|作用|说明|author|license|metadata|description|version|tags|related|>)/i.test(l)) continue;
    if (l.includes('|')) continue;
    for (const k of keys) {
      if (l.includes(k)) {
        const r = cleanRule(l);
        if (r && !seen.has(r)) { seen.add(r); keep.push(r); }
        break;
      }
    }
    if (keep.length >= cap) break;
  }
  return keep;
}
function injectLayer() {
  const out = [];
  for (const [rel, title, keys, cap] of INJECT_LAYER) {
    const full = join(MIND, rel.replace('mind/', ''));
    if (!existsSync(full)) continue;
    const rules = extractRules(readFileSync(full, 'utf8'), keys, cap);
    if (rules.length) {
      out.push(`\n--- ${title} ---\n${rules.join('；')}`);
    }
  }
  // AGENTS 运行纪律：L0 版为唯一权威（根版已于 09-04 退役）。此处带实质内容，不再是指针。
  const l0Agents = join(MIND, 'L0', 'AGENTS.md');
  if (existsSync(l0Agents)) {
    const agentsText = readFileSync(l0Agents, 'utf8');
    // 去掉文件头 frontmatter / 元数据说明行，只留规则正文
    const body = agentsText.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    out.push(`\n--- AGENTS 运行纪律 ---\n${body.slice(0, 1200)}`);
  }
  if (!out.length) return '';
  return `\n■ 注入层（出厂固件，随每轮携带；关键决策规则摘要）${out.join('')}`;
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
const inj = injectLayer();
if (inj) out.push(inj);
if (p.progress) out.push(`\n■ project.md「进度状态」\n${p.progress}`);
if (p.todos.length) out.push(`\n■ project.md「下一步」待办（未勾选 ${p.todos.filter((t) => !t.done).length}）\n${p.todos.filter((t) => !t.done).slice(0, 8).map((t) => `- [ ] ${t.text}`).join('\n')}`);
if (memories.length) out.push(`\n■ L3 相关记忆（top${memories.length}）\n${memories.map((m) => `- [${m.score}] ${m.rel} :: ${m.section}\n  ${m.snippet}`).join('\n')}`);
if (lrn.length) out.push(`\n■ Learn 最近教训\n${lrn.join('\n')}`);
if (rules) out.push(`\n■ user-rules（用户偏好/铁律）\n${rules}`);
console.log(out.join('\n'));
