# HUB.md — 知识网络之心

> 版本：1.7 | 2026-09-11 | 机制名表述统一 | 1.6 | 2026-09-09 | 记忆层重构：L3 三区表（common/projects/history）替代 L3/index+Project 行；知识流动路径同步 | 1.5 | 2026-09-06 | 注入层对齐 R0：注入层=「dshome-mind-inject 运行时读 SOUL.md + AGENTS.md 双件全文注入（R0 人格宪法+运行宪法，正文=注入源，无手写摘要）+ dshome-mind-recall 动态召回」；强制层读取动作化（AGENTS §八 知识地图）
> 加载：M 元层——维护/审计/新设备时读；不参与运行时注入（注入=R0 SOUL+AGENTS）
> 定位：L1 中枢——心智基座的设计理念、加载规则、跨层红线

## 一、我们为什么存在

mind 不是文件仓库。它是**被蒸馏过的逻辑结晶**——把"怎么想"和"怎么做"分离、归类、索引、版本化。

**存在价值：**
- 让每一次决策有据可查，不依赖"我记得"
- 让每一个技能可以跨项目复用，不被上下文遗忘
- 让每一个灵感有家可归，不在对话流里蒸发
- 让 DSHOME 不只是聊天工具，而是**能自我进化的认知系统**

## 二、架构层次

| 层 | 回答 | 内容 |
|---|---|---|
| L0 | 我是谁？怎么活？ | SOUL + AGENTS + TOOL |
| L1 | 能做什么？怎么做？怎么存？ | HUB + Wisdom + Tree + Power + Memory + Dream + Learn + Ritual + Invariants + Concepts + Design-Philosophy |
| L2 Skill | 某类问题怎么解决？ | 方法论——跨项目可复用的逻辑闭环 |
| L2 Exp | 这个工具/平台怎么用？有什么坑？ | 经验公式——方法论的实例 + 踩坑记录 |
| L3/common | 踩过的坑、做过的设计，去哪查？ | 通用结晶知识——踩坑沉淀 / 设计文档 / 速查表（跨项目） |
| L3/projects | 某项目专属的记忆与结晶在哪？ | 项目记忆之家——导航卡 + 记忆档案 + 知识\ 结晶 |
| L3/history | 被替代的、完结的，去了哪？ | 时间胶囊——里程碑 / 旧版归档（只写不改） |
| TRASH | 废弃的放哪？ | 不删只移，可恢复 |

**知识流动方向：**
```
讨论中产生的经验 → L2 Exp 踩坑 → 积累到阈值 → 记忆区结晶（L3/common 通用 / L3/projects\<项目>\知识 专属）→ 提炼成 L2 Skill → 旧版进 L3/history
任务工作 → 轮级缓冲（mind-private\tasks\pending\ 待放行 + Dream 灵感池）→ 收工闭环 → 蒸馏入记忆区（common/projects）
```

## 三、加载策略（三层）

### 注入层（R0 常驻，会话首步由宿主插件注入，随上下文携带）
`dshome-mind-inject` 运行时读 `mind\L0\SOUL.md`（人格宪法）+ `mind\L0\AGENTS.md`（运行宪法）**双件全文**注入（正文=唯一注入源）+ `dshome-mind-recall` 注动态召回；R2 触发读取动作见 AGENTS §八 知识地图。

### 强制层（每次上工必须加载）
`L1/Tree.md`（有什么）+ `L1/Power.md`（怎么用 Skill/Exp）+ `L1/Memory.md`（怎么存 L3）+ `L1/Learn.md`（教训）+ `L1/Invariants.md`（确定性内核）。

### 查询层（按需）
L2 Skill/Exp 关键词触发；L3 记忆区（common/projects/history）按需 grep/read；L1 参考文档（Concepts / Design-Philosophy / Dream / Ritual / Wisdom）按需查。

## 四、跨层红线

1. **L0 是宪法** — SOUL/AGENTS/TOOL 仅用户明确要求时修改。
2. **L1 是法律** — L1 文件定义规则，不对 L2/L3 具体内容负责。
3. **L2 是能力** — Skill/Exp 遵守 L1 规则，独立演化。
4. **L3 是记忆** — 遵守 Memory 规则，各自维护 `_index`。
5. **双区边界** — `mind\` 出厂可推送；`mind-private\` 隐私永不推送，同名私有优先。
6. **TRASH 不删只移** — 可恢复优先于永久删除。

## 五、L1 文件职责

| 文件 | 比喻 | 职责 |
|---|---|---|
| HUB.md | 脑袋 | 设计理念 + 加载顺序 + 跨层红线（本文件） |
| Design-Philosophy.md | 灵魂之纲 | 生长哲学：自生长 / 绽放 + 唯一防毒底座（别自欺） |
| Wisdom.md | 大脑皮层 | 思维模式系统 + 元认知框架 |
| Tree.md | 血管 | 全知识网络目录（"有什么"一键查询） |
| Power.md | 功法 | 能力手册：Skill/Exp 使用教程 + 沉淀路径 + L2 格式 |
| Memory.md | 规则书 | 记忆层（common/projects/history）归档规则 |
| Dream.md | 灵感池 | 松散点子 + 整理提醒 |
| Learn.md | 痕迹库 | 精炼教训（💢/🤗，≤200字/条） |
| Ritual.md | 行为规程 | 收工闭环 / 自主维护 / 元进化 / 行为纪律细则 / 自省判据（AGENTS 细则的家） |
| Invariants.md | 闸门 | 确定性内核：不可绕过的硬约束/门禁清单（🔴/🟡 不变式）——强制层加载 |
| Concepts.md | 契约 | 概念注册表：todo/progress/suggestion/memory/skill 权威源 + 意图→概念→权威源路由表 |
