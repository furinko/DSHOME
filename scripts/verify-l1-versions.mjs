#!/usr/bin/env node
// scripts/verify-l1-versions.mjs — L0/L1 规则件「改正文必须提版本 + 换下的旧版本行必须归档」门禁（2026-09-17 建）
//
// ── 为什么需要它（真实漏项，不是假想）────────────────────────────────────────
// 既定流程（`Ritual §四` 自我修改事务）要求：改 L1 规则 ⇒ **版本号 +0.1 + 版本行追加本次授权与
// 改动摘要**。但 `mind-validate` 的"版本四元"只覆盖 **L2 Skill**（frontmatter ↔ 文件尾 ↔ `Tree`
// ↔ `_index`）——**L1 规则文件（Ritual / Power / Memory / Invariants / HUB / Concepts /
// Design-Philosophy / Wisdom）的头/尾版本行无人校验**。2026-09-17 实测：同一天我把
// `Ritual.md`（§四 四段式 + `:47`）与 `Power.md`（`:79` 口径）正文改了两次、**两次都忘了提版本**，
// 靠收工自查才发现（事后补 1.15 / 1.14）。同类已知盲区：`Skill\README.md` 能力表。
// ⚠️ 2026-09-28 **改动面扩到 `mind/L0/`**（主人授权；上一轮的诚实边界 3）：L0 四件（SOUL / AGENTS /
//   TOOL / CREW）的版本行同样受「改正文必须提版本」约束，换下的旧行同样要归档（SOUL/AGENTS →
//   `changelog-L0.md`；CREW/TOOL → `changelog-L1.md`）。**扩面之前**：判据 B 的映射虽已含 L0 四件，
//   但改动面只有 `mind/L1/`，且「无 L1 改动 ⇒ 跳过」会先短路 ⇒ **只改 L0 的提交，判据 B 一次都不跑**
//   （改 L0 后没把换下的旧版本行搬进台账，机器看不见）。
//
// ── 判据（不需要任何台账）───────────────────────────────────────────────────
// 拿 **staged 内容 vs HEAD 内容** 直接比：
//   · 内容变了 + 版本行**没变** ⇒ ❌ 红（"改了正文没提版本"）
//   · 内容变了 + 版本行变了   ⇒ ✅（这就是流程要求的形态）
//   · 头/尾版本号不一致（两行都在时）⇒ ⚠️ warn（**历史遗留**只提示、不拦）
//   · **本次改动新引入**的头/尾不一致（改前一致、改后不一致）⇒ ❌ 红（2026-09-24 收紧：原先只 warn，
//     实测「头 1.3 / 尾 1.4」仍 PASS ⇒ 新改动引入的不一致会**静默通过**；历史遗留不误伤）
// 只看**已暂存**的改动（pre-commit 里就是本次提交的内容）；新文件（HEAD 无同名）跳过。
// ⚠️ 2026-09-25 补（独立复核指出）：**「跳过」不等于「验过」**——`changed.length === 0` 时原实现直接
//   `exit 0` 打印"跳过"，于是「工作区改了 L1 却没 `git add`」的人跑它也会读成"全绿"（假绿）。
//   现在：跳过分支会读 `git status`，工作区有 L1 改动就**响亮列出来**并给出真判据；另加 `--all`
//   （`HEAD` ↔ **工作区**，含未跟踪）供"直接跑"用。**刻意不做成硬失败**：pre-commit 场景下
//   "本次提交不含 L1"本就是正确跳过，硬失败会误伤与 L1 无关的提交。
//   （2026-09-28 扩面后，跳过口径＝「**L0 与 L1 都**无改动」；任一有改动就真跑。）
//
// ── 反例（写不出反例＝没验过；`--selftest` 可执行）──────────────────────────
//   ① 只改正文不动版本行 → 必须红 · ② 只动版本行 → 必须不红 · ③ 两处都改 → 不红
//   ④ 内容未变 → 不红 · ⑤ 历史遗留的头尾不一致 → warn（不红）
//   ⑧ 改前一致、改后不一致（本次引入）⇒ 必须红
//   —— 判据 B（旧版本行是否已归档，2026-09-28 加）——
//   ⑨ 被换下的当前版本行**不在**台账 ⇒ 必须红（本次遗漏）· ⑩ 已整行照抄进台账 ⇒ 不红
//   ⑪ HEAD 正文里更老的残留行被顺带清掉且不在台账 ⇒ 只 warn（历史遗留，不拦无关提交）
//   ⑫ HEAD 无此文件（新文件）/ 两份 changelog 都无该段（未受管）⇒ 显式跳过（不许静默）
//   —— 面级反例（L0 扩面，2026-09-28 加，跑在 `%TEMP%` 独立 git 夹具仓里）——
//   ⑭ 只改 `mind/L0/` 的当前版本行且台账里没有 ⇒ 红，且 `[info]` 分母证明**没走跳过分支**（比对 ≥1）
//   ⑮ L0 与 L1 **都**无改动 ⇒ 走跳过分支，且 `[info]` 仍报受管面分母
//   ⑯ L0 那行已照抄进台账 ⇒ 不红 · ⑰ 暂存口径（无参）同样覆盖 L0（staged 改了 L0 ⇒ 红）
//
// 用法：node scripts/verify-l1-versions.mjs [--selftest] [--all]
// 退出码：0 = 通过；1 = 有断言失败（或 git 不可用——门禁跑不起来要响亮，见 verify-integrity）
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const L1_DIR = 'mind/L1/';
const L0_DIR = 'mind/L0/';                                              // 2026-09-28 扩面：L0 四件同受约束
const SURFACE = [L0_DIR, L1_DIR];                                       // 改动面（git pathspec；两个面一起取）
// 沿革台账（判据 B 的映射来源；**不写死受管清单**，段标题从这两份文件实测）。
const CHANGELOGS = ['mind/L1/changelog-L1.md', 'mind/L1/changelog-L0.md'];

const HEAD_RE = /^>\s*版本：\s*([0-9]+(?:\.[0-9]+)*)/m;
const FOOT_RE = /^_版本：\s*([0-9]+(?:\.[0-9]+)*)/gm;

/** 取头/尾版本号（缺则为 null）。
 *  🔴 尾版本取**最后一个**匹配，不取第一个：正文里可能内嵌"版本行模板"（`Memory.md` 的 §模板
 *    就含 `_版本：vX | 日期 | 本轮摘要_`，实文件尾在千行之后）。取第一个会**认错尾行** ⇒ 假 warn。
 *     反例（`--selftest` ⑥）：正文放一个 `_版本：1.0 …_` 占位、真尾是 1.1 ⇒ 必须读出 1.1。 */
function versionsOf(text) {
  // 2026-09-29 修（本机实测）：头行只在**文首窗口**内取——口径与 `mind-validate.mjs` 的 `versionPair()`（`slice(0,1500)`）对齐。
  //   原实现全文取第一个 `> 版本：`，会被**段内照抄的旧头行**劫持：`changelog-L1.md` 的「Memory.md 沿革 → 替换追加」
  //   小节里那条 `> 版本：1.35 | …` 被当成该台账的"本档头行" ⇒ 每轮恒打印「头(1.35) ≠ 尾(1.x)（历史遗留）」，而该台账
  //   第 11 行自陈「本档头部不设版本行、取**最后一个**匹配」⇒ 实现与自述不符（恒亮提示＝没提示）。窗口内没有 ⇒ head=null（合法形态）。
  const head = HEAD_RE.exec(String(text ?? '').slice(0, 1500))?.[1] ?? null;
  const all = [...String(text ?? '').matchAll(FOOT_RE)];
  const foot = all.length > 0 ? all[all.length - 1][1] : null;
  return { head, foot };
}
const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n');

// ── 判据 B（2026-09-28 加）：**被换下来的旧版本行是否已搬进沿革台账** ──────────────
// 背景：`l1-slim`（2026-09-28）之后，规则件正文的版本行只留「本版摘要 + 指针」，**被换下来的旧沿革整行**
//   须追加到 `mind\L1\changelog-L1.md`（L1 规则件 + L0 从属件 CREW/TOOL）或 `mind\L1\changelog-L0.md`
//   （L0 两件 SOUL/AGENTS）。实测**同型遗漏已两次**（3.14/3.15 一次、3.16 一次），而上面 4 条判据只盖
//   「改了正文没提版本」那一半 —— 遗漏恰好发生在这**没盖的另一半**。
// 判据（纯函数 `judgeArchivedLines()`，可离线跑）：取 `HEAD` 的版本行**整行文本**（口径同 `versionsOf()`：
//   头 `> 版本：` / 尾 `_版本：`），凡在本次内容（提交口径＝staged · `--all` 口径＝工作区）里**已不存在**
//   （＝被换下）的那一行，必须出现在对应 changelog 的当前内容里 ⇒ 否则 ❌「旧版本行未归档」。
// 哲学（与既有实现一致，**不引入新台账**）：只有「**本次改动引入**的未归档」才红，历史遗留只 warn——
//   被换下的行若正是 HEAD 的**当前版本行**（首个头行 / 最后一个尾行，口径同 `versionsOf()`），它按约定
//   本就尚未归档（「归档」正是本次改动的动作）⇒ 缺归档＝本次遗漏 ⇒ 红；若只是 HEAD 正文里**更老的残留行**
//   被顺带清掉，它早在更早的改动里就该归档了 ⇒ 缺归档属历史遗留 ⇒ 只提示，不拦无关提交。
// 映射：**实测两份 changelog 的 `## <文件> 沿革` 分段标题**得出（不写死清单）；两处都无段 ⇒ 未受管 ⇒
//   跳过并计入 `[info]` 的跳过数（不许静默）。面与上面 4 条判据**同一侧**（提交＝staged / `--all`＝工作区）。
// 反例（`--selftest` ⑨⑩⑪⑫）：⑨ 换下的当前版本行不在台账 ⇒ 必须红 · ⑩ 已整行照抄 ⇒ 不红 ·
//   ⑪ 被顺带清掉的老残留行不在台账 ⇒ 只 warn 不红 · ⑫ HEAD 无此文件 / 未受管 ⇒ 显式跳过。
/** 版本**整行**文本（头行 + 尾行；各自口径与 `versionsOf()` 完全一致：同前缀 + 紧邻必须是数字）。
 *  ⚠️ 取整行而不是抽版本号：归档约定是「**整行逐字节照抄**」（`changelog-L1.md` 第 7 行），
 *     比对也必须整行比——否则「搬进台账但被改写」会被读成搬到了。 */
const HEAD_LINE_RE = /^>\s*版本：\s*[0-9]+(?:\.[0-9]+)*.*$/gm;
const FOOT_LINE_RE = /^_版本：\s*[0-9]+(?:\.[0-9]+)*.*$/gm;
function versionLines(text) {
  const t = norm(text);
  return [
    ...[...t.matchAll(HEAD_LINE_RE)].map((m) => m[0]),
    ...[...t.matchAll(FOOT_LINE_RE)].map((m) => m[0]),
  ];
}
/** HEAD 的**当前版本行**（＝本版那两条：首个头行 + 最后一个尾行，口径同 `versionsOf()`）。 */
function liveVersionLines(text) {
  const t = norm(text);
  // 2026-09-29：头行同样限定文首窗口（口径与 `versionsOf()` 保持一致——原注释自称"口径同 versionsOf()"，实际两处都取全文）
  const head = [...t.slice(0, 1500).matchAll(HEAD_LINE_RE)][0]?.[0] ?? null;
  const feet = [...t.matchAll(FOOT_LINE_RE)];
  const foot = feet.length ? feet[feet.length - 1][0] : null;
  return new Set([head, foot].filter((x) => x !== null));
}
const clip = (s, n = 72) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/**
 * 纯判定：**被换下的旧版本行是否已归档**（判据 B）。
 * @param {string|null} oldText - HEAD 内容（新文件传 null）。
 * @param {string} newText - 本次内容（提交口径＝staged / `--all`＝工作区）。
 * @param {string|null} changelogText - 对应 changelog 的当前内容；无对应段（未受管）传 null。
 * @returns {{skip:boolean, ok:boolean, removed:string[], unarchived:string[], warn:string|null, reason:string}}
 */
export function judgeArchivedLines(oldText, newText, changelogText) {
  if (oldText === null || oldText === undefined) {
    return { skip: true, ok: true, removed: [], unarchived: [], warn: null, reason: 'HEAD 无此文件（新文件）→ 跳过' };
  }
  if (changelogText === null || changelogText === undefined) {
    return { skip: true, ok: true, removed: [], unarchived: [], warn: null, reason: '两份 changelog 均无该文件段（未受管）→ 跳过' };
  }
  const c = norm(changelogText);
  const after = new Set(versionLines(newText));
  const removed = [...new Set(versionLines(oldText))].filter((l) => !after.has(l));  // 被换下的整行
  const missing = removed.filter((l) => !c.includes(l));                            // 台账里找不到
  const live = liveVersionLines(oldText);                                           // HEAD 的当前版本行
  const red = missing.filter((l) => live.has(l));
  const legacy = missing.filter((l) => !live.has(l));
  const warn = legacy.length ? `${legacy.length} 条更老的残留版本行亦未在台账里找到（历史遗留，只提示）` : null;
  if (red.length) {
    return {
      skip: false, ok: false, removed, unarchived: red, warn,
      reason: `${red.length} 条被换下的**本版**版本行没搬进对应 changelog（如「${clip(red[0])}」）⇒ 按台账维护约定：旧版本行**整行**追加到 changelog`,
    };
  }
  return {
    skip: false, ok: true, removed, unarchived: [], warn,
    reason: removed.length ? `换下 ${removed.length} 条版本行，均已归档` : '无版本行被换下',
  };
}

/** 受管文件 → 沿革台账 的映射：**实测两份 changelog 的 `## <文件> 沿革` 分段标题**得出（不写死清单）。
 *  @returns {{map:Map<string,string>, text:Map<string,string>, info:string, conflicts:string[]}|null}
 *   读不到台账 ⇒ null（调用方**响亮失败**：门禁跑不起来不许静默跳过 = 假绿）。 */
function changelogMap() {
  const map = new Map();    // basename → changelog 相对路径
  const text = new Map();   // changelog 相对路径 → 当前工作区内容
  const info = [];
  const conflicts = [];
  for (const rel of CHANGELOGS) {
    let content;
    try { content = readFileSync(join(repoRoot, rel), 'utf8'); }
    catch (e) { console.error(`[verify-l1-versions] ❌ 读不到沿革台账 ${rel}：${e?.message ?? e}`); return null; }
    text.set(rel, content);
    const names = [...norm(content).matchAll(/^##\s+(\S+\.md)\s+沿革\s*$/gm)].map((m) => m[1]);
    info.push(`${rel} ${names.length} 段`);
    for (const n of names) {
      if (map.has(n)) { conflicts.push(`${n}（已在 ${map.get(n)}，${rel} 亦有段）`); continue; }
      map.set(n, rel);
    }
  }
  return { map, text, info: info.join(' · '), conflicts };
}

/**
 * 纯判定：一次 L1 文件改动是否合规。
 * @param {string} oldText - HEAD 里的内容（新文件传 null）。
 * @param {string} newText - 暂存区里的内容。
 * @returns {{ok: boolean, warn: string|null, reason: string}}
 */
export function judgeL1VersionChange(oldText, newText) {
  if (oldText === null || oldText === undefined) return { ok: true, warn: null, reason: '新文件 → 跳过' };
  const a = norm(oldText);
  const b = norm(newText);
  if (a === b) return { ok: true, warn: null, reason: '内容未变 → 无需提版本' };
  const va = versionsOf(a);
  const vb = versionsOf(b);
  const bumped = va.head !== vb.head || va.foot !== vb.foot;
  const mismatchAfter = vb.head !== null && vb.foot !== null && vb.head !== vb.foot;
  const mismatchBefore = va.head !== null && va.foot !== null && va.head !== va.foot;
  const warn = mismatchAfter ? `头(${vb.head}) ≠ 尾(${vb.foot})` : null;
  if (!bumped) {
    return {
      ok: false, warn,
      reason: `内容已改但版本行未变（头 ${va.head ?? '—'} / 尾 ${va.foot ?? '—'}）⇒ 按 Ritual §四 须「版本号 +0.1 + 版本行追加摘要」`,
    };
  }
  // 2026-09-24 收紧：**本次改动新引入**的头尾不一致 ⇒ 红（两行同批改才是流程要求的形态）；
  //   **历史遗留**的不一致（改前就一致不了）仍只 warn，避免误伤与本次改动无关的旧账。
  if (mismatchAfter && !mismatchBefore) {
    return {
      ok: false, warn,
      reason: `本次改动引入了头/尾版本不一致（头 ${vb.head} / 尾 ${vb.foot}）—— 两行必须同批改（历史遗留的不一致仍只提示）`,
    };
  }
  return { ok: true, warn, reason: `版本行已更新（头 ${va.head ?? '—'}→${vb.head ?? '—'} / 尾 ${va.foot ?? '—'}→${vb.foot ?? '—'}）` };
}

// ── 面级反例（L0 扩面，2026-09-28 加）：跑**本文件的真 CLI** + 真 git，夹具建在 `%TEMP%` 独立 git 仓里
//    （真仓库零触碰；`mind/L0/` 是高危区，只读只判、绝不写）。为什么要面级而不是只测纯函数：
//    「L0 有没有进改动面 / 有没有被跳过分支短路」是 **main() 的事实**，纯函数测不到。
/** @returns {{clean:object, red:object, unstaged:object, staged:object, archived:object}} */
function surfaceFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'l1v-surface-'));
  const cli = fileURLToPath(import.meta.url);
  const g = (args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args],
    { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runCli = (args) => {
    try {
      const out = execFileSync(process.execPath, [cli, ...args],
        { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: tmp } });
      return { code: 0, out: String(out) };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };   // ❌ 走 stderr，合并取全
    }
  };
  try {
    mkdirSync(join(tmp, 'mind', 'L0'), { recursive: true });
    mkdirSync(join(tmp, 'mind', 'L1'), { recursive: true });
    // 夹具 L0 件形态对齐真机：`CREW.md` 只有**尾行**版本行、没有头行（mind\L0\ 四件：CREW/SOUL/AGENTS 仅尾行、TOOL 仅头行）
    writeFileSync(join(tmp, 'mind', 'L0', 'CREW.md'), [
      '# CREW.md — 成员底线（夹具）', '', '## 一、正文', '- 原文', '',
      '_版本：1.0 | 2026-01-01 | 初版_', '',
    ].join('\n'), 'utf8');
    writeFileSync(join(tmp, 'mind', 'L1', 'changelog-L1.md'), [
      '# changelog-L1.md（夹具）', '', '## CREW.md 沿革', '', '（夹具：暂无归档行）', '',
      '## TOOL.md 沿革', '', '（夹具）', '', '_版本：1.0 | 2026-01-01 | 台账_', '',
    ].join('\n'), 'utf8');
    writeFileSync(join(tmp, 'mind', 'L1', 'changelog-L0.md'), [
      '# changelog-L0.md（夹具）', '', '## SOUL.md 沿革', '', '（夹具）', '',
      '## AGENTS.md 沿革', '', '（夹具）', '', '_版本：1.0 | 2026-01-01 | 台账_', '',
    ].join('\n'), 'utf8');
    g(['init', '-q']);
    g(['add', '-A']);
    g(['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-q', '-m', 'init']);
    const clean = runCli(['--all']);                        // ⑮ 初始：L0/L1 都无改动
    const p = join(tmp, 'mind', 'L0', 'CREW.md');
    writeFileSync(p, readFileSync(p, 'utf8')
      .replace('_版本：1.0 | 2026-01-01 | 初版_', '_版本：1.1 | 2026-02-02 | 本版：改了正文_'), 'utf8');
    const red = runCli(['--all']);                          // ⑭ 只改 L0 的当前版本行、台账不动
    const unstaged = runCli([]);                            // ⑰前置：没 `git add` ⇒ staged 面看不见
    g(['add', 'mind/L0/CREW.md']);
    const staged = runCli([]);                              // ⑰ 暂存口径同样覆盖 L0 ⇒ 红
    writeFileSync(join(tmp, 'mind', 'L1', 'changelog-L1.md'), readFileSync(join(tmp, 'mind', 'L1', 'changelog-L1.md'), 'utf8')
      .replace('（夹具：暂无归档行）', ['### 替换追加', '', '_版本：1.0 | 2026-01-01 | 初版_'].join('\n'))
      // ⚠️ 真流程复刻：往台账里追加归档**同时要提台账自身的尾版本行**（否则既有判据 A 会判台账「改了正文却没提版本」红——
      //    台账未受管只是**判据 B** 的面，不是判据 A 的面）。
      .replace('_版本：1.0 | 2026-01-01 | 台账_', '_版本：1.1 | 2026-02-02 | 追加 CREW 旧行归档_'), 'utf8');
    const archived = runCli(['--all']);                     // ⑯ 已整行照抄进台账
    return { clean, red, unstaged, staged, archived };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ── 自检：可执行反例（判据 A 8 项 + 判据 B 6 项 + L0 扩面 4 项 ＝ 18 项；分项见文件头反例清单）────────
function selftest() {
  const base = [
    '> 版本：1.0 | 2026-01-01 | 初版',
    '',
    '## 一、正文',
    '- 原文',
    '',
    '_版本：1.0 | 2026-01-01 | 初版_',
  ].join('\n');
  const cases = [
    ['① 只改正文 → 必须红', base, base.replace('- 原文', '- 改了正文'), false],
    ['② 只动版本行 → 不红', base, base.replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02'), true],
    ['③ 两处都改 → 不红', base, base.replace('- 原文', '- 改了正文').replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02'), true],
    ['④ 内容未变 → 不红', base, base, true],
    ['⑤ 历史遗留的头尾不一致 → warn 但不红', base.replace('_版本：1.0', '_版本：0.9'), base.replace('- 原文', '- 改了正文').replace('> 版本：1.0', '> 版本：1.1'), true],
    ['⑧ 本次改动引入头尾不一致 → 必须红', base, base.replace('- 原文', '- 改了正文').replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02').replace('_版本：1.1', '_版本：1.0'), false],
  ];
  let bad = 0;
  for (const [name, oldT, newT, wantOk] of cases) {
    const r = judgeL1VersionChange(oldT, newT);
    const wantWarn = name.startsWith('⑤') || name.startsWith('⑧');
    const ok = r.ok === wantOk && (wantWarn ? !!r.warn : true);
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  → ok=${r.ok} warn=${r.warn ?? '—'}  «${r.reason}»`);
  }
  // ⑥ 反例之反例：把"内容变"造出来却不带版本行，判定必须为红（防 judge 退化成恒绿）
  const r6 = judgeL1VersionChange(base, base.replace('- 原文', '- 改了正文'));
  if (r6.ok) { bad += 1; console.error('FAIL ⑥ judge 对「改正文不提版本」返回了绿 ⇒ 判据退化'); }
  else console.log('ok   ⑥ 判据未退化（改正文不提版本 ⇒ 红）');
  // ⑦ 尾版本必须取**最后一个**：正文里内嵌模板占位（Memory.md §模板那种）不得冒充真尾行
  const withTemplate = [
    '> 版本：1.0 | 2026-01-01 | 初版', '', '## 模板', '_版本：vX | 日期 | 本轮摘要_', '', '',
    '_版本：1.2 | 2026-03-03 | 真尾_',
  ].join('\n');
  const v7 = versionsOf(withTemplate);
  if (v7.foot === '1.2') console.log('ok   ⑦ 尾版本取最后一个匹配（模板占位不冒充真尾）');
  else { bad += 1; console.error(`FAIL ⑦ 尾版本取错：得到 ${v7.foot}（期望 1.2）—— 正文模板占位会遮住真尾行`); }
  // ── 判据 B（沿革归档，2026-09-28 加）——
  const bumped = base.replace('- 原文', '- 改了正文').replaceAll('1.0 | 2026-01-01', '1.1 | 2026-02-02');
  const chEmpty = ['# changelog-L1.md — L1 规则件版本沿革台账（出厂区）', '', '## X.md 沿革', '', '（该段里没有 X 的旧版本行）', ''].join('\n');
  const chFull = ['# changelog-L1.md — L1 规则件版本沿革台账（出厂区）', '', '## X.md 沿革', '', '### 替换追加（最新在上）', '',
    '> 版本：1.0 | 2026-01-01 | 初版', '', '_版本：1.0 | 2026-01-01 | 初版_', ''].join('\n');
  // ⑨ 反例 a：被换下的**当前版本行**（头+尾）不在台账 ⇒ 必须红。两条断言成对——
  //    先证明夹具**真的**造出了「被换下」的行（分母非零，否则反例是空打，同 ⑥ 的思路），再看判据变不变红。
  const a9 = judgeArchivedLines(base, bumped, chEmpty);
  if (a9.removed.length === 2) console.log(`ok   ⑨ 夹具造出 2 条被换下的当前版本行（头+尾 ⇒ 分母非零），未归档 ${a9.unarchived.length} 条`);
  else { bad += 1; console.error(`FAIL ⑨ 夹具没造出「被换下」的版本行（removed=${a9.removed.length}）⇒ 反例空打`); }
  if (a9.ok === false) console.log('ok   ⑨ 旧版本行被换下、台账里没有 ⇒ 红（本次遗漏）');
  else { bad += 1; console.error('FAIL ⑨ 旧版本行被换下、台账里没有，判据却给绿 ⇒ 判据退化'); }
  // ⑩ 反例 b：同一改动，旧行**已整行照抄**进台账 ⇒ 不红
  const b10 = judgeArchivedLines(base, bumped, chFull);
  if (b10.ok === true && b10.removed.length === 2) console.log('ok   ⑩ 旧版本行已整行照抄进台账 ⇒ 不红');
  else { bad += 1; console.error(`FAIL ⑩ 旧行已归档却报红（ok=${b10.ok} / removed=${b10.removed.length}）⇒ 假红`); }
  // ⑪ 历史遗留：HEAD 正文里**更老的残留尾行**被顺带清掉、台账里也没有 ⇒ 只 warn，不红（不拦无关提交）
  const legacyHead = [
    '> 版本：1.2 | 2026-03-03 | 本版', '',
    '_版本：0.9 | 2026-01-01 | 更早的残留尾行_', '',
    '_版本：1.2 | 2026-03-03 | 本版尾_',
  ].join('\n');
  const legacyNew = legacyHead.replace('_版本：0.9 | 2026-01-01 | 更早的残留尾行_\n\n', '');
  const c11 = judgeArchivedLines(legacyHead, legacyNew, chEmpty);
  if (c11.ok === true && c11.removed.length === 1 && !!c11.warn) console.log(`ok   ⑪ 更老的残留行被顺带清掉且不在台账 ⇒ warn 不红 «${c11.warn}»`);
  else { bad += 1; console.error(`FAIL ⑪ 历史遗留应只 warn（ok=${c11.ok} / removed=${c11.removed.length} / warn=${c11.warn}）`); }
  // ⑫ 跳过必须显式且可分辨：新文件 / 未受管
  const d1 = judgeArchivedLines(null, bumped, chEmpty);
  const d2 = judgeArchivedLines(base, bumped, null);
  if (d1.skip && d2.skip) console.log(`ok   ⑫ 新文件与未受管都显式跳过（«${d1.reason}» / «${d2.reason}»）`);
  else { bad += 1; console.error(`FAIL ⑫ 跳过情形没显式标出（d1.skip=${d1.skip} / d2.skip=${d2.skip}）`); }
  // ⑬ 整行口径与 versionsOf 同源：正文里的版本行**模板占位**（无数字）不算版本行
  if (versionLines(withTemplate).length === 2) console.log('ok   ⑬ 版本行**整行**口径与 versionsOf 同源（模板占位 `_版本：vX …_` 不算）');
  else { bad += 1; console.error(`FAIL ⑬ 整行口径不齐：得到 ${versionLines(withTemplate).length} 条（期望 2：1 头 + 1 尾）`); }
  // ── 面级反例（L0 扩面，2026-09-28 加）：真 CLI + 真 git，%TEMP% 独立夹具仓（真仓库零触碰）──
  let fx;
  try { fx = surfaceFixture(); } catch (e) { fx = { error: e?.message ?? String(e) }; }
  if (fx.error) {
    bad += 1;
    console.error(`FAIL ⑭⑮⑯⑰ L0 扩面的**面级反例未能执行**（不是通过）：${fx.error}`);
  } else {
    const numOf = (out, re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
    // ⑮ 两个面都无改动 ⇒ 走跳过分支，且 `[info]` 仍报受管面分母（不许静默）
    if (fx.clean.code === 0 && fx.clean.out.includes('本次提交无 L0/L1 改动 → 跳过') && /受管文件 4 件/.test(fx.clean.out)) {
      console.log('ok   ⑮ L0 与 L1 **都**无改动 ⇒ 走跳过分支，且 [info] 仍报受管面分母（受管文件 4 件）');
    } else {
      bad += 1;
      console.error(`FAIL ⑮ 跳过分支口径不符：exit=${fx.clean.code} out=«${clip(fx.clean.out, 180)}»`);
    }
    // ⑭ 只改 L0 的**当前版本行**、台账里没有 ⇒ 必须红；并证明**没走跳过分支**（分母「本次比对 ≥1」+ 无跳过文案）
    const cmp = numOf(fx.red.out, /本次比对 (\d+) 件/);
    const onlyArchiveRed = fx.red.out.includes('1 个 L0/L1 文件的旧版本行没搬进沿革台账')
      && !fx.red.out.includes('改了正文却没提版本');
    if (fx.red.code === 1 && fx.red.out.includes('❌ mind/L0/CREW.md：旧版本行未归档')
      && !fx.red.out.includes('本次提交无 L0/L1 改动') && cmp !== null && cmp >= 1 && onlyArchiveRed) {
      console.log(`ok   ⑭ 只改 mind/L0/ 的当前版本行、台账里没有 ⇒ 红（exit 1；未走跳过分支：本次比对 ${cmp} 件 ≥1；且唯一失败面是「旧版本行未归档」）`);
    } else {
      bad += 1;
      console.error(`FAIL ⑭ L0 未归档没变红 / 被跳过分支短路：exit=${fx.red.code} 比对=${cmp} 唯一归档红=${onlyArchiveRed} out=«${clip(fx.red.out, 220)}»`);
    }
    // ⑰ 暂存口径（无参）同样覆盖 L0：未 `git add` ⇒ 看不见（跳过分支响亮列出）；`git add` 后 ⇒ 红
    const un = fx.unstaged.code === 0 && fx.unstaged.out.includes('工作区有 1 项 L0/L1 改动未被本门禁校验');
    const st = fx.staged.code === 1 && fx.staged.out.includes('❌ mind/L0/CREW.md：旧版本行未归档');
    if (un && st) {
      console.log('ok   ⑰ 暂存口径（无参）同样覆盖 L0：未 `git add` ⇒ 跳过分支响亮列出该项；`git add` 后 ⇒ 红');
    } else {
      bad += 1;
      console.error(`FAIL ⑰ 暂存口径异常：未暂存 exit=${fx.unstaged.code}（响亮列出=${un}）/ 已暂存 exit=${fx.staged.code}（红=${st}）`);
    }
    // ⑯ 换下的 L0 版本行已整行照抄进台账 ⇒ 不红
    if (fx.archived.code === 0 && fx.archived.out.includes('沿革归档 ✓（换下 1 条版本行，均已归档）')) {
      console.log('ok   ⑯ L0 换下的版本行已**整行**照抄进台账 ⇒ 不红');
    } else {
      bad += 1;
      console.error(`FAIL ⑯ 已归档却仍红：exit=${fx.archived.code} out=«${clip(fx.archived.out, 220)}»`);
    }
  }
  console.log(bad ? `\nverify-l1-versions --selftest: ${bad} 项失败` : '\nverify-l1-versions --selftest: 全部通过（判据 A 8 项 · 判据 B 6 项 · L0 扩面 4 项 ＝ 18 项）');
  process.exit(bad ? 1 : 0);
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function main() {
  if (process.argv.includes('--selftest')) selftest();
  const allMode = process.argv.includes('--all');
  let changed;
  try {
    if (allMode) {
      // `--all`：`HEAD` ↔ **工作区**（含未跟踪）——"直接跑"要判的是磁盘现状，不是暂存区。
      const tracked = git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', ...SURFACE]);
      const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...SURFACE]);
      changed = [...tracked.split('\n'), ...untracked.split('\n')]
        .map((s) => s.trim()).filter((s) => s.endsWith('.md'));
    } else {
      changed = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', ...SURFACE])
        .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md'));
    }
  } catch (e) {
    // 🔴 门禁跑不起来要**响亮**（verify-integrity：输入缺失即失败）——静默跳过＝假绿。
    console.error(`[verify-l1-versions] ❌ 无法读取改动面（git 不可用？）：${e?.message ?? e}`);
    process.exit(1);
  }
  // 沿革台账映射（判据 B 的输入）：**在跳过分支之前**读——跳过也要 `[info]` 报出受管面，不许静默（Invariants #14）。
  const cm = changelogMap();
  if (!cm) process.exit(1);   // 台账读不到＝门禁跑不起来 ⇒ 响亮失败（已在 changelogMap 里打原因）
  if (changed.length === 0) {
    // 跳过 ≠ 验过（2026-09-25 补）：工作区有改动就**响亮列出来**，别让人把"跳过"读成"全绿"。
    // 2026-09-28 扩面后：跳过口径＝「**L0 与 L1 都**无改动」；列出与判据都覆盖两个面。
    let dirty = [];
    try { dirty = git(['status', '--porcelain', '--', ...SURFACE]).split('\n').map((s) => s.trim()).filter(Boolean); }
    catch { /* git 面已在上游响亮报错 */ }
    if (dirty.length > 0) {
      console.log(`[verify-l1-versions] ⚠️ 本次提交无 L0/L1 改动（暂存区），但**工作区有 ${dirty.length} 项 L0/L1 改动未被本门禁校验**：`);
      for (const d of dirty.slice(0, 10)) console.log('   ' + d);
      console.log('[verify-l1-versions] ⇒ 要校验工作区请跑 `node scripts/verify-l1-versions.mjs --all`（或先 `git add` 走提交口径）');
    } else {
      console.log('[verify-l1-versions] 本次提交无 L0/L1 改动 → 跳过（工作区亦无 L0/L1 改动）');
    }
    console.log(`[info] 沿革归档面（判据 B）：受管文件 ${cm.map.size} 件（${cm.info}）· 本次无 L0/L1 改动 ⇒ 归档判据**未跑**（跳过，不是「验过」）`);
    if (cm.conflicts.length) console.log(`[info] ⚠️ 段冲突：${cm.conflicts.join('；')}`);
    process.exit(0);
  }
  let failedVersion = 0; let failedArchive = 0; let warned = 0;
  let archiveChecked = 0; let archiveSkipped = 0;
  for (const p of changed) {
    let oldText = null;
    try { oldText = git(['show', `HEAD:${p}`]); } catch { oldText = null; /* 新文件 */ }
    let newText = '';
    if (allMode) {
      try { newText = readFileSync(join(repoRoot, p), 'utf8'); } catch { console.error(`[verify-l1-versions] ❌ 读不到工作区文件：${p}`); failedVersion += 1; continue; }
    } else {
      try { newText = git(['show', `:${p}`]); } catch { console.error(`[verify-l1-versions] ❌ 读不到暂存内容：${p}`); failedVersion += 1; continue; }
    }
    const r = judgeL1VersionChange(oldText, newText);
    if (!r.ok) { failedVersion += 1; console.error(`  ❌ ${p}：${r.reason}`); }
    else if (r.warn) { warned += 1; console.log(`  ⚠️  ${p}：${r.warn}（历史遗留，只提示）`); }
    else console.log(`  ✅ ${p}：${r.reason}`);
    // ── 判据 B（沿革归档）：独立成行，红/黄都不与上面 4 条判据混算 ──────────────
    const chRel = cm.map.get(basename(p)) ?? null;
    const arch = judgeArchivedLines(oldText, newText, chRel ? cm.text.get(chRel) : null);
    if (arch.skip) { archiveSkipped += 1; console.log(`  [info] ${p}：沿革归档检查**跳过** —— ${arch.reason}`); }
    else {
      archiveChecked += 1;
      if (!arch.ok) { failedArchive += 1; console.error(`  ❌ ${p}：旧版本行未归档 —— ${arch.reason}`); }
      else if (arch.warn) { warned += 1; console.log(`  ⚠️  ${p}：${arch.warn}`); }
      else console.log(`  ✅ ${p}：沿革归档 ✓（${arch.reason}）`);
    }
  }
  const parts = [];
  if (failedVersion) parts.push(`${failedVersion} 个 L0/L1 文件改了正文却没提版本`);
  if (failedArchive) parts.push(`${failedArchive} 个 L0/L1 文件的旧版本行没搬进沿革台账`);
  console.log(parts.length
    ? `\n[verify-l1-versions] ❌ ${parts.join(' / ')}（Ritual §四：版本号 +0.1 + 版本行追加摘要；被换下的旧版本行**整行**追加到对应 changelog）`
    : `\n[verify-l1-versions] ✅ 通过（${changed.length} 个 L0/L1 改动${warned ? `，${warned} 处仅提示` : ''}）`);
  // 🔎 自证扫了几个文件（Invariants #14：门禁必须报分母，否则「绿」不可复算）。
  console.log(`[info] 沿革归档面（判据 B）：${cm.info} ⇒ 受管文件 ${cm.map.size} 件 · 本次比对 ${archiveChecked} 件 / 跳过 ${archiveSkipped} 件（HEAD 无此文件 或 未受管）；映射取自「## <文件> 沿革」段`);
  if (cm.conflicts.length) console.log(`[info] ⚠️ 段冲突：${cm.conflicts.join('；')}`);
  process.exit(parts.length ? 1 : 0);
}

main();
