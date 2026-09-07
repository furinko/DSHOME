#!/usr/bin/env node
// 源码内容 → build-stage/payload 的增量同步（只覆盖、不删除、保留大目录）。
// 用途：发版重排 payload 时，把源根的内容文件（packages/mind/scripts/docs/… 及根文件）
// 同步进 payload，避免陈旧快照漏掉本轮源码改动。只处理"内容"文件。
//
// ⚠️ 排异纪律（漏一个就可能把用户私有数据打进安装包）：
//   - 保留不镜像：node_modules / runtime / .git / build-stage / mind-private（保留原有）
//   - 用户运行时数据：sessions / storages / attachments / .agent-snapshot / .dsh-market / .credentials.yaml /
//     settings.yaml / .anonymous-user-id / .dshw-*.json  —— 一律不外发
//   - junction 跳过（profiles\node_modules 自愈目录等）
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, cpSync, lstatSync, readlinkSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..');
const dst = join(src, 'build-stage', 'payload');

// 按路径段名排除的目录（任意深度命中即跳过）
const EXCLUDE_DIR_SEG = new Set([
  'node_modules', 'runtime', '.git', 'build-stage', 'mind-private',
  'sessions', 'storages', 'attachments', '.agent-snapshot', '.dsh-market',
]);
// 按文件名排除
const EXCLUDE_FILE = new Set([
  '.credentials.yaml', 'settings.yaml', '.anonymous-user-id', '.dshw-size.json', '.dshw-usage.json',
]);

function isExcludedDir(rel) {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  return segs.some((s) => EXCLUDE_DIR_SEG.has(s));
}
function isExcludedFile(name) {
  return EXCLUDE_FILE.has(name);
}

let copied = 0;
const changed = [];
function normPath(p) { return p.replace(/[\\/]+/g, '/'); }

function syncFile(relPath) {
  const s = join(src, relPath);
  const d = join(dst, relPath);
  try {
    const sb = readFileSync(s);
    let same = false;
    if (existsSync(d)) {
      try { same = readFileSync(d).equals(sb); } catch { same = false; }
    }
    if (!same) {
      mkdirSync(dirname(d), { recursive: true });
      writeFileSync(d, sb);
      copied += 1;
      changed.push('COPY ' + normPath(relPath));
    }
  } catch (e) {
    console.error('[stage] copy fail ' + relPath + ': ' + e.message);
  }
}

function walk(dirRel) {
  let entries;
  try { entries = readdirSync(join(src, dirRel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = dirRel ? dirRel + '\\' + e.name : e.name;
    if (isExcludedDir(rel)) continue;
    if (isExcludedFile(e.name)) continue;
    const sp = join(src, rel);
    if (e.isSymbolicLink()) continue; // junction：保留原样
    const st = statSync(sp);
    if (st.isDirectory()) walk(rel);
    else if (st.isFile()) syncFile(rel);
  }
}

function rootFiles() {
  let entries;
  try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = e.name;
    if (isExcludedDir(rel)) continue;
    if (isExcludedFile(e.name)) continue;
    if (e.isSymbolicLink()) continue;
    const st = statSync(join(src, rel));
    if (st.isFile()) syncFile(rel);
    else if (st.isDirectory()) walk(rel);
  }
}

// 预检由上方 EXCLUDE_* 排除逻辑保证；不做全树冗余扫描。

rootFiles();

// 同步 node_modules 缺失的 profile bundle（此前 EXCLUDE_DIR_SEG 排除 node_modules，导致新加入
// profile 的社区插件 / workspace 主包没进 payload → 后端启动崩。只增缺失、不动已 build 的原生模块，
// 符号链接解引用）。以 profiles/dshome/package.json 的 dependencies + profile.bundles 为同步目标。
function syncNodeModulesBundles() {
  const profilePkgPath = join(src, 'profiles', 'dshome', 'package.json');
  if (!existsSync(profilePkgPath)) return 0;
  const pp = JSON.parse(readFileSync(profilePkgPath, 'utf8'));
  const targets = new Set();
  for (const key of Object.keys(pp.dependencies || {})) targets.add(key);
  for (const b of pp.dsh?.profile?.bundles || []) targets.add(b);
  const srcNM = join(src, 'node_modules');
  const dstNM = join(dst, 'node_modules');
  let synced = 0;
  for (const name of targets) {
    const s = join(srcNM, name);
    const d = join(dstNM, name);
    if (existsSync(d)) continue;      // payload 已有 → 跳过（不动已 build 原生模块）
    if (!existsSync(s)) continue;     // 源也没有 → 跳过
    const st = lstatSync(s);
    if (st.isSymbolicLink()) {
      // workspace 主包（源是软链）→ payload 建 junction 指向 payload 的 packages/<name>
      const px = join(dst, 'packages', name);
      if (existsSync(px)) {
        try {
          symlinkSync(px, d, 'junction');
          synced += 1;
          changed.push('LINK ' + normPath(join('node_modules', name)));
        } catch (e) {
          console.error('[stage] link fail ' + name + ': ' + e.message);
        }
        continue;
      }
    }
    // 实体包 → 解引用复制整目录（依赖已 hoist 在 payload 顶层，无需递归拷贝节点）
    try {
      cpSync(s, d, { recursive: true });
      synced += 1;
      changed.push('COPY ' + normPath(join('node_modules', name)));
    } catch (e) {
      console.error('[stage] copy fail ' + name + ': ' + e.message);
    }
  }
  return synced;
}
const syncedBundles = syncNodeModulesBundles();
console.log(`[stage] 同步 node_modules 缺失 bundle：${syncedBundles} 个`);

// 同步 profile 内 node_modules 的 workspace 包（dshome / dsh-imagegen 等在 profiles/dshome/node_modules 下是
// junction → packages/<name>；payload 里可能是旧实体（dshome exports 缺 mind-*）或缺（dsh-imagegen）。
// 统一重建为 junction 指向 payload packages/<name>，保证完整 exports / 包体（符号链接解引用进安装树）。
function syncProfileNodeModules() {
  const srcProfileNM = join(src, 'profiles', 'dshome', 'node_modules');
  const dstProfileNM = join(dst, 'profiles', 'dshome', 'node_modules');
  if (!existsSync(srcProfileNM)) return 0;
  let synced = 0;
  for (const e of readdirSync(srcProfileNM, { withFileTypes: true })) {
    const name = e.name;
    const s = join(srcProfileNM, name);
    let st;
    try { st = lstatSync(s); } catch { continue; }
    if (!st.isSymbolicLink()) continue;      // 只处理 workspace 链接
    const srcTarget = readlinkSync(s);       // 源 junction 目标（如 ...\packages\imagegen-plugin）
    const px = join(dst, 'packages', basename(srcTarget));  // payload 对应 packages/<真实目录名>
    if (!existsSync(px)) continue;           // payload 无对应 → 跳过
    const d = join(dstProfileNM, name);
    let need = true;
    if (existsSync(d)) {
      try {
        const dlt = lstatSync(d);
        if (dlt.isSymbolicLink() && resolve(readlinkSync(d)) === resolve(px)) need = false;
        else rmSync(d, { recursive: true, force: true });   // 旧实体/错链接 → 覆盖重建
      } catch { rmSync(d, { recursive: true, force: true }); }
    }
    if (need) {
      mkdirSync(dirname(d), { recursive: true });
      try {
        symlinkSync(px, d, 'junction');
        synced += 1;
        changed.push('LINK-profile ' + normPath(join('profiles', 'dshome', 'node_modules', name)));
      } catch (e) {
        console.error('[stage] profile link fail ' + name + ': ' + e.message);
      }
    }
  }
  return synced;
}
const syncedProfile = syncProfileNodeModules();
console.log(`[stage] 同步 profile 内工作区链接：${syncedProfile} 个`);

// AGENTS.md：源根已无 AGENTS.md（权威版 mind\L0\AGENTS.md），payload 需保留并镜像权威版
const authAgents = join(src, 'mind', 'L0', 'AGENTS.md');
const payloadAgents = join(dst, 'AGENTS.md');
if (existsSync(authAgents) && (!existsSync(payloadAgents) || !readFileSync(payloadAgents).equals(readFileSync(authAgents)))) {
  mkdirSync(dirname(payloadAgents), { recursive: true });
  writeFileSync(payloadAgents, readFileSync(authAgents));
  copied += 1;
  changed.push('COPY AGENTS.md (auth←authority)');
}

console.log(`[stage] 处理完成：copy=${copied} file(s)`);
for (const c of changed) console.log('[stage] ' + c);
