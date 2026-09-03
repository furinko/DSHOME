// scripts/verify-boot-recall.mjs — 心智生长哲学底座·组件B 验证器（重启宿主后跑一次即可确认）
// 用途：宿主重启并加载新版 dshome-mind 后，确认开机硬注入 hook 是否：
//   ① 已注册（bootRecall.registered=true）
//   ② 已被主会话触发且成功注入（有 agent state=ok / injected=true）
//   ③ 未误伤（skip=防 cron 双份 / skip-child=子代理 / empty=空库优雅降级 均为预期分支）
// 用法：
//   node scripts/verify-boot-recall.mjs [--port 3099] [--expect-agent <agentId>]
// 退出码：0 = hook 已注册（符合组件B落地状态）；1 = 未注册或探测失败。
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3099;
const expectAgent = process.argv.indexOf('--expect-agent') >= 0 ? process.argv[process.argv.indexOf('--expect-agent') + 1] : '';

async function main() {
  const url = `http://127.0.0.1:${port}/api/mind/status`;
  const res = await fetch(url, {
    headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const br = body && body.bootRecall;
  console.log(`[verify-boot-recall] /api/mind/status ok=${body && body.ok}`);
  if (!br) {
    console.log('[verify-boot-recall] ❌ bootRecall 字段缺失 —— 宿主仍在跑旧版 dshome-mind，请重启 DSHOME 后再跑本脚本');
    process.exit(1);
  }
  console.log(`[verify-boot-recall] bootRecall.registered = ${br.registered}`);
  console.log(`[verify-boot-recall] 已观测 agent 数 = ${br.agents ?? 0}`);
  if (br.hookError) console.log(`[verify-boot-recall] hookError = ${br.hookError}`);
  if (br.lastInject) console.log(`[verify-boot-recall] lastInject = ${br.lastInject.agentId} @ ${br.lastInject.at}`);
  if (expectAgent) {
    // --expect-agent <id>：等目标会话触发后再确认该 agent 状态
    console.log(`[verify-boot-recall] 期望 agent ${expectAgent} 已注入 — 请先开新会话并发言一轮，再重跑本脚本带本参数`);
    if (br.lastInject && br.lastInject.agentId === expectAgent) {
      console.log('[verify-boot-recall] ✅ 目标 agent 成功注入');
      process.exit(0);
    }
    console.log('[verify-boot-recall] ⏳ 目标 agent 尚未注入（可能尚未触发 pre-step，或走了 skip/skip-child 分支）');
    process.exit(2);
  }
  if (br.registered === true) {
    console.log('[verify-boot-recall] ✅ hook 已注册 —— 组件B 已生效（新会话首轮应出现【上工自动召回】块）');
    process.exit(0);
  }
  console.log('[verify-boot-recall] ❌ hook 未注册，请查宿主日志（dshome-mind boot recall hook disabled）');
  process.exit(1);
}

main().catch((e) => {
  console.log('[verify-boot-recall] ❌ 探测失败:', e.message);
  process.exit(1);
});
