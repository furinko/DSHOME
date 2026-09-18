#!/usr/bin/env node
// scripts/patch-web-assets.mjs — 关掉 Web 前端「单个 ~ 即删除线」的行为（remark-gfm singleTilde）。
//
// 为什么：DSH Web 界面把消息正文里的单个 `~` 当删除线定界符（GitHub 只认 `~~`），
//   `中文常见是英文的 1.3~2 倍` 会被渲染成 `1.32 倍`、并把配对区间整段划掉。
//   该选项在预构建的前端 bundle 里被 minifier 常量折叠成恒真
//   （`let n={}.singleTilde; … return n==null&&(n=!0)`，形参被丢弃）→ 没有运行时配置入口，只能改产物。
//
// 靶标（文件名带内容哈希、随上游升级变化，因此按内容匹配而非写死路径）：
//   <root>/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-*.js
// 改动：把 strikethrough 扩展的默认值 `(<v>=!0)` → `(<v>=!1)` —— 等长替换，语法零风险。
// 语义：单个 `~` 不再成对；`~~双波浪线~~` 的删除线照旧可用。
//
// 用法：
//   node scripts/patch-web-assets.mjs                 # 默认：仓库 dev 树 + build-stage/payload（存在的才处理）
//   node scripts/patch-web-assets.mjs --verify-only   # 只检测不改写；有未打补丁的目标 → exit 1
//   node scripts/patch-web-assets.mjs --root <dir>    # 指定根目录（可重复；默认见上）
//   node scripts/patch-web-assets.mjs --allow-missing # 找不到靶标时不判失败（上游可能已换实现）
//
// 留痕：mind-private/backup/web-assets/PATCH-NOTES.md
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const argv = process.argv.slice(2);
let verifyOnly = false;
let allowMissing = false;
const roots = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--verify-only') verifyOnly = true;
  else if (a === '--allow-missing') allowMissing = true;
  else if (a === '--root') {
    const v = argv[++i];
    if (!v) { console.error('[patch-web] --root 缺少值'); process.exit(2); }
    roots.push(resolve(v));
  } else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/patch-web-assets.mjs [--verify-only] [--allow-missing] [--root <dir>]...');
    process.exit(0);
  } else {
    console.error(`[patch-web] 未知参数: ${a}`);
    process.exit(2);
  }
}
if (roots.length === 0) {
  roots.push(repoRoot);
  roots.push(join(repoRoot, 'build-stage', 'payload'));
}

// 压缩形态锚点：`let <v>={}.singleTilde;const <ext>={name:"strikethrough"…};return <v>==null&&(<v>=!0|!1)`
// 组：1=前缀（含 `(<v>=`）2=singleTilde 变量名（用于反向引用）3=值（!0 / !1）4=右括号
const TARGET_RE = /(let\s+([A-Za-z_$][\w$]*)=\{\}\.singleTilde;const\s+[A-Za-z_$][\w$]*=\{name:"strikethrough"[^{}]*\}[;,]\s*return\s+\2==null&&\(\2=)(!0|!1)(\))/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (buf) => sha256(buf).slice(0, 12);

function vendorFiles(root) {
  const assets = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
  if (!existsSync(assets)) return { assets, files: [] };
  const files = readdirSync(assets)
    .filter((n) => /^vendor-.*\.js$/.test(n))
    .map((n) => join(assets, n));
  return { assets, files };
}

let failed = false;
let patched = 0;
let already = 0;

for (const root of roots) {
  const { assets, files } = vendorFiles(root);
  if (!existsSync(assets)) {
    console.log(`[patch-web] 跳过（无前端产物）: ${assets}`);
    continue;
  }
  if (files.length === 0) {
    console.log(`[patch-web] 跳过（assets 内无 vendor-*.js）: ${assets}`);
    continue;
  }
  console.log(`[patch-web] root: ${root}`);
  for (const file of files) {
    const rel = file.slice(root.length + 1).replace(/\\/g, '/');
    const before = readFileSync(file);
    const text = before.toString('utf8');
    const m = TARGET_RE.exec(text);
    if (!m) {
      if (text.includes('.singleTilde')) {
        console.error(`[patch-web] 靶标形态变了（需人工确认）: ${rel}`);
        failed = true;
      } else if (allowMissing) {
        console.warn(`[patch-web] 未找到 strikethrough 靶标（上游已改实现？）: ${rel}`);
      } else {
        console.error(`[patch-web] 未找到 strikethrough 靶标: ${rel}（上游实现变了；确认无碍可加 --allow-missing）`);
        failed = true;
      }
      continue;
    }
    if (m[3] === '!1') {
      console.log(`[patch-web] 已打补丁 ✓ ${rel}  sha=${short(before)}`);
      already += 1;
      continue;
    }
    if (verifyOnly) {
      console.error(`[patch-web] 未打补丁 ✗ ${rel}（singleTilde 默认 true → 单个 ~ 会被渲染成删除线）`);
      failed = true;
      continue;
    }
    const next = text.replace(TARGET_RE, '$1!1$4');
    if (next.length !== text.length) {
      console.error(`[patch-web] 替换长度异常，放弃: ${rel}`);
      failed = true;
      continue;
    }
    // 先 unlink 再写：pnpm 用硬链接把 store 文件接到 node_modules（payload 往往共享同一 inode），
    // 就地覆盖会穿透改写 .pnpm-store 的内容寻址条目；断链后写 = 只影响本目标，store 保持原样。
    try {
      rmSync(file, { force: true });
      writeFileSync(file, next);
    } catch (e) {
      try { writeFileSync(file, before); } catch { /* 留给 pnpm install 重建 */ }
      console.error(`[patch-web] 写入失败（已尽力回滚）: ${rel} — ${e.message}`);
      failed = true;
      continue;
    }
    const after = readFileSync(file);
    const recheck = TARGET_RE.exec(after.toString('utf8'));
    if (!recheck || recheck[3] !== '!1' || after.length !== before.length || recheck[1] !== m[1]) {
      console.error(`[patch-web] 写入后复核失败: ${rel}`);
      failed = true;
      continue;
    }
    console.log(`[patch-web] PATCH ✓ ${rel}`);
    console.log(`[patch-web]   sha ${short(before)} → ${short(after)}  (${after.length} bytes, 等长替换)`);
    patched += 1;
  }
}

// ── 补丁二：给自定义权限档位「mind-guard」补图标（2026-09-18 加）────────────────────────
// 为什么：上游 `dsh-client-ui-conversation` 的会话区权限选择器里，档位图标是一张**闭集映射**
//   `permissionGlyphs`（只 `read-only` / `workspace-write` / `danger-full-access`），且上游注释明写
//   「Glyph for a permission option value; host-configured names outside the design set get none.」
//   ⇒ 方案④「拆档」新增的 `mind-guard` 档位在 composer 权限下拉里**没有图标**（主人 2026-09-18 报）。
// 画法：沿用同一套笔画语言（16×16 / `fill:none` / 盾牌轮廓复用同文件 `shieldOutline` 常量 1.31831 描边）
//   内芯＝**锁**（锁梁描边 + 锁体填充）——语义＝「受闸 / 需放行」；现有三档内芯分别是「勾」「笔」「感叹号」。
// 靶标（按内容匹配，不写死行号/哈希）：`const permissionGlyphs = new Map([`（该常量紧跟在 `shieldOutline` 之后，
//   故插入项可安全引用它）。安装后 `pnpm install` 会还原上游文件 ⇒ 由 `stage-payload` 每次重新打（见其 L225）。
const GLYPH_ANCHOR = 'const permissionGlyphs = new Map([';
const GLYPH_ENTRY = `\n\t\t\t["mind-guard", (0, react_jsx_runtime.jsxs)("svg", {`
  + `\n\t\t\t\twidth: "16",`
  + `\n\t\t\t\theight: "16",`
  + `\n\t\t\t\tviewBox: "0 0 16 16",`
  + `\n\t\t\t\tfill: "none",`
  + `\n\t\t\t\t"aria-hidden": true,`
  + `\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("path", {`
  + `\n\t\t\t\t\td: shieldOutline,`
  + `\n\t\t\t\t\tstroke: "currentColor",`
  + `\n\t\t\t\t\tstrokeWidth: "1.31831",`
  + `\n\t\t\t\t\tstrokeLinejoin: "round"`
  + `\n\t\t\t\t}), (0, react_jsx_runtime.jsx)("path", {`
  + `\n\t\t\t\t\td: "M6.95 9.35V7.85C6.95 6.85 7.62 6.2 8.4 6.2C9.18 6.2 9.85 6.85 9.85 7.85V9.35",`
  + `\n\t\t\t\t\tstroke: "currentColor",`
  + `\n\t\t\t\t\tstrokeWidth: "1.2",`
  + `\n\t\t\t\t\tstrokeLinecap: "round"`
  + `\n\t\t\t\t}), (0, react_jsx_runtime.jsx)("path", {`
  + `\n\t\t\t\t\td: "M5.95 9.15H10.85V13H5.95V9.15Z",`
  + `\n\t\t\t\t\tfill: "currentColor"`
  + `\n\t\t\t\t})]`
  + `\n\t\t\t})],`;

function conversationClientFile(root) {
  const f = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js');
  return existsSync(f) ? f : null;
}

for (const root of roots) {
  const file = conversationClientFile(root);
  if (file === null) {
    console.log(`[patch-web] 跳过（未装 dsh-client-ui-conversation）: ${root}`);
    continue;
  }
  const rel = file.slice(root.length + 1).replace(/\\/g, '/');
  const before = readFileSync(file);
  const text = before.toString('utf8');
  if (text.includes('["mind-guard"')) {
    console.log(`[patch-web] 已打补丁 ✓ ${rel}  sha=${short(before)}`);
    already += 1;
    continue;
  }
  const at = text.indexOf(GLYPH_ANCHOR);
  if (at < 0) {
    console.error(`[patch-web] 未找到权限图标靶标（上游实现变了）: ${rel}`);
    failed = true;
    continue;
  }
  if (text.indexOf(GLYPH_ANCHOR, at + 1) >= 0) {
    console.error(`[patch-web] 靶标出现多次，无法安全定位: ${rel}`);
    failed = true;
    continue;
  }
  if (!text.includes('const shieldOutline = "M8.20554 0.899994')) {
    console.error(`[patch-web] 盾牌轮廓常量形态变了（插入项会引用它）: ${rel}`);
    failed = true;
    continue;
  }
  if (verifyOnly) {
    console.error(`[patch-web] 未打补丁 ✗ ${rel}（mind-guard 档位在权限下拉里会没有图标）`);
    failed = true;
    continue;
  }
  const insertAt = at + GLYPH_ANCHOR.length;
  const next = text.slice(0, insertAt) + GLYPH_ENTRY + text.slice(insertAt);
  try {
    rmSync(file, { force: true }); // 同补丁一：先断 pnpm store 硬链接，再写
    writeFileSync(file, next);
  } catch (e) {
    try { writeFileSync(file, before); } catch { /* 留给 pnpm install 重建 */ }
    console.error(`[patch-web] 写入失败（已尽力回滚）: ${rel} — ${e.message}`);
    failed = true;
    continue;
  }
  const after = readFileSync(file).toString('utf8');
  // 复核：条目在锚点之后、只多一处、且原有三档仍在（不许动别人）
  const ok = after.includes(GLYPH_ENTRY)
    && after.indexOf('["mind-guard"') > at
    && after.includes('["read-only"') && after.includes('["workspace-write"') && after.includes('[FULL_ACCESS,');
  if (!ok) {
    console.error(`[patch-web] 写入后复核失败: ${rel}`);
    failed = true;
    continue;
  }
  console.log(`[patch-web] PATCH ✓ ${rel}`);
  console.log(`[patch-web]   sha ${short(before)} → ${short(readFileSync(file))}  (+${GLYPH_ENTRY.length} bytes, 纯插入)`);
  patched += 1;
}

console.log(`[patch-web] 完成：patched=${patched} already=${already}${verifyOnly ? '（verify-only，未写入）' : ''}`);
process.exit(failed ? 1 : 0);