#!/usr/bin/env node
// scripts/shot.mjs — 视觉类交付的渲染自检（一条命令替代手工 6 步）
//
// 为什么（2026-09-16 鹈鹕测试的实伤）：视觉产物（HTML/SVG/动画）写完**必须真看渲染结果**——
//   当次靠手工跑 `chrome --headless=new --screenshot` 多帧 + `read_image` 自看 + 改 `viewBox` 当放大镜，
//   挖出两处桩测试抓不到的错（"橙色叶子"脚吞掉脚蹬 · 远脚被画在车架之下）。
//   手工 6 条命令的形态不稳（换个人/隔一天就忘），故工具化成**一条命令**。
//
// 用法（argless 只打用法并 exit 2 ⇒ 可安全挂 `verify-scripts-run` 白名单：usage 退出不算失败）：
//   node scripts/shot.mjs <file.html | http(s)://…> [选项]
//     --at <ms>          虚拟时间推进到 ms 后截图（动画定格；默认 0）
//     --frames <n>       取 n 帧（在 0…--span 间均分；默认 1）
//     --span <ms>        n 帧的总时长（默认 max(--at, 1500)）
//     --width <px>       视口宽（默认 1280）
//     --height <px>      视口高（默认 800）
//     --zoom x y w h     局部放大镜：把 (x,y,w,h) 这块按倍数铺满视口（比整图缩略图更容易看出对位错）
//     --out <png|dir>    输出（.png=单帧；目录=多帧落该目录；默认 %TEMP%\dshome-shot\）
//     --keep-html        保留 --zoom 生成的临时包裹页，便于自查（默认自动删）
//     --browser <exe>    指定浏览器（默认：env DSHOME_SHOT_BROWSER → Chrome → Edge → PATH）
//
// 输出：打印每个 PNG 的**绝对路径 + 字节数**，供随后 `read_image` 自看（验收标准＝"我真的看了渲染结果"）。
// 约束：不写仓库任何文件；只写 --out 指定处 +（--zoom 时）目标同目录的临时包裹页（默认自动删）。
//       本文件**不得出现本机盘符/仓库绝对路径**（2026-09-11 教训：硬编码被推送即 MODULE_NOT_FOUND）。
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
function parseArgs(list) {
  const o = { target: null, at: 0, frames: 1, span: null, width: 1280, height: 800, zoom: null, out: null, keepHtml: false, browser: null };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--at') o.at = num(list[++i], 0);
    else if (a === '--frames') o.frames = Math.max(1, num(list[++i], 1));
    else if (a === '--span') o.span = num(list[++i], null);
    else if (a === '--width') o.width = num(list[++i], 1280);
    else if (a === '--height') o.height = num(list[++i], 800);
    else if (a === '--zoom') o.zoom = [num(list[++i], 0), num(list[++i], 0), num(list[++i], 0), num(list[++i], 0)];
    else if (a === '--out') o.out = list[++i];
    else if (a === '--keep-html') o.keepHtml = true;
    else if (a === '--browser') o.browser = list[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!o.target) o.target = a;
    else { console.error(`[shot] 未知参数: ${a}`); process.exit(2); }
  }
  return o;
}
function usage() {
  console.log('用法: node scripts/shot.mjs <file.html|url> [--at ms] [--frames n] [--span ms] [--width px] [--height px]');
  console.log('                              [--zoom x y w h] [--out <png|dir>] [--keep-html] [--browser <exe>]');
}
const o = parseArgs(argv);
if (o.help || !o.target) { usage(); process.exit(o.help ? 0 : 2); }

/** 浏览器发现：显式 > env > 常见安装位 > PATH。找不到就**响亮失败**（不静默跳过）。 */
function findBrowser() {
  const cands = [];
  if (o.browser) cands.push(o.browser);
  if (process.env.DSHOME_SHOT_BROWSER) cands.push(process.env.DSHOME_SHOT_BROWSER);
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  cands.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  cands.push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const p of (process.env.PATH || '').split(';').filter(Boolean)) {
    cands.push(join(p, 'chrome.exe'), join(p, 'msedge.exe'));
  }
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* 忽略非法路径 */ } }
  return null;
}

const browser = findBrowser();
if (!browser) {
  console.error('[shot] ❌ 找不到无头浏览器（试过：DSHOME_SHOT_BROWSER / ProgramFiles 下 Chrome·Edge / PATH）');
  console.error('[shot]    可用 --browser <exe> 或设 DSHOME_SHOT_BROWSER 指定');
  process.exit(1);
}

// 目标 URL：本地文件 → file:// 绝对 URL（相对资源因此正常解析）；http(s) 原样。
const isUrl = /^https?:\/\//i.test(o.target);
const absTarget = isUrl ? o.target : resolve(o.target);
if (!isUrl && !existsSync(absTarget)) {
  console.error(`[shot] ❌ 目标不存在: ${absTarget}`);
  process.exit(1);
}
const targetUrl = isUrl ? absTarget : pathToFileURL(absTarget).href;

// 输出落点
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = (isUrl ? 'url' : basename(absTarget, extname(absTarget))) || 'shot';
let outDir = null;
let singlePng = null;
if (o.out && /\.png$/i.test(o.out)) singlePng = resolve(o.out);
else {
  outDir = o.out ? resolve(o.out) : join(tmpdir(), 'dshome-shot');
  mkdirSync(outDir, { recursive: true });
}

/** --zoom：写一个包裹页（放在**目标同目录**，保证相对资源解析），用 transform 把区域放大铺满视口。 */
function zoomWrapper() {
  const [x, y, w, h] = o.zoom;
  if (!(w > 0 && h > 0)) { console.error('[shot] ❌ --zoom 需要 x y w h（w/h > 0）'); process.exit(2); }
  const scale = Math.min(o.width / w, o.height / h);
  const dir = isUrl ? tmpdir() : dirname(absTarget);
  const file = join(dir, `.dshome-shot-zoom-${stamp}.html`);
  const src = targetUrl;
  const html = `<!doctype html><meta charset="utf-8"><title>dshome-shot zoom</title>
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}
iframe{border:0;width:${o.width}px;height:${o.height}px;transform-origin:0 0;transform:scale(${scale}) translate(${-x}px,${-y}px)}</style>
<iframe src="${src}" width="${o.width}" height="${o.height}" scrolling="no"></iframe>`;
  writeFileSync(file, html, 'utf8');
  return file;
}

let wrapped = null;
let shotUrl = targetUrl;
if (o.zoom) { wrapped = zoomWrapper(); shotUrl = pathToFileURL(wrapped).href; }

const span = o.span ?? Math.max(o.at, 1500);
const frames = o.frames <= 1 ? [o.at] : Array.from({ length: o.frames }, (_, i) => Math.round((span * i) / (o.frames - 1)));
const written = [];
let failed = false;
try {
  frames.forEach((at, i) => {
    const out = singlePng ?? join(outDir, `${base}-f${i}-at${at}-${stamp}.png`);
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--window-size=${o.width},${o.height}`,
    ];
    // ⚠️ `--at 0` **不能**传 `--virtual-time-budget=0`：实测 Chrome 会一直挂着等虚拟时间推进 ⇒ spawnSync 超时（status=null）。
    //    0 的语义＝"加载完就拍"，那就干脆不传这个参数。
    if (at > 0) args.push(`--virtual-time-budget=${at}`);
    args.push(`--screenshot=${out}`, shotUrl);
    const r = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000 });
    const ok = existsSync(out) && statSync(out).size > 0;
    if (!ok) {
      failed = true;
      const hint = r.status === null ? '（进程未正常退出＝超时被杀；若 --at 很小请确认已跳过 virtual-time-budget）' : '';
      console.error(`[shot] ❌ 第 ${i + 1} 帧未产出（at=${at}ms）exit=${r.status}${hint}${r.stderr ? ' stderr=' + String(r.stderr).slice(0, 200) : ''}`);
    } else {
      written.push({ at, out, bytes: statSync(out).size });
    }
  });
} finally {
  if (wrapped && !o.keepHtml) { try { rmSync(wrapped, { force: true }); } catch { /* 清理失败不掩盖主结论 */ } }
}

console.log(`[shot] 浏览器: ${browser}`);
console.log(`[shot] 目标: ${targetUrl}${o.zoom ? `  （--zoom ${o.zoom.join(' ')}；包裹页${o.keepHtml && wrapped ? '保留: ' + wrapped : '已删'}）` : ''}`);
console.log(`[shot] 视口 ${o.width}×${o.height} · ${written.length}/${frames.length} 帧产出`);
for (const w of written) console.log(`  ✅ at=${String(w.at).padStart(4)}ms  ${w.out}  (${w.bytes} B)`);
if (written.length) console.log('[shot] 下一步：用 read_image 自看上面的 PNG（视觉交付的验收标准＝我真的看了渲染结果）');
process.exit(failed || written.length === 0 ? 1 : 0);
