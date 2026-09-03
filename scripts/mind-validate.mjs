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
  const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
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

// ② L3 记忆条目完整性（单记忆文件 = 文件名带 YYYY-MM-DD_ 前缀）
const memories = walk(join(PRIV, 'L3', 'index'), [], 'L3/index')
  .filter((f) => !/README|_index/.test(basename(f.rel)) && /^\d{4}-\d{2}-\d{2}_/.test(basename(f.rel)));
for (const m of memories) {
  const kv = readFm(readFileSync(m.full, 'utf8'));
  const miss = hasKeys(kv, ['kind', 'importance', 'scope', 'topic', 'tags']);
  if (!kv) issues.push({ sev: 'critical', file: m.rel, msg: 'L3 记忆缺 frontmatter' });
  else if (miss.length) issues.push({ sev: 'critical', file: m.rel, msg: `L3 记忆 frontmatter 缺: ${miss.join(', ')}` });
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
for (const f of walk(MIND, [], 'mind').concat(walk(PRIV, [], 'priv', ))) {
  const kv = readFm(readFileSync(f.full, 'utf8'));
  const rel = (kv && kv.related) || '';
  for (const t of rel.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!relExists(t)) issues.push({ sev: 'critical', file: f.rel, msg: `related 死链: ${t}` });
  }
}

// ④ _index.md 引用的文件必须真实存在（同目录）
function checkIndexes() {
  const idxFiles = walk(join(PRIV, 'L3', 'index'), [], 'L3/index').filter((f) => basename(f.rel) === '_index.md');
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

const treeSet = skillSetFromTree();
if (treeSet.ok) {
  const missInTree = [...actualSkills].filter((x) => !treeSet.set.has(x));
  const extraInTree = [...treeSet.set].filter((x) => !actualSkills.has(x));
  if (missInTree.length || extraInTree.length)
    issues.push({ sev: 'critical', file: 'mind/L1/Tree.md', msg: `(a) Tree 与 Skill 实际不一致——Tree 缺: ${missInTree.join(',') || '无'}；Tree 多: ${extraInTree.join(',') || '无'}` });
}
const idxSet = skillSetFromIndex();
if (idxSet.ok) {
  const missInIdx = [...actualSkills].filter((x) => !idxSet.set.has(x));
  const extraInIdx = [...idxSet.set].filter((x) => !actualSkills.has(x));
  if (missInIdx.length || extraInIdx.length)
    issues.push({ sev: 'critical', file: 'mind/L2/Skill/_index.md', msg: `(a) _index 与 Skill 实际不一致——_index 缺: ${missInIdx.join(',') || '无'}；_index 多: ${extraInIdx.join(',') || '无'}` });
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
    if (/^##\s*意图路由表/.test(line)) { inRoutes = true; continue; }
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
}

// ⑦ (c) AGENTS 双版本同步：根 E:\DSHOME\AGENTS.md 与 build-stage\payload\AGENTS.md 引用路径集合
function refPaths(content) {
  const set = new Set();
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(content))) {
    const t = m[1].replace(/\\/g, '/').trim();
    if (/\//.test(t) || /^mind|^mind-private|^scripts|^tasks|^build-stage/.test(t)) set.add(t);
  }
  return set;
}
const rootAgentsFile = join(repoRoot, 'AGENTS.md');
const payloadAgentsFile = join(repoRoot, 'build-stage', 'payload', 'AGENTS.md');
if (existsSync(rootAgentsFile) && existsSync(payloadAgentsFile)) {
  const rootC = readFileSync(rootAgentsFile, 'utf8');
  const payloadC = readFileSync(payloadAgentsFile, 'utf8');
  const rp = refPaths(rootC);
  const pp = refPaths(payloadC);
  const onlyRoot = [...rp].filter((x) => !pp.has(x));
  const onlyPayload = [...pp].filter((x) => !rp.has(x));
  const declaredRootAuthoritative = /唯一权威版|仅以根版为准|根版权威|权威.*根版|根版.*权威|打包快照/.test(rootC);
  if ((onlyRoot.length || onlyPayload.length) && !declaredRootAuthoritative) {
    issues.push({
      sev: 'warn', file: 'AGENTS.md',
      msg: `(c) 根版与 build-stage\\payload\\AGENTS.md 引用路径漂移——仅根版有: ${onlyRoot.slice(0, 4).join(';') || '无'}；仅 payload 有: ${onlyPayload.slice(0, 4).join(';') || '无'}。若以根版为唯一权威，请在根版声明"唯一权威版/以根版为准"`
    });
  }
}

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
