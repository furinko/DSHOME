#!/usr/bin/env node
// scripts/verify-trash.mjs — 「TRASH 回收站」真值表验证（2026-09-12 建）
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 2026-09-12 建 `evolve-log trash` 时我**手工**跑了 8 项测试（含 4 个反例），当场抓到一个真 bug：
//   「给了路径但没给 `--reason`」这例 **exit=1 正确、但打印的是"用法"而不是"必须给 --reason"**
//   —— 根因 `ri = -1` 时过滤式 `i !== ri + 1` 等价于 `i !== 0`，把唯一那个路径也吃掉了。
// 但那些测试是**一次性的**：跑完就没了，下次谁改 `trash` 没有任何东西守着。
// 对比 `verify-guard-decisions.mjs`（同样的"手工测试 → 机器化"先例）——
//   **验证不沉淀 ≈ 没验证**（Learn 2026-09-11：「蒸出的不是第三个 Skill，而是机器」）。
//
// ── 怎么做到「不污染被测对象」 ───────────────────────────────────────────────
// `evolve-log.mjs` 的 `repoRoot` 取自 `process.env.DSH_HOME`，`TRASH` / `changelog` / `snapshots`
// 全部由它派生。本脚本给**每个用例一个独立临时 DSH_HOME** ⇒ 真仓库的 `mind-private/TRASH/`
// 与 `changelog.md` **一个字节都不会被碰**；收尾再用**文件系统对照**自证零污染（跑前 / 跑后各取一次
// "递归文件数 + 逐文件 size/mtimeMs 摘要"，增删改任一都判红）。
// ⚠️ 2026-09-28 修：原先那条"`git status` 自证 ✅ 干净"是**恒绿假绿**——`mind-private/` 被
// `.gitignore:42` 忽略（`git ls-files mind-private` = 0 条）⇒ 该区**任何**改动它都读不出来，从建立起
// 没红过。git 读数现降级为 `[info]`（留痕），判据改由文件系统对照承担；可执行反例见文件尾测试口
// （`VERIFY_TRASH_REAL_AREA=<临时区>` + `VERIFY_TRASH_INJECT_PROBE=1` ⇒ 注入一个文件 ⇒ 本判据必红）。
//
// ── 覆盖什么（反例优先：写不出反例＝没验过） ─────────────────────────────────
//   ① 无参数 / ② 缺 --reason（**回归那个真 bug**）/ ③ 路径不存在（响亮失败）
//   ④ 真移入四连断言（原位消失·实体到位·索引有行·changelog 留痕）
//   ⑤ 恢复（内容一致 + 索引划掉 + 双向留痕）
//   ⑥ 反例：原路径被占用 → 拒绝覆盖 / ⑦ 反例：restore 找不到 → 响亮失败
//   ⑧ 目录移入（递归体积）/ ⑨ --list 条数 / ⑩ 只读子命令不建库
//
// 用法：node scripts/verify-trash.mjs
// 退出码：0=全对；1=有用例偏差；2=环境不可用（缺 evolve-log / 非 git 仓库）
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const EVO = join(repoRoot, 'scripts', 'evolve-log.mjs');
if (!existsSync(EVO)) {
  console.error(`[verify-trash] ❌ 环境不可用：找不到 ${EVO}`);
  process.exit(2);
}

/** 每个用例一个**独立** DSH_HOME（真仓库零触碰的关键）。 */
function freshHome() {
  const d = mkdtempSync(join(tmpdir(), 'verify-trash-'));
  mkdirSync(join(d, 'mind-private'), { recursive: true });
  return d;
}
/** 以隔离环境跑 evolve-log，返回 {code, out}。 */
function evo(home, args) {
  const r = spawnSync(process.execPath, [EVO, ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const trashDir = (h) => join(h, 'mind-private', 'TRASH');
const indexFile = (h) => join(trashDir(h), '_index.md');
const changelog = (h) => join(h, 'mind-private', 'tasks', 'evolution', 'changelog.md');
const entities = (h) => (existsSync(trashDir(h)) ? readdirSync(trashDir(h)).filter((n) => n !== '_index.md') : []);
const emptyDir = (p) => { if (existsSync(p)) rmSync(p, { recursive: true, force: true }); };

// ── 零污染对照面：**活区**（真仓库 `mind-private`）的文件系统读数 ─────────────────
// 为什么不再拿 `git status` 当判据（2026-09-28 修）：`mind-private/` 被 `.gitignore` 忽略
// （`.gitignore:42`；`git ls-files mind-private` = **0** 条）⇒ 该区**任何**改动在 git 读数里都恒为
// "✅ 干净"——那条自证从建立起就**没红过**（恒绿假绿，读不出任何东西；同 `verify-mind-panel-labels`
// 里那条"兜底后缀 ≤ 40"的病）。文件系统读数不受 ignore 影响：
//   · 跑前 / 跑后各取一次「递归文件数 + 逐文件 size/mtimeMs 摘要」⇒ 增/删/改任一都判红（**可执行反例**
//     见文件尾"反例注入"测试口）；git 读数保留为 `[info]`（留痕用，不作判据）。
// 测试口（反例用，正常跑**不用**设）：
//   VERIFY_TRASH_REAL_AREA       被测「活区」根（默认＝真仓库 `mind-private`）；反例时指向临时目录
//   VERIFY_TRASH_INJECT_PROBE=1  在两次对照之间往被测区 TRASH 写一个探针文件——**只在**
//     `VERIFY_TRASH_REAL_AREA` 显式指向非真仓库路径时生效（保护：绝不对真仓库注入）。
const realHome = process.env.VERIFY_TRASH_REAL_AREA
  ? resolve(process.env.VERIFY_TRASH_REAL_AREA)
  : join(repoRoot, 'mind-private');
const realTrash = join(realHome, 'TRASH');
const realLog = join(realHome, 'tasks', 'evolution', 'changelog.md');
/** 目录摘要：递归文件数 + 逐文件 `size/mtimeMs`（排序后）哈希 ⇒ 增 / 删 / 改任一都变。 */
function areaDigest(dir) {
  const files = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else if (e.isFile()) {
        try { const st = statSync(join(d, e.name)); files.push(`${r}|${st.size}|${Math.round(st.mtimeMs)}`); }
        catch { /* 读不到 stat 的文件跳过（不影响"有没有变"的判定） */ }
      }
    }
  };
  walk(dir, '');
  files.sort();
  return {
    exists: existsSync(dir),
    count: files.length,
    hash: createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12),
    files,
  };
}
/** 单文件摘要（changelog 用）。 */
function fileDigest(p) {
  try { const st = statSync(p); return { exists: true, size: st.size, hash: `${st.size}|${Math.round(st.mtimeMs)}` }; }
  catch { return { exists: false, size: 0, hash: '' }; }
}
/** 两份目录摘要的差异明细（新增 / 消失 / 被改，各取前 5 条打屏）。 */
function diffDigest(before, after) {
  const key = (s) => s.slice(0, s.lastIndexOf('|'));
  const b = new Map(before.files.map((s) => [key(s), s]));
  const a = new Map(after.files.map((s) => [key(s), s]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)),
    changed: [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)),
  };
}

// ── 用例表：每项返回 {pass, detail} ──────────────────────────────────────────
const CASES = [
  ['① 无参数 → 用法 + exit 1', () => {
    const h = freshHome();
    const r = evo(h, ['trash']);
    return { pass: r.code === 1 && /用法/.test(r.out), detail: `exit=${r.code} out=${r.out.trim().slice(0, 60)}` };
  }],

  ['② 有路径但缺 --reason → exit 1 且**理由正确**（回归真 bug）', () => {
    const h = freshHome();
    const f = join(h, 'x.txt');
    writeFileSync(f, 'hello');
    const r = evo(h, ['trash', f]);
    // 关键：不只是"拦了"，还要"以正确的理由拦"——错误消息是判据的一部分
    const ok = r.code === 1 && /必须给 --reason/.test(r.out) && existsSync(f);
    return { pass: ok, detail: `exit=${r.code} 未移走=${existsSync(f)} out=${r.out.trim().slice(0, 70)}` };
  }],

  ['③ 路径不存在 → 响亮失败（不静默跳过）', () => {
    const h = freshHome();
    const r = evo(h, ['trash', 'no/such/file.txt', '--reason', '测试']);
    const ok = r.code === 1 && /不存在/.test(r.out) && entities(h).length === 0;
    return { pass: ok, detail: `exit=${r.code} TRASH实体=${entities(h).length}` };
  }],

  ['④ 真移入 → 原位消失 + 实体到位 + 索引有行 + changelog 留痕', () => {
    const h = freshHome();
    const f = join(h, 'a.txt');
    writeFileSync(f, 'content-a');
    const r = evo(h, ['trash', f, '--reason', '用例四']);
    const idx = existsSync(indexFile(h)) ? readFileSync(indexFile(h), 'utf8') : '';
    const log = existsSync(changelog(h)) ? readFileSync(changelog(h), 'utf8') : '';
    const checks = {
      原位消失: !existsSync(f), exit0: r.code === 0, 实体: entities(h).length === 1,
      索引: /a\.txt/.test(idx) && /用例四/.test(idx), 留痕: /↳退役/.test(log),
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    return { pass: bad.length === 0, detail: bad.length ? `未过: ${bad.join('/')}` : '四连断言全过' };
  }],

  ['⑤ 恢复 → 内容一致 + 索引划掉 + 双向留痕', () => {
    const h = freshHome();
    const f = join(h, 'b.txt');
    writeFileSync(f, 'content-b');
    evo(h, ['trash', f, '--reason', '用例五']);
    const r = evo(h, ['trash', '--restore', 'b.txt']);
    const idx = readFileSync(indexFile(h), 'utf8');
    const log = readFileSync(changelog(h), 'utf8');
    const checks = {
      exit0: r.code === 0, 原位重现: existsSync(f),
      内容一致: existsSync(f) && readFileSync(f, 'utf8') === 'content-b',
      实体清空: entities(h).length === 0, 索引划掉: /已恢复/.test(idx), 恢复留痕: /↳恢复/.test(log),
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    return { pass: bad.length === 0, detail: bad.length ? `未过: ${bad.join('/')}` : '六连断言全过' };
  }],

  ['⑥ 反例：原路径被占用 → 拒绝覆盖', () => {
    const h = freshHome();
    const f = join(h, 'c.txt');
    writeFileSync(f, 'old');
    evo(h, ['trash', f, '--reason', '用例六']);
    writeFileSync(f, 'occupied');
    const r = evo(h, ['trash', '--restore', 'c.txt']);
    const ok = r.code === 1 && /已被占用/.test(r.out) && readFileSync(f, 'utf8') === 'occupied';
    return { pass: ok, detail: `exit=${r.code} 占位未被覆盖=${readFileSync(f, 'utf8') === 'occupied'}` };
  }],

  ['⑦ 反例：restore 找不到 → 响亮失败（不模糊恢复）', () => {
    const h = freshHome();
    const r = evo(h, ['trash', '--restore', '压根不存在.txt']);
    return { pass: r.code === 1 && /找不到/.test(r.out), detail: `exit=${r.code} out=${r.out.trim().slice(0, 60)}` };
  }],

  ['⑧ 目录移入 → 递归体积统计正确', () => {
    const h = freshHome();
    const d = join(h, 'somedir');
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'f1.txt'), 'x'.repeat(1000));
    writeFileSync(join(d, 'sub', 'f2.txt'), 'y'.repeat(500));
    const r = evo(h, ['trash', d, '--reason', '用例八']);
    const idx = readFileSync(indexFile(h), 'utf8');
    const ok = r.code === 0 && !existsSync(d) && entities(h).length === 1 && /1\.5 KB/.test(idx);
    return { pass: ok, detail: `exit=${r.code} 体积行=${(idx.match(/\| ([^|]*B) \|/) || [])[1] || '?'}` };
  }],

  ['⑨ --list 条数正确', () => {
    const h = freshHome();
    for (const n of ['p.txt', 'q.txt']) { writeFileSync(join(h, n), 'z'); evo(h, ['trash', join(h, n), '--reason', '用例九']); }
    const r = evo(h, ['trash', '--list']);
    const ok = r.code === 0 && /索引 2 条/.test(r.out);
    return { pass: ok, detail: `exit=${r.code} out=${r.out.trim().split('\n')[0].slice(0, 60)}` };
  }],

  ['⑩ 只读：--list 不建库（changelog 不被创建）', () => {
    const h = freshHome();
    const r = evo(h, ['trash', '--list']);
    const ok = r.code === 0 && !existsSync(changelog(h));
    return { pass: ok, detail: `exit=${r.code} changelog 未创建=${!existsSync(changelog(h))}` };
  }],
];

// ── 运行 ────────────────────────────────────────────────────────────────────
console.log(`[verify-trash] 用例 ${CASES.length} 项（隔离方式：每例独立临时 DSH_HOME）`);
let pass = 0;
const failed = [];

// 跑前快照（零污染对照面的"前"半边；必须在任何用例开跑**之前**取）
const beforeArea = areaDigest(realTrash);
const beforeLog = fileDigest(realLog);
// 反例注入（测试口；`realHome` 就是真仓库时**拒绝注入** ⇒ 真仓库零触碰）
if (process.env.VERIFY_TRASH_INJECT_PROBE === '1') {
  if (resolve(realHome) === resolve(repoRoot, 'mind-private')) {
    console.log('  [info] 忽略 VERIFY_TRASH_INJECT_PROBE：被测活区就是真仓库 mind-private（不允许注入）');
  } else {
    mkdirSync(realTrash, { recursive: true });
    writeFileSync(join(realTrash, 'probe-注入反例.md'), '# 探针（反例注入，不是真实内容）\n');
    console.log(`  [info] 反例注入：已往 ${join(realTrash, 'probe-注入反例.md')} 写探针 ⇒ 下面的对照判据必须报红`);
  }
}

for (const [name, fn] of CASES) {
  let res;
  try { res = fn(); } catch (e) { res = { pass: false, detail: `异常: ${e && e.message}` }; }
  if (res.pass) { console.log(`  ✅ ${name}  ${res.detail ? `« ${res.detail}»` : ''}`); pass++; }
  else { console.log(`  ❌ ${name}  « ${res.detail}»`); failed.push(name); }
}

// ── 自证零污染（**文件系统对照**，可判红）：活区的 TRASH 与 changelog 一个字节都不该动 ──
// 上面每例都用独立临时 DSH_HOME ⇒ 真仓库本不该有任何变化。这条判据把"不该"变成机器事实。
const afterArea = areaDigest(realTrash);
const afterLog = fileDigest(realLog);
const d = diffDigest(beforeArea, afterArea);
const areaChanged = beforeArea.count !== afterArea.count || beforeArea.hash !== afterArea.hash;
const logChanged = beforeLog.hash !== afterLog.hash;
console.log('');
console.log(`[verify-trash] 零污染自证（文件系统对照 · 跑前/跑后）：活区 ${realHome}`);
console.log(`  [info] TRASH：${beforeArea.count} 个文件 / 摘要 ${beforeArea.hash}（存在=${beforeArea.exists}）`
  + ` → ${afterArea.count} 个文件 / 摘要 ${afterArea.hash}`);
console.log(`  [info] changelog：${beforeLog.exists ? `${beforeLog.size} 字节 / 摘要 ${beforeLog.hash}` : '不存在'}`
  + ` → ${afterLog.exists ? `${afterLog.size} 字节 / 摘要 ${afterLog.hash}` : '不存在'}`);
const fmtList = (arr) => `${arr.slice(0, 5).join(' / ')}${arr.length > 5 ? ` … 共 ${arr.length}` : ''}`;
if (d.added.length) console.log(`  ❌ TRASH 新增：${fmtList(d.added)}`);
if (d.removed.length) console.log(`  ❌ TRASH 消失：${fmtList(d.removed)}`);
if (d.changed.length) console.log(`  ❌ TRASH 被改：${fmtList(d.changed)}`);
if (areaChanged || logChanged) failed.push('零污染自证（活区被改动）');
else console.log('  ✅ 活区零污染：TRASH 文件数 + 逐文件 size/mtime 摘要、changelog 摘要，跑前跑后完全一致');
// git 读数（**信息臂**，不判失败）：`mind-private/` 被 `.gitignore` 忽略 ⇒ 该读数对该区恒为"干净"、
// 读不出任何改动——这正是它不能当判据的原因（2026-09-28 之前那条"✅ 干净"因此恒绿）。
const probe = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'mind-private'], { encoding: 'utf8' });
const dirty = (probe.stdout || '').trim();
console.log(`  [info] git 读数（信息臂，对该区恒"干净"——mind-private 被 .gitignore 忽略）：${dirty ? `有改动\n${dirty}` : '干净'}`);

console.log('');
if (failed.length) {
  console.error(`[verify-trash] ❌ ${failed.length}/${CASES.length} 项未过：${failed.join(' / ')}`);
  process.exit(1);
}
console.log(`[verify-trash] ✅ ${pass}/${CASES.length} 全部通过`);
process.exit(0);
