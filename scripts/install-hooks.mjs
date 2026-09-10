#!/usr/bin/env node
// scripts/install-hooks.mjs — 安装 git hooks（**可重复执行、幂等**）
//
// ── 为什么需要它（第四轮盲评 · C2 指摘）────────────────────────────────────────
// `.git/hooks/` **不被 git 跟踪**，而全仓没有 `prepare` / `postinstall` / 安装脚本
// （grep `pre-commit` 只有 2 处命中：hook 自身 + 它注释里的 cp 装法）→
// **新克隆上这道门根本不存在**。我此前反复强调"hook 让不通过不落盘成为机器事实"，
// 但那只是**本机事实**——门禁的「存在性」本身无人守。
// 本脚本把安装变成一条命令，并接进 `package.json` 的 `prepare`（install 后自动跑）。
//
// 用法：node scripts/install-hooks.mjs        （幂等：重复跑只是覆盖同一份）
import { readdirSync, copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(repoRoot, 'scripts', 'hooks');
const DST = join(repoRoot, '.git', 'hooks');

// 非 git 仓库（如从 npm 包安装、或装进一个没有 .git 的目录）→ 静默跳过，不算失败
if (!existsSync(join(repoRoot, '.git'))) {
  console.log('[install-hooks] 非 git 工作区（无 .git/），跳过安装');
  process.exit(0);
}
if (!existsSync(SRC)) {
  console.error(`[install-hooks] ❌ 找不到 hook 源目录：${SRC}`);
  process.exit(1);
}
mkdirSync(DST, { recursive: true });

let n = 0;
const failed = [];
for (const name of readdirSync(SRC)) {
  const s = join(SRC, name);
  const d = join(DST, name);
  try {
    copyFileSync(s, d);
    try { chmodSync(d, 0o755); } catch { /* Windows 上 chmod 可能失败，不影响 git 用 sh 执行 */ }
    console.log(`[install-hooks] ✅ 已安装 ${name} → .git/hooks/${name}`);
    n++;
  } catch (e) {
    failed.push(`${name}: ${e && e.message}`);
  }
}
if (failed.length) {
  console.error(`[install-hooks] ❌ ${failed.length} 个 hook 安装失败：`);
  for (const f of failed) console.error('   ' + f);
  process.exit(1);
}
console.log(`[install-hooks] 完成（${n} 个）。提交时自动跑校验；逃生门：git commit --no-verify`);
