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
const { searchL3, fmValue, listMemoryCandidates } = require2('./mind-search-lib.cjs');

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const PRIV = join(repoRoot, 'mind-private');
const args = process.argv.slice(2);
const hasExplicitQuery = !!args[0] && !args[0].startsWith('--');
const asJson = args.includes('--json');
// ── 可选 --cwd <path>：当前工作区/项目绝对路径 → 项目记忆隔离（2026-09-06）──
// 规则：候选记忆 = 通用（无 project 标记）或当前项目；其它项目专属记忆被排除 → 不串项目。
let projectCwd = '';
{
  const idx = args.findIndex((a) => a === '--cwd' || a.startsWith('--cwd='));
  if (idx >= 0) projectCwd = args[idx] === '--cwd' ? (args[idx + 1] || '') : args[idx].split('=')[1];
}
const taskProject = projectCwd ? basename(resolve(projectCwd)) : '';
// 检索 query（召回主题/消歧用）：显式传入优先；否则当前项目名；否则默认主线（DSHOME 心智）。
const query = hasExplicitQuery ? args[0] : (taskProject || 'DSHOME 心智');
// 通用层检索独立用默认焦点（避免 mind 自用会话召回退化）；项目层用当前项目名。
const generalQuery = hasExplicitQuery ? args[0] : 'DSHOME 心智';
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
// ── 项目 key 解析（2026-09-11 修回归）──────────────────────────────────────
// Memory §十 定义「项目 key = 会话 cwd 目录名」，但本机会话 cwd（如本机插件开发工作区）与项目记忆
// 目录（`projects\<项目>\`）**并不总是同名** → 硬用 cwd 名会让**导航卡与项目层记忆双双失联**
// （重启后实测：进度/待办恒空、项目层 4 条记忆召不回；此前硬编码 'DSHOME' 反而没这个问题）。
// fallback 链：cwd 项目目录存在 → 用它；否则 projects 下**只有一个项目**时用它（无歧义）；否则空
// （只扫 common 层）。**不硬编码项目名**，保持出厂可移植。
const L3_ROOT = join(PRIV, 'L3');
const projectKey = (() => {
  const projs = join(L3_ROOT, 'projects');
  const cand = String(taskProject || '').trim();
  if (cand && !/[/\\]/.test(cand) && existsSync(join(projs, cand))) return cand;
  try {
    const all = readdirSync(projs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort();
    return all.length === 1 ? all[0] : '';
  } catch { return ''; }
})();

function search(limit2) {
  // 记忆层重构（2026-09-09）：候选 = listMemoryCandidates(L3, projectKey)
  //   = common（通用，恒含）+ projects/<projectKey>（当前项目专属，物理隔离）
  const files = listMemoryCandidates(L3_ROOT, projectKey);
  const general = [], proj = [];
  for (const f of files) {
    if (f.rel.startsWith('common/')) general.push(f);
    else if (projectKey && f.rel.startsWith(`projects/${projectKey}/`)) proj.push(f);
  }
  // 通用层：结果导向三级退——任务 query → 工作区(项目名) → 重要度兜底（不空转）。
  let generalHits = searchL3(generalQuery, general, limit2);
  if (generalHits.length === 0 && projectKey && projectKey !== generalQuery) {
    generalHits = searchL3(projectKey, general, limit2);
  }
  if (generalHits.length === 0 && general.length) {
    generalHits = searchL3('', general, limit2, { minScore: 0 });
  }
  // 项目层：当前项目专属记忆全部列入（项目专属即相关；不靠 query——中英不匹配会漏），minScore 0 保证在场。
  const projHits = projectKey && proj.length ? searchL3(projectKey, proj, limit2, { minScore: 0 }) : [];
  // 合并：项目优先保留（当前项目上下文），通用知识补充；去重取前 limit。
  const picked = [];
  const seen = new Set();
  for (const m of [...projHits, ...generalHits]) {
    if (seen.has(m.file)) continue;
    seen.add(m.file); picked.push(m);
    if (picked.length >= limit2) break;
  }
  return picked;
}

// ── project.md（体系主线档）：进度状态 + 下一步（待办）─────────────────────
// 标题匹配容忍序号前缀与括号后缀（如「## 二、进度状态」「## 下一步（待办）」），
// 跨设备/不同写法都能装配；todo/progress 权威源语义见 mind/L1/Concepts.md。
function project() {
  // 项目 key：projectKey（cwd 名 → 单项目回退，见上）；无项目 → 不注入进度块
  if (!projectKey) return { progress: '', todos: [] };
  const f = join(PRIV, 'L3', 'projects', projectKey, 'project.md');
  if (!existsSync(f)) return { progress: '', todos: [] };
  const body = readFileSync(f, 'utf8');
  const progLines = [];
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
    // 2026-09-11 修复：进度状态的实际写法是 bullet（`- phase:` / `- 里程碑:` / 缩进 ✅），
    // 此前只收 `|` 表格行 → 实测 progress 恒空（导航卡在场却不注入）。两种写法都收。
    if (inProgress && (line.startsWith('|') || /^\s*[-*]\s/.test(line))) progLines.push(line.trim());
    if (inTodo) {
      const m = /^\s*-\s*\[( |x)\]\s*(.*)$/.exec(line);
      if (m) todos.push({ done: m[1] === 'x', text: m[2] });
    }
  }
  // 注入限长（2026-09-11）：phase 行 + 最近 3 条里程碑——里程碑按 Memory §四 逐轮 append
  // 会无限增长，全文注入会吃掉 R1 预算；真源仍全文在 project.md，此处只装配摘要。
  const picked = [...new Set([...progLines.slice(0, 1), ...progLines.slice(-3)])];
  return { progress: picked.join('\n').slice(0, 900), todos };
}

// ── Learn + user-rules ────────────────────────────────────────────────────
function learn() {
  const f = join(PRIV, 'L1', 'Learn.md');
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => /^-\s*\[/.test(l));
  return lines.slice(-4); // 最近 4 条教训
}
function userRules() {
  const f = join(PRIV, 'L3', 'common', 'user-rules', 'rules.md');
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').split('\n').filter((l) => /^##\s+\[/.test(l)).join('\n');
}
// ── 人设卡（本机私密，演绎唯一权威源）——上工召回自动装配，让鱼鱼开机即带人设 ──
// Q1（2026-09-06）：优先读约定名「人设卡.md」；不存在则回退扫 L0 下任一含"人设/persona"的 md
//   （历史文件曾用别的命名 → 约定名与物理名漂移导致装配静默为空；回退兜底）。
function persona() {
  const dir = join(PRIV, 'L0');
  if (!existsSync(dir)) return '';
  const f = join(dir, '人设卡.md');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  try {
    const hit = readdirSync(dir).find((n) => /人设|persona/i.test(n) && n.endsWith('.md'));
    if (hit) return readFileSync(join(dir, hit), 'utf8').trim();
  } catch { /* 忽略 */ }
  return '';
}
// ── 上工地图速览（知识发现机器化，2026-09-06）────────────────────────────
// 目的：把 Tree/Power 的"存在与用法"随 R1 机器到场——不靠模型记得"上工先 read"（AGENTS §八
//      由动作条款升级为机器带，堵"条款在场≠执行"的 gap）。速览=头部说明 + Tree 层骨架，
//      动态读原文，无拷贝漂移；完整内容按需 read 对应文件。
function mapSight() {
  const out = [];
  const tree = join(repoRoot, 'mind', 'L1', 'Tree.md');
  if (existsSync(tree)) {
    try {
      const lines = readFileSync(tree, 'utf8').split('\n');
      const heads = lines.filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, '').trim()).filter((h) => h !== '使用说明' && h !== '更新规则').slice(0, 12);
      const usage = lines.slice(0, 12).find((l) => l.includes('查"X 在哪"'));
      if (heads.length) {
        let t = `Tree 全库目录（${usage ? usage.trim() + '；' : ''}深查 read 本文件）：${heads.join(' / ')}`;
        out.push(t);
      }
    } catch { /* 忽略 */ }
  }
  const power = join(repoRoot, 'mind', 'L1', 'Power.md');
  if (existsSync(power)) {
    try {
      const lines = readFileSync(power, 'utf8').split('\n');
      const pos = (lines.find((l) => /^> 定位/.test(l)) || '').replace(/^>\s*/, '').replace(/\*\*/g, '').trim();
      if (pos) out.push(`Power：${pos}（Skill 触发已机器化：skill-loader 扫 frontmatter contract.triggers；积木盘点 _index.md）`);
    } catch { /* 忽略 */ }
  }
  return out.join('\n');
}
// ── 注：R0 宪法（mind\L0\SOUL.md 人格 + AGENTS.md 运行）由宿主插件 dshome-mind-inject 运行时读双件全文注入
//    （正文=注入源，无手写摘要副本）；mind-prime 不再重复生成任何 R0 内容（旧版关键词抽取已删——依据唯一）。
// 本脚本只装配动态召回：project 进度/待办 + L3 相关记忆 + Learn 最近教训 + user-rules + 人设。

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
const prs = persona();
const mp = mapSight();
// 歧义检测只对显式传入的 query 生效（用户/调用方给的搜索词）；内部默认装配关键词不提示
const ambiguous = hasExplicitQuery ? disambiguationFor(query) : [];

if (asJson) {
  console.log(JSON.stringify({ query, project: p, memories, learn: lrn, userRules: rules, persona: prs, ambiguous }, null, 2));
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
const openTodos = p.todos.filter((t) => !t.done);
if (openTodos.length) out.push(`\n■ project.md「下一步」待办（未勾选 ${openTodos.length}）\n${openTodos.slice(0, 8).map((t) => `- [ ] ${t.text}`).join('\n')}`);
if (memories.length) out.push(`\n■ L3 相关记忆（top${memories.length}）\n${memories.map((m) => `- [${m.score}] ${m.file} :: ${m.section}\n  ${m.snippet}`).join('\n')}`);
if (lrn.length) out.push(`\n■ Learn 最近教训\n${lrn.join('\n')}`);
if (mp) out.push(`\n■ 上工地图（知识库速览——Tree/Power，深查 read 对应文件）\n${mp}`);
if (rules) out.push(`\n■ user-rules（用户偏好/铁律）\n${rules}`);
if (prs) out.push(`\n■ 人设卡（本机私密，演绎唯一权威源）\n${prs}`);
console.log(out.join('\n'));
