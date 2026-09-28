// scripts/mind-reasoning-lang.mjs — 推理正文检索 + 思考语言体检（只读观测器）
//
// 为什么有这个脚本（2026-09-28 立）：
//   主人的问题是「如何让你尽量用中文思考」。此前**没有任何工具能回答它**——
//   `read-session.mjs` 打全文但搜不了；`/api/mind/search` 只搜记忆不搜会话；
//   `mind-audit.mjs` 只审"该查没查"。而实测发现：**推理正文是落盘的**，
//   位置＝`assistant/message` 记录的 `data.message.content[type=reasoning].text`。
//   ⇒ 本脚本补这个盲区：把"思考用什么语言"从感觉变成可复算的读数。
//
// 性质：**只读**。不写任何文件、不改会话、不拦 commit（exit 恒 0），只产出读数。
//
// 用法：
//   node scripts/mind-reasoning-lang.mjs --grep "<正则>"      # 全库搜推理正文（本脚本独有能力）
//   node scripts/mind-reasoning-lang.mjs --lang               # 主对话会话的思考语言占比
//   node scripts/mind-reasoning-lang.mjs --cost               # 推理 token 真实开销（按语言分组）
//   node scripts/mind-reasoning-lang.mjs --lang --json        # 结构化输出（供面板/cron 消费）
//   可选：--sessions <dir> 指定会话根（默认 <repoRoot>/sessions）；--limit <n> 限制 --lang 样本数
//
// ⚠️ 判据边界（**必读：这些数能信到什么程度**）：
//   a. **"英文句"＝以英文功能词开头**（The/This/I/Let/Should/The user says…）。
//      ⚠️ 曾经的漏判据是「含中文字符即中文句」——它会把
//      「The user says 现在后端崩了后没有报错框了」判成中文句，
//      实测把 **87% 的英文思考测成 0%**（2026-09-28 亲历，主人一张截图戳破）。
//      改判后同一批会话英文整句占比 0% → 28.8%。**别再用"中文字符数"当语言证据。**
//   b. **中文字符占比会被英文技术名词与空格污染**（路径/函数名/字段名），
//      跨会话比这个数**没有意义**；跨语言比 token 单价也一样（per 字符口径不可比）。
//      要比 token 成本请用 --cost 的「per 步」口径。
//   c. **会话分类是启发式**（宁可漏、不可错）：判为"主对话"需
//      ① 首条真实用户输入是 ≤200 字的中文短句 ② 该会话主人输入 ≥3 条
//      ③ header 无 delegationDepth/origin=subagent。其余一律归 `口径不明` 不参与汇总。
//      ⇒ 会漏掉"启动快照开头"或首条即长任务的会话（少数），但**不混入成员会话**。
//   d. 会话产物是**追加写入的多帧 zstd**，末尾可能有 torn frame（读取端已跳过）。
//
// 基线（2026-09-28 实跑，供日后对照是否漂移）：
//   50 个主对话会话：英文整句占比 28.8%；排障/改代码类会话 87~93%；
//   聊天/规划/中文文档类 0~1%。中文思考不比英文贵：每步推理 913 vs 786 token（+16%）。
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionText } from './read-session.mjs';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (flag) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

const SESSIONS = resolve(val('--sessions') ?? join(repoRoot, 'sessions'));
const LIMIT = Number(val('--limit') ?? 60);
const AS_JSON = has('--json');

// ── 会话枚举（sessions/<slug>/<sessionId>/session.v3.jsonl.zstd）──────────────
function listSessions(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(root, slug.name);
    for (const d of readdirSync(slugDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const name of ['session.v3.jsonl.zstd', 'session.v3.jsonl']) {
        const p = join(slugDir, d.name, name);
        if (existsSync(p)) { out.push({ path: p, slug: slug.name, id: d.name }); break; }
      }
    }
  }
  return out.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
}

// ── 会话解析 ─────────────────────────────────────────────────────────────────
/** header 记录（type=session）——含 delegationDepth / origin / cwd 等。 */
function headerOf(text) {
  const first = text.split(/\r?\n/).find((l) => l.includes('"type":"session"'));
  try { return JSON.parse(first); } catch { return {}; }
}

/** 主人真实输入（剔除 R0 注入 / R1 召回 / skill 卡这类系统塞进去的 user 消息）。 */
function realUserMsgs(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.includes('"user/message"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (/inject|recall|skill|system/i.test(String(o?.data?.source ?? ''))) continue;
    const c = o?.data?.content;
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join(' ') : '';
    if (!txt) continue;
    if (txt.includes('R0 运行宪法') || txt.includes('上工自动召回')) continue;
    out.push(txt);
  }
  return out;
}

/** 收集一条会话的全部推理块 / 作答块 / usage。 */
function collect(text) {
  const reasoning = [], said = [], usage = { in: 0, out: 0, rea: 0, steps: 0 };
  for (const l of text.split(/\r?\n/)) {
    if (!l.includes('"assistant/message"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const u = o?.data?.usage;
    if (u && typeof u === 'object') {
      usage.in += Number(u.inputTokens ?? 0);
      usage.out += Number(u.outputTokens ?? 0);
      usage.rea += Number(u.reasoningTokens ?? 0);
      usage.steps += 1;
    }
    const c = o?.data?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p?.type === 'reasoning' && typeof p.text === 'string') reasoning.push(p.text);
      else if (p?.type === 'text' && typeof p.text === 'string') said.push(p.text);
    }
  }
  return { reasoning, said, usage };
}

// ── 语言判据（见头注 a/b/c）──────────────────────────────────────────────────
const EN_SENT_START = /^(The|This|That|These|Those|I|We|My|Our|It|Its|Let|Now|So|But|And|Then|First|Next|Finally|Wait|Hmm|Actually|Okay|OK|Yes|No|Also|Maybe|Perhaps|Since|Because|If|When|While|After|Before|Should|Could|Would|There|Here|Why|What|How|Where|Which|Who|Need|Check|Look|Let's)\b/;
const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);
/** 0=中文句 · 1=英文句 · 2=其它（路径/代码/碎片） */
function sentKind(s) {
  const t = s.trim();
  if (!t) return 2;
  if (EN_SENT_START.test(t)) return 1;
  if (hasCjk(t)) return 0;
  return 2;
}
/** 净化：去掉代码块/行内代码/路径/URL/文件名——避免把材料当成思考本身。 */
function stripNoise(s) {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b[A-Za-z]:[\\/][^\s，。；、)）]*/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[\w.-]+\.(mjs|js|ts|md|json|jsonl|zstd|yml|yaml)\b/g, ' ');
}

/** 主对话判定（保守；见头注 c）。返回 'main' | 'sub' | 'unsure' */
function classify(text) {
  const h = headerOf(text);
  const d = h.data ?? {};
  if (Number(h.delegationDepth ?? d.delegationDepth ?? 0) > 0) return 'sub';
  if (h.origin === 'subagent' || d.origin === 'subagent') return 'sub';
  const us = realUserMsgs(text);
  const fu = (us[0] ?? '').trim();
  if (!fu) return 'unsure';
  if (/^Current runtime context/i.test(fu)) return 'unsure';
  if (fu.length > 200 || !hasCjk(fu)) return 'unsure';
  if (us.length < 3) return 'unsure';
  return 'main';
}

// ── 模式：--grep（本脚本独有能力）─────────────────────────────────────────────
function runGrep(pattern) {
  const re = new RegExp(pattern, 'i');
  const files = listSessions(SESSIONS);
  const hits = [];
  for (const f of files) {
    let text; try { text = readSessionText(f.path); } catch { continue; }
    const blocks = [];
    for (const l of text.split(/\r?\n/)) {
      if (!l.includes('"assistant/message"')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const c = o?.data?.message?.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p?.type !== 'reasoning' || typeof p.text !== 'string') continue;
        const i = p.text.search(re);
        if (i < 0) continue;
        blocks.push(p.text.slice(Math.max(0, i - 70), i + 240).replace(/\s+/g, ' '));
      }
    }
    if (!blocks.length) continue;
    const h = headerOf(text);
    hits.push({
      id: f.id,
      slug: f.slug,
      kind: classify(text),
      depth: h.delegationDepth ?? 0,
      blocks: blocks.length,
      firstUser: (realUserMsgs(text)[0] ?? '').replace(/\s+/g, ' ').slice(0, 46),
      samples: blocks.slice(0, 3),
    });
  }
  if (AS_JSON) { console.log(JSON.stringify({ pattern, scanned: files.length, hits }, null, 2)); return; }
  console.log(`[--grep ${pattern}] 扫描 ${files.length} 个会话，命中 ${hits.length} 个 / ${hits.reduce((s, x) => s + x.blocks, 0)} 个思考块`);
  for (const x of hits) {
    console.log(`✗ ${x.id.slice(0, 36)}  ${x.kind} depth=${x.depth} 命中${x.blocks}块 | 首条主人输入: ${x.firstUser}`);
    for (const s of x.samples) console.log(`     ↳ ${s.slice(0, 190)}`);
  }
  if (!hits.length) console.log('（0 命中——若这是"某特征不存在"的结论，请先造一个已知含该特征的样本做正对照）');
}

// ── 模式：--lang ─────────────────────────────────────────────────────────────
function runLang() {
  const files = listSessions(SESSIONS);
  const rows = [], skipped = { sub: 0, unsure: 0, noReason: 0 };
  let scanned = 0;
  for (const f of files) {
    if (rows.length >= LIMIT) break;
    scanned += 1;
    let text; try { text = readSessionText(f.path); } catch { continue; }
    const kind = classify(text);
    if (kind !== 'main') { skipped[kind]++; continue; }
    const { reasoning, said } = collect(text);
    if (!reasoning.length) { skipped.noReason++; continue; }
    const R = stripNoise(reasoning.join('\n'));
    const S = stripNoise(said.join('\n'));
    const segs = R.split(/(?<=[。！？；\n])|(?<=\.\s)/).map((s) => s.trim()).filter((s) => s.length >= 12);
    let en = 0, cn = 0, other = 0;
    for (const s of segs) { const k = sentKind(s); if (k === 1) en++; else if (k === 0) cn++; else other++; }
    const denom = en + cn || 1;
    const cnChars = (R.match(/[\u4e00-\u9fff]/g) || []).length;
    rows.push({
      id: f.id.slice(0, 12),
      blocks: reasoning.length,
      reasonChars: R.length,
      cnCharsPct: R.length ? Math.round((cnChars / R.length) * 100) : 0,
      enSents: en, cjkSents: cn, otherSents: other,
      enSentPct: Math.round((en / denom) * 100),
      saidCnPct: S.length ? Math.round((((S.match(/[\u4e00-\u9fff]/g) || []).length) / S.length) * 100) : 0,
      samples: segs.filter((s) => sentKind(s) === 1).slice(0, 2),
      title: (realUserMsgs(text)[0] ?? '').replace(/\s+/g, ' ').slice(0, 30),
    });
  }
  const aggEn = rows.reduce((s, r) => s + r.enSents, 0);
  const aggCn = rows.reduce((s, r) => s + r.cjkSents, 0);
  const aggChars = rows.reduce((s, r) => s + r.reasonChars, 0);
  const aggCnChars = rows.reduce((s, r) => s + (r.cnCharsPct * r.reasonChars) / 100, 0);
  const summary = {
    mainSessions: rows.length,
    scanned,
    totalSessions: files.length,
    truncated: scanned < files.length,
    skipped,
    reasonChars: aggChars,
    cnCharsPct: aggChars ? Number(((aggCnChars / aggChars) * 100).toFixed(1)) : 0,
    enSentPct: aggEn + aggCn ? Number(((aggEn / (aggEn + aggCn)) * 100).toFixed(1)) : 0,
    enSents: aggEn, cjkSents: aggCn,
  };
  if (AS_JSON) { console.log(JSON.stringify({ summary, rows }, null, 2)); return; }
  console.log('会话         | 思考块 | 净字数 | 中文字符% | 英文句 | 中文句 | 其它 | 英文句% | 首条主人输入');
  for (const r of [...rows].sort((a, b) => b.enSentPct - a.enSentPct)) {
    console.log([
      r.id.padEnd(12), String(r.blocks).padStart(6), String(r.reasonChars).padStart(6),
      String(r.cnCharsPct + '%').padStart(9), String(r.enSents).padStart(6), String(r.cjkSents).padStart(6),
      String(r.otherSents).padStart(4), String(r.enSentPct + '%').padStart(7), '| ' + r.title,
    ].join(' | '));
  }
  console.log('---');
  console.log(`主对话会话 ${summary.mainSessions} 个（已扫 ${summary.scanned}/${summary.totalSessions}${summary.truncated ? '，⚠️ 受 --limit 截断，非全量' : ''}）`);
  console.log(`跳过：成员 ${skipped.sub} / 口径不明 ${skipped.unsure} / 无思考块 ${skipped.noReason}`);
  console.log(`思考净字数 ${summary.reasonChars} / 中文字符占比 ${summary.cnCharsPct}%（⚠️ 会被英文技术名词污染，勿跨会话比）`);
  console.log(`英文整句 ${summary.enSents} / 中文句 ${summary.cjkSents} → 英文句占比 ${summary.enSentPct}%（基线 28.8%）`);
  const top = [...rows].sort((a, b) => b.enSentPct - a.enSentPct)[0];
  if (top) { console.log(`英文句占比最高：${top.id}（${top.enSentPct}%）`); for (const s of top.samples) console.log(`   ↳ ${s.slice(0, 110)}`); }
}

// ── 模式：--cost ─────────────────────────────────────────────────────────────
function runCost() {
  const files = listSessions(SESSIONS);
  const rows = [];
  let scanned = 0;
  for (const f of files) {
    scanned += 1;
    let text; try { text = readSessionText(f.path); } catch { continue; }
    const h = headerOf(text);
    if (Number(h.delegationDepth ?? 0) > 0 || h.origin === 'subagent') continue;
    const { reasoning, usage } = collect(text);
    const chars = reasoning.join('').length;
    if (!chars || !usage.rea) continue;
    const cn = (reasoning.join('').match(/[\u4e00-\u9fff]/g) || []).length;
    rows.push({ id: f.id.slice(0, 12), rea: usage.rea, chars, cnPct: Math.round((cn / chars) * 100), tpc: usage.rea / chars, inTok: usage.in, outTok: usage.out, steps: usage.steps });
  }
  const avg = (a, k) => a.reduce((s, r) => s + r[k], 0) / (a.length || 1);
  const en = rows.filter((r) => r.cnPct < 15), cn = rows.filter((r) => r.cnPct > 30);
  const totSteps = rows.reduce((s, r) => s + r.steps, 0);
  const totIn = rows.reduce((s, r) => s + r.inTok, 0);
  const totOut = rows.reduce((s, r) => s + r.outTok, 0);
  const totRea = rows.reduce((s, r) => s + r.rea, 0);
  const out = {
    sessions: rows.length, steps: totSteps,
    inputTokens: totIn, outputTokens: totOut, reasoningTokens: totRea,
    reasoningShareOfOutput: totOut ? Number(((totRea / totOut) * 100).toFixed(1)) : 0,
    perStep: { input: Math.round(totIn / (totSteps || 1)), reasoning: Math.round(totRea / (totSteps || 1)) },
    enDominant: { n: en.length, perStepReasoning: Math.round(avg(en.map((r) => ({ tps: r.rea / (r.steps || 1) })), 'tps')) },
    cnDominant: { n: cn.length, perStepReasoning: Math.round(avg(cn.map((r) => ({ tps: r.rea / (r.steps || 1) })), 'tps')) },
    rewriteEstimateTokens200: Math.round(200 * (avg(cn, 'tpc') || 0.5)),
  };
  if (AS_JSON) { console.log(JSON.stringify({ summary: out, rows }, null, 2)); return; }
  console.log('id           | 思考token | 思考字符 | 中文字符% | token/字符 | 输入token | 输出token | 步数');
  for (const r of [...rows].sort((a, b) => a.cnPct - b.cnPct).slice(0, 24)) {
    console.log([r.id.padEnd(12), String(r.rea).padStart(9), String(r.chars).padStart(9), String(r.cnPct + '%').padStart(9), r.tpc.toFixed(3).padStart(10), String(r.inTok).padStart(9), String(r.outTok).padStart(9), String(r.steps).padStart(5)].join(' | '));
  }
  console.log('---');
  console.log(`已扫 ${scanned} 个会话，其中 ${rows.length} 个有可用 usage + 思考正文（成员会话已排除）`);
  console.log(`本批总账：输入 ${totIn} / 输出 ${totOut} / 其中推理 ${totRea} token（占输出 ${out.reasoningShareOfOutput}%，共 ${totSteps} 步）`);
  console.log(`每步均量：输入 ${out.perStep.input} token / 推理 ${out.perStep.reasoning} token`);
  console.log('【语言成本·per 步口径（唯一可比）】');
  console.log(`  英文主导 ${out.enDominant.n} 个会话：每步推理 ${out.enDominant.perStepReasoning} token`);
  console.log(`  中文主导 ${out.cnDominant.n} 个会话：每步推理 ${out.cnDominant.perStepReasoning} token`);
  console.log('  ⚠️ 不做 per 字符比较——英文分母含空格，该口径不可比（见头注 b）');
  console.log(`【复述成本】200 字中文复述 ≈ ${out.rewriteEstimateTokens200} token ≈ 单步输入的 ${((out.rewriteEstimateTokens200 / (out.perStep.input || 1)) * 100).toFixed(1)}%`);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
if (has('--grep')) runGrep(val('--grep') ?? '');
else if (has('--cost')) runCost();
else if (has('--lang')) runLang();
else {
  console.log('用法（详见文件头注）：');
  console.log('  node scripts/mind-reasoning-lang.mjs --grep "<正则>"   # 全库搜推理正文');
  console.log('  node scripts/mind-reasoning-lang.mjs --lang             # 思考语言占比');
  console.log('  node scripts/mind-reasoning-lang.mjs --cost             # 推理 token 开销');
  console.log('  可选：--sessions <dir> · --limit <n> · --json');
}
