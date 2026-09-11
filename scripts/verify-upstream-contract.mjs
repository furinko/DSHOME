#!/usr/bin/env node
// scripts/verify-upstream-contract.mjs — 上游契约自检（2026-09-11 建）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// `packages/dshome/lib/host/upstream.js` 那层只治**一类**升级故障：
// **官方具名/默认导出消失或改名**（静态导入是 ESM 链接期错误，会把整棵插件树带崩）。
//
// 但它治不了另一类故障 —— **运行时行为契约**：
//   · 我们挂的**槽位名**（slot）在官方 UI 包里没了 → 界面上静默少一块，不报错
//   · 我们覆盖的**官方行 id** 改了名 → cordis.patch.yml 的覆盖**静默失效**，配置不生效
//   · 我们依赖的**服务名**没有提供方 → 插件降级或报错
//
// 这三类都**不会在启动时报错**（静默失效），只有实跑才知道。本脚本把它们变成
// **升级后、正式切换前**就能逐项 ✅/❌ 的清单。
//
// 用法：node scripts/verify-upstream-contract.mjs
// 退出码：0 = 全部命中；1 = 有 ❌（说明升级会静默坏掉某些面）
//
// ── 诚实边界 ────────────────────────────────────────────────────────────────
// · 本脚本查的是**静态存在性**（字符串/导出在不在），**不等于运行时行为正确**
// · hook 签名（如 `agent/pre-step` 的参数形状）**静态查不出来**，归 `verify-host-plugins` 的真跑断言
// · 服务名那一类**只做尽力检查**，见 §D

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(repoRoot, 'node_modules');
const results = [];
const fail = (section, item, detail) => results.push({ ok: false, section, item, detail });
const pass = (section, item, detail) => results.push({ ok: true, section, item, detail });

// ── §A 具名导出：我们依赖的官方导出是否还在 ────────────────────────────────
// 与 packages/dshome/lib/host/upstream.js 保持一致；cron.cjs 另有两处 require。
const NEEDED_EXPORTS = [
  ['@deepseek-ai/dsh-llm', 'createUserMessage', 'R0 宪法注入 / 上工召回 / Skill 卡注入'],
  ['@deepseek-ai/dsh-settings', 'settingsNamespace', 'notify / plugin-manager 设置总线'],
  ['@deepseek-ai/schemastery', 'default', '设置 schema 构造器 z'],
  ['@deepseek-ai/dsh-agent', 'installModelSelection', 'cron 定时任务的模型选择'],
  ['@deepseek-ai/dsh-llm', 'createMessage', 'cron 定时任务构造消息'],
];

for (const [spec, name, why] of NEEDED_EXPORTS) {
  try {
    const mod = await import(spec);
    const v = name === 'default' ? mod.default : mod[name];
    if (v === undefined) fail('A 具名导出', `${spec}#${name}`, `已消失或改名（用途：${why}）`);
    else pass('A 具名导出', `${spec}#${name}`, `在（${typeof v}）`);
  } catch (e) {
    fail('A 具名导出', `${spec}#${name}`, `包本身导入失败：${e?.message ?? e}（用途：${why}）`);
  }
}

// ── §B 槽位名：我们注册的 slot 是否还存在于官方 UI 包 ──────────────────────
// 槽位名归官方 UI 包所有。改名 = 我们的界面块**静默消失**（注册不报错，只是挂不上）。
const NEEDED_SLOTS = [
  ['conversation.view', 'dshome-mind 心智面板 / 定时面板'],
  ['conversation.input.left', 'dshome-mind「接入心智」开关'],
  ['settings.general.item', 'dshome-assistant-identity 设置两行'],
  ['sidebar.footer.action', 'dshome-plugin-center 插件中心入口'],
  ['sidebar.brand.mark', 'dshome-theme 品牌标记'],
  ['sidebar.brand.name', 'dshome-theme 品牌名'],
  ['conversation.hero.brand.mark', 'dshome-theme 首屏品牌标记'],
];

/** 在全部官方 client UI 包里找某个字符串（返回命中的包名列表）。 */
function findInOfficialUiClients(needle) {
  let pkgDirs = [];
  try {
    pkgDirs = readdirSync(NM).filter((d) => d.startsWith('@deepseek-ai'));
  } catch { return []; }
  const hits = [];
  for (const scope of pkgDirs) {
    const scopeDir = join(NM, scope);
    let names = [];
    try { names = readdirSync(scopeDir).filter((d) => d.includes('client')); } catch { continue; }
    for (const n of names) {
      const libDir = join(scopeDir, n, 'lib');
      if (!existsSync(libDir)) continue;
      if (treeContains(libDir, needle)) hits.push(`${scope}/${n}`);
    }
  }
  return hits;
}

/** 递归在目录下的文本文件里找 needle（限 .js/.cjs/.mjs/.d.ts，防扫到二进制）。 */
function treeContains(dir, needle, depth = 0) {
  if (depth > 4) return false;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (treeContains(p, needle, depth + 1)) return true; continue; }
    if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
    try { if (readFileSync(p, 'utf8').includes(needle)) return true; } catch { /* 跳过 */ }
  }
  return false;
}

for (const [slot, why] of NEEDED_SLOTS) {
  const hits = findInOfficialUiClients(slot);
  if (hits.length) pass('B 槽位名', slot, `存在于 ${hits.join(', ')}`);
  else fail('B 槽位名', slot, `官方 client 包里**找不到** → 该界面块会静默挂不上（用途：${why}）`);
}

// ── §C 官方行 id：cordis.patch.yml 覆盖的行是否还存在 ──────────────────────
// 我们的主 profile 覆盖 4 条官方行。官方行 id 一改名，覆盖**静默失效**。
const patchFile = join(repoRoot, 'packages', 'dshome', 'cordis.patch.yml');
let overriddenIds = [];
if (existsSync(patchFile)) {
  for (const line of readFileSync(patchFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*-\s*id:\s*([\w-]+)\s*$/.exec(line);
    if (m && !m[1].startsWith('dshome')) overriddenIds.push(m[1]);
  }
}
overriddenIds = [...new Set(overriddenIds)];

/** 在全部已装官方包的 cordis.patch.yml 里找某个行 id。 */
function findRowIdInOfficialPatches(id) {
  const hits = [];
  let scopes = [];
  try { scopes = readdirSync(NM).filter((d) => d.startsWith('@deepseek-ai')); } catch { return hits; }
  for (const scope of scopes) {
    let names = [];
    try { names = readdirSync(join(NM, scope)); } catch { continue; }
    for (const n of names) {
      const pf = join(NM, scope, n, 'cordis.patch.yml');
      if (!existsSync(pf)) continue;
      try {
        // ⚠️ 必须允许**前导缩进**：官方 bundle 的行是缩在 `insert:` 下的
        //    （实测 `dsh-web-app\cordis.patch.yml:137` 原文为 `    - id: web-runtime`）。
        //    首版写成 `^-`（顶格）→ 4 项全部**假阴性**；而 Select-String 的显示会
        //    `.Trim()`，看起来像顶格，差点据此误判。教训：验证脚本自己也要被验证。
        const re = new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm');
        if (re.test(readFileSync(pf, 'utf8'))) hits.push(`${scope}/${n}`);
      } catch { /* 跳过 */ }
    }
  }
  return hits;
}

if (!overriddenIds.length) {
  fail('C 官方行 id', '(解析)', '未能从 packages/dshome/cordis.patch.yml 解析出任何被覆盖的官方行 id');
} else {
  for (const id of overriddenIds) {
    const hits = findRowIdInOfficialPatches(id);
    if (hits.length) pass('C 官方行 id', id, `官方 bundle 里存在（${hits.join(', ')}）`);
    else fail('C 官方行 id', id, '官方 bundle 的 cordis.patch.yml 里找不到 → 我们的覆盖会**静默失效**（config 不生效，不报错）');
  }
}

// ── §D 服务名（尽力检查）───────────────────────────────────────────────────
// `ctx.inject([...])` / `ctx.get(...)` 用的服务名。静态无法可靠判定"有没有提供方"
// （服务由插件运行时 provide），所以这里只**列出我们依赖的服务名**供人工核对，
// 不计入成败。
const SERVICE_NAMES = ['webServer', 'settings', 'sessions', 'jobs', 'loader', 'tools', 'fs', 'llm', 'attachments', 'theme'];

// ── 输出 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
let section = '';
for (const r of results) {
  if (r.section !== section) { section = r.section; console.log(`\n── ${section} ──`); }
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.item}${r.detail ? ` — ${r.detail}` : ''}`);
}

console.log(`\n── D 服务名（人工核对，不计成败）──`);
console.log(`  我们依赖的服务名：${SERVICE_NAMES.join(', ')}`);
console.log('  （服务由插件运行时 provide，静态查不出提供方；升级后请用 verify-host-plugins 真跑挂载面）');

console.log(`\n[verify-upstream-contract] ${failed.length === 0
  ? '✅ 上游契约全部命中'
  : `❌ ${failed.length} 项失配 —— 升级会让这些面静默失效`}（退出码 ${failed.length === 0 ? 0 : 1}）`);

process.exit(failed.length === 0 ? 0 : 1);
