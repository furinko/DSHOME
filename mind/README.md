# mind — 鱼鱼心智基座（出厂版）

> DSHOME 智能体（鱼鱼）的 L0-L3 四阶知识系统，参考 Cathome CCBP 架构 + Hermes 轮级缓冲 + dsh-evolve 自动化理念重构。
> 本目录 = **出厂固件**（架构 + 默认内容），可推送 GitHub。运行时自进化数据在 `E:\DSHOME\mind-private\`（gitignore，永不上传）。

## 一、四阶架构

| 层 | 回答 | 内容 |
|---|---|---|
| L0 | 我是谁？怎么活？ | SOUL（人格）+ USER（关系）+ AGENTS（纪律）+ TOOL（工具） |
| L1 | 能做什么？怎么做？怎么存？ | HUB（中枢）+ Wisdom（思维）+ Tree（索引）+ Power（功法）+ Memory（归档规则）+ Dream（灵感）+ Learn（痕迹）+ Concepts（契约）+ Design-Philosophy（生长哲学） |
| L2 | 某类问题怎么解决？ | Skill（方法论）+ Exp（工具手册） |
| L3 | 踩过的坑去哪查？被替代的去了哪？ | index（结晶知识）+ history（时间胶囊） |
| Project | 现在在做什么？ | 行动锚点（与知识网络平级） |
| TRASH | 废弃的放哪？ | 不删只移，可恢复 |

## 二、三层加载模型

```
注入层（系统提示词，随每轮携带）：L0 四文件 + L1/HUB + L1/Wisdom
强制层（每次上工必须加载）：L1/Tree + Power + Memory + Dream + Learn
查询层（按需）：L2 Skill/Exp + L3 index/history + Project + L1 参考文档（Concepts / Design-Philosophy）
```

## 三、双区知识基座

- `mind\`（本目录）：出厂固件，GitHub 可推送
- `mind-private\`（同级目录，.gitignore）：本机运行时自进化（真实记忆/项目/Learn 条目/个性化覆盖）
- **同名文件私有区优先**：加载时规则从 mind\ 读，记忆和项目从 mind-private\ 读

## 四、文件格式规范（frontmatter）

所有 L2 Skill/Exp 与 L3 记忆文件带头部元数据（机器可识别，支撑导入协议）：

```yaml
---
name: 条目名
description: 一句话摘要
version: 1.0.0
author: 来源（鱼鱼/Hermes/cathome/其他设备）
license: internal | MIT
metadata:
  tags: [关键词触发]
  related: [关联的 skill/记忆/文档]   # 知识网络链路
---
```

## 五、导入协议（即插即用）

其他设备/agent 产物"直接丢给鱼鱼"→ 识别（frontmatter/结构）→ 校验（版本/死链）→ 归类放置（mind-private\）→ 更新索引 → git checkpoint → 汇报。详见 `mind-private\L1\` 导入规则与 import-artifact 技能。

## 六、知识流动方向

```
讨论经验 → L2 Exp 踩坑 → 阈值触发 → L3/index 结晶 → 提炼成 L2 Skill → 旧版进 L3/history
任务工作 → 轮级缓冲（mind-private\tasks\：pending 待放行 / ideas.md 点子）→ 收工闭环 → 蒸馏入 L3/通用层
```
