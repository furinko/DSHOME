#!/usr/bin/env node
// scripts/verify-trash-sweep.mjs — 「TRASH 排空」执行件的行为核验（2026-09-26 建；同日按独立复核重做）
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// `scripts/trash-sweep.mjs` 是**会物理删除文件**的工具。没有行为门禁＝拿主机的回收站当测试场。
// 本文件用**每个用例一个独立临时 DSH_HOME**（真仓库的 `mind-private\TRASH\` 与 `changelog.md` 一个字节
// 都不会被碰）。
//
// ── 判据（含**复核抓到的三个阻断项的回归反例**）─────────────────────────────
//   1. 默认＝**只列清单**（只读）：不加 `--sweep` 一个字节都不删、也不写留痕。
//   2. 乙档只认**构建产物/分发包**扩展名（zip/exe/msi/…）；`.bak/.tmp/.log` 一律落回甲档
//      （复核实测：真库那两个 `.bak` 是手工备份，不是"可再生产物"）。
//   3. **保护名的备份尾巴也不许绕过**（复核阻断项 ①）：`人设卡.md.bak` 必须留。
//   4. **含不可再生内容的目录不许整目录删**（复核阻断项 ②）：目录名像产物但内含 `.md` ⇒ 留。
//   5. 丙档＝与活文件逐字节相同；活文件已不在时**跳过**（依据失效）。
//   6. 划行用**原路径**这个唯一键（复核阻断项 ③）：同一秒入站的多条不能被连带划掉。
//   7. `--age` 非法值**响亮失败**（不静默降级成"无龄闸"）；`--age N` 龄内不删。
//   8. `--json` 的结果字段**在删除之后**才给（`deleted/failed`，不再"假绿"）。
//
// 用法：node scripts/verify-trash-sweep.mjs；退出码 0＝全过 / 1＝有偏差 / 2＝环境不可用。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'trash-sweep.mjs');
if (!existsSync(TOOL)) { console.error(`[verify-trash-sweep] ❌ 环境不可用：找不到 ${TOOL}`); process.exit(2); }

let pass = 0; const failures = [];
function assert(label, cond, expected, actual) {
  if (cond) { pass++; console.log(`  ok   ${label}`); return; }
  failures.push(label); console.log(`  FAIL ${label}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
  console.log(`       actual:   ${JSON.stringify(actual)}`);
}
function readdirList(d) { try { return readdirSync(d); } catch { return []; } }

/** 隔离夹具。返回各条目的绝对路径，供断言用。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'verify-sweep-'));
  const priv = join(home, 'mind-private');
  const trash = join(priv, 'TRASH');
  mkdirSync(join(priv, 'tasks', 'evolution'), { recursive: true });
  mkdirSync(trash, { recursive: true });
  const w = (rel, text) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  const liveText = '活文件正文-alpha';
  w('mind-private/L3/common/方法论/活档.md', liveText);
  // 乙档：构建产物/分发包（新判据只认这些）
  const zip = w('mind-private/TRASH/2026-09-01T00-00-00__abc12345__old-build.zip', 'zip');
  const msi = w('mind-private/TRASH/2026-09-01T00-00-01__abc12346__setup-1.0.msi', 'msi');
  // 同秒 B 的实体：与索引第二行同秒、且**必须留**（甲档 .md，不在候选里）
  const sameSecKeep = w('mind-private/TRASH/2026-09-01T00-00-00__abc12351__keep-me.md', '同秒的另一件（甲档）');
  // 甲档：`.bak`（复核后**不再**算乙档——真库那两个是手工备份）
  const bak = w('mind-private/TRASH/2026-09-01T00-00-02__abc12347__main.cjs.bak', 'bak');
  const bakTs = w('mind-private/TRASH/2026-09-01T00-00-03__abc12348__main.cjs.bak-20260909-064351', 'bak-ts');
  // 丙档：与活文件逐字节相同
  const dup = w('mind-private/TRASH/2026-09-01T00-00-04__abc12349__活档.md', liveText);
  // 甲档：不可再生、无机器可证依据
  const keep = w('mind-private/TRASH/2026-09-01T00-00-05__abc1234a__某记忆条目.md', '独一无二的内容-不可再生');
  // 复核阻断项 ① 的回归反例：保护名 + 备份尾巴
  const protBak = w('mind-private/TRASH/2026-09-01T00-00-06__abc1234b__人设卡.md.bak', '人设卡旧版');
  const protTmp = w('mind-private/TRASH/2026-09-01T00-00-07__abc1234c__AGENTS.md.tmp', 'AGENTS 旧版');
  const prot = w('mind-private/TRASH/2026-09-01T00-00-08__abc1234d__人设卡.md', '人设卡');
  // 甲档·目录（非可再生产物）
  mkdirSync(join(trash, '2026-09-01T00-00-09__abc1234e__退役目录'), { recursive: true });
  writeFileSync(join(trash, '2026-09-01T00-00-09__abc1234e__退役目录', 'x.md'), '目录里的不可再生');
  // 乙档·目录（名字是 .zip 且内含件全为产物）
  mkdirSync(join(trash, '2026-09-01T00-00-10__abc1234f__old-build.zip'), { recursive: true });
  writeFileSync(join(trash, '2026-09-01T00-00-10__abc1234f__old-build.zip', 'a.zip'), 'zip');
  // 复核阻断项 ② 的回归反例：目录名是 .zip，但**内含 .md**（快照字节）⇒ 必须留
  mkdirSync(join(trash, '2026-09-01T00-00-11__abc12350__伪装产物.zip'), { recursive: true });
  writeFileSync(join(trash, '2026-09-01T00-00-11__abc12350__伪装产物.zip', 'AGENTS.md'), '# 快照字节');
  // 索引：**同一秒入站两行**，且两行原路径各自对应一个真实实体（复核阻断项 ③ 的回归反例形态）
  writeFileSync(join(trash, '_index.md'),
    ['# TRASH 索引', '',
      '| 入站时间 | 原路径 | 体积 | 理由 |', '|---|---|---|---|',
      '| 2026-09-01T00-00-00 | `mind-private/old/old-build.zip` | 3 B | 测试乙档（同秒 A） |',
      '| 2026-09-01T00-00-00 | `mind-private/old/keep-me.md` | 1 KB | 测试甲档（同秒 B） |',
    ].join('\n') + '\n');
  return { home, trash, zip, msi, bak, bakTs, dup, keep, prot, protBak, protTmp, sameSecKeep, priv };
}
function sweep(home, args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

console.log('[verify-trash-sweep] TRASH 排空执行件 · 行为核验');

// ── 1) 默认＝只列清单 ───────────────────────────────────────────────────────
{
  const f = fixture();
  const r = sweep(f.home, ['--json']);
  const alive = [f.zip, f.msi, f.bak, f.bakTs, f.dup, f.keep, f.prot, f.protBak, f.protTmp].filter(existsSync).length;
  let j = null; try { j = JSON.parse(r.out); } catch { /* 见下 */ }
  assert('无参数＝只列清单，退出 0', r.code === 0, 0, r.code);
  assert('只列清单后所有条目原样存在（9 个文件都在）', alive === 9, 9, alive);
  assert('--json 可解析且 mode=list', j && j.mode === 'list', 'mode=list', j && j.mode);
  assert('清单里同时出现乙档与丙档候选', j && j.candidates.some((c) => c.tier === '乙') && j.candidates.some((c) => c.tier === '丙'), '含乙与丙', j && j.candidates.map((c) => c.tier));
  assert('只列清单不写留痕（没有 _cleared-*.md）', !readdirList(f.trash).some((n) => /^_cleared-/.test(n)), '无留痕', readdirList(f.trash).filter((n) => /^_cleared-/.test(n)));
  rmSync(f.home, { recursive: true, force: true });
}

// ── 2) --sweep：乙/丙删，甲档 + 保护名（含备份尾巴）+ 混装目录一个不少 ────────
{
  const f = fixture();
  const r = sweep(f.home, ['--sweep', '--only', 'old-build.zip,setup-1.0.msi,活档.md', '--json']);
  let j = null; try { j = JSON.parse(r.out); } catch { /* 见下 */ }
  assert('--sweep + --only 退出 0', r.code === 0, 0, r.code);
  const rNoOnly = sweep(f.home, ['--sweep', '--json']);
  assert('**只给 --sweep 不给 --only ⇒ 退出 1 拒绝执行**（判据只列候选，落刀逐次点名）', rNoOnly.code === 1 && /--only/.test(rNoOnly.out), 'exit 1 + 提示 --only', rNoOnly.code);
  assert('乙档（.zip / .msi）被删', !existsSync(f.zip) && !existsSync(f.msi), '两件已删', { zip: existsSync(f.zip), msi: existsSync(f.msi) });
  assert('`.bak` 落回甲档、**没被删**（复核后收窄：手工备份不是可再生产物）', existsSync(f.bak) && existsSync(f.bakTs), '两件仍在', { bak: existsSync(f.bak), bakTs: existsSync(f.bakTs) });
  assert('丙档（与活文件逐字节相同）被删', !existsSync(f.dup), '已删', existsSync(f.dup) ? '仍在' : '已删');
  assert('甲档（不可再生、无依据）没被删', existsSync(f.keep), '仍在', existsSync(f.keep) ? '仍在' : '被删了');
  assert('**回归反例①**：保护名 `人设卡.md.bak` 没被删（备份尾巴不许绕过保护）', existsSync(f.protBak), '仍在', existsSync(f.protBak) ? '仍在' : '被删了');
  assert('**回归反例①**：保护名 `AGENTS.md.tmp` 没被删', existsSync(f.protTmp), '仍在', existsSync(f.protTmp) ? '仍在' : '被删了');
  assert('保护名 `人设卡.md` 没被删', existsSync(f.prot), '仍在', existsSync(f.prot) ? '仍在' : '被删了');
  assert('**回归反例②**：名像产物但内含 .md 的目录没被删（不许整目录 rmSync）', existsSync(join(f.trash, '2026-09-01T00-00-11__abc12350__伪装产物.zip')), '仍在', '见磁盘');
  assert('乙档目录（名 .zip 且内含件全为产物）被删', !existsSync(join(f.trash, '2026-09-01T00-00-10__abc1234f__old-build.zip')), '已删', '见磁盘');
  assert('非产物目录没被删', existsSync(join(f.trash, '2026-09-01T00-00-09__abc1234e__退役目录')), '仍在', '见磁盘');
  assert('留痕 _cleared-*.md 落盘', readdirList(f.trash).some((n) => /^_cleared-/.test(n)), '有留痕', '无');
  assert('changelog 追加了 ↳清理 行', /↳清理/.test((() => { try { return readFileSync(join(f.priv, 'tasks', 'evolution', 'changelog.md'), 'utf8'); } catch { return ''; } })()), '有 ↳清理 行', '无');
  assert('--json 的结果在删除之后给出：deleted=4（.zip/.msi + 两个产物目录）/ failed=0', j && j.deleted === 4 && j.failed === 0 && j.ok === true, { deleted: 4, failed: 0, ok: true }, j && { deleted: j.deleted, failed: j.failed, ok: j.ok });
  const idx = readFileSync(join(f.trash, '_index.md'), 'utf8');
  assert('**回归反例③**：划行只划原路径命中的那行，**同一秒的另一行不许被连带划掉**', /~~`mind-private\/old\/old-build\.zip`~~（已清/.test(idx) && !/~~`mind-private\/old\/keep-me\.md`~~/.test(idx), '只划 old-build.zip 那行', idx.split('\n').filter((l) => l.startsWith('|')).map((l) => l.slice(0, 52)));
  rmSync(f.home, { recursive: true, force: true });
}

// ── 3) --age：龄内不动；非法值响亮失败 ──────────────────────────────────────
{
  const f = fixture();
  const r1 = sweep(f.home, ['--age', '30', '--json']);
  assert('--age 30 时刚入站的条目一个都不在候选里（清单为空、两件仍在）', r1.code === 0 && /"totalCandidates": 0/.test(r1.out) && [f.zip, f.dup].every(existsSync), '0 候选 + 两件仍在', { code: r1.code, out: r1.out.slice(-40), zip: existsSync(f.zip) });
  const r2 = sweep(f.home, ['--age', '7x', '--json']);
  assert('--age 7x ⇒ 退出 1（响亮失败，不静默当 0）', r2.code === 1 && /--age/.test(r2.out), 'exit 1 + 报错', r2.code);
  const r3 = sweep(f.home, ['--age', '-1', '--json']);
  assert('--age -1 ⇒ 退出 1', r3.code === 1, 1, r3.code);
  rmSync(f.home, { recursive: true, force: true });
}

// ── 4) 环境不可用 ⇒ 响亮失败 ────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'verify-sweep-empty-'));
  const r = sweep(home, ['--json']);
  assert('没有 TRASH 目录 ⇒ 退出 2（响亮失败，不静默成功）', r.code === 2, 2, r.code);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures.length === 0 ? `PASS ${pass}/${pass}` : `FAIL ${failures.length}/${pass + failures.length} assertion(s)`);
process.exit(failures.length === 0 ? 0 : 1);
