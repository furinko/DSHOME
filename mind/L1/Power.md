# Power.md — 能力手册（Skill/Exp）

> 版本：1.5 | 2026-09-05 | 设计债闭环：Skill 触发加载机器化（mind-skill-loader 插件）+ 双区落地（私有暂存区建立）；余同 1.4（能力手册）
> 加载：强制层（每次上工必读）——能力怎么用、怎么长，常驻
> 定位：L1 能力手册——如何使用 L2 Skill/Exp，沉淀路径，L2 格式规范。
> 🔴 **权威声明**：本文件只管**能力域**（Skill/Exp 是什么、怎么沉淀、什么格式）。行为/流程/纪律类内容在 `mind\L1\Ritual.md`（收工/洗澡/元进化/纪律/自省判据）——不要在本文件追加行为类规则。

## 一、什么是 Skill，什么是 Exp

### Skill（功法·方法论）
- 跨项目可复用的**逻辑闭环**，描述"解决某类问题的方法论"
- 生命周期：6 个月以上；创建条件：跨 2+ 项目验证、有可验证的逻辑规则
- 禁止：项目特有配置、工具踩坑、项目叙事

### Exp（工具书·经验）
- 外部工具/平台/引擎的**使用手册**，描述"怎么操作"
- 生命周期：依赖工具版本，较短；创建条件：引入新外部工具
- 禁止：跨项目持久原则、项目叙事

## 二、Skill/Exp 触发加载

对话中出现关键词 → 加载对应 Skill/Exp（未命中不加载）。加载后即生效——是硬约束不是参考资料，不凭"我记得"替代。

**触发登记唯一权威 = `mind\L2\Skill\_index.md`（能力积木总索引）+ Skill/Exp 文件自身的 frontmatter `contract.triggers`**——不在此另列表格（曾有空壳表重复定义，已废弃）。盘点/查询能力积木去 `_index.md`。

> **实现状态（2026-09-05 更新）**：
> - **触发加载已有机器实现**：host 插件 `dshome-mind-skill-loader` 每步检测对话触发词，命中注入方法论卡片（frontmatter description + outputs 摘要，约 150 词元，防全文灌上下文）。检测触发词唯一来源 = frontmatter `contract.triggers`（改触发词即改检测行为）。_index.md 仍是人类盘点索引；机器加载不依赖它（插件直接扫 Skill 目录 frontmatter）。
> - **Skill 双区（V1）**：加载器读**双区**——出厂 `mind\L2\Skill\`（可推送）+ 私有暂存 `mind-private\L2\Skill\`（gitignore 永不推送，同名私有优先覆盖出厂）。**私有 skill 落法**：未成熟/含隐私/未去敏 → 写 `mind-private\L2\Skill\<id>.md`（同样 frontmatter 含 contract.triggers），加载器自动纳入检测，卡片标注"私有区不推送"；成熟去敏后 → 移入出厂 `mind\L2\Skill\` + 更新 `_index.md` + `Tree.md`（提升流程）。私有 skill **不**进出厂 _index/Tree（避免推送泄漏）。

## 三、沉淀路径

### 蒸馏判据（该不该沉淀 + 落哪）
做完一件事（重要任务/收工/踩坑/有新方法）→ **主动判断**该不该沉淀：
- **可复用方法论/流程**（跨项目、有逻辑闭环）→ **Skill 积木**（`mind\L2\Skill\<id>.md` frontmatter 含 `contract` + 更新能力 `_index.md` + `Tree.md`）
- **工具/场景经验**（单点、怎么用）→ **Exp**（`mind\L2\Exp\`）
- **踩坑/教训**（通用、跨项目）→ **lessons 主题**（`mind-private\L3\index\lessons\`）
- **用户偏好/批评表扬** → **user-rules** / `Learn.md`（**当下就写**，不等蒸馏）
- **项目决策/状态** → **Project**（`project.md`）

**判据**（三条 ≥2 才沉淀，否则只记轮级缓冲/不记）：
① 跨项目可复用？ ② 有验证过的逻辑/事实？ ③ 以后还会遇到？
**索引同步**：Skill→`_index`+`Tree`；记忆→对应 `_index`；改"自我类"→进化档案 `log`（见 `mind\L1\Ritual.md` §四）。

### 新增 Skill
```
1. 草稿（轮级缓冲或临时文件）
2. 用户确认
3. 写入 mind\L2\Skill\<Name>.md（frontmatter 含 contract）
4. 更新 mind\L1\Tree.md「L2-Skill 清单」
5. 更新能力积木 _index.md 加一行
6. 建 L3/index 对应子目录（如需要）
```

### 更新 Skill/Exp
```
1. 收集改动点 → 定稿
2. 覆盖原文件；版本号 +0.1（小改）/ +1.0（大改）
3. 更新 Tree.md 版本号
4. 涉及底层原则的改动需用户确认
```

### 废弃
```
1. 移入 TRASH\（不删只移）
2. 更新 Tree.md（标记 ⚠️ 已废弃 + 去向）
3. 清理对应 L3/index 子目录（如存在）
```

## 四、L2 统一格式规范

### 文件头（frontmatter，必填）
```yaml
---
name: 名称
description: 一句话描述（含触发关键词）
version: 1.0.0
author: 来源
license: internal | MIT
metadata:
  tags: [触发关键词]
  related: [关联的 skill/记忆/文档]
---
```

### Skill 固定五章
`## 一、使用流程`（Step 1→N）· `## 二、核心规则`（硬约束）· `## 三、行为准则`（软技能）· `## 四、踩坑记录`（每条 ≤100 字）· `## 五、关联索引`（L1/L2/L3 交叉引用）

### Exp 固定四章
`## 一、工具定位` · `## 二、部署/接入` · `## 三、核心操作` · `## 四、关联索引`

### 版本号规则
- 小改 +0.1（修正/补充/格式）；大改 +1.0（重写/新章节/架构变更）
- 文件头版本与文件尾版本一致

---

_版本：1.5 | 2026-09-05 | v1.4（诚实标注）→ 设计债闭环：mind-skill-loader 机器加载 + Skill 双区落地_
