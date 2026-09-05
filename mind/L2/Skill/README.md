# Skill — 方法论技能库（mind\L2\Skill\）

> 版本：1.1 | 2026-09-05
> 定位：L2 能力层——跨项目可复用的逻辑闭环。**双区**：出厂 `mind\L2\Skill\`（可推送）+ 私有暂存 `mind-private\L2\Skill\`（gitignore，同名私有优先）。成熟 skill 出厂，未成熟/含隐私的暂存私有区。

## 使用规则（详见 L1/Power.md）

- Skill = 方法论（跨 2+ 项目验证、有可验证逻辑规则）；Exp = 工具手册（放 mind\L2\Exp\）。
- **触发加载机器化**：host 插件 `dshome-mind-skill-loader` 每步扫对话，命中 frontmatter `contract.triggers` → 注入方法论卡片（摘要，非全文）。触发词改 frontmatter 即改检测。
- 私有 skill（放 mind-private\L2\Skill\）：加载器同样纳入检测（卡片标注"私有区不推送"）；**不进出厂 _index/Tree**（避免推送泄漏）。
- 版本号：小改 +0.1 / 大改 +1.0；文件头版本与文件尾一致。
- 废弃 → TRASH（不删只移）+ 更新 Tree.md。

## 格式模板（frontmatter + 五章）

```markdown
---
name: 技能名
description: 一句话描述（含触发关键词）
version: 1.0.0
author: 来源
license: internal | MIT
metadata:
  tags: [触发关键词]
  related: [关联的 skill/记忆/文档]
---

# 技能名 — 一句话定位

## 一、使用流程
Step 1→N 线性操作指南（遇到 X → 做 Y → 验证 Z）

## 二、核心规则
硬约束（不可违反）

## 三、行为准则
软技能/职业判断（该技能下应该怎么想）

## 四、踩坑记录
每条 ≤100 字（现象 → 对策）

## 五、关联索引
**L1：** 引用的 L1 文件
**L2 Skill：** 引用的 Skill
**L2 Exp：** 引用的 Exp
**L3 Index：** 对应的 L3/index 主题文件

---
_版本：1.0.0 | 2026-09-02 | 变更摘要_
```

## 当前技能

| 技能 | 版本 | 描述 |
|---|---|---|
| import-artifact | 1.0.0 | 导入协议：其他设备/agent 产物即插即用 |
| boot-recall | 1.0.2 | 上工自动召回：project+相关L3+教训+user-rules+人设卡 装配成注入上下文 |
| dshome-diagnostics | 1.0.0 | DSHOME 后端诊断（崩/卡/闪断：先分真假+证据） |
| dshome-plugin-dev | 1.1.0 | DSHOME/DSH 结构与 Cordis 插件开发 |
| landing-audit | 1.0.0 | 落地审计三查法（定义/接线/数据逐层查） |
| scar-inference | 1.1.0 | 伤疤反推法/咬痕考古法（版本差/反推坑/作者画像） |
