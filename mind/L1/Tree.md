# Tree.md — 知识网络血管（全目录）

> 版本：1.7 | 2026-09-10 | 出厂卫生清理：版本行去私有项目名（收工扫描发现同类回归 7 处，本文件为其一）；配套 `mind-validate` 出厂卫生禁词表门禁 | 1.6 | 2026-09-09 | 记忆层重构：L3 段改三区结构（common/projects/history），Project 独立段并入 L3\projects（51df701 隐私卫生延续：出厂不枚举运行时条目）| 1.5 | 2026-09-08 | 隐私修复：Project 段改结构描述 + 更新规则禁私有条目（51df701 回归补漏——2387d50 误加私有项目名已移除）
> 加载：R2/R3——上工由 R1 召回带层骨架速览；完整目录按需 read（查"X 在哪"→ 本文件定位 → grep/read 目标）
> 定位：L1 循环系统——全知识网络目录，AI 友好表格化。"有什么"的一键查询。

## 使用说明
每个 ## 段落对应一个层级/类别。查"X 在哪"→ 本文件定位 → grep/read 目标文件。
**本机运行时内容（L3 记忆/项目/Learn 条目）在 `mind-private\`，同名私有优先。**

## L0 — 基本指令集（mind\L0\，出厂固件）

| 文件 | 角色 | 修改规则 |
|---|---|---|
| SOUL.md | 身份锚点 + 价值观 + 决策规则 | 仅用户明确要求时修改 |
| AGENTS.md | 运行纪律 + 层级铁律（L0 权威版，`mind\L0\AGENTS.md`，由 `dshome-mind-inject` 注入；根版已退役） | 需确认后改 |
| TOOL.md | 工具操作指南 | 环境变化时更新 |

## L1 — 认知中枢（mind\L1\）

| 文件 | 比喻 | 职责 |
|---|---|---|
| HUB.md | 脑袋 | 设计理念 + 加载顺序 + 跨层红线 |
| Design-Philosophy.md | 灵魂之纲 | 生长哲学：自生长/绽放 + 唯一防毒底座（别自欺） |
| Wisdom.md | 大脑皮层 | 思维模式系统 + 元认知框架 |
| Tree.md | 血管 | 全知识网络目录（本文件） |
| Power.md | 功法 | 能力手册：Skill/Exp 使用教程 + 沉淀路径 + L2 格式 |
| Memory.md | 规则书 | L3 归档规则 |
| Invariants.md | 闸门 | 确定性内核：不可绕过的硬约束/门禁清单（🔴/🟡 不变式）——强制层加载 |
| Concepts.md | 契约 | 概念注册表：todo/progress/suggestion/memory/skill 的**权威源** + 意图→概念→权威源路由表 |
| Dream.md | 灵感池 | 松散点子 |
| Learn.md | 痕迹库 | 🤗/💢教训（模板在 mind\，实际条目在 mind-private\L1\） |
| Ritual.md | 行为规程 | 收工闭环 / 自主洗澡 / 元进化 / 行为纪律细则 / 自省判据（AGENTS 细则的家，按需读） |

## L2 — 能力层（mind\L2\）

### Skill 清单（方法论）
| 文件 | 版本 | 描述 | 触发关键词 |
|---|---|---|---|
| import-artifact.md | 1.0.0 | 导入协议：其他设备/agent 产物即插即用 | import、导入、即插即用、artifact、蒸馏包 |
| boot-recall.md | 1.0.3 | 上工自动召回：project.md+L3+Learn+user-rules+人设卡 装配成注入上下文 | 上工、你想不起来、有什么待办、记忆召回 |
| dshome-diagnostics.md | 1.1.0 | DSHOME 诊断两层：进程层（崩/卡/闪断：先分真假+证据）+ agent 层（报错→源码链→会话日志取证四跳 + 离线端到端验证） | 后端重启、卡、exit1、闪断、本轮运行失败、报错文本、turn error |
| dshome-crash-recovery.md | 1.0.4 | DSHOME/DSH 崩溃排查+自愈：三层定位（装配期/运行期/前端半区）+ marker 定位崩溃插件 + guard --recover/safe 逃生 + Failed to load plugins 四证核对 | 启动失败、起不来、崩溃循环、Failed to load plugins、半区加载失败、ERR_PACKAGE_PATH_NOT_EXPORTED |
| dshome-plugin-dev.md | 1.3.0 | DSHOME/DSH 结构与运行时 Cordis 插件开发：写码前先 `cordis_inspect` 读真实接口，纯 JS code.host/code.client，生命周期/修复/回滚；自有 host 插件落地三步（exports 易漏）；打包缺 bundle + 包外脚本 require 实体化失效排查 | 做/改插件、cordis、slot、`is not declared`、`host.call` 失败、启动崩溃 |
| landing-audit.md | 1.0.0 | 落地审计三查法：查「文档说有 ≠ 机制真在跑 ≠ 数据真达标」（定义/接线/数据逐层查） | 审计、落地、三查、落到实处吗、纸面定义、空壳、接线 |
| scar-inference.md | 1.1.0 | 伤疤反推法/咬痕考古法：不蒸整体蒸版本差，不读架构图读咬痕 | 考古、蒸、版本差、反推坑、咬痕、伤疤、为什么在、作者画像、同源盲区 |

### Exp 清单（工具手册）
| 文件 | 版本 | 描述 | 触发关键词 |
|---|---|---|---|
| （待迁移/待结晶） | — | — | — |

## L3 — 记忆层（mind-private\L3\，隐私）

> 记忆层重构（2026-09-09）：三区 = `common\`（通用结晶）+ `projects\`（项目记忆）+ `history\`（归档）。检索隔离 = 物理目录（common 恒含 + projects\<当前>）。结构与规则详见 `mind\L1\Memory.md`。

### common — 通用结晶（跨项目可调取）
> 主题目录 = `mind-private\L3\common\<主题>\`（当前：user-rules / lessons）；索引 = 各主题 `_index.md` + `common\_index.md`。
### projects — 项目记忆（每项目一目录，上工加载）
> `mind-private\L3\projects\<项目>\`：导航 project.md + 记忆档案（如管线记忆.md）+ `知识\<主题>\` 项目结晶。
> 🔴 **出厂不登记任何项目条目**（51df701 隐私卫生：出厂只给结构、不枚举本机运行时条目——含本仓库 DSHOME 自身，它也只是私有区里的一个项目档案）。
### history 归档
> history = `mind-private\L3\history\`（时间胶囊，只写不改）。当前为空；归档时 `YYYY-MM-DD_<标题>_归档.md` 命名并在此登记一行。

## TRASH — 回收站（不删只移）

| 文件 | 原因 | 移入日期 |
|---|---|---|
| （空） | — | — |

## 更新规则
- 出厂 L2 Skill/Exp 变更 → 同步更新本文件对应清单。
- 🔴 私有 L3 记忆（common/projects/history 运行时条目）→ **不进本文件**（本文件随 git 推公开仓库；运行时条目一律归 mind-private，51df701）。
- 版本号/关联变化 → 同步。
- 每轮收工（Ritual.md §一 9 步）第 4 步强制检查本文件同步。
