# mind — 心智基座（出厂版）

> DSHOME 智能体（DSHOME）的 L0-L3 四阶知识系统，参考 Cathome CCBP 架构 + Hermes 轮级缓冲 + dsh-evolve 自动化理念重构。
> 本目录 = **出厂固件**（架构 + 默认内容），可推送 GitHub。运行时自进化数据在 `$DSH_HOME\mind-private\`（仓库同级 `mind-private\`，gitignore，永不上传）。

## 一、四阶架构

| 层 | 回答 | 内容 |
|---|---|---|
| L0 | 我是谁？怎么活？ | SOUL（人格）+ AGENTS（纪律）+ TOOL（工具） |
| L1 | 能做什么？怎么做？怎么存？ | HUB（中枢·运行时总纲）+ Wisdom（思维）+ Tree（索引）+ Power（能力手册）+ Memory（归档规则）+ Learn（痕迹）+ Dream（灵感）+ Ritual（行为规程）+ Invariants（确定性内核）+ Concepts（契约）+ Design-Philosophy（生长哲学） |
| L2 | 某类问题怎么解决？ | Skill（方法论）+ Exp（工具手册） |
| L3 | 踩过的坑去哪查？被替代的去了哪？ | index（结晶知识）+ history（时间胶囊） |
| Project | 现在在做什么？ | 行动锚点（与知识网络平级） |
| TRASH | 废弃的放哪？ | 不删只移，可恢复 |

## 二、三层加载模型

> 完整加载策略（注入/强制/查询 每层含哪些文件）的**权威在 `mind\L1\HUB.md` §三**。此处仅速览：

```
注入层：L0 三文件 + L1/HUB ｜ 强制层：Tree/Power/Memory/Learn/Invariants ｜ 查询层：其余 L1 参考 + L2/L3/Project 按需
```

## 三、怎么用私密区（本机，一句话）

- **要记关于你/本机的事、存偏好、建人设卡** → 放 `mind-private\`（本机，gitignore 永不推）。
- **要人设演绎** → 在 `mind-private\L0\` 建你的**人设卡**（不建就是干净通用智能体）。
- 出厂 `mind\` 是通用逻辑，**别把私密写这**（会推出去）。
- **用就是了，不用先懂双区架构**——真要存私密/加人设时，Assistant/护栏会指点你放哪。

## 四、文件格式规范（frontmatter）

所有 L2 Skill/Exp 与 L3 记忆文件带头部元数据（机器可识别，支撑导入协议）：

```yaml
---
name: 条目名
description: 一句话摘要
version: 1.0.0
author: 来源（DSHOME/Hermes/cathome/其他设备）
license: internal | MIT
metadata:
  tags: [关键词触发]
  related: [关联的 skill/记忆/文档]   # 知识网络链路
---
```

## 五、导入协议（即插即用）

其他设备/agent 产物"直接丢给智能体"→ 识别（frontmatter/结构）→ 校验（版本/死链）→ 归类放置（mind-private\）→ 更新索引 → git checkpoint → 汇报。详见 `mind-private\L1\` 导入规则与 import-artifact 技能。

## 六、知识流动方向

```
讨论经验 → L2 Exp 踩坑 → 阈值触发 → L3/index 结晶 → 提炼成 L2 Skill → 旧版进 L3/history
任务工作 → 轮级缓冲（mind-private\tasks\pending\ 待放行 + Dream 灵感池）→ 收工闭环 → 蒸馏入 L3
```
