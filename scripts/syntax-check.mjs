#!/usr/bin/env node
// DSHOME 全仓插件入口语法检查（scripts/syntax-check.mjs）
// 遍历 packages/* 的 main / exports 指向的 JS 入口，逐个执行 node --check。
// 用途：把「全仓插件入口语法健康」变成一条可执行命令（根 package.json 的 build），可接 CI。
// 注意：node --check 只做语法解析，抓不住协议/运行时问题（如 cordis 插件缺 apply、
// client 服务名不存在的版本族不兼容）——那部分由 scripts/smoke.mjs 覆盖。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(here, '..', 'packages');

/** 从 main / exports 收集 JS 入口（跳过 cordis.patch.yml / package.json 等非 JS 目标）。 */
function collectEntries(pkgDir, manifest) {
  const out = [];
  const add = (rel) => {
    if (typeof rel !== 'string') return;
    if (!/\.(?:js|cjs|mjs)$/.test(rel)) return; // 只查 JS 入口
    out.push(join(pkgDir, rel));
  };
  if (typeof manifest.main === 'string') add(manifest.main);
  if (manifest.exports && typeof manifest.exports === 'object') {
    for (const key of Object.keys(manifest.exports)) {
      const v = manifest.exports[key];
      if (typeof v === 'string') add(v);
      else if (v && typeof v === 'object') {
        if (typeof v.require === 'string') add(v.require);
        if (typeof v.default === 'string') add(v.default);
      }
    }
  }
  return out;
}

const all = [];
for (const dir of readdirSync(packagesDir)) {
  const pjPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(pjPath)) continue;
  let manifest;
  try { manifest = JSON.parse(readFileSync(pjPath, 'utf8')); } catch (e) {
    console.error(`syntax-check: ${pjPath} JSON 解析失败: ${e.message}`);
    process.exit(1);
  }
  for (const rel of collectEntries(join(packagesDir, dir), manifest)) all.push(rel);
}

let bad = 0;
for (const file of all) {
  if (!existsSync(file)) {
    console.error(`syntax-check FAIL: 入口文件缺失 ${file}`);
    bad++;
    continue;
  }
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`syntax-check FAIL: ${file}\n${(r.stderr || '').trim()}`);
    bad++;
  } else {
    console.log(`ok  ${file}`);
  }
}

if (bad > 0) {
  console.error(`syntax-check: ${bad} 个文件失败`);
  process.exit(1);
}
console.log(`syntax-check: ${all.length} 个入口文件全部通过`);
