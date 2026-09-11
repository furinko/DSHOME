#!/usr/bin/env node
// DSHOME 恢复模式（Phase 1+）：用 --patch 覆盖层临时禁用全部自有插件启动，
// 判定崩溃来源（设计见历史文档 §13.5 L2 / §9.1 铁律，已归档）。不改任何配置、不删代码。
//
// 用法：node scripts/safe.mjs [--port <port>] [--profile <name>] [--print-ids]
//   --port       后端端口（默认 3099）
//   --profile    profile 名（默认 dshome）——决定 L4 覆盖层去哪找
//   --print-ids  只打印将要禁用的自有插件 id / 来源层 / 覆盖层文本（JSON）后退出，
//                不启动后端——逃生启动前的自检，也是 verify-safe-overlay 的断言入口。
//
// ── 版本史 ───────────────────────────────────────────────────────────────────
// v3（2026-09-11）：清单口径改走**外壳同一纯函数** `shell-app/safe-overlay.cjs`
//   （L3 产品层 + L4 profile 覆盖层）。
// v2（2026-09-05）：静态清单 → 动态解析 cordis.patch.yml，但**只读 L3**
//   （packages/dshome/cordis.patch.yml）→ L4 后加的 `dsh-imagegen` / Agent Teams
//   三个实验包不在禁用范围（2026-09-11 实测：崩的 `#agent-teams` 恰是 L4 行）
//   → 逃生通道对同类崩因兜不住。与外壳 main.cjs v3 修的是同一个病、两种实现，
//   现由 safe-overlay.cjs 统一口径，并加 `--print-ids` + `verify-safe-overlay.mjs`
//   D 段断言锁死（CLI 清单必须恒等于外壳清单）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const argv = process.argv;
/** 取 `--flag <value>`；下一个参数缺失或又是旗标时回退默认值。 */
function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const port = argOf('--port', '3099');
const profile = argOf('--profile', 'dshome');
const printIds = argv.includes('--print-ids');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const safeOverlay = require(join(here, '..', 'shell-app', 'safe-overlay.cjs'));

// 与外壳 buildSafeOverlay() 同参同口径：
//   instDir = 仓库根 → L3 `packages/dshome/cordis.patch.yml`
//   dshHome + profile → L4 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
//   （dshHome 缺省时纯函数自 shellDir 上溯找 profiles，安装版/异机 DSH_HOME 也能兜住）
const { ids, sources } = safeOverlay.collectSafeIds({
  shellDir: here,
  instDir: repoRoot,
  dshHome: process.env.DSH_HOME || null,
  profile,
});

if (!ids.length) {
  console.error('[safe] 未从任何 patch 层解析到自有插件 id——请检查',
    join(repoRoot, 'packages', 'dshome', 'cordis.patch.yml'), '与',
    join(process.env.DSH_HOME || repoRoot, 'profiles', profile, 'cordis.patch.yml'));
  process.exit(1);
}

const overlayText = safeOverlay.overlayText(ids);

if (printIds) {
  console.log(JSON.stringify({
    profile,
    ids,
    sources: sources.map((s) => s.file),
    overlay: overlayText,
  }));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'dshome-safe-'));
const overlay = join(dir, 'safe.yml');
writeFileSync(overlay, overlayText, 'utf8');
console.log(`[safe] 动态解析到 ${ids.length} 个自有插件（来源 ${sources.length} 层）: ${ids.join(', ')}`);

// 用当前 node + 仓库内 dsh bin.js 直跑，不依赖 PATH 里的 dsh 命令。
const dshBin = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(dshBin)) {
  console.error('[safe] 找不到 dsh 入口:', dshBin, '——先在仓库根跑 pnpm install');
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

// 🔴 `--patch` 必须在 app 参数（--no-open/--port）之前，否则 dsh 判 unknown option。
const child = spawn(process.execPath, [dshBin, '--profile', profile, '--patch', overlay, '--no-open', '--port', port], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
