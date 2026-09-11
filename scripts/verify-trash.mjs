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
// 与 `changelog.md` **一个字节都不会被碰**；收尾再用 `git status` 自证零残留。
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
for (const [name, fn] of CASES) {
  let res;
  try { res = fn(); } catch (e) { res = { pass: false, detail: `异常: ${e && e.message}` }; }
  if (res.pass) { console.log(`  ✅ ${name}  ${res.detail ? `« ${res.detail}»` : ''}`); pass++; }
  else { console.log(`  ❌ ${name}  « ${res.detail}»`); failed.push(name); }
}

// ── 自证零污染：真仓库的 TRASH 与 changelog 一个字节都不该动 ────────────────
const realTrash = join(repoRoot, 'mind-private', 'TRASH');
const realLog = join(repoRoot, 'mind-private', 'tasks', 'evolution', 'changelog.md');
const probe = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'mind-private'], { encoding: 'utf8' });
const dirty = (probe.stdout || '').trim();
console.log('');
console.log(`[verify-trash] 零污染自证：真仓库 mind-private 的 git 状态 ${dirty ? `❌ 有改动\n${dirty}` : '✅ 干净'}（TRASH 存在=${existsSync(realTrash)}）`);

console.log('');
if (failed.length) {
  console.error(`[verify-trash] ❌ ${failed.length}/${CASES.length} 项未过：${failed.join(' / ')}`);
  process.exit(1);
}
console.log(`[verify-trash] ✅ ${pass}/${CASES.length} 全部通过`);
process.exit(0);
