#!/usr/bin/env node
// scripts/trash-sweep.mjs — 「TRASH 回收站排空」执行件（2026-09-26 建）
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// `Memory §十一` 硬约束 1 早定了**三档**（2026-09-23）：甲｜不可再生（记忆/规则/快照字节）**永不物理删除**；
// 乙｜可再生产物（`build-stage` 产物/旧安装包/下载缓存）**解除"永不"**；丙｜逐字节重复件（`sha256`
// 与**活文件**相同）**解除"永不"**。**举证责任在删方，且必须机器可证**。
// 但那三档**没有任何执行件**：`TRASH\` 只有入口（`evolve-log trash` ＝移入），没有出口；每日 `self-clean`
// 的权限只是"清理自己产生的中间物"，删 TRASH 不在权内 ⇒ 实测 **407 件 / 11.6 MB 只进不出**，
// `growth-audit` 的件数判据因此"恒亮后被迫调安静"。本文件就是那个出口。
//
// ── 判据（机器可证；举不出依据 ⇒ 落回甲档、不动）────────────────────────────
//   乙档：扩展名 ∈ {exe,msi,zip,7z,iso,tar,gz,tgz,rar,bak,tmp,ndjson,log}（`growth-audit` 同源判据）
//         或单件 > 20 MB（可再生产物通常是大件；小件保守留）
//   丙档：`sha256` 与**仓库内某个活文件**（TRASH 之外）逐字节相同 ⇒ 恢复点就是活文件本身，删它零信息损失
//   甲档：其余一律**不动**，哪怕看起来没用 —— 交给主人明确要求（§十一 唯一例外）
//
// ── 安全姿势 ────────────────────────────────────────────────────────────────
//   · **默认 dry-run**：不加 `--apply` 只打印清单与体积，一个字节都不删。
//   · 删除前列出「每条：路径 · 档位 · 依据（扩展名/大小/与哪个活文件同哈希）」，可留档。
//   · 删除后**双向留痕**：`TRASH\_index.md` 对应行划掉 + `tasks\evolution\changelog.md` 追加 `↳清理` 行。
//   · `--age <N>`：只清**进入 TRASH 超过 N 天**的（默认 0＝不设龄；给巡检用时可设 7 天做缓冲）。
//
// 用法：node scripts/trash-sweep.mjs [--sweep] [--age <天>] [--json] [--quiet]
//   ⚠️ **默认＝只列清单（只读）**：要真删必须显式给 `--sweep` —— 2026-09-26 独立复核后定的姿势：
//      物理删除是最不可逆的动作，不给"顺手删"，也不让 `--apply` 这种暧昧词承担它。
//   `--age <N>`：只清进入 TRASH 超过 N 天（N 必须是 ≥0 的整数；非法值**响亮失败**，不静默当 0）。
// 退出码：0＝正常（含无可清项）；2＝环境不可用（找不到 TRASH 根）；1＝参数非法。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, unlinkSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.DSH_HOME || resolve(here, '..');
const PRIVATE = join(repoRoot, 'mind-private');
const TRASH = join(PRIVATE, 'TRASH');
const TRASH_INDEX = join(TRASH, '_index.md');
const LOG = join(PRIVATE, 'tasks', 'evolution', 'changelog.md');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--sweep');
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const ageIdx = argv.indexOf('--age');
const ageRaw = ageIdx >= 0 ? argv[ageIdx + 1] : '0';
const AGE_DAYS = Number(ageRaw);
// 2026-09-26 复核后加：非法龄**响亮失败**——原来 `--age 7x` / 无值 / 负数会被 `Number()` 变成 NaN 或负数，
// 而 `AGE_DAYS > 0` 恒假 ⇒ 静默降级成"无龄闸"（读数还像设了），这是"看起来在拦、其实没拦"。
if (!Number.isInteger(AGE_DAYS) || AGE_DAYS < 0) {
  console.error(`[trash-sweep] ❌ --age 要给 ≥0 的整数（收到 ${JSON.stringify(ageRaw ?? '(无值)')}）`);
  process.exit(1);
}

if (!existsSync(TRASH)) {
  console.error(`[trash-sweep] ❌ 环境不可用：找不到 ${TRASH}`);
  process.exit(2);
}

/**
 * 乙档判据（2026-09-26 复核后**收窄**）：只认"**构建产物/分发包**"这一类扩展名。
 * ⚠️ 原判据把 `bak|tmp|ndjson|log` 也算乙档，复核实测证伪：真 TRASH 里那两个 `.bak` 是
 * **profile 覆盖层与 package.json 的手工备份**（不是"可重建产物"），照原判据会被物理删。
 * 现在 `.bak/.tmp/.log` 一律落回甲档（留给主人一句话），只有明确的产物/分发包才自动清。
 */
const REPRO_EXT = /\.(exe|msi|zip|7z|iso|tar|gz|tgz|rar)$/i;
const REPRO_EXT_TS = /\.(exe|msi|zip|7z|iso|tar|gz|tgz|rar)-\d{8}(-\d{6})?$/i;
const BIG_BYTES = 20 * 1024 * 1024;
/** 扫描时跳过的目录（不是"活文件"，不能当丙档依据）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'TRASH', 'build-stage']);
// 保护名（2026-09-26 加）：**身份/规则真源**的历史副本，即使与活文件逐字节相同也**不走自动清理**。
// ⚠️ 复核抓到过洞：原实现只在"文件基名末尾是 .md"时命中保护名 ⇒ `人设卡.md.bak` 会**绕过保护名**
//    被判乙档删掉。现改为：先**剥掉一切备份/临时尾巴**（`.bak` / `.bak-<ts>` / `.tmp` / `.log` /
//    `.old` / `.orig` / `~` / 纯数字后缀）再匹配 —— 保护名是**闸门**，不是"提前 return 的侥幸"。
const PROTECTED_NAME = /^(人设卡|AGENTS|SOUL|Memory|Ritual|Invariants|Concepts|Power|HUB|Design-Philosophy|Wisdom|Learn)\.md$/i;
function baseNoBackupTail(name) {
  let b = String(name);
  for (let i = 0; i < 4; i++) {
    const before = b;
    b = b.replace(/\.(bak|tmp|log|old|orig|save|swp)(-\d{8}(-\d{6})?)?$/i, '');
    b = b.replace(/[~]$/, '');
    if (b === before) break;
  }
  return b;
}
function isProtectedName(name) {
  const b = baseNoBackupTail(name);
  return PROTECTED_NAME.test(b) || PROTECTED_NAME.test(name);
}
/** 目录内容里是否含"不可再生"的东西（含受保护名或任何非可再生产物扩展名）⇒ 整目录落回甲档。 */
function dirHasUnreproducible(dir) {
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return true; }
  for (const it of items) {
    if (it.isDirectory()) { if (dirHasUnreproducible(join(dir, it.name))) return true; continue; }
    if (isProtectedName(it.name)) return true;
    if (!REPRO_EXT.test(it.name) && !REPRO_EXT_TS.test(it.name)) return true;
  }
  return false;
}

function isRepro(name, size) { return REPRO_EXT.test(name) || REPRO_EXT_TS.test(name) || size > BIG_BYTES; }

/** 活文件索引：size → [相对路径...]（TRASH 之外的整个仓库；`SKIP_DIRS` 不算活文件）。 */
function buildActiveIndex() {
  const bySize = new Map();
  const walk = (dir) => {
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) { if (!SKIP_DIRS.has(it.name)) walk(join(dir, it.name)); continue; }
      const p = join(dir, it.name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!bySize.has(st.size)) bySize.set(st.size, []);
      bySize.get(st.size).push(p);
    }
  };
  walk(repoRoot);
  return bySize;
}
/** 丙档判据：与某个活文件逐字节相同（先按 size 缩小候选，再算 sha256）。 */
function sameAsActive(file, bySize) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const cands = bySize.get(st.size);
  if (!cands || !cands.length) return null;
  const h = createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const c of cands) {
    try { if (createHash('sha256').update(readFileSync(c)).digest('hex') === h) return c; } catch { /* 读不到就跳过 */ }
  }
  return null;
}
/** TRASH 顶层条目（文件 + 目录），递归求体积；目录按整体成一个候选（不拆内部文件，避免"半个目录被删"）。 */
function trashEntries() {
  const out = [];
  for (const it of readdirSync(TRASH, { withFileTypes: true })) {
    if (it.name === '_index.md' || it.name.startsWith('_cleared-')) continue;
    const p = join(TRASH, it.name);
    let st;
    try { st = statSync(p); } catch { continue; }
    let size = st.size;
    if (it.isDirectory()) { try { size = dirSize(p); } catch { size = 0; } }
    out.push({ path: p, name: it.name, isDir: it.isDirectory(), size, mtimeMs: st.mtimeMs, orig: origForEntry(it.name) });
  }
  return out;
}
function dirSize(d) {
  let n = 0;
  for (const it of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, it.name);
    if (it.isDirectory()) n += dirSize(p);
    else { try { n += statSync(p).size; } catch { /* 忽略 */ } }
  }
  return n;
}
const human = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B');

// ── 分类 ────────────────────────────────────────────────────────────────────
const bySize = buildActiveIndex();
// 索引台账（`_index.md`）：用于把"被清条目"回指到**原路径**（划行必须用原路径这个唯一键，
// 不能用名字前 19 字符的入站时间戳——同一秒入站的多条共用它，会一次划掉整批）。
let indexRows = [];
try {
  if (existsSync(TRASH_INDEX)) {
    indexRows = readFileSync(TRASH_INDEX, 'utf8').split('\n')
      .map((l) => /^\|\s*(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\s*\|\s*`([^`]+)`/.exec(l))
      .filter(Boolean)
      .map((m) => ({ at: m[1], orig: m[2] }));
  }
} catch { indexRows = []; }
const origOfName = new Map(indexRows.map((r) => [r.at, r.orig]));
/** 实体名 → 索引里的**原路径**。⚠️ 不能只用入站时间戳前缀取值：同秒入站的多条共用一个时间戳
 *  （真库 265 行只有 17 个唯一时间戳），按它取值会串行、进而划错行（独立复核阻断项 ③）。
 *  故用"时间戳 + 名字尾段＝原路径 basename"双重校验，命中唯一才认。 */
function origForEntry(name) {
  const at = name.slice(0, 19);
  const bare = name.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}__/, '').replace(/^[0-9a-f]{8}__/, '');
  const sameAt = indexRows.filter((r) => r.at === at);
  const exact = sameAt.find((r) => r.orig.split('/').pop() === bare);
  if (exact) return exact.orig;
  if (sameAt.length === 1) return sameAt[0].orig;
  return null; // 同秒多条且尾段对不上 ⇒ **不猜**（划行宁可少划，也不误划别人的账）
}
const now = Date.now();
const candidates = [];
const kept = [];
for (const e of trashEntries()) {
  const ageDays = (now - e.mtimeMs) / 86400000;
  if (AGE_DAYS > 0 && ageDays < AGE_DAYS) { kept.push({ ...e, why: `龄 ${ageDays.toFixed(1)} 天 < ${AGE_DAYS}` }); continue; }
  if (isProtectedName(e.name)) { kept.push({ ...e, why: '甲档·保护名（身份/规则真源的副本，含备份尾巴，归主人权利域）' }); continue; }
  // 目录：整体只看乙档，**且必须先确认里面没有不可再生的东西**（复核阻断项：只看外壳会把含
  //      `.md` 快照字节的目录整个 `rmSync recursive`）
  if (e.isDir) {
    if (isRepro(e.name, e.size) && !dirHasUnreproducible(e.path)) {
      candidates.push({ ...e, tier: '乙', evidence: `目录 · 名/体积属可再生产物（${REPRO_EXT.test(e.name) || REPRO_EXT_TS.test(e.name) ? '扩展名' : '体积 > 20MB'}）+ 内含件全为可再生产物` });
    } else if (isRepro(e.name, e.size)) {
      kept.push({ ...e, why: '甲档：目录名像产物，但**内含不可再生的东西**（快照字节/受保护名）⇒ 不动' });
    } else {
      kept.push({ ...e, why: '甲档：目录非可再生产物（不动，等主人明确要求）' });
    }
    continue;
  }
  const dup = sameAsActive(e.path, bySize);
  if (dup) { candidates.push({ ...e, tier: '丙', evidence: `与活文件逐字节相同：${relative(repoRoot, dup)}` }); continue; }
  if (isRepro(e.name, e.size)) {
    const byExt = REPRO_EXT.test(e.name) || REPRO_EXT_TS.test(e.name);
    candidates.push({ ...e, tier: '乙', evidence: byExt ? `扩展名属构建产物/分发包（${(e.name.match(REPRO_EXT) || e.name.match(REPRO_EXT_TS) || [''])[0]}）` : `体积 ${human(e.size)} > 20MB` });
    continue;
  }
  kept.push({ ...e, why: '甲档：不可再生或无法机器举证（不动，等主人明确要求）' });
}

const totalBytes = candidates.reduce((s, c) => s + c.size, 0);

// ── 执行删除 + 双向留痕 ─────────────────────────────────────────────────────
// 姿势（2026-09-26 独立复核后收紧）：**`--sweep` 与 `--only <子串>` 必须同时给**。
//   ① `--sweep`＝"我确实要执行"（默认只列清单，不给暧昧词"顺手删"的机会）；
//   ② `--only` ＝本次执行的**对象白名单**（按条目名子串匹配，逗号分隔）：自动判据只负责**列候选**，
//      真正落刀必须逐次点名——判据错一次不会变成批量损失（对齐 §十一 硬约束 1 的"举证责任在删方"）。
//   不给 `--only` 就拒绝执行（响亮失败，不是静默只列）。
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
if (APPLY && ONLY.length === 0) {
  console.error('[trash-sweep] ❌ `--sweep` 必须配 `--only <条目名子串[,子串…]>`：自动判据只列候选，落刀要逐次点名（判据错一次 ≠ 批量损失）。先跑不带参数的清单，再点名。');
  process.exit(1);
}
const targets = ONLY.length ? candidates.filter((c) => ONLY.some((k) => c.name.includes(k))) : [];
if (APPLY && ONLY.length && targets.length === 0) {
  console.error(`[trash-sweep] ❌ --only 点名的对象在候选里一个都没匹配上（${ONLY.join(' / ')}）——拒绝执行（不猜）`);
  process.exit(1);
}
let deleted = 0, failed = 0, deletedBytes = 0, clearedLog = null, changelogOk = null;
const lines = [];
if (APPLY && targets.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  clearedLog = join(TRASH, `_cleared-${stamp}.md`);
  lines.push(`# TRASH 清理留痕 ${stamp}`, '', '判据＝`Memory §十一` 硬约束 1 三档（乙可再生产物 / 丙逐字节重复件）；甲档与保护名不动。', '', '| 条目 | 档 | 体积 | 依据 | 结果 |', '|---|---|---|---|---|');
  const struck = [];
  for (const c of targets) {
    // 复核后加：删前**再核一次**——丙档的依据是"与活文件相同"，而活文件可能已被并发写者移走/改掉
    if (c.tier === '丙') {
      const liveRel = c.evidence.replace(/^.*：/, '');
      if (!existsSync(resolve(repoRoot, liveRel))) { failed++; lines.push(`| \`${c.name}\` | 丙 | ${human(c.size)} | 活文件已不在（${liveRel}） | ⏭ 跳过（依据失效） |`); continue; }
    }
    try {
      rmSync(c.path, { recursive: true, force: true });
      deleted++; deletedBytes += c.size;
      lines.push(`| \`${c.name}\` | ${c.tier} | ${human(c.size)} | ${c.evidence} | ✅ 已删 |`);
      struck.push(c.name);
    } catch (e) {
      failed++;
      lines.push(`| \`${c.name}\` | ${c.tier} | ${human(c.size)} | ${c.evidence} | ⚠️ 删除失败：${e.message} |`);
    }
  }
  writeFileSync(clearedLog, lines.join('\n') + '\n');
  // ① 索引：**按「原路径」唯一键**匹配并划行（复核阻断项：原来按"名字前 19 字符＝入站时间戳"匹配，
  //     而同一秒入站的多条共用一个时间戳 ⇒ 删 1 件会划掉整批（真库实测最大一组 112 行）。
  //     只划**确实删掉**的那些；失败/跳过的不划（"留痕但没删"是假账）。
  if (existsSync(TRASH_INDEX) && struck.length) {
    const day = new Date().toISOString().slice(0, 10);
    let idx = readFileSync(TRASH_INDEX, 'utf8');
    const origOf = new Map(targets.map((c) => [c.name, c.orig]));
    for (const name of struck) {
      const orig = origOf.get(name);
      if (!orig) continue;
      const needle = '`' + orig + '`';
      idx = idx.split('\n').map((l) => (l.includes(needle) && !l.includes('~~') ? l.replace(needle, '~~' + needle + '~~（已清 ' + day + '）') : l)).join('\n');
    }
    writeFileSync(TRASH_INDEX, idx);
  }
  // ② changelog：追一行（审计流水）；**写不进去就把退出码置 1**（复核指出：留痕不完整却 exit 0 = 假绿）
  try {
    appendFileSync(LOG, `| ${new Date().toISOString().slice(0, 10)} | ↳清理:TRASH | 乙/丙档机器可证（§十一 硬约束 1） | 物理删除 ${deleted} 项 ${human(deletedBytes)}（失败 ${failed}） | ${relative(repoRoot, clearedLog).replace(/\\/g, '/')} |\n`);
    changelogOk = true;
  } catch (e) {
    changelogOk = false;
    console.error(`[trash-sweep] ⚠️ changelog 追写失败（留痕不完整）：${e.message}`);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: failed === 0 && changelogOk !== false,
    mode: APPLY ? 'sweep' : 'list', ageDays: AGE_DAYS, trash: TRASH,
    candidates: candidates.map((c) => ({ name: c.name, tier: c.tier, size: c.size, evidence: c.evidence })),
    kept: kept.map((c) => ({ name: c.name, size: c.size, why: c.why })),
    totalCandidates: candidates.length, totalBytes, keptCount: kept.length, targeted: targets.length, only: ONLY,
    deleted, failed, deletedBytes, clearedLog: clearedLog ? relative(repoRoot, clearedLog) : null, changelogOk,
  }, null, 2));
} else if (!QUIET) {
  console.log(`[trash-sweep] ${APPLY ? '🔴 SWEEP（执行物理删除）' : '📋 LIST（只列清单，不删任何东西；要删给 --sweep）'} · ${TRASH}`);
  if (!candidates.length) console.log('  无「可清」条目（乙/丙档为空）——甲档一律不动。');
  for (const c of candidates) console.log(`  [${c.tier}] ${c.name}  ${human(c.size)}  ← ${c.evidence}`);
  console.log(`  合计：${candidates.length} 项 / ${human(totalBytes)}；甲档保留 ${kept.length} 项`);
  if (APPLY && targets.length) console.log(`  ${failed ? '⚠️' : '✅'} 已删 ${deleted} 项 · ${human(deletedBytes)}${failed ? ` · 失败/跳过 ${failed}` : ''}；留痕 → ${clearedLog}`);
}
process.exit(failed === 0 && changelogOk !== false ? 0 : 1);

