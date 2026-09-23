#!/usr/bin/env node
// scripts/mind-write-log-itest.mjs — 写入归属台账自测（2026-09-23 建 · 配合 write-log 归属维度）
//
// 验什么：`dshome-mind-guard` 的 `appendWriteClaim` 记的是**谁在什么时候写了哪个文件**——
//   `scripts/git-writer-probe.mjs` 新增的归属维度全靠它（台账错 ⇒ 探针把归属指错人，
//   比"没有归属"更坏：它会让人以为已经查清了）。
// 判据（每条都配反例——写不出反例＝没验过）：
//   A 有会话 → 记下 session / tool / **仓库相对路径**；台账不存在也要自动建（不是静默失败）
//   B 无会话（agent-less 执行）→ session 记 **null**（归属未知要如实留空，不许伪装成某个会话）
//     反例：把 `session` 写成无条件的 `String(sid)` ⇒ B1 必红（会记成字符串 "undefined"）
//   C 绝对路径 / 反斜杠路径 → 一律归一成相对路径（探针的 `git status` 给的是相对路径，两边必须同口径）
//     反例：去掉 `repoRelPath` 的归一、直接存原样 ⇒ C1/C2 必红
//   D 超上界（512KB）→ 保留后半（可查 ≠ 全存），且**刚写的那条必须在**（不许裁掉自己）
// 隔离：`DSH_HOME` 指向临时目录（真仓库零触碰），跑完删除。
// 用法：node scripts/mind-write-log-itest.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (name, ok, extra) => results.push([name, ok ? 'PASS' : 'FAIL', extra]);

const home = mkdtempSync(join(tmpdir(), 'dshome-writelog-'));
mkdirSync(join(home, 'mind'), { recursive: true }); // repoRoot() 认 DSH_HOME；建 mind/ 与仓内同形
process.env.DSH_HOME = home;

const { appendWriteClaim, writeLogFile, repoRelPath } = await import('../packages/dshome/lib/host/mind-guard.js');

const exists = (f) => { try { statSync(f); return true; } catch { return false; } };
const readLog = () => readFileSync(writeLogFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const sid = 'aaaa1111-2222-3333-4444-555566667777';
const withAgent = { name: 'edit', agent: { session: { header: { id: sid } } } };

// ── A 有会话：自动建 + 记对字段 ────────────────────────────────────────────────
check('A0 起点：台账不存在（否则 A1 证明不了"自动建"）', !exists(writeLogFile()), writeLogFile());
appendWriteClaim(withAgent, 'mind/L1/Tree.md');
const a = readLog();
check('A1 台账不存在也自动建目录并写入', a.length === 1, `len=${a.length}`);
check('A2 记下 session / tool / 仓库相对路径',
  a[0]?.session === sid && a[0]?.tool === 'edit' && a[0]?.path === 'mind/L1/Tree.md',
  JSON.stringify(a[0]));

// ── B 无会话：如实留空 ────────────────────────────────────────────────────────
appendWriteClaim({ name: 'write' }, 'mind/L2/Skill/x.md');
const b = readLog().at(-1);
check('B1 无会话 → session=null（不伪装成某个会话）', b?.session === null, `session=${JSON.stringify(b?.session)}`);

// ── C 路径归一（两侧同口径）──────────────────────────────────────────────────
appendWriteClaim(withAgent, join(home, 'packages', 'x', 'y.js'));
const c1 = readLog().at(-1);
check('C1 绝对路径 → 归一成仓库相对路径', c1?.path === 'packages/x/y.js', `path=${c1?.path}`);
appendWriteClaim(withAgent, 'packages\\x\\z.js');
const c2 = readLog().at(-1);
check('C2 反斜杠路径 → 统一成 /', c2?.path === 'packages/x/z.js', `path=${c2?.path}`);
const outside = repoRelPath('C:/outside/foo.txt');
check('C3 仓库外路径 → 原样返回（不假装它在仓里）', /outside/i.test(outside) && !outside.startsWith('mind'), outside);

// ── D 超上界裁剪：保留后半，且**最新一条必须在** ──────────────────────────────
const bigLine = JSON.stringify({ ts: new Date().toISOString(), session: 'pad', tool: 'edit', path: 'pad/x.md', blob: 'x'.repeat(400) });
const padLines = [];
for (let i = 0; i < 1400; i++) padLines.push(bigLine.replace('"pad"', `"pad-${i}"`).replace('pad/x.md', `pad/${i}.md`));
writeFileSync(writeLogFile(), padLines.join('\n') + '\n');
check('D0 起点：台账已超上界 512KB', statSync(writeLogFile()).size > 512 * 1024, `${Math.round(statSync(writeLogFile()).size / 1024)}KB`);
appendWriteClaim(withAgent, 'mind/L1/after-trim.md');
const d = readLog();
check('D1 超上界 → 裁掉前半（行数明显减少）', d.length < 1400, `len=${d.length}`);
check('D2 裁剪后**刚写的那条仍在**（不许把自己裁掉）', d.at(-1)?.path === 'mind/L1/after-trim.md', JSON.stringify(d.at(-1)?.path));

rmSync(home, { recursive: true, force: true });

let failed = 0;
for (const [name, verdict, extra] of results) {
  if (verdict === 'FAIL') failed++;
  console.log(`[itest] ${name}: ${verdict}${extra ? ` (${extra})` : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
