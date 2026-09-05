// DSHOME 版本单源（version-lib）
// 发版版本号唯一真源 = packages/dshome/package.json 的 version。
// 4 个消费者承载同一发版号，必须与单源一致（历史漏更两类：v0.1.0 徽章、v0.2.0 壳应用 app.getVersion）。
// 被 scripts/sync-version.mjs（同步）与 scripts/verify-payload.mjs（打包门禁）复用。
//
// 注意：不强制同步的子包独立 version（dshome-assistant-identity / mind / palette /
// plugin-center / dshome-theme 的 package.json）是各自 npm 包的 semver，非发版号，
// 切勿列入 CONSUMERS——它们与 DSHOME 发版号本就允许不同。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');

// 单源：主包
export const CANONICAL_FILE = 'packages/dshome/package.json';

export function canonicalFile() {
  return join(repoRoot, CANONICAL_FILE);
}

export function readCanonical() {
  return JSON.parse(readFileSync(canonicalFile(), 'utf8')).version;
}

export function setCanonical(version) {
  const file = canonicalFile();
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  obj.version = version;
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// 消费者定义：read(text) → 归一化版本（不含前导 v），读不到返回 null；
// write(text, canonical) → 返回替换后的新文本。
// 只放承载「DSHOME 发版号」的位置，不放子包独立 semver。
export const CONSUMERS = [
  {
    name: '壳应用 app.getVersion (shell-app)',
    file: 'packages/dshome/shell-app/package.json',
    read(t) {
      const m = /"version"\s*:\s*"([0-9.]+)"/.exec(t);
      return m ? m[1] : null;
    },
    write(t, v) {
      return t.replace(/("version"\s*:\s*")[0-9.]+(")/, `$1${v}$2`);
    },
  },
  {
    name: '侧栏版本徽章 (dshome-theme)',
    file: 'packages/dshome-theme/lib/client.js',
    read(t) {
      const m = /const DSHOME_VERSION = "v?([0-9.]+)"/.exec(t);
      return m ? m[1] : null;
    },
    write(t, v) {
      return t.replace(/(const DSHOME_VERSION = ")v?[0-9.]+(")/, `$1v${v}$2`);
    },
  },
  {
    name: 'updates.json',
    file: 'updates.json',
    read(t) {
      const m = /"version"\s*:\s*"([0-9.]+)"/.exec(t);
      return m ? m[1] : null;
    },
    write(t, v) {
      let obj;
      try { obj = JSON.parse(t); } catch { return t; }
      obj.version = v;
      // url 依版式重写（sha256 是构建产物校验和，保留不动）
      obj.url = `https://github.com/furinko/DSHOME/releases/download/v${v}/DSHOME-setup-${v}.exe`;
      const nl = t.endsWith('\n') ? '\n' : '';
      return JSON.stringify(obj, null, 2) + nl;
    },
  },
  {
    name: '安装脚本 (DSHOME.iss)',
    file: 'build-stage/DSHOME.iss',
    read(t) {
      const m = /#define MyAppVersion "([0-9.]+)"/.exec(t);
      return m ? m[1] : null;
    },
    write(t, v) {
      let out = t.replace(/(#define MyAppVersion ")[0-9.]+(")/, `$1${v}$2`);
      out = out.replace(/DSHOME-setup-[0-9.]+\.exe/, `DSHOME-setup-${v}.exe`);
      return out;
    },
  },
];

// 读取所有消费者 → [{name, file, actual, missing}]
export function readAll() {
  return CONSUMERS.map((c) => {
    const full = join(repoRoot, c.file);
    if (!existsSync(full)) return { name: c.name, file: c.file, actual: null, missing: true };
    return { name: c.name, file: c.file, actual: c.read(readFileSync(full, 'utf8')), missing: false };
  });
}

// 把 canonical 写进所有消费者，返回改动列表 [{name, file, from, to}]
export function syncAll(canonical) {
  const changed = [];
  for (const c of CONSUMERS) {
    const full = join(repoRoot, c.file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    const cur = c.read(text);
    if (cur === canonical) continue;
    writeFileSync(full, c.write(text, canonical), 'utf8');
    changed.push({ name: c.name, file: c.file, from: cur, to: canonical });
  }
  return changed;
}
