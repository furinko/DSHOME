// scripts/verify-boot-recall.mjs — mind-recall（上工自动召回 host 插件）落地验证器
// 用途：重启 DSHOME 后跑一次，确认 dshome-mind-recall 插件已注册生效：
//   ① mind-recall-marker.txt 存在（插件 apply 时写入 = 已挂载）
//   ② 行为验收交给 mind-boot-recall-itest.mjs（顶层注入/幂等/跳子代理/cron防双份/注入位置）
// 用法：
//   node scripts/verify-boot-recall.mjs
//   退出码：0 = 插件已落地；1 = 未注册（先重启 DSHOME）；2 = 插件源码在但 marker 未更新
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const markerFile = join(repoRoot, 'profiles', 'dshome', '.dsh-market', 'mind-recall-marker.txt');
const pluginFile = join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'mind-recall.js');

async function main() {
  console.log('[verify-boot-recall] 检查 mind-recall 插件落地状态……');
  if (!existsSync(pluginFile)) {
    console.log('[verify-boot-recall] ❌ 插件源码不存在:', pluginFile);
    process.exit(1);
  }
  if (!existsSync(markerFile)) {
    console.log('[verify-boot-recall] ❌ marker 缺失 —— 插件源码在但宿主未加载（旧进程？），请重启 DSHOME 后再跑');
    process.exit(1);
  }
  const marker = readFileSync(markerFile, 'utf8').trim();
  console.log('[verify-boot-recall] ✅ mind-recall 已注册（marker: ' + marker + '）');
  console.log('[verify-boot-recall] 行为验收（顶层注入/幂等/跳子代理/cron防双份/注入位置）请跑:');
  console.log('[verify-boot-recall]   node scripts/mind-boot-recall-itest.mjs');
  console.log('[verify-boot-recall] 新会话首步将自动注入【上工自动召回 · 会话记忆】块（空机优雅降级不注）');
  process.exit(0);
}

main().catch((e) => {
  console.log('[verify-boot-recall] ❌ 探测失败:', e.message);
  process.exit(1);
});
