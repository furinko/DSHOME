// scripts/mind-validate.mjs — 心智自写校验器（transaction gate 的验证一半）
// 用途：改"自我类"文件（AGENTS/mind 规则/技能/自身记忆）前/后跑一遍，
//      校验 frontmatter 完整性、related 死链、_index 引用真实存在，
//      以及三类结构性失真：(a) Tree↔_index↔实际 同步、(b) 权威源单一性、(c) AGENTS 双版本。
// 这是"改前快照 → 验证通过才提交 → 失败回滚"里的【验证】步骤的机器实现。
//
// 用法：node scripts/mind-validate.mjs [--strict]
//   默认：输出"问题清单"，critical 存在则 exit 1（阻塞提交）；仅 warnings 则 exit 0。
//   --strict：警告也当成问题（exit 1）。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const MIND = join(repoRoot, 'mind');
const PRIV = join(repoRoot, 'mind-private');
const strict = process.argv.includes('--strict');

const issues = []; // {sev:'critical'|'warn', file, msg}

function walk(dir, out, rel = '') {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    if (statSync(full).isDirectory()) walk(full, out, r);
    else if (e.endsWith('.md')) out.push({ full, rel: r });
  }
  return out;
}

function readFm(content) {
  // CRLF 兼容：Windows 下 mind 文件多为 \r\n，先归一化再解析（否则 LF-only 正则误判缺 frontmatter）
  const c = String(content || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(c);
  if (!m) return null;
  const body = m[1];
  const kv = {};
  for (const line of body.split('\n')) {
    const mm = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (mm) kv[mm[1]] = (mm[2] || '').trim().replace(/^['"]|['"]$/g, '');
  }
  return kv;
}
function hasKeys(kv, keys) {
  if (!kv) return [];
  return keys.filter((k) => !kv[k] && (kv[k] !== '' || !(k in kv)));
}

// ① L2 Skill 完整性
const skills = walk(join(MIND, 'L2', 'Skill'), [], 'L2/Skill')
  .filter((f) => !/README|_index/.test(basename(f.rel)));
for (const s of skills) {
  const kv = readFm(readFileSync(s.full, 'utf8'));
  const miss = hasKeys(kv, ['name', 'description', 'version']);
  if (!kv) issues.push({ sev: 'critical', file: s.rel, msg: 'Skill 缺 frontmatter' });
  else if (miss.length) issues.push({ sev: 'critical', file: s.rel, msg: `Skill frontmatter 缺: ${miss.join(', ')}` });
  if (kv && !/^##\s+一、/m.test(readFileSync(s.full, 'utf8'))) issues.push({ sev: 'warn', file: s.rel, msg: '未按 Skill 五章（## 一、…）格式' });
}

// ①b Skill 版本一致性（Power.md §六："文件头版本与文件尾版本一致"）——四元比对：
//     Skill frontmatter.version == 文件尾 "_版本：x.y" == Tree.md 清单版本 == _index.md 版本。
//     规则：frontmatter 是机器可读真源；文件尾/Tree/_index 是人工维护的镜像。任一不一致即 warn（镜像漂移）。
function footerVersion(md) {
  // 匹配文件尾 `_版本：x.y | ...`（Power L1 文件尾也用此格式；L2 Skill 文件尾在底部署名行）
  const m = md.match(/_版本[：:]\s*v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
  return m ? m[1] : null;
}
function skillVersionFromTree(fileRel) {
  const p = join(MIND, 'L1', 'Tree.md');
  if (!existsSync(p)) return null;
  const line = readFileSync(p, 'utf8').split('\n').find((l) => l.includes(fileRel));
  if (!line) return null;
  const cells = line.split('|').map((c) => c.trim());
  // Tree Skill 清单：| 文件 | 版本 | 描述 | 触发关键词 |
  return (cells[2] || '').match(/[0-9]+\.[0-9]+(?:\.[0-9]+)?/)?.[0] || null;
}
function skillVersionFromIndex(baseName) {
  const p = join(MIND, 'L2', 'Skill', '_index.md');
  if (!existsSync(p)) return null;
  const line = readFileSync(p, 'utf8').split('\n').find((l) => l.includes('`' + baseName + '`'));
  if (!line) return null;
  return (line.match(/\|\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*\|/) || [])[1] || null;
}
for (const s of skills) {
  const content = readFileSync(s.full, 'utf8');
  const kv = readFm(content);
  if (!kv) continue;
  const base = basename(s.rel).replace(/\.md$/, '');
  const fmv = (kv.version || '').trim();
  const foot = footerVersion(content);
  const treeV = skillVersionFromTree(base + '.md');
  const idxV = skillVersionFromIndex(base);
  // 四元去重后若存在不一致 → warn。frontmatter 为真源，镜像偏差不阻塞（--strict 可拦）。
  const set = new Set([fmv, foot, treeV, idxV].filter((v) => v));
  if (set.size > 1) {
    issues.push({
      sev: 'warn', file: s.rel,
      msg: `Skill 版本不一致——frontmatter=${fmv} 文件尾=${foot || '无'} Tree=${treeV || '无'} _index=${idxV || '无'}（依 frontmatter 为准，镜像需对齐）`
    });
  }
}

// ② L3 记忆条目完整性（单记忆文件 = 文件名带 YYYY-MM-DD_ 前缀）
//    记忆区（记忆层重构 2026-09-09）= L3/common + L3/projects/<各项目>/知识（结晶）；导航卡/档案不在此列
function memoryRoots() {
  const roots = [];
  const common = join(PRIV, 'L3', 'common');
  if (existsSync(common)) roots.push({ dir: common, rel: 'L3/common' });
  const projs = join(PRIV, 'L3', 'projects');
  if (existsSync(projs)) {
    for (const e of readdirSync(projs)) {
      const know = join(projs, e, '知识');
      if (existsSync(know)) roots.push({ dir: know, rel: `L3/projects/${e}/知识` });
    }
  }
  return roots;
}
const memories = [];
for (const r of memoryRoots()) {
  memories.push(...walk(r.dir, [], r.rel).filter((f) => !/README|_index/.test(basename(f.rel)) && /^\d{4}-\d{2}-\d{2}_/.test(basename(f.rel))));
}
for (const m of memories) {
  const kv = readFm(readFileSync(m.full, 'utf8'));
  const miss = hasKeys(kv, ['kind', 'importance', 'scope', 'topic', 'tags']);
  if (!kv) issues.push({ sev: 'critical', file: m.rel, msg: 'L3 记忆缺 frontmatter' });
  else if (miss.length) issues.push({ sev: 'critical', file: m.rel, msg: `L3 记忆 frontmatter 缺: ${miss.join(', ')}` });
  // 溯源契约（生长哲学底座-组件A）：source（外部可查证依据）或 verified:false（自推理降权）至少其一
  if (kv) {
    const hasSource = !!(kv.source || '').trim();
    const isUnverified = String(kv.verified || '').trim().toLowerCase() === 'false';
    if (!hasSource && !isUnverified)
      issues.push({ sev: 'critical', file: m.rel, msg: 'L3 记忆缺溯源：须带 source（外部可查证依据）或 verified: false（自推理降权，不参与权威）' });
  }
}

// ②b 记忆层布局接线自检（2026-09-11 新增）：防「重构换了消费者，存量数据没迁」
//    实测病灶（2026-09-11 盲评）：2026-09-09 记忆层重构把 L3/index 判为废止，但 6 条存量记忆
//    从未迁移；检索/召回/图谱/dupCheck 全按新布局寻址 → 生产路径 100% 空转（召回 0/6），
//    而 ② 因 memoryRoots 返回空数组静默通过（整段成运行时死代码，记忆溯源从未被检查）。
//    本条把「新布局空 + 旧布局非空」提升为 critical——布局断线不许提交。
{
  const legacyDirs = [
    { dir: join(PRIV, 'L3', 'index'), rel: 'L3/index' },
    { dir: join(PRIV, 'Project'), rel: 'Project' },
  ];
  const legacyCount = legacyDirs.reduce((n, d) => n + (existsSync(d.dir)
    ? walk(d.dir, [], d.rel).filter((f) => /^\d{4}-\d{2}-\d{2}_/.test(basename(f.rel))).length : 0), 0);
  const legacyNames = legacyDirs.filter((d) => existsSync(d.dir)).map((d) => d.rel).join(' / ');
  if (legacyCount > 0 && memories.length === 0) {
    issues.push({
      sev: 'critical', file: legacyNames,
      msg: `记忆层布局断线：新布局区（L3/common + L3/projects/<项目>/知识）无记忆文件，旧布局仍有 ${legacyCount} 条——检索/召回/dupCheck 全按新布局寻址，存量不迁即「写得进、召不回」。迁移数据或回退消费者口径后再提交。`
    });
  } else if (legacyCount > 0) {
    issues.push({
      sev: 'warn', file: legacyNames,
      msg: `旧布局残留 ${legacyCount} 条记忆（新布局已有 ${memories.length} 条）——确认为归档副本还是重复真源；单一真源铁律（Memory.md §四 防漂移）。`
    });
  }
}

// ②c 重复真源检测（2026-09-11 补，盲评指摘）：`L3/history` 是归档区（合法，Memory §三「只写不改」），
//    但若它与**活区**存在同名文件，就有两种可能：① 一次迁移留档（可接受，宜按 §三 命名加 `_归档`
//    后缀以消除歧义）；② 误复制 → 单一真源被破坏、改活区时副本静默漂移。
//    ②b 只看「旧布局目录是否还有残留」，**看不见 history 里的同名副本**（盲评实测：8 个文件与活区
//    内容全同，校验器完全不可见）。等级 warn：归档本身合法，人确认即可，不阻塞提交。
{
  const histRoot = join(PRIV, 'L3', 'history');
  if (existsSync(histRoot)) {
    const liveByName = new Map();
    for (const r of memoryRoots()) {
      for (const f of walk(r.dir, [], r.rel)) liveByName.set(basename(f.rel), f.full);
    }
    const dups = [];
    for (const h of walk(histRoot, [], 'L3/history')) {
      // 🔴 排除每目录索引 `_index.md`：它按设计分布在 `common/<主题>/`、`projects/<项目>/知识/<主题>/`
      //    以及 `history/` 自身（见本文件 ④ 的说明），**天然与活区同名**，不构成「重复真源」。
      //    2026-09-11 实测：本项唯一命中就是 `L3/history/_index.md` 与 `L3/common/_index.md` 同名——
      //    而它们是两个不同目录各自的索引，内容不同是正常的（旧判据把它误报成"副本已失效"）。
      if (basename(h.rel) === '_index.md') continue;
      const live = liveByName.get(basename(h.rel));
      if (!live) continue;
      let same = false;
      try { same = readFileSync(live, 'utf8') === readFileSync(h.full, 'utf8'); } catch { /* 忽略 */ }
      dups.push(`${h.rel}${same ? '（同名同内容）' : '（同名·内容已漂移）'}`);
    }
    if (dups.length) {
      issues.push({
        sev: 'warn', file: 'L3/history',
        msg: `history 与活区同名文件 ${dups.length} 个——归档副本合法，但需确认不是「重复真源」：${dups.slice(0, 3).join('、')}${dups.length > 3 ? ` …另 ${dups.length - 3} 个` : ''}（若为迁移留档，建议按 Memory §三 命名加 \`_归档\` 后缀消除歧义；若显示"内容已漂移"则该副本已失效）`
      });
    }
  }
}

// ③ related 死链（frontmatter related 属性 → 文件必须存在）
function relExists(target) {
  const t = (target || '').replace(/\.md$/i, '');
  const candidates = [
    join(MIND, t), join(PRIV, t),
    join(MIND, t + '.md'), join(PRIV, t + '.md'),
  ];
  // related 常写作相对路径如 mind/L1/Memory.md 或 basename
  for (const c of candidates) if (existsSync(c)) return true;
  // basename 兜底：在 mind/(mind-private) 下找同名
  const base = basename(t);
  if (base) {
    for (const root of [MIND, PRIV]) {
      const files = walk(root, []);
      if (files.some((f) => basename(f.rel).replace(/\.md$/i, '') === base)) return true;
    }
  }
  return false;
}
let relatedSeen = 0;
for (const f of walk(MIND, [], 'mind').concat(walk(PRIV, [], 'priv', ))) {
  const kv = readFm(readFileSync(f.full, 'utf8'));
  // related 支持两种写法：逗号分隔字符串 或 YAML 数组 [a, b]（剥外层方括号再拆）
  const relRaw = (kv && kv.related) || '';
  const rel = String(relRaw).trim().replace(/^\[|\]$/g, '');
  for (const t of rel.split(',').map((s) => s.trim()).filter(Boolean)) {
    relatedSeen++;
    if (!relExists(t)) issues.push({ sev: 'critical', file: f.rel, msg: `related 死链: ${t}` });
  }
}
// 2026-09-11（第四轮盲评 · C2）：本检查此前是「critical 级 + **零输入** + 100% 恒真」——
// 全仓 109 个 .md 里 `related:` 出现 **0 次**，而 README/Skill 里却宣传它"会拦死链"。
// 处理：保留检查（将来有人用 related 时仍能抓死链），但把"当前零输入"变成**可见的 info**，
// 而不升温成 critical/warn —— 后者会造一盏恒亮灯（A′/C2 都批评过恒亮灯）。
if (relatedSeen === 0) {
  issues.push({ sev: 'info', file: 'mind/**（全仓 frontmatter）', msg: 'related 死链检查当前**零输入**：没有任何文件带 `related` 字段 → 该 critical 级检查实际从未执行过。要用它就补 related；不用它，请从 README/Skill 的宣传里去掉这半句。' });
}

// ④ _index.md 引用的文件必须真实存在（同目录）——记忆层重构后 _index 分布：L3/common/<主题>/、L3/projects/<项目>/知识/<主题>/、L3/history/
function checkIndexes() {
  const idxFiles = walk(join(PRIV, 'L3'), [], 'L3').filter((f) => basename(f.rel) === '_index.md');
  for (const idx of idxFiles) {
    const dir = dirname(idx.full);
    for (const line of readFileSync(idx.full, 'utf8').split('\n')) {
      const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
      if (!m) continue;
      const cell = m[1].trim().replace(/`/g, '');
      if (/\.md$|\.json$/.test(cell)) {
        if (!existsSync(join(dir, cell))) issues.push({ sev: 'critical', file: idx.rel, msg: `_index 引用缺失文件: ${cell}` });
      }
    }
  }
}
checkIndexes();

// ⑤ (a) Tree ↔ _index ↔ 实际 同步：L2-Skill 文件名集合一致性
function baseName(rel) { return basename(rel).replace(/\.md$/i, ''); }
const actualSkills = new Set(skills.map((s) => baseName(s.rel)));

function skillSetFromTree() {
  const p = join(MIND, 'L1', 'Tree.md');
  if (!existsSync(p)) return { ok: false, set: new Set() };
  const set = new Set();
  let inSkill = false;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (/^###\s+Skill\s+清单/.test(line)) { inSkill = true; continue; }
    if (inSkill && /^###\s+/.test(line)) break;
    if (!inSkill) continue;
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (m) {
      const cell = m[1].trim();
      if (/\.md$/i.test(cell)) set.add(cell.replace(/\.md$/i, ''));
    }
  }
  return { ok: true, set };
}
function skillSetFromIndex() {
  const p = join(MIND, 'L2', 'Skill', '_index.md');
  if (!existsSync(p)) return { ok: false, set: new Set() };
  const set = new Set();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) set.add(m[1].trim());
  }
  return { ok: true, set };
}

// 2026-09-11（第四轮盲评 · C2 首推）：**输入缺失 ⇒ critical，不再静默跳过**。
// 病灶：全文件原有 8 处 `if (xxx.ok)` / `if (existsSync(...))` 结构，输入缺失时无声跳过 →
//   「门禁的『存在性』本身无人守」：改个标题、删个索引、挪个目录，门禁就消失得无声无息，输出仍全绿。
//   `(c)` 就是这样死了几个月（基准条件恒假）——同款句式当时还剩 7 处。
// 原则：**判据消失比判据判错更危险**（判错至少会响）。本批起，任何"解析不到输入"一律响亮失败。
const treeSet = skillSetFromTree();
if (treeSet.ok) {
  const missInTree = [...actualSkills].filter((x) => !treeSet.set.has(x));
  const extraInTree = [...treeSet.set].filter((x) => !actualSkills.has(x));
  if (missInTree.length || extraInTree.length)
    issues.push({ sev: 'critical', file: 'mind/L1/Tree.md', msg: `(a) Tree 与 Skill 实际不一致——Tree 缺: ${missInTree.join(',') || '无'}；Tree 多: ${extraInTree.join(',') || '无'}` });
} else {
  issues.push({ sev: 'critical', file: 'mind/L1/Tree.md', msg: '(a) 门禁输入缺失：Tree.md 的 Skill 清单解析不到（文件缺失或表格格式变了）→ 本检查实际未执行，不能据此认为「Tree 与实际一致」' });
}
const idxSet = skillSetFromIndex();
if (idxSet.ok) {
  const missInIdx = [...actualSkills].filter((x) => !idxSet.set.has(x));
  const extraInIdx = [...idxSet.set].filter((x) => !actualSkills.has(x));
  if (missInIdx.length || extraInIdx.length)
    issues.push({ sev: 'critical', file: 'mind/L2/Skill/_index.md', msg: `(a) _index 与 Skill 实际不一致——_index 缺: ${missInIdx.join(',') || '无'}；_index 多: ${extraInIdx.join(',') || '无'}` });
} else {
  issues.push({ sev: 'critical', file: 'mind/L2/Skill/_index.md', msg: '(a) 门禁输入缺失：_index.md 的 Skill 清单解析不到（文件缺失或表格格式变了）→ 本检查实际未执行' });
}

// ⑥ (b) 权威源单一性（Concepts.md 契约）：每个概念只声明一个唯一权威源（自洽）；
//       且"意图路由表"里每条路由的目标概念必须已在注册表声明（无悬空）。
//       说明：不做跨文档"中文↔英文概念名"的模糊匹配（易误报，违背薄契约原则）；
//             AGENTS 侧一致性由"引用 Concepts 而非重复定义"结构性保证，双版本由 (c) 兜底。
function conceptRegistry() {
  const p = join(MIND, 'L1', 'Concepts.md');
  if (!existsSync(p)) return { ok: false, map: new Map() };
  const map = new Map(); // concept(lower) -> 唯一权威源
  let inRegistry = false;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (/^##\s*概念注册表/.test(line)) { inRegistry = true; continue; }
    if (inRegistry && /^##\s+/.test(line)) break;
    if (!inRegistry) continue;
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const concept = m[1].trim().replace(/`/g, '').toLowerCase();
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (/^(概念|唯一权威源|--+)$/.test(concept)) continue;
    if (cells.length < 2) continue;
    const src = cells[1];
    if (!src || /^--+$/.test(src)) continue;
    if (map.has(concept) && map.get(concept) !== src)
      issues.push({ sev: 'critical', file: 'mind/L1/Concepts.md', msg: `(b) 概念「${concept}」声明两个不同权威源：${map.get(concept)} ↹ ${src}` });
    else map.set(concept, src);
  }
  return { ok: true, map };
}
function routeConcepts() {
  const p = join(MIND, 'L1', 'Concepts.md');
  if (!existsSync(p)) return [];
  const out = [];
  let inRoutes = false;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    // 2026-09-11 修（盲评实测）：原正则 `^##\s*意图路由表` 与 Concepts.md 的实际标题
    // `## 意图 → 概念 → 权威源（路由表）` 不匹配 → `routeConcepts()` 恒返回 []，本段成**死代码**
    // （改了路由表也不会报）。放宽为 `^##\s*意图` 前缀匹配。
    if (/^##\s*意图/.test(line)) { inRoutes = true; continue; }
    if (inRoutes && /^##\s+/.test(line)) break;
    if (!inRoutes) continue;
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^(意图|概念|权威源|去哪里|来源|--+)$/.test(cells[1])) continue;
    const concept = cells[1].replace(/`/g, '').toLowerCase();
    if (concept) out.push(concept);
  }
  return out;
}
const reg = conceptRegistry();
if (reg.ok) {
  const declared = new Set(reg.map.keys());
  for (const c of routeConcepts()) {
    if (!declared.has(c))
      issues.push({ sev: 'critical', file: 'mind/L1/Concepts.md', msg: `(b) 意图路由表指向未在注册表声明的概念「${c}」` });
  }
} else {
  issues.push({ sev: 'critical', file: 'mind/L1/Concepts.md', msg: '(b) 门禁输入缺失：「## 概念注册表」解析不到（文件缺失或标题被改）→ 权威源单一性检查实际未执行' });
}

// ⑥c Concepts 接口 ↔ 后端路由 对应（K3 ② 补半：改表不改后端=纸面漂移；后端删接口未同步表=实现漂移）
function backendMindRoutes() {
  const p = join(repoRoot, 'packages', 'dshome-mind', 'lib', 'index.cjs');
  if (!existsSync(p)) return { ok: false, set: new Set() };
  const src = readFileSync(p, 'utf8');
  const set = new Set();
  // 路由两种写法：字面量 path: '/api/mind/...'  或 模板 path: `${API_PREFIX}/...`（API_PREFIX=/api/mind）
  for (const m of src.matchAll(/path:\s*'(\/api\/mind\/[^']+)'/g)) set.add(m[1]);
  for (const m of src.matchAll(/path:\s*`\$\{API_PREFIX\}\/([^`]+)`/g)) set.add('/api/mind/' + m[1]);
  return { ok: true, set };
}
function conceptInterfaces() {
  const p = join(MIND, 'L1', 'Concepts.md');
  if (!existsSync(p)) return [];
  const src = readFileSync(p, 'utf8');
  const out = new Set();
  // 抽行内 /api/mind/<path>（去 query 尾）——主路径与后端 route 精确比对
  for (const m of src.matchAll(/\/api\/mind\/[a-z][a-z-]*(?:\/[a-z][a-z-]*)*/g)) out.add(m[0]);
  return [...out];
}
const bRoutes = backendMindRoutes();
if (bRoutes.ok) {
  for (const iface of conceptInterfaces()) {
    if (!bRoutes.set.has(iface))
      issues.push({ sev: 'warn', file: 'mind/L1/Concepts.md', msg: `(c) Concepts 接口「${iface}」在后端 index.cjs 路由中未找到——改表没改后端 / 后端接口已删未同步（路由表↔后端符号缺失）` });
  }
} else {
  issues.push({ sev: 'critical', file: 'packages/dshome-mind/lib/index.cjs', msg: '(c) 门禁输入缺失：后端 index.cjs 读不到（文件缺失或路径变了）→ 「Concepts 接口 ↔ 后端路由」对应检查实际未执行' });
}

// ⑥d 注入源检查（v3.0：R0 双件注入——mind-inject.js 须读 mind\L0\SOUL.md + AGENTS.md 为注入源；
//   手写 L0_SUMMARY 摘要已废，死灰复燃即 warn；R0 双件路径任一缺失也 warn）。启发式。
function injectSourceCheck() {
  const p = join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'mind-inject.js');
  if (!existsSync(p)) return { ok: false, issues: [] };
  const src = readFileSync(p, 'utf8');
  const issues = [];
  if (/const\s+L0_SUMMARY\s*=/.test(src))
    issues.push({ sev: 'warn', file: 'packages/dshome/lib/host/mind-inject.js', msg: `手写 L0_SUMMARY 死灰复燃——v3.0 起注入源必须是 mind\\L0\\SOUL.md + AGENTS.md 全文（正文即注入，禁止硬编码纪律副本）` });
  const hasR0 = src.includes("'mind', 'L0'") && src.includes("'SOUL.md'") && src.includes("'AGENTS.md'");
  if (!hasR0)
    issues.push({ sev: 'warn', file: 'packages/dshome/lib/host/mind-inject.js', msg: `mind-inject.js 未引用 R0 双件路径（mind\\L0\\SOUL.md + AGENTS.md）——注入源应为两件宪法全文（正文即注入源）` });
  return { ok: true, issues };
}
const isc = injectSourceCheck();
if (isc.ok) issues.push(...isc.issues);
else issues.push({ sev: 'critical', file: 'packages/dshome/lib/host/mind-inject.js', msg: '(d) 门禁输入缺失：mind-inject.js 读不到（文件缺失或路径变了）→ 「注入源是否为 R0 双件」检查实际未执行' });

// ⑦ (c) AGENTS 双版本同步：权威版 mind\L0\AGENTS.md 与打包快照 build-stage\payload\AGENTS.md 全文一致
//    （根版 $DSH_HOME\AGENTS.md 已于 2026-09-04 退役删除，权威版唯一 = mind\L0\AGENTS.md。
//      原「根版 vs payload」基准的条件恒假，导致 (c) 从未真正执行；且旧判定用"反引号路径集合"近似，
//      抓不住正文漂移（如 USER 残留、措辞差异）。payload 是打包时从权威版同步的快照，
//      故改为【全文一致】判定——规范化换行后逐字符比对，严格、无近似。允许行尾差异。）
function normalizeEOL(s) { return String(s).replace(/\r\n/g, '\n'); }
const authoritativeAgentsFile = join(MIND, 'L0', 'AGENTS.md');
const payloadAgentsFile = join(repoRoot, 'build-stage', 'payload', 'AGENTS.md');
if (existsSync(authoritativeAgentsFile) && existsSync(payloadAgentsFile)) {
  const authC = normalizeEOL(readFileSync(authoritativeAgentsFile, 'utf8'));
  const payloadC = normalizeEOL(readFileSync(payloadAgentsFile, 'utf8'));
  if (authC !== payloadC) {
    issues.push({
      sev: 'warn', file: 'mind/L0/AGENTS.md',
      msg: `(c) 权威版(mind/L0/AGENTS.md)与 build-stage\\payload\\AGENTS.md 内容不一致——payload 是打包快照（禁止手改，打包时从权威版同步），当前两者已漂移，部署将带上旧版 AGENTS。请重新打包同步；跑 --strict 可拦截`
    });
  }
}

// ⑧ 头/尾版本一致性（Power §六：文件头版本与文件尾版本一致）——规则类文件两端都带版本行才比较
// 头部取值序：frontmatter version（L2 Skill）→ 正文头 `> 版本：x.y`；尾部取文末 `_版本：x.y`。
function versionPair(content) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  const num = (s) => { const m = String(s || '').trim().match(/^(\d+)\.(\d+)/); return m ? Number(m[1]) * 100 + Number(m[2]) : null; };
  const headLines = c.slice(0, 1500).split('\n');
  const tailLines = c.slice(-1500).split('\n');
  let head = null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(c);
  if (fm) { const v = /^version:\s*([0-9.]+)/m.exec(fm[1]); if (v) head = v[1]; }
  if (head === null) for (const ln of headLines) { const m = /^\s*>\s*版本[：:]\s*([0-9.]+)/.exec(ln); if (m) { head = m[1]; break; } }
  let tail = null;
  for (const ln of tailLines) { const m = /_?\s*版本[：:]\s*([0-9.]+)/.exec(ln); if (m) { tail = m[1]; break; } }
  return { head: num(head), tail: num(tail), hs: head, ts: tail };
}
// 根 AGENTS.md 已于 2026-09-04 退役删除（权威版唯一 = mind/L0/AGENTS.md）；存在时才加入版本检查（向前兼容）
const extraVersionFiles = [];
if (existsSync(join(repoRoot, 'AGENTS.md'))) extraVersionFiles.push({ full: join(repoRoot, 'AGENTS.md'), rel: 'AGENTS.md' });
for (const f of walk(MIND, [], 'mind').concat(extraVersionFiles)) {
  if (/L3|Project|TRASH/.test(f.rel)) continue; // 记忆/项目档不适用版本行规范
  const c = readFileSync(f.full, 'utf8');
  const { head, tail, hs, ts } = versionPair(c);
  if (head !== null && tail !== null && head !== tail)
    issues.push({ sev: 'warn', file: f.rel, msg: `头/尾版本不一致（头 ${hs} vs 尾 ${ts}）——Power §六 要求一致` });
}

// ⑨ 出厂卫生：禁词表扫描公开面（2026-09-10）
//   背景：2026-09-08 隐私事故（Tree.md 登记私有项目名并推送）修复后，09-09 重构波又以"举例"形式把它
//   写回 AGENTS/Memory/scripts/client.js —— 同一个洞换了扇门。收工自省扫描（git grep HEAD）才抓到 7 处。
//   判据：出厂区/公开面**永不写私有项目名 / 个人路径**；靠记性守不住，改成机器扫。
//   禁词表存 `mind-private\tasks\private-denylist.txt`（含私有名 → 本身不能进公开仓库）。
//   等级：**critical**（2026-09-10 当日先用 warn 上线、清零存量后按约定升为 critical）——出厂区写私有名/个人路径
//   是🔴红线（随 git 推公开仓库即外泄），只提示不阻塞等于留个洞。要放行某处，需先从禁词表移除该词或改掉内容。
function publicDenylistCheck() {
  const listFile = join(PRIV, 'tasks', 'private-denylist.txt');
  // 2026-09-11 修（openhanako 考古 · 出厂边界）：**输入缺失必须响亮失败**，不再静默 no-op。
  // 背景：C2 审计指出「删掉禁词表文件即整体解除」——原实现两处 `return` 让门禁在输入缺失时**假装全绿**，
  // 而这门禁是出厂卫生的**唯一**守卫（禁词表本身在私有区、含私有名 ⇒ 二者只能同生共死）。
  // 三分支：① 私有区在、表不在 → 本机该有却没有（被误删/未建）→ critical；
  //         ② 私有区不在（公开克隆的正常态）→ info **显式说明"⑨ 未执行"**（不静默）；
  //         ③ 表在、零有效词条 → 形同虚设 → critical。
  if (!existsSync(listFile)) {
    if (existsSync(PRIV)) {
      issues.push({ sev: 'critical', file: '出厂卫生', msg: '⑨ 门禁输入缺失：私有区存在但 `mind-private\\tasks\\private-denylist.txt` 不在 → 出厂卫生检查**实际未执行**（C2 审计：「删一个文件即整体解除」）。请重建该表，或明确接受无此门禁' });
    } else {
      issues.push({ sev: 'info', file: '出厂卫生', msg: '⑨ 未执行：本机无 `mind-private/`（公开克隆的正常状态）——该门禁需在持有私有区的环境运行' });
    }
    return;
  }
  const terms = readFileSync(listFile, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!terms.length) {
    issues.push({ sev: 'critical', file: '出厂卫生', msg: '⑨ 门禁输入为空：禁词表存在但**零有效词条** → 检查形同虚设（要么补词、要么删表并显式接受无此门禁）' });
    return;
  }
  // 扫描根 = 一切**会被推送**的目录（2026-09-11 扩面）。
  // 原来只扫 mind/scripts/packages/docs 四根 → vendor/、profile-template/、仓库根散文件、skills/
  // 全是盲区（盲评实测），而这些同样进 git。build-stage 仍由 SKIP_DIR 排除（打包产物，源在扫描面内）。
  const ROOTS = ['mind', 'scripts', 'packages', 'docs', 'profile-template', 'vendor', 'skills']
    .map((r) => join(repoRoot, r)).filter((d) => existsSync(d));
  const SCAN_EXT = /\.(md|mjs|cjs|js|json|txt|ya?ml)$/i;
  const SKIP_DIR = /(^|[\\/])(node_modules|build-stage|\.git|retired|archives|dist)$/;
  // 🔴 2026-09-11 修判据：扫的应该是「**会被推送**的文件」，而不是「路径长在仓库里」的文件。
  //   事故：本机运行时配置 `settings.yaml`（`.gitignore:24` 忽略、`git ls-files` 查无）里的
  //   状态轮播文案含同形词，被当"公开面出现禁词"报 critical —— 量错了对象（假阳性）。
  //   判据改为 git 语义：`git ls-files --others --ignored --exclude-standard` 列出被忽略文件，
  //   命中即跳过。git 不可用（脱仓/无 git）时返回空集 → 退回原行为（宁多扫，不放过真公开面）。
  const ignored = (() => {
    try {
      const out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      return new Set(out.split('\0').filter(Boolean).map((p) => resolve(repoRoot, p)));
    } catch { return new Set(); }
  })();
  const hits = [];
  const scanFile = (full) => {
    if (!SCAN_EXT.test(full)) return;
    if (ignored.has(resolve(full))) return; // 永不推送的本机文件 → 不算公开面

    let text = '';
    try { text = readFileSync(full, 'utf8'); } catch { return; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const t of terms) {
        if (lines[i].includes(t)) hits.push(`${full.slice(repoRoot.length + 1).replace(/\\/g, '/')}:${i + 1}「${t}」`);
      }
    }
  };
  const scan = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (SKIP_DIR.test(full)) continue;
      if (e.isDirectory()) { scan(full); continue; }
      if (e.isFile()) scanFile(full);
    }
  };
  for (const root of ROOTS) scan(root);
  // 仓库根**散文件**单独扫（不递归）：README/LICENSE/*.cmd/*.yml 等也会进 git，属公开面。
  // 不递归是为了不把 sessions/、storages/、attachments/ 等运行时数据拖进来（它们不进 git，也不该被当公开面）。
  try {
    for (const e of readdirSync(repoRoot, { withFileTypes: true })) {
      if (e.isFile()) scanFile(join(repoRoot, e.name));
    }
  } catch { /* 忽略 */ }
  if (hits.length) {
    issues.push({ sev: 'critical', file: '出厂卫生', msg: `公开面出现禁词 ${hits.length} 处（私有项目名/个人路径不得进出厂区——Invariants #13）→ ${hits.slice(0, 8).join('、')}${hits.length > 8 ? ` …另 ${hits.length - 8} 处` : ''}` });
  }
}
publicDenylistCheck();

// 输出
const crit = issues.filter((i) => i.sev === 'critical');
const warn = issues.filter((i) => i.sev === 'warn');
console.log(`[mind-validate] 扫描 mind/ + mind-private/ 完成`);
console.log(`[mind-validate] critical=${crit.length} warn=${warn.length}`);
for (const i of issues) console.log(`  [${i.sev}] ${i.file}: ${i.msg}`);
if (crit.length || (strict && warn.length)) {
  console.log('[mind-validate] ❌ 校验未过，阻塞提交（改前快照 → 验证失败 → 回滚）');
  process.exit(1);
}
console.log('[mind-validate] ✅ 校验通过（可提交/固化）');
