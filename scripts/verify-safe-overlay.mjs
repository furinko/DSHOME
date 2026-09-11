#!/usr/bin/env node
// scripts/verify-safe-overlay.mjs — 外壳「安全模式覆盖层」回归验证（2026-09-11 建）
//
// ── 为什么需要它（真实事故）──────────────────────────────────────────────────
// 主人报「后端崩了没报错框、安全模式打不开」，查出两处硬伤，都是**纯逻辑、单测可锁**的：
//   ① 覆盖层只取「找到的第一个 patch 文件」→ 只覆盖 L3 产品层 15 行；L4 覆盖层里
//      后加的 `dsh-imagegen` / Agent Teams 三个实验包**不在禁用范围**（dump-config 实测）。
//   ② 安全模式的 `--patch` 被拼在 app 参数（`--no-open`/`--port`）**之后** → dsh 0.1.5
//      直接判 `unknown option '--patch'`（实测）→ 后端根本起不来，安全模式反成崩溃源。
// 两处都不靠「跑一次看看」，靠断言即可防复发——这就是本脚本存在的唯一理由。
//
// ── 断言什么 ────────────────────────────────────────────────────────────────
//   A. 解析规则：insert 块内的行算自有；insert 之外的「覆盖官方行」（webserver /
//      llm-deepseek…）**绝不能被禁**（禁了会把宿主一起打死）；任何位置的 dshome* 兜底收。
//   B. 参数位置：`--patch` 必须插在 `--profile` 之后、app 参数之前；已带则不重复插。
//   C. 真实仓库布局：L3 产品层 15 行必须全部命中；四个官方覆盖行必须全部缺席；
//      L4 若存在必须在来源里（其行可被人工注释停用，故不硬断言具体 id）。
// 退出码：0 = 全通过；1 = 有断言失败。
//
// 用法：node scripts/verify-safe-overlay.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const so = require(join(repoRoot, 'packages', 'dshome', 'shell-app', 'safe-overlay.cjs'));

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`ok  ${name}`); return true; }
  failed += 1;
  console.error(`FAIL ${name}${extra ? '  → ' + extra : ''}`);
  return false;
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ── A. 解析规则 ─────────────────────────────────────────────────────────────
const L3_SHAPE = [
  '- insert:',
  '    - id: dshome-core',
  '      name: dshome/core',
  '    - id: dshome-mind',
  '      name: dshome-mind',
  '- id: webserver',
  '  config:',
  '    port: 3099',
  '- id: llm-deepseek',
  '  config:',
  '    apiKeyEnv: DSHOME_USER_KEY',
  '- id: ui-brand-official',
  '  disabled: true',
  '',
].join('\n');
check('A1 insert 块内的行被收（L3 形态）', same(so.idsFromPatchText(L3_SHAPE), ['dshome-core', 'dshome-mind']),
  JSON.stringify(so.idsFromPatchText(L3_SHAPE)));
check('A2 覆盖官方行不被收（web/llm/品牌）',
  !so.idsFromPatchText(L3_SHAPE).some((i) => ['webserver', 'llm-deepseek', 'ui-brand-official'].includes(i)));

const L4_SHAPE = [
  '- insert:',
  '    - id: dsh-imagegen',
  '      name: dsh-imagegen',
  '# ── 官方实验版 ──',
  '- insert:',
  "    - id: dsh-experimental-agent-team",
  "      name: '@deepseek-ai/dsh-experimental-agent-team'",
  '',
].join('\n');
check('A3 非 dshome 前缀的自有行也被收（L4 形态）',
  same(so.idsFromPatchText(L4_SHAPE), ['dsh-imagegen', 'dsh-experimental-agent-team']),
  JSON.stringify(so.idsFromPatchText(L4_SHAPE)));
check('A4 insert 外的 dshome* 行兜底被收（历史写法）',
  same(so.idsFromPatchText('- id: dshome-desktop\n  disabled: true\n'), ['dshome-desktop']));
check('A5 同一 id 不重复', so.idsFromPatchText('- insert:\n    - id: dshome-core\n    - id: dshome-core\n').length === 1);
check('A6 空文本不炸', so.idsFromPatchText('').length === 0 && so.idsFromPatchText(undefined).length === 0);

// ── B. --patch 位置（本次事故②）────────────────────────────────────────────
const CMD = 'node "E:\\DSHOME\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile dshome --no-open --port 3099';
const OVERLAY = 'C:\\Users\\x\\AppData\\Roaming\\dshome-shell\\dshome-safe.yml';
const patched = so.withPatchFlag(CMD, OVERLAY);
check('B1 --patch 在 --profile 之后', patched.indexOf('--profile dshome --patch') >= 0, patched);
check('B2 --patch 在 app 参数之前（本次事故根因）',
  patched.indexOf('--patch') < patched.indexOf('--no-open'), patched);
check('B3 路径带引号', patched.includes(`--patch "${OVERLAY}"`), patched);
check('B4 已带 --patch 时不重复插', so.withPatchFlag(patched, OVERLAY) === patched);
check('B5 无 --profile 时插在 app 参数之前',
  (() => { const c = so.withPatchFlag('node bin.js --no-open --port 3099', OVERLAY); return c.indexOf('--patch') < c.indexOf('--no-open'); })());
check('B6 profile 解析（带引号 / 不带 / 无）',
  so.profileFromCmd(CMD) === 'dshome'
  && so.profileFromCmd('x --profile "web" --no-open') === 'web'
  && so.profileFromCmd('dsh x --no-open') === null);

// ── C. 真实仓库布局（端到端数据面）────────────────────────────────────────────
const shellDir = join(repoRoot, 'packages', 'dshome', 'shell-app');
const { ids, sources } = so.collectSafeIds({
  shellDir, profDir: null, instDir: null, dshHome: repoRoot, profile: 'dshome',
});
const L3_IDS = [
  'dshome-core', 'dshome-shell', 'dshome-theme', 'dshome-palette', 'dshome-notify',
  'dshome-plugin-manager', 'dshome-plugin-center', 'dshome-assistant-identity',
  'dshome-mind', 'dshome-mind-inject', 'dshome-mind-guard', 'dshome-mind-recall',
  'dshome-mind-connect', 'dshome-mind-skill-loader', 'dshome-desktop',
];
const missing = L3_IDS.filter((i) => !ids.includes(i));
check('C1 L3 产品层 15 个自有插件全部命中', missing.length === 0, '缺：' + missing.join(', '));
const OFFICIAL = ['web-runtime', 'webserver', 'llm-deepseek', 'ui-brand-official'];
const leaked = ids.filter((i) => OFFICIAL.includes(i));
check('C2 官方覆盖行一个都没被误禁', leaked.length === 0, '泄漏：' + leaked.join(', '));
check('C3 来源含 L3 产品层',
  sources.some((s) => s.file.replace(/\\/g, '/').endsWith('packages/dshome/cordis.patch.yml')),
  JSON.stringify(sources.map((s) => s.file)));
const l4 = join(repoRoot, 'profiles', 'dshome', 'cordis.patch.yml');
if (existsSync(l4)) {
  check('C4 L4 覆盖层存在时纳入来源（事故①）',
    sources.some((s) => s.file.replace(/\\/g, '/').endsWith('profiles/dshome/cordis.patch.yml')),
    JSON.stringify(sources.map((s) => s.file)));
  const l4Ids = so.idsFromPatchText(readFileSync(l4, 'utf8'));
  if (l4Ids.length) {
    const l4Missing = l4Ids.filter((i) => !ids.includes(i));
    check('C5 L4 里的自有行全部并入', l4Missing.length === 0, '缺：' + l4Missing.join(', '));
  } else {
    console.log('ok  C5 L4 当前无启用行（人工临时停用中）→ 跳过并入断言');
  }
} else {
  console.log('ok  C4/C5 L4 覆盖层不存在 → 跳过');
}
const text = so.overlayText(ids);
check('C6 覆盖层文本对每个 id 都写 disabled: true',
  ids.every((id) => text.includes(`- id: ${id}\n  disabled: true`)));

console.log(failed ? `\nverify-safe-overlay: ${failed} 项失败` : `\nverify-safe-overlay: 全部通过（自有行 ${ids.length} 个，来源 ${sources.length} 层）`);
process.exit(failed ? 1 : 0);
