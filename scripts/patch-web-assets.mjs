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

console.log(`[patch-web] 完成：patched=${patched} already=${already}${verifyOnly ? '（verify-only，未写入）' : ''}`);
process.exit(failed ? 1 : 0);
