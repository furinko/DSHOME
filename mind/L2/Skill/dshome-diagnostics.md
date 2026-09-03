---
name: dshome-diagnostics
description: DSHOME 后端崩溃/卡顿诊断——先分真假(exit崩 vs offline闪断)，再 shell log errTail/进程/隔离复现。触发：后端重启/卡顿/exit1/offline闪断。
version: 1.0.0
author: 鱼鱼 (DSHOME)
license: internal
metadata:
  tags: [dshome, 诊断, 崩溃, 卡顿, 重启, errTail]
  related: [packages/dshome/shell-app/main.cjs, mind/L1/Invariants.md, mind/L1/Concepts.md]
contract:
  id: dshome-diagnostics
  triggers: [后端重启, 后端卡, exit1, offline闪断, 频繁重启]
  inputs: [后端异常现象, shell log, 进程状态]
  outputs: [诊断结论(真崩/闪断/卡顿+根因), 处理建议]
  deps: [dshome-shell.log, tasklist]
---

# dshome-diagnostics — DSHOME 后端诊断

> 建立：2026-09-02 | 目标：先分清"真的崩了"还是"状态抖"，别把闪断当重启、别瞎改。

## 一、使用流程（诊断步骤）

```
① 先区分真假：后端"重启"到底是——
   A. 真崩：shell log 有 {"backend":"exit","code":1} → 壳 restart-scheduled 自动重启
   B. 状态抖：shell log 只有 offline→online（1 秒，无 exit）→ 壳探测瞬时失败，不是进程重启
② 看 shell log：`%APPDATA%\dshome-shell\dshome-shell.log`
   - grep "backend.*exit" 看 code（1=崩；新壳带 errTail=崩溃详情）
   - grep "state.*offline" 看闪断频率
③ 看进程：`tasklist //FI "IMAGENAME eq node.exe"` —— 找残留测试后端
   - 端口非 3099 / CPU 累计极高 = 测试残留（吃资源=卡顿元凶）
   - 主后端应只有一个（3099）
④ 真崩但旧壳无 errTail → 用**新壳**（exit 记 stderr 尾部）下次崩抓根因
⑤ 卡顿 → tasklist 找 CPU 高的 node（多为残留测试后端）→ kill 它
⑥ 复现 → **隔离 DSH_HOME** 起测试后端（勿共享主环境）
```

## 二、核心规则

- 🔴 **测试后端勿共享主 DSH_HOME** —— 用隔离目录起测试后端，否则与主后端争 profile/cron/资源 → 主后端不稳（反复起共享测试后端 = 主后端 exit1 诱因之一）
- 🔴 **先分真假再动手** —— 先确认是真崩（exit）还是状态抖（offline 闪断），别把闪断当重启去修
- 🟡 **看证据不猜** —— shell log / 进程 PID / CPU 都是证据；先收集再下结论

## 三、行为准则

- 区分"我该收敛的"（测试活动/起后端干扰）vs"真 bug"（exit 崩根因）
- 诊断时**别频繁起测试后端/高密度跑命令**——那本身会扰乱主后端（offline 闪断）
- 查证据优先，不先假设

## 四、踩坑记录

- 反复起共享主 `DSH_HOME` 的测试后端 → 主后端 exit1（争资源/重复调度）
- offline/online 1 秒闪断 ≠ 重启（误判会往"崩"方向瞎修）
- 旧壳 backend exit 不记 stderr（只看 code）——**新壳才带 errTail**，别靠旧壳定位
- 自己密集测试活动 → 主后端 offline 闪断（该收敛）

## 五、关联索引

**日志：** `%APPDATA%\dshome-shell\dshome-shell.log`
**代码：** `packages\dshome\shell-app\main.cjs`（errTail）
**待办：** `mind-private\Project\`（当前项目档「下一步」区，后端重启排查项）

---
_版本：1.0.0 | 2026-09-02 | 后端诊断固化_
