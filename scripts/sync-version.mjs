#!/usr/bin/env node
// DSHOME 版本单源同步（sync-version）
// 以 packages/dshome/package.json 的 version 为唯一真源，把它传播到 4 个消费者：
//   ① 壳应用 shell-app（Electron app.getVersion() 读它 → 更新器据此判断；漏更 = 本 bug）
//   ② dshome-theme 侧栏徽章 DSHOME_VERSION
//   ③ updates.json（version + 依版式重写 url；sha256 是构建产物，不动）
//   ④ build-stage/DSHOME.iss（MyAppVersion + 头注释输出名）
// 用法：
//   node scripts/sync-version.mjs           # 读单源，只同步消费者（修漂移）
//   node scripts/sync-version.mjs 0.4.0     # 先 bump 单源，再同步消费者（发版）
import { readCanonical, setCanonical, CONSUMERS, syncAll, repoRoot } from './version-lib.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const arg = process.argv[2];
let canonical;

if (arg) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error(`[sync-version] 版本格式应为 x.y.z，收到 "${arg}"`);
    process.exit(1);
  }
  setCanonical(arg);
  canonical = arg;
  console.log(`[sync-version] 单源已 bump: packages/dshome/package.json version = ${canonical}`);
} else {
  canonical = readCanonical();
  console.log(`[sync-version] 单源当前版本: ${canonical}`);
}

const changed = syncAll(canonical);
if (changed.length === 0) {
  console.log('[sync-version] 全部消费者已与单源一致，无需改动。');
} else {
  for (const c of changed) {
    console.log(`[sync-version] ${c.name}: ${c.from} -> ${c.to}`);
  }
  console.log(`[sync-version] 已同步 ${changed.length} 处。`);
}

// 终检：确认无残余漂移
let ok = true;
for (const c of CONSUMERS) {
  const full = join(repoRoot, c.file);
  if (!existsSync(full)) continue;
  const cur = c.read(readFileSync(full, 'utf8'));
  if (cur !== canonical) {
    ok = false;
    console.error(`[sync-version] 仍漂移: ${c.name}=${cur} != 单源=${canonical}`);
  }
}
console.log(ok ? '[sync-version] 终检一致。' : '[sync-version] 终检仍有漂移！');
process.exit(ok ? 0 : 1);
