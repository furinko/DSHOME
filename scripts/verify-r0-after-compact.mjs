#!/usr/bin/env node
// verify-r0-after-compact.mjs — 「压缩后 R0/R1 注入是否自愈」真机验收（2026-09-26 立）
//
// 背景（为什么需要这个工具）：
//   压缩器 `dsh-compaction-basic` 选压缩范围时写死
//   `firstIdx = systemHead(surfaceNodes[0]) === void 0 ? 0 : 1`
//   （node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:398）——
//   只保护 surface 第 0 格的 `system/message`，**从第 1 格起压**。
//   而 R0（mind-inject）/ R1（mind-recall）都是"塞成 user 消息"、位置恰好是第 1 格，
//   ⇒ **每次压缩必被 shadow**。修复前用「会话级一次性 Set + step===1」去重，压缩吃掉后
//   永不回补（实测 session-72e393d3：8 次注入全被 shadow，最后一次被吃后会话又跑 1300+
//   事件零补注，且 R1 同病灶）。
//
// 判据（机器可判，不看人话）：
//   ① 会话日志里找出所有「真注入消息」的 seq（R0 / R1 分别），并标注它是否带 `inject#repair`；
//   ② 找出所有 compaction 事件的 `shadowedSeqs`（= 该次压缩从上下文里拿掉的 seq 集合）；
//   ③ 对「吃掉了注入消息」的压缩，检查**该压缩之后**有没有新的注入：
//        · 带 `inject#repair` 标记 ⇒ **权威判据**：补注入路径生效（v3.1+ 行为）
//        · 无标记但存在 ⇒ 退回启发式（离 system/message 的 seq 距离）判是新段首注还是补注入
//        · 完全没有 ⇒ 仍失效 ⇒ FAIL
//
// ⚠️ 两条验收纪律（2026-09-26 由独立复核指摘后加固）：
//   1. **没有 compaction 记录 ⇒ 本工具什么都没验到**。定向验收（给了会话选择器）时这按 FAIL
//      计（退出码 1），不再打一行 ⚠ 就写「无 FAIL」——那会给出"看起来通过"的假读数。
//      要靠它验收，必须先让目标会话真的发生过一次压缩（重启后 /compact 或聊到超窗）。
//   2. 注入判据以 **`data.source`** 为准；文本块头只在 `data` **完全没有 source 字段**时兜底。
//      否则「把 R0 全文贴进对话」的消息会被数成一次注入，读数虚高（输出里带 `?` 标出兜底项）。
//
// 无输入即响亮失败：读不到会话目录 / 解压不出任何事件 ⇒ FAIL，绝不静默通过。
// 只读：不写任何 marker、不改任何文件（不污染被测对象）。
//
// 用法：
//   node scripts/verify-r0-after-compact.mjs <会话id子串|文件路径>   # 定向验收（严格）
//   node scripts/verify-r0-after-compact.mjs --n=10                  # 普查最近 10 个（不严格）
//
// 退出码：0 = 无 FAIL；1 = 有 FAIL 或输入缺失。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SESS_DIR = join(ROOT, 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 注入块头（与 mind-inject.js / mind-recall.js 的 payload 首行一致）。 */
const R0_HEAD = '【心智系统 · R0 运行宪法';
const R1_HEAD = '【上工自动召回';
/** 补注入标记（v3.1 起，payload 块头带它）——**权威的「补注入」判据**。 */
const REPAIR_MARK = 'inject#repair';
/** 真注入消息的 source 判据（与 mind-inject/mind-recall 的 createUserMessage 一致）。 */
const SRC = {
  r0: 'dshome-mind-inject',
  r1: 'dshome-mind-recall',
};

/** 递归找所有会话日志。 */
function findSessions(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findSessions(p, out);
    else if (e.name === 'session.v3.jsonl.zstd') out.push(p);
  }
  return out;
}

/** 逐帧解压读取会话事件（文件是多帧 zstd 追加，非单流；帧尾可能带额外字节，故带回退）。 */
function readEvents(file) {
  const buf = readFileSync(file);
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4; }
  if (offs.length === 0) return { events: [], frames: 0, failed: 0, why: '找不到 zstd 帧头' };

  const events = [];
  const push = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 半行/损坏行跳过（不计入事件数） */ }
    }
  };
  let frames = 0, failed = 0;
  for (let k = 0; k < offs.length; k += 1) {
    const start = offs[k], end = offs[k + 1] ?? buf.length;
    let done = false;
    for (let trim = 0; trim <= 8 && !done; trim += 1) {
      try { push(zstdDecompressSync(buf.subarray(start, end - trim)).toString('utf8')); done = true; frames += 1; } catch { /* 继续回退 */ }
    }
    if (!done) failed += 1;
  }
  return { events, frames, failed };
}

/** 判据：真注入消息。source 优先；文本块头兜底**仅当 data 完全没有 source 字段**。
 *  返回 { kind, repair, heuristic } 或 null。 */
function isInjection(ev) {
  if (String(ev?.type ?? '') !== 'user/message') return null;
  const d = ev.data ?? {};
  const src = d.source ?? {};
  const text = JSON.stringify(d.content ?? '');
  const repair = text.includes(REPAIR_MARK);
  const bySource = src.plugin === SRC.r0 ? 'r0' : (src.plugin === SRC.r1 ? 'r1' : null);
  if (bySource) return { kind: bySource, repair, heuristic: false };
  const hasSource = d.source !== undefined && d.source !== null;
  if (!hasSource) {
    if (text.includes(R0_HEAD)) return { kind: 'r0', repair, heuristic: true };
    if (text.includes(R1_HEAD)) return { kind: 'r1', repair, heuristic: true };
  }
  return null;
}

/** 分析一个会话文件。注入项记 { seq, repair, heuristic }。 */
function analyze(events) {
  const inj = { r0: [], r1: [] };
  const sysSeqs = [];
  const comps = [];
  for (const ev of events) {
    const t = String(ev?.type ?? '');
    const seq = ev?.seq;
    if (typeof seq !== 'number') continue;
    if (t === 'system/message') { sysSeqs.push(seq); continue; }
    const hit = isInjection(ev);
    if (hit) { inj[hit.kind].push({ seq, repair: hit.repair, heuristic: hit.heuristic }); continue; }
    if (t.startsWith('compaction/')) {
      const d = ev.data ?? {};
      const seqs = d.shadowedSeqs ?? (d.shadowedRange ? [d.shadowedRange.start, d.shadowedRange.end] : null);
      if (Array.isArray(seqs) && seqs.length) comps.push({ seq, shadowed: new Set(seqs) });
    }
  }
  return { inj, sysSeqs, comps };
}

/** 对一条注入链下判定。 */
function verdict(label, injs, comps, sysSeqs) {
  if (injs.length === 0) {
    return { state: 'FAIL', note: `${label}: 该会话**没有任何**注入记录（注入从未发生，或判据不匹配）` };
  }
  const seqs = injs.map((i) => i.seq);
  const kills = [];
  for (const c of comps) {
    const killed = seqs.filter((s) => c.shadowed.has(s));
    if (killed.length) kills.push({ at: c.seq, killed });
  }
  if (kills.length === 0) {
    return { state: 'N/A', note: `${label}: 未发现「压缩吃掉注入」的记录（本会话无需自愈）—— 注入 ${injs.length} 次，压缩 ${comps.length} 次` };
  }
  const last = kills[kills.length - 1];
  const after = injs.filter((i) => i.seq > last.at);
  if (after.length === 0) {
    return { state: 'FAIL', note: `${label}: 压缩 seq=${last.at} 吃掉了注入（${last.killed.join(',')}），其后**无任何补注入** ⇒ 仍失效`, killsAt: last.at };
  }
  // 判据优先级：① 显式 `inject#repair` 标记 = 权威判据；② 无标记则退回「离 system/message 的距离」启发式。
  const marked = after.filter((i) => i.repair);
  if (marked.length) {
    return {
      state: 'PASS',
      note: `${label}: 压缩 seq=${last.at} 吃掉注入后，seq=${marked.map((i) => i.seq).join(',')} 带 ${REPAIR_MARK} 标记重新注入 ⇒ 补注入路径生效（权威判据）`,
      killsAt: last.at, revivedAt: marked[0].seq, evidence: 'marker',
    };
  }
  const nearest = after[0];
  const gap = sysSeqs.map((s) => nearest.seq - s).filter((g) => g >= 0 && g <= 3);
  // ⚠️ 2026-09-27 修（独立复核 N1）：`inject#repair` 是**进程级**语义（`ever` 只记"本进程真注入过"）。
  //   重启 / resume 后第一次补注入**不带标记** —— 若把"无标记"一律降级为启发式，就会在
  //   「重启后拿旧会话验收」这条**主验收路径**上给出弱结论（评核员实测复现）。
  //   故提级：**压缩之后确实出现了新注入、且它不是紧跟 system/message 的新段首注** ⇒ 判为补注入。
  //   （标记仍是最强证据，有则优先；这里补的是"没有标记时也够硬"的那一档。）
  if (!gap.length) {
    return {
      state: 'PASS',
      note: `${label}: 压缩 seq=${last.at} 吃掉注入后，seq=${nearest.seq} 重新注入（无 ${REPAIR_MARK} 标记——` +
        '进程重启/resume 会使标记位丢失，见复核 N1；但它**非同段首注** ⇒ 判为补注入）',
      killsAt: last.at, revivedAt: nearest.seq, evidence: 'post-compaction',
    };
  }
  return {
    state: 'PASS',
    note: `${label}: 压缩 seq=${last.at} 吃掉注入后，seq=${nearest.seq} 重新注入 —— ⚠ 无 ${REPAIR_MARK} 标记，` +
      '且紧跟 system/message（**可能是新会话段首注，不是压缩后补注入**，需人工确认）',
    killsAt: last.at, revivedAt: nearest.seq, evidence: 'heuristic',
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const nArg = args.find((a) => a.startsWith('--n='));
const limit = nArg ? Number(nArg.slice(4)) || 5 : 5;
const selector = args.find((a) => !a.startsWith('--'));
/** 定向验收（给了选择器）＝严格模式：没验到东西就是 FAIL，不许写"无 FAIL"。 */
const strictSingle = Boolean(selector);

// ── 反证自检（--self-test）──────────────────────────────────────────────────
// gate-ledger: reverse-cases 本套件自带「应当变红」的负向用例（见 CASES 的 expect）。
// 为什么必须自带反例：本工具的判据面（压缩 shadowedSeqs × 注入 seq）只有在**真的发生过压缩**
//   时才会被走到，而真机压缩不可控（重启后才可能触发）⇒ 不合成输入就无法证明它**会**变红，
//   也无法证明它**不会**假红。写不出反例＝没验过。
// 全是纯内存合成事件：不读真会话、不写盘、不依赖重启。跑法：
//   node scripts/verify-r0-after-compact.mjs --self-test      （期望全 ✅，退出码 0）
if (args.includes('--self-test')) {
  const mk = (seq, type, data) => ({ seq, type, data });
  const r0 = (seq, repair) => mk(seq, 'user/message', {
    source: { kind: 'plugin', plugin: SRC.r0, form: 'instructions' },
    content: [{ type: 'text', text: `${R0_HEAD}）】` + (repair ? ` · 补注入 ${REPAIR_MARK}` : '') }],
  });
  const r1 = (seq, repair) => mk(seq, 'user/message', {
    source: { kind: 'plugin', plugin: SRC.r1, form: 'recall' },
    content: [{ type: 'text', text: `${R1_HEAD} · x】` + (repair ? ` ${REPAIR_MARK}` : '') }],
  });
  const comp = (seq, shadowed) => mk(seq, 'compaction/summary', { shadowedSeqs: shadowed });
  const sys = (seq) => mk(seq, 'system/message', {});

  const CASES = [
    // ① 应当变红 · 这是本工具存在的理由：压缩吃掉注入且其后无补注
    { name: '① 压缩吃掉 R0 且其后无补注 ⇒ 应当变红(FAIL)', events: [r0(10, false), comp(20, [10])], expect: 'FAIL' },
    // ② 反例：真解决后必须转绿（权威判据＝marker）
    { name: '② 压缩后带 inject#repair 补注 ⇒ 应当转绿(PASS/marker)', events: [r0(10, false), comp(20, [10]), r0(30, true)], expect: 'PASS', evidence: 'marker' },
    // ③ 反向验证：补注紧跟 system/message（疑似新段首注）⇒ 转绿但降级提示人工确认
    { name: '③ 压缩后补注但紧跟 system/message ⇒ PASS 但降级(heuristic)', events: [r0(10, false), comp(20, [10]), sys(28), r0(30, false)], expect: 'PASS', evidence: 'heuristic' },
    // ④ 覆盖复核 N1：重启后标记丢失，无标记且非同段首注 ⇒ 仍须给 PASS(post-compaction)
    { name: '④ 无标记但非同段首注 ⇒ PASS(post-compaction，覆盖重启后标记丢失)', events: [r0(10, false), comp(20, [10]), r0(80, false)], expect: 'PASS', evidence: 'post-compaction' },
    // ⑤ 反例 · 不许假红：没压缩就是"未验到"，不是失效
    { name: '⑤ 无压缩 ⇒ 应当判「未验到」N/A（不许假红）', events: [r0(10, false)], expect: 'N/A' },
    // ⑥ 反例 · 不许假红：压了但没吃到注入 ⇒ N/A
    { name: '⑥ 压缩未吃到注入 ⇒ N/A（不许误判失效）', events: [r0(10, false), comp(20, [999])], expect: 'N/A' },
    // ⑦ R1 同构（同病灶）：吃掉 R1 且无补注 ⇒ 应当变红
    { name: '⑦ R1 同构：压缩吃掉 R1 且无补注 ⇒ 应当变红(FAIL)', events: [r1(11, false), comp(20, [11])], expect: 'FAIL', pick: 'r1' },
    // ⑧ 反例 · 非注入消息不得被数成注入（否则读数虚高）
    { name: '⑧ 引用宪法块头的 assistant 消息 ⇒ 不得计为注入(N/A)', events: [mk(10, 'assistant/message', { content: [{ type: 'text', text: R0_HEAD + '）】' }] })], expect: 'FAIL' },
  ];

  let bad = 0;
  for (const c of CASES) {
    const { inj, sysSeqs, comps } = analyze(c.events);
    const seqs = c.pick === 'r1' ? inj.r1 : inj.r0;
    const v = verdict(c.pick === 'r1' ? 'R1' : 'R0', seqs, comps, sysSeqs);
    const ok = v.state === c.expect && (c.evidence === undefined || v.evidence === c.evidence);
    if (!ok) bad += 1;
    console.log(`${ok ? '✅' : '❌'} ${c.name}  →  实得 state=${v.state}${v.evidence ? ` evidence=${v.evidence}` : ''}（期望 ${c.expect}${c.evidence ? '/' + c.evidence : ''}）`);
  }
  console.log(bad === 0
    ? `[verify-r0-after-compact] 反证自检：${CASES.length}/${CASES.length} 通过（含 ${CASES.filter((c) => c.expect === 'FAIL').length} 条「应当变红」）`
    : `[verify-r0-after-compact] 反证自检：${bad} 条不符 ⇒ **判据已失真，勿据此下任何结论**`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!existsSync(SESS_DIR)) {
  console.error(`[verify-r0-after-compact] ❌ 输入缺失：会话目录不存在 → ${SESS_DIR}`);
  process.exit(1);
}
let files = findSessions(SESS_DIR);
if (files.length === 0) {
  console.error(`[verify-r0-after-compact] ❌ 输入缺失：${SESS_DIR} 下找不到 session.v3.jsonl.zstd`);
  process.exit(1);
}
if (selector) {
  const hit = files.filter((f) => f.includes(selector) || basename(dirname(f)).includes(selector));
  if (hit.length === 0) {
    console.error(`[verify-r0-after-compact] ❌ 选择器 "${selector}" 没匹配到任何会话（共 ${files.length} 个）`);
    process.exit(1);
  }
  files = hit;
} else {
  files = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, limit);
}

console.log(`[verify-r0-after-compact] 检查 ${files.length} 个会话${strictSingle ? '（定向验收·严格）' : '（普查）'}（判据：压缩 shadowedSeqs 是否吃掉注入 + 其后有无补注入）\n`);
let failed = 0;
let anyCompaction = false;
let anyMarkerEvidence = false;
let anyHeuristic = false;

for (const file of files) {
  const name = basename(dirname(file));
  const { events, frames, failed: frameFail, why } = readEvents(file);
  if (events.length === 0) {
    console.log(`❌ ${name}: 解压不出任何事件（${why ?? '未知'}，帧失败 ${frameFail}）→ 本会话未验证（响亮失败，不当作通过）`);
    failed += 1;
    continue;
  }
  const { inj, sysSeqs, comps } = analyze(events);
  if (comps.length) anyCompaction = true;
  const fmt = (arr) => arr.map((i) => i.seq + (i.repair ? '*' : '') + (i.heuristic ? '?' : '')).join(', ');
  console.log(`${name}  [事件 ${events.length} / 帧 ${frames}${frameFail ? ` / 帧失败 ${frameFail}` : ''} / 压缩 ${comps.length}]`);
  console.log(`   注入 seq: R0=[${fmt(inj.r0)}]  R1=[${fmt(inj.r1)}]   （* = 带 ${REPAIR_MARK} 标记；? = 无 source、按文本兜底认定）`);
  if (inj.r0.some((i) => i.heuristic) || inj.r1.some((i) => i.heuristic)) anyHeuristic = true;
  for (const [label, seqs] of [['R0', inj.r0], ['R1', inj.r1]]) {
    const v = verdict(label, seqs, comps, sysSeqs);
    if (v.state === 'FAIL') failed += 1;
    if (v.evidence === 'marker') anyMarkerEvidence = true;
    const icon = v.state === 'PASS' ? '✅' : v.state === 'FAIL' ? '❌' : '➖';
    console.log(`   ${icon} ${v.note}`);
  }
  console.log('');
}

if (!anyCompaction) {
  // ⚠️ 这是"什么都没验到"，不是"通过"。定向验收时按 FAIL 计（复核指摘：原先会给出假读数）。
  console.log('❌ 本工具**没验到任何压缩** ⇒ 「压缩后自愈」这条未被真机触发，结论不可用。');
  console.log('   做法：重启 DSHOME 后在目标会话执行 /compact（或聊到超窗自动压缩），再定向跑本工具。');
  if (strictSingle) failed += 1;
} else if (!anyMarkerEvidence) {
  console.log('⚠ 有压缩记录，但**没有任何** inject#repair 标记——这有**两种正常情形**，都不代表修复失效：');
  console.log('  ① 该会话的压缩发生在进程重启之前（走的是旧代码路径，见上面 ❌ 的行）；');
  console.log('  ② 本进程从未注入过 R0/R1 ⇒ 重启/resume 后**首次**补注入一律无标记（`ever` 是**进程级**状态，见复核 N1）。');
  console.log('  标记只在「同一进程内先注入过 → 再被压缩 → 补注入」时出现；无标记时以上面 ✅ 的 post-compaction（非同段首注）判据为准。');
  console.log('  注：`inject#repair` 是**注入消息的块头**（文本层），不是 marker 文件的行——marker 只记 `inject: len=…`。');
}
if (anyHeuristic) {
  console.log('⚠ 有注入项是按**文本块头**兜底认定的（无 source 字段）⇒ 读数可能虚高，请人工核对。');
}

console.log(failed === 0 ? '[verify-r0-after-compact] 结论：无 FAIL' : `[verify-r0-after-compact] 结论：${failed} 项 FAIL`);
process.exit(failed === 0 ? 0 : 1);
