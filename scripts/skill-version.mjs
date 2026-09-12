#!/usr/bin/env node
// scripts/skill-version.mjs — L2 Skill「版本四元」的**机器同步器**（2026-09-12 建）。
//
// 为什么要它：Skill 的版本号写在四处（frontmatter / 文件尾 `_版本：` / `mind\L1\Tree.md` 清单列 /
// `mind\L2\Skill\_index.md` 表格列），**全是手工同步**。2026-09-12 一天之内为两个 Skill 各手工改了
// 4 处、连做两轮（改内容 → 升版本 → 同步四个镜像），一次漏改就是「版本四元不一致」warn。
// 既然 frontmatter 已被定为**机器可读真源**（见 mind-validate.mjs ①b 注释），真源→镜像的复制就该由机器做。
//
// 设计（**不动门禁**）：校验仍在 `scripts/mind-validate.mjs`（pre-commit ② 已经在跑，四元不一致即 warn、
// `--strict` 即拒）。本工具只当**执行器**：按 frontmatter 真源回写那三个镜像。单一职责，避免第二套判据。
//
// 用法：
//   node scripts/skill-version.mjs --check                  # 只报漂移（读，不写）
//   node scripts/skill-version.mjs --sync <id>              # 按 frontmatter 回写三个镜像
//   node scripts/skill-version.mjs --bump <id> <x.y.z>      # 改 frontmatter + 回写三个镜像（一条命令代替四处手改）
//   node scripts/skill-version.mjs --selftest               # 隔离临时树自测（含"应当变红"的反证）
//   node scripts/skill-version.mjs --check --root <dir>     # 指定根（自测/隔离环境用）
//
// ⚠️ `--sync` / `--bump` **会改 mind 文件**（只动版本单元格，不碰正文）⇒ 跑前自己先
//    `node scripts\evolve-log.mjs snapshot <file> "<理由>"`（§四 硬流程：改前快照）。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** @param {{root?: string}} opts */
function paths(root) {
  const r = root || process.env.DSH_HOME || REPO;
  return {
    root: r,
    skillDir: join(r, 'mind', 'L2', 'Skill'),
    tree: join(r, 'mind', 'L1', 'Tree.md'),
    index: join(r, 'mind', 'L2', 'Skill', '_index.md'),
  };
}

const VER = String.raw`v?[0-9]+\.[0-9]+(?:\.[0-9]+)?`;
const fmVersion = (md) => (md.match(/^version:\s*(v?[0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/m) || [])[1] || null;
const footVersion = (md) => (md.match(new RegExp(`_版本[：:]\\s*(${VER})`)) || [])[1] || null;

/** 列出 Skill（排除索引/README）。 */
function listSkills({ skillDir }) {
  if (!existsSync(skillDir)) return [];
  return readdirSync(skillDir)
    .filter((f) => f.endsWith('.md') && f !== '_index.md' && f !== 'README.md')
    .map((f) => ({ id: basename(f, '.md'), file: join(skillDir, f), rel: f }));
}

/** Tree.md 行里第 2 格 = 版本。 */
function treeVersion(treePath, rel) {
  if (!existsSync(treePath)) return null;
  const line = readFileSync(treePath, 'utf8').split('\n').find((l) => l.includes(rel));
  if (!line) return null;
  return ((line.split('|')[2] || '').match(VER) || [])[0] || null;
}

/** _index.md 行里**最后一格** = 版本（取最后格而非"首个像版本的串"，避免描述里的 0.1.5 之类被误认）。 */
function indexVersion(indexPath, id) {
  if (!existsSync(indexPath)) return null;
  const line = readFileSync(indexPath, 'utf8').split('\n').find((l) => l.includes('`' + id + '`'));
  if (!line) return null;
  const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
  const last = cells[cells.length - 1] || '';
  return (last.match(VER) || [])[0] || null;
}

/** 一个 Skill 的四元快照。 */
function snapshot(root, s) {
  const p = paths(root);
  const md = readFileSync(s.file, 'utf8');
  return {
    id: s.id,
    file: s.file,
    fm: fmVersion(md),
    foot: footVersion(md),
    tree: treeVersion(p.tree, s.rel),
    index: indexVersion(p.index, s.id),
  };
}

const uniq = (xs) => [...new Set(xs.filter((v) => v))];

/** 报告漂移；返回漂移列表（空 = 四元一致）。 */
export function check(root) {
  const out = [];
  for (const s of listSkills(paths(root))) {
    const v = snapshot(root, s);
    const set = uniq([v.fm, v.foot, v.tree, v.index]);
    if (set.length > 1 || !v.fm) out.push(v);
  }
  return out;
}

/** 把三个镜像回写成给定版本（逐处精确替换，只动版本单元格）。返回改了什么。 */
function writeMirrors(root, s, ver, { footer = true } = {}) {
  const p = paths(root);
  const changes = [];
  // ① 文件尾：只替换**第一处** `_版本：`（Skill 文件尾是「最新在前」的历史链）
  const md = readFileSync(s.file, 'utf8');
  if (footer) {
    const oldFoot = footVersion(md);
    const newMd = md.replace(new RegExp(`(_版本[：:]\\s*)(${VER})`), `$1${ver}`);
    if (newMd !== md) { writeFileSync(s.file, newMd, 'utf8'); changes.push(`文件尾 ${oldFoot || '无'}→${ver}`); }
  }
  // ② Tree.md：该行第 2 格
  if (existsSync(p.tree)) {
    const oldTree = treeVersion(p.tree, s.rel);
    const lines = readFileSync(p.tree, 'utf8').split('\n');
    let hit = false;
    const out = lines.map((l) => {
      if (hit || !l.includes(s.rel)) return l;
      const cells = l.split('|');
      if (cells.length < 4) return l;
      const old = (cells[2] || '').trim();
      if (!(new RegExp(`^${VER}$`)).test(old)) return l;
      hit = true;
      cells[2] = ` ${ver} `;
      return cells.join('|');
    });
    if (hit) { writeFileSync(p.tree, out.join('\n'), 'utf8'); changes.push(`Tree.md ${oldTree || '无'}→${ver}`); }
  }
  // ③ _index.md：该行**最后一格**
  if (existsSync(p.index)) {
    const oldIdx = indexVersion(p.index, s.id);
    const lines = readFileSync(p.index, 'utf8').split('\n');
    let hit = false;
    const out = lines.map((l) => {
      if (hit || !l.includes('`' + s.id + '`')) return l;
      const cells = l.split('|');
      const lastIdx = cells.length - 2; // 末格（cells[length-1] 是行尾空串）
      if (lastIdx < 1) return l;
      const old = cells[lastIdx].trim();
      if (!(new RegExp(`^${VER}$`)).test(old)) return l;
      hit = true;
      cells[lastIdx] = ` ${ver} `;
      return cells.join('|');
    });
    if (hit) { writeFileSync(p.index, out.join('\n'), 'utf8'); changes.push(`_index.md ${indexVersion(p.index, s.id)}→${ver}`); }
  }
  return changes;
}

/** --sync：按 frontmatter 回写镜像。 */
export function sync(root, id) {
  const s = listSkills(paths(root)).find((x) => x.id === id);
  if (!s) throw new Error(`找不到 Skill「${id}」`);
  const v = snapshot(root, s);
  if (!v.fm) throw new Error(`Skill「${id}」frontmatter 无 version —— 真源缺失，拒绝回写`);
  return writeMirrors(root, s, v.fm);
}

/** --bump：改 frontmatter（真源）+ 回写镜像。
 *  给了 `note` 就在文件尾**追加一条新变更记录**（`_版本：新 | 日期 | 摘要 | _版本：旧 | …`）——
 *  只改数字会把旧摘要挂到新版本名下，那是记录造假，所以摘要必须随版本一起写。 */
export function bump(root, id, ver, note) {
  if (!new RegExp(`^${VER}$`).test(ver)) throw new Error(`非法版本号「${ver}」`);
  const s = listSkills(paths(root)).find((x) => x.id === id);
  if (!s) throw new Error(`找不到 Skill「${id}」`);
  const md = readFileSync(s.file, 'utf8');
  if (!/^version:\s*/m.test(md)) throw new Error(`Skill「${id}」frontmatter 无 version 行 —— 拒绝新建（请人工确认结构）`);
  const oldFoot = footVersion(md);
  let out = md.replace(/^version:\s*.*$/m, `version: ${ver}`);
  const changed = [`frontmatter →${ver}`];
  if (note && oldFoot) {
    const day = new Date().toISOString().slice(0, 10);
    out = out.replace(
      new RegExp(`_版本[：:]\\s*${oldFoot.replace(/\./g, '\\.')}`),
      `_版本：${ver} | ${day} | ${note} | _版本：${oldFoot}`
    );
    changed.push(`文件尾 追加 ${oldFoot}→${ver}（含摘要）`);
    writeFileSync(s.file, out, 'utf8');
    changed.push(...writeMirrors(root, s, ver, { footer: false }));
  } else {
    writeFileSync(s.file, out, 'utf8');
    changed.push(...writeMirrors(root, s, ver));
  }
  return changed;
}

// ── 自测（隔离临时树；含"应当变红"的反证）────────────────────────────────────
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'skill-version-'));
  const ok = [];
  const bad = [];
  const assert = (cond, label) => (cond ? ok : bad).push(label);
  try {
    const dir = join(root, 'mind', 'L2', 'Skill');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'mind', 'L1'), { recursive: true });
    writeFileSync(join(dir, 'fake-skill.md'),
      '---\nname: fake-skill\nversion: 1.0.0\n---\n\n# fake\n\n## 一、x\n\n---\n_版本：1.0.0 | 初始_\n', 'utf8');
    writeFileSync(join(root, 'mind', 'L1', 'Tree.md'),
      '| 文件 | 版本 | 描述 | 触发 |\n|---|---|---|---|\n| fake-skill.md | 1.0.0 | 假技能 | 无 |\n', 'utf8');
    writeFileSync(join(dir, '_index.md'),
      '| Skill | 描述 | 触发 | 产出 | 依赖 | 版本 |\n|---|---|---|---|---|---|\n| `fake-skill` | 假 | 无 | 无 | 无 | 1.0.0 |\n', 'utf8');

    assert(check(root).length === 0, 'A 起点四元一致（check 无漂移）');
    // 反证 1：打坏一个镜像 → check 必红
    writeFileSync(join(dir, 'fake-skill.md'),
      readFileSync(join(dir, 'fake-skill.md'), 'utf8').replace('_版本：1.0.0', '_版本：0.9.9'), 'utf8');
    assert(check(root).length === 1, 'B 打坏文件尾 → check 抓到漂移（应当变红）');
    // 修复
    sync(root, 'fake-skill');
    assert(check(root).length === 0, 'C --sync 后四元复一致');
    assert(snapshot(root, listSkills(paths(root))[0]).foot === '1.0.0', 'C --sync 把文件尾写回 frontmatter 真值');
    // 反证 2：打坏 Tree 与 _index → check 必红；--bump 一并写成新版本
    writeFileSync(join(root, 'mind', 'L1', 'Tree.md'),
      readFileSync(join(root, 'mind', 'L1', 'Tree.md'), 'utf8').replace('| 1.0.0 |', '| 0.1.0 |'), 'utf8');
    writeFileSync(join(dir, '_index.md'),
      readFileSync(join(dir, '_index.md'), 'utf8').replace('| 1.0.0 |', '| 0.1.0 |'), 'utf8');
    assert(check(root).length === 1, 'D 打坏 Tree+_index → check 抓到漂移');
    bump(root, 'fake-skill', '2.0.0');
    const v = snapshot(root, listSkills(paths(root))[0]);
    assert(v.fm === '2.0.0' && v.foot === '2.0.0' && v.tree === '2.0.0' && v.index === '2.0.0',
      'E --bump 后四处全为 2.0.0');
    assert(check(root).length === 0, 'F --bump 后 check 干净');
    // 反证 4：--note 必须「追加新记录 + 保留旧记录」，不许把旧摘要挂到新版本名下
    bump(root, 'fake-skill', '3.0.0', '测试摘要XYZ');
    const md3 = readFileSync(join(dir, 'fake-skill.md'), 'utf8');
    assert(/^version: 3\.0\.0$/m.test(md3)
      && new RegExp('_版本：3\\.0\\.0 \\| \\d{4}-\\d{2}-\\d{2} \\| 测试摘要XYZ \\| _版本：2\\.0\\.0').test(md3),
      'H --bump --note 追加新记录且保留旧记录');
    assert(check(root).length === 0, 'I --note 后四元仍一致');
    // 反证 3：真源缺失 → 拒绝回写
    writeFileSync(join(dir, 'fake-skill.md'), readFileSync(join(dir, 'fake-skill.md'), 'utf8').replace(/^version:.*$/m, 'x: y'), 'utf8');
    let threw = false;
    try { sync(root, 'fake-skill'); } catch { threw = true; }
    assert(threw, 'G frontmatter 无 version → 拒绝回写（响亮失败）');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  for (const l of ok) console.log(`  ✅ ${l}`);
  for (const l of bad) console.error(`  ❌ ${l}`);
  console.log(`skill-version selftest: ${ok.length}/${ok.length + bad.length} 通过`);
  return bad.length === 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const ri = args.findIndex((a) => a === '--root');
  const root = ri === -1 ? undefined : args[ri + 1];
  if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  if (args.includes('--check')) {
    const drift = check(root);
    if (!drift.length) { console.log('skill-version: 全部 Skill 版本四元一致 ✅'); process.exit(0); }
    for (const d of drift) console.error(`  ❌ ${d.id}: frontmatter=${d.fm || '无'} 文件尾=${d.foot || '无'} Tree=${d.tree || '无'} _index=${d.index || '无'}`);
    console.error(`skill-version: ${drift.length} 个 Skill 漂移（用 --sync <id> 或 --bump <id> <x.y.z> 修）`);
    process.exit(1);
  }
  if (args.includes('--sync')) {
    const id = args[args.indexOf('--sync') + 1];
    if (!id) { console.error('用法: --sync <skill-id>'); process.exit(2); }
    const changed = sync(root, id);
    console.log(changed.length ? `已同步 ${id}: ${changed.join(' · ')}` : `${id}: 无需改动（已一致）`);
    process.exit(0);
  }
  if (args.includes('--bump')) {
    const i = args.indexOf('--bump');
    const [id, ver] = [args[i + 1], args[i + 2]];
    const ni = args.indexOf('--note');
    const note = ni === -1 ? undefined : args[ni + 1];
    if (!id || !ver) { console.error('用法: --bump <skill-id> <x.y.z> [--note "<变更摘要>"]'); process.exit(2); }
    console.log(`已升级 ${id}: ${bump(root, id, ver, note).join(' · ')}`);
    process.exit(0);
  }
  console.log('用法: node scripts/skill-version.mjs --check | --sync <id> | --bump <id> <x.y.z> | --selftest [--root <dir>]');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
