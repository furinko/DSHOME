#!/usr/bin/env node
// scripts/verify-memory-archive.mjs — 「指针化」执行件的行为核验（2026-09-26 建）
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// `memory-archive.mjs` 会**改写主人的记忆正文**（把长小节搬到 `L3\history\` + 原处留指针）。
// 这类动作没有行为门禁＝拿真记忆当测试场。本门禁在**临时 DSH_HOME 的 L3 副本**上跑，
// 真仓库一个字节都不碰。
//
// ── 判据（每条都钉"内容是否真的零丢失"）─────────────────────────────────────
//   1. 默认/`--list` 只读：一个字节不改、不建 history、不建备份。
//   2. `--apply` 不给 `--only` ⇒ 退出 1（判据只列候选，落刀要人点）。
//   3. `--only` 点不到任何 `##` 小节 ⇒ 退出 1（不猜、不糊）。
//   4. **搬走的字节逐字节一致**：history 文件内容 == 原小节正文（丢一个字符就是丢记忆）。
//   5. 原处**留下指针**且体积显著下降；源文件有改前备份。
//   6. 只动超配额文件（未超配额的文件不在候选里）。
//   7. history 已存在同名 ⇒ 跳过该小节、不覆盖（幂等，不毁既有归档）。
//
// 用法：node scripts/verify-memory-archive.mjs；退出码 0＝全过 / 1＝有偏差 / 2＝环境不可用。
//
// ── 门禁反证台账（gate-ledger 用）─────────────────────────────────────────────
// gate-ledger: reverse-cases 本套件自带「应当响亮失败 / 应当不动手」的负向用例 ——
//   「`--apply` 不给 `--only` ⇒ 退出 1（不猜）」·「`--only` 点不到任何 `##` 小节 ⇒ 退出 1」·
//   「history 同名已存在 ⇒ 不覆盖既有归档 + 源文件不动 + 不留 `.bak` 垃圾」；
//   三条都在**临时 DSH_HOME**上跑，真仓库零触碰。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'memory-archive.mjs');
if (!existsSync(TOOL)) { console.error(`[verify-memory-archive] ❌ 环境不可用：找不到 ${TOOL}`); process.exit(2); }

let pass = 0; const failures = [];
function assert(label, cond, expected, actual) {
  if (cond) { pass++; console.log(`  ok   ${label}`); return; }
  failures.push(label); console.log(`  FAIL ${label}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
  console.log(`       actual:   ${JSON.stringify(actual)}`);
}
/** 夹具：一个超配额文件（含 2 个 ## 小节）+ 一个不超配额文件。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'verify-memarch-'));
  const l3 = join(home, 'mind-private', 'L3', 'projects', 'P1');
  mkdirSync(l3, { recursive: true });
  const big = join(l3, 'project.md');
  const secA = ['## 进度状态', '', ...Array.from({ length: 60 }, (_, i) => `- 里程碑 ${i}：${'细节'.repeat(400)}`)].join('\n');
  const secB = ['## 下一步（待办）', '', ...Array.from({ length: 40 }, (_, i) => `- 待办 ${i}：${'说明'.repeat(200)}`)].join('\n');
  const text = ['# P1 项目档', '', secA, '', secB, ''].join('\n');
  writeFileSync(big, text, 'utf8');
  const small = join(l3, '小档.md'); writeFileSync(small, '# 小档\n\n## 一小节\n\n- 一句话\n', 'utf8');
  return { home, big, small, text, secA, secB };
}
function run(home, args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const walkFiles = (d) => { const out = []; (function w(x) { let it; try { it = readdirSync(x, { withFileTypes: true }); } catch { return; } for (const e of it) { const p = join(x, e.name); e.isDirectory() ? w(p) : out.push(p); } })(d); return out; };

console.log('[verify-memory-archive] 指针化执行件 · 行为核验');

// ── 1) 默认只读 ─────────────────────────────────────────────────────────────
{
  const f = fixture();
  const before = readFileSync(f.big, 'utf8');
  const r = run(f.home, ['--json']);
  let j = null; try { j = JSON.parse(r.out); } catch { /* 见下 */ }
  assert('默认＝只列候选，退出 0', r.code === 0, 0, r.code);
  assert('只读：源文件逐字节未变', readFileSync(f.big, 'utf8') === before, '未变', '变了');
  assert('只读：不建 history、不建备份', !existsSync(join(f.home, 'mind-private', 'L3', 'history')) && !existsSync(`${f.big}.bak-before-archive`), '都没有', '有残留');
  assert('--json 可解析且列出超配额文件与小节', !!j && j.mode === 'list' && j.oversized.length === 1 && j.oversized[0].sections.length >= 2, '1 个超配额文件 / ≥2 小节', j && j.oversized.map((o) => o.rel));
  assert('未超配额的文件不在候选里', j && !j.oversized.some((o) => /小档/.test(o.rel)), '小档不在候选', j && j.oversized.map((o) => o.rel));
  rmSync(f.home, { recursive: true, force: true });
}

// ── 2/3) 两条响亮失败 ───────────────────────────────────────────────────────
{
  const f = fixture();
  const r1 = run(f.home, ['--apply']);
  assert('--apply 不给 --only ⇒ 退出 1', r1.code === 1 && /--only/.test(r1.out), 'exit 1 + 提示', r1.code);
  const r2 = run(f.home, ['--apply', '--file', 'project.md', '--only', '不存在的锚点']);
  assert('--only 点不到任何 ## 小节 ⇒ 退出 1（不猜）', r2.code === 1 && /没匹配到/.test(r2.out), 'exit 1 + 没匹配到', r2.code);
  rmSync(f.home, { recursive: true, force: true });
}

// ── 4/5) 真搬一次：内容零丢失 + 留指针 + 有备份 ─────────────────────────────
{
  const f = fixture();
  const r = run(f.home, ['--apply', '--file', 'project.md', '--only', '进度状态', '--json']);
  const after = readFileSync(f.big, 'utf8');
  const hist = walkFiles(join(f.home, 'mind-private', 'L3', 'history'));
  assert('--apply --only 退出 0', r.code === 0, 0, r.code);
  assert('history 落了一个文件', hist.length === 1, 1, hist.map((p) => p.replace(f.home, '')));
  const trimEnd = (s) => String(s).replace(/[\r\n]+$/, '');   // 只归一化**尾部换行**：正文一个字符都不许差
  const saved = hist.length ? trimEnd(readFileSync(hist[0], 'utf8')) : '';
  const origSec = trimEnd(f.secA);
  assert('**搬走的字节逐字节一致**（丢一个字符就是丢记忆）', saved === origSec, '与原文相同', { savedLen: saved.length, origLen: origSec.length, same: saved === origSec });
  assert('原处留下指针（含 history 路径与"为什么"）', /📦/.test(after) && /L3\/history\//.test(after) && /为什么/.test(after), '指针块存在', after.slice(after.indexOf('## 进度状态'), after.indexOf('## 进度状态') + 80));
  assert('源文件体积显著下降（该小节体量被搬走）', statSync(f.big).size < Buffer.byteLength(f.text, 'utf8') * 0.6, '< 原来的 60%', statSync(f.big).size);
  assert('另一个小节未被误动', after.includes('## 下一步（待办）') && /待办 39/.test(after), '待办小节仍在', '丢了');
  assert('改前备份存在（可回滚）', existsSync(`${f.big}.bak-before-archive`) && readFileSync(`${f.big}.bak-before-archive`, 'utf8') === f.text, '备份 == 改前原文', '备份缺失或不一致');
  rmSync(f.home, { recursive: true, force: true });
}

// ── 6) history 已存在同名 ⇒ 跳过、不覆盖 ────────────────────────────────────
{
  const f = fixture();
  const histDir = join(f.home, 'mind-private', 'L3', 'history', `${new Date().toISOString().slice(0, 10)}_P1`, 'project');
  mkdirSync(histDir, { recursive: true });
  writeFileSync(join(histDir, '进度状态.md'), '既有归档：不许覆盖', 'utf8');
  const before = readFileSync(join(histDir, '进度状态.md'), 'utf8');
  const r = run(f.home, ['--apply', '--file', 'project.md', '--only', '进度状态']);
  assert('history 同名已存在 ⇒ 不覆盖既有归档（幂等）', readFileSync(join(histDir, '进度状态.md'), 'utf8') === before, '既有内容未变', r.out.trim().split('\n').slice(-2));
  assert('源文件也没被改（搬不动就不动，不留半成品）', readFileSync(f.big, 'utf8') === f.text, '源文件未变', '被改了');
  assert('搬不动时**不留备份垃圾**', !walkFiles(join(f.home, 'mind-private', 'L3')).some((x) => x.includes('.bak-before-archive')), '无 .bak', walkFiles(join(f.home, 'mind-private', 'L3')).filter((x) => x.includes('.bak')));
  rmSync(f.home, { recursive: true, force: true });
}

console.log(failures.length === 0 ? `PASS ${pass}/${pass}` : `FAIL ${failures.length}/${pass + failures.length} assertion(s)`);
process.exit(failures.length === 0 ? 0 : 1);
