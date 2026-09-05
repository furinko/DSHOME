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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
