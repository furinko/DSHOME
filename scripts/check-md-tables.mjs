#!/usr/bin/env node
// scripts/check-md-tables.mjs — 手写表格「行被吞 / 两行被黏」检查（2026-09-24 建）
//
// ── 为什么需要它（Learn 复发：锚点粘连同日 2 次）────────────────────────────────
// `edit` 用**行首片段**当 `old_string`、却没把它放回 `new_string` 时，前一行会被**吞掉表头**、
// 两行**黏成一行**。今日（09-24）复发第 3、4 次，都是靠人肉 `read` 回看才发现 ⇒ 需要机器判据。
//
// ── 判据（只认"少格"，不认"多格"——这条是拿实测假阳换来的）──────────────────────
//   · 表块 = 连续以 `|` 开头的行；按"**未被代码跨包裹的** `|`"切格
//   · 某行格数 **少于表头** ⇒ ❌ 红（典型形态＝行被吞/被黏）
//   · 某行格数 **多于表头** ⇒ ⚠️ 只提示（单元格正文里含**裸 `|`**——Markdown 本身就会那样断格，
//     把它当缺陷会制造大面积假阳）
//   · 代码跨（`` ` `` / ` `` `）里的 `|` **不算分隔符**：实测全库 139 个表块里 9 处假阳，全部来自
//     `ERR|`、`grep 'a|b'` 这类**反引号内**的管道符 ⇒ 朴素计数不能当门禁，必须先排除代码跨
//
// 用法：node scripts/check-md-tables.mjs [路径…] [--selftest]
//   默认路径＝`mind/` + `mind-private/L1` + `mind-private/L3`（跳过 TRASH / snapshots / node_modules）
// 退出码：0 = 没有"少格"行；1 = 有少格行（或 `--selftest` 失败）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['TRASH', 'snapshots', 'node_modules', '.git', 'build-stage', 'sessions', 'storages']);

/** 数一行里"**未被代码跨包裹**"的 `|` 个数（`\|` 转义也不算）。
 *  🔴 两遍法，**只认成对的反引号**：CommonMark 里**未配对**的反引号串是**字面文本**（不构成代码跨）——
 *     一行里反引号个数为奇数时，若按"见 ` 就进跨、再也不出"处理，后面所有 `|` 都会被吞 ⇒ **假阳**
 *     （2026-09-24 实测：`project.md` 两条超长行就是这样被误判成"少格"）。 */
export function pipesOf(line) {
  const s = String(line ?? '');
  // ① 收集反引号串
  const runs = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '`') continue;
    let j = i;
    while (j < s.length && s[j] === '`') j += 1;
    runs.push({ start: i, len: j - i });
    i = j - 1;
  }
  // ② 贪心配对（同长度才闭合；跨内不同长度的串是字面量，不闭合）
  const spans = [];
  let open = null;
  for (const r of runs) {
    if (open === null) { open = r; continue; }
    if (r.len === open.len) { spans.push([open.start, r.start + r.len]); open = null; }
    // r.len !== open.len ⇒ 仍在跨内的字面量，保持 open
  }
  // open !== null ⇒ 该开串没配对 ⇒ 整条丢弃（不当代码跨）
  const inSpan = (idx) => spans.some(([a, b]) => idx >= a && idx < b);
  // ③ 数跨外、未转义的 `|`
  let pipes = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '|' && s[i - 1] !== '\\' && !inSpan(i)) pipes += 1;
  }
  return pipes;
}

/** 一行的**格数**（GFM 容得下"行尾省略 `|`"，故不能直接拿管道数当列数）。
 *  · 先数跨外、未转义的 `|`（`pipesOf`）
 *  · 去掉**行首/行尾**各一个 `|` 后，"内部分隔符数 + 1" 才是格数：
 *      `| a | b |` ⇒ 3 管道 → 2 格 · `| a | b` ⇒ 2 管道 → 2 格 · `| a |` ⇒ 1 格
 *  🔴 真实数据教的一课（2026-09-24）：`project.md` 有一条 1447 字的行是 `| A | B`（**省略行尾 `|`**），
 *     拿"管道数 == 表头管道数"判会把它误报成少格 ⇒ 必须按格数比。 */
export function cellsOf(line) {
  const s = String(line ?? '');
  const p = pipesOf(s);
  const t = s.trim();
  const lead = t.startsWith('|') ? 1 : 0;
  const tail = t.endsWith('|') && !t.endsWith('\\|') ? 1 : 0;
  return Math.max(1, p - lead - tail + 1);
}

/** 表格分隔行（`|---|---|`、带对齐冒号也算）——不参与格数比对。 */
const isSep = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(String(line ?? '')) && String(line).includes('-');

/**
 * 纯判定：一个表块（连续 `|` 行）里有没有"少格"行。
 * @param {string[]} block - 行数组（首行＝表头）
 * @returns {{short: {index:number,cells:number}[], long: number[]}} index 为块内下标
 */
export function judgeBlock(block) {
  const head = cellsOf(block[0]);
  const short = [];
  const long = [];
  for (let i = 1; i < block.length; i += 1) {
    if (isSep(block[i])) continue;                 // 分隔行跳过（对齐冒号/数量不齐都无所谓）
    const c = cellsOf(block[i]);
    if (c < head) short.push({ index: i, cells: c });
    else if (c > head) long.push(i);
  }
  return { short, long };
}

function selftest() {
  const H = '| 日期 | 点子 | 状态 |';
  const cases = [
    ['① 正常表 → 不红', [H, '|---|---|---|', '| a | b | c |'], 0],
    ['② 行被吞（少格）→ 必须红', [H, '|---|---|---|', '| a | b |'], 1],
    ['③ 两行被黏（多格）→ 不红（只提示）', [H, '|---|---|---|', '| a | b | c | d | e |'], 0],
    ['④ 反引号内的 `|` → 不红', [H, '|---|---|---|', '| a | `ERR|` | c |'], 0],
    ['⑤ 双反引号代码跨含 `|` → 不红', [H, '|---|---|---|', '| a | ``x|y`` | c |'], 0],
    ['⑥ 转义 `\\|` → 不红', [H, '|---|---|---|', '| a | b\\|c | d |'], 0],
    ['⑦ 未配对的反引号（奇数个）→ 不红（不吞后续 `|`）', [H, '|---|---|---|', '| a ` b | c | d |'], 0],
    ['⑧ 行尾省略 `|` → 不红（格数照样对得上）', [H, '|---|---|---|', '| a | b | c'], 0],
    ['⑨ 分隔行格数不齐 → 跳过不判', [H, '|---|', '| a | b | c |'], 0],
  ];
  let bad = 0;
  for (const [name, block, wantShort] of cases) {
    const r = judgeBlock(block);
    const ok = r.short.length === wantShort;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  → short=${r.short.length} long=${r.long.length}`);
  }
  // 退化检查：判据不能恒绿
  const r = judgeBlock([H, '|---|---|---|', '| a | b |']);
  if (r.short.length !== 1) { bad += 1; console.error('FAIL 退化检查：少格行未被判红'); }
  else console.log('ok   ⑩ 判据未退化（少格 ⇒ 红）');
  console.log(bad ? `\ncheck-md-tables --selftest: ${bad} 项失败` : '\ncheck-md-tables --selftest: 全部通过（9 反例 + 1 退化检查 = 10 项）');
  process.exit(bad ? 1 : 0);
}

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (e.name.endsWith('.md')) out.push(join(dir, e.name));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) selftest();
  const paths = args.filter((a) => !a.startsWith('--'));
  const roots = paths.length > 0 ? paths : ['mind', 'mind-private/L1', 'mind-private/L3'].map((p) => join(repoRoot, p));
  const files = [];
  const missing = [];
  for (const p of roots) {
    try { if (statSync(p).isDirectory()) walk(p, files); else if (p.endsWith('.md')) files.push(p); else missing.push(p); }
    catch { missing.push(p); }
  }
  // 🔴 缺输入即**响亮失败**（`verify-integrity` 配方：判据拿不到输入却打印全绿 = 假绿）。
  //    2026-09-24 实测踩到：路径写错（`$env:USERPROFILE\..\DSHOME\…`）⇒ 若静默"扫 0 个文件、exit 0"，
  //    人会把"没扫到"读成"没问题"。路径不存在 / 一个文件都没扫到 ⇒ exit 1。
  if (missing.length > 0) {
    console.error(`[check-md-tables] ❌ 路径不存在（不是"没问题"，是没扫到）：${missing.join(' · ')}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('[check-md-tables] ❌ 一个 md 都没扫到（检查传入路径 / 工作目录；缺输入即失败，不返回"全绿"）');
    process.exit(1);
  }
  let red = 0; let blocks = 0; let longs = 0;
  for (const f of files) {
    let lines;
    try { lines = readFileSync(f, 'utf8').split(/\r?\n/); } catch { continue; }
    let block = []; let start = 0;
    const flush = () => {
      if (block.length < 2) { block = []; return; }
      blocks += 1;
      const r = judgeBlock(block);
      if (r.long.length > 0) {
        longs += r.long.length;
        // 多格**只提示**（正文裸 `|` 与"旧粘连残留"都会长这样，分不清 ⇒ 不当红），但必须**点名到行**：
        // 只报个计数等于让人再去猜哪一行（2026-09-24 实测：本仓 4 处，逐条看才知是近几日的旧账）。
        for (const i of r.long) {
          console.log(`  ⚠️  ${f}:${start + i}  格数 ${cellsOf(block[i])} > 表头 ${cellsOf(block[0])}（正文含裸 \`|\` 或旧粘连残留）：${block[i].slice(0, 90)}`);
        }
      }
      for (const s of r.short) {
        red += 1;
        console.error(`  ❌ ${f}:${start + s.index}  格数 ${s.cells} < 表头 ${cellsOf(block[0])}（疑似行被吞/被黏）：${block[s.index].slice(0, 90)}`);
      }
      block = [];
    };
    lines.forEach((l, i) => { if (/^\s*\|/.test(l)) { if (block.length === 0) start = i + 1; block.push(l); } else flush(); });
    flush();
  }
  console.log(`[check-md-tables] 扫 ${files.length} 个 md · 表块 ${blocks} 个 · 少格行 ${red} · 多格行（只提示：正文裸 \`|\`）${longs}`);
  process.exit(red ? 1 : 0);
}

// 只在**被当脚本跑**时执行主流程；被 `import`（自测 / 复用 `pipesOf`/`cellsOf`/`judgeBlock`）时不跑、不 exit。
const isMain = (() => {
  try { return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false; } catch { return false; }
})();
if (isMain) main();
