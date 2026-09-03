# Tree.md — 知识网络血管（全目录）

> 版本：1.2 | 2026-09-06 | 隐私校准：L3/Project 段改为结构描述，出厂版不再枚举本机具体记忆主题/归档/项目条目（运行时条目属 mind-private，不入出厂）
> 加载：强制层（每次上工必读）
> 定位：L1 循环系统——全知识网络目录，AI 友好表格化。"有什么"的一键查询。

## 使用说明
每个 ## 段落对应一个层级/类别。查"X 在哪"→ 本文件定位 → grep/read 目标文件。
**本机运行时内容（L3 记忆主题/条目、Learn 条目、具体项目档）在 `mind-private\`，同名私有优先；出厂版只描述结构，不登记具体条目（出厂文档不指向具体某条记忆）。**

## L0 — 基本指令集（mind\L0\，出厂固件）

| 文件 | 角色 | 修改规则 |
|---|---|---|
| SOUL.md | 身份锚点 + 价值观 + 决策规则 | 仅用户明确要求时修改 |
| USER.md | 用户关系（通用模板；真实信息在 mind-private\L0\USER.md 覆盖） | 同上 |
| AGENTS.md | 运行纪律 + 层级铁律（E:\DSHOME\AGENTS.md 常驻注入） | 需确认后改 |
| TOOL.md | 工具操作指南 | 环境变化时更新 |

## L1 — 认知中枢（mind\L1\）

| 文件 | 比喻 | 职责 |
|---|---|---|
| HUB.md | 脑袋 | 设计理念 + 加载顺序 + 跨层红线 |
| Design-Philosophy.md | 灵魂之纲 | 生长哲学：自生长/绽放 + 唯一防毒底座（别自欺）+ 性格罗盘（七美德×七原罪，Learn 归类尺） |
| Wisdom.md | 大脑皮层 | 思维模式系统 + 元认知框架 |
| Tree.md | 血管 | 全知识网络目录（本文件） |
| Power.md | 功法 | Skill/Exp 使用教程 + 沉淀模板 |
| Memory.md | 规则书 | L3 归档规则 |
| Concepts.md | 契约 | 概念注册表：todo/progress/suggestion/memory/skill 的**唯一权威源** + 意图→概念→权威源路由表 |
| Dream.md | 灵感池 | 松散点子 |
| Learn.md | 痕迹库 | 好鱼鱼/笨鱼鱼教训，批评归罪/表扬归德（模板在 mind\，实际条目在 mind-private\L1\） |

## L2 — 能力层（mind\L2\）

### Skill 清单（方法论）
| 文件 | 版本 | 描述 | 触发关键词 |
|---|---|---|---|
| import-artifact.md | 1.0.0 | 导入协议：其他设备/agent 产物即插即用 | import、导入、即插即用、artifact、蒸馏包 |
| boot-recall.md | 1.0.0 | 上工自动召回：project.md+L3+Learn+user-rules 装配成注入上下文 | 上工、你想不起来、有什么待办、记忆召回 |
| dshome-diagnostics.md | 1.0.0 | DSHOME 后端诊断（崩/卡/闪断：先分真假+证据） | 后端重启、卡、exit1、闪断 |
| dshome-plugin-dev.md | 1.0.0 | DSHOME/DSH 结构与运行时 Cordis 插件开发：写码前先 `cordis_inspect` 读真实接口，纯 JS code.host/code.client，生命周期/修复/回滚 | 做/改插件、cordis、slot、`is not declared`、`host.call` 失败 |
| scar-inference.md | 1.0.0 | 伤疤反推法/咬痕考古法：不蒸整体蒸版本差，不读架构图读咬痕 | 考古、蒸、版本差、反推坑、咬痕、伤疤、为什么在、作者画像、同源盲区 |

### Exp 清单（工具手册）
| 文件 | 版本 | 描述 | 触发关键词 |
|---|---|---|---|
| （待迁移/待结晶） | — | — | — |

## L3 — 记忆层（结构；实际条目在 mind-private\L3\，隐私）

- **index**（结晶知识）：按主题分目录，格式见 `mind\L1\Memory.md` §二。**本机实际主题清单不入出厂**——加载/查询走 `mind-private\L3\index\` 各目录 `_index.md`（上工必读）或 `/api/mind/search` 模糊召回。
- **history**（时间胶囊/归档）：规则见 `mind\L1\Memory.md` §三；实际归档在 `mind-private\L3\history\`（只写不改，各自维护 `_index.md`）。

## Project — 行动锚点（结构；实际项目档在 mind-private\Project\）

- 每个项目一个目录 + `project.md`（模板见 `mind\L1\Memory.md` §四）。
- **体系主线档** = `mind-private\Project\DSHOME\project.md`：todo/progress 概念的唯一权威源（跨设备语义，见 `mind\L1\Concepts.md`）；用户业务项目（链潮等）各自独立，不入 todo API。
- **本机在跑的具体业务项目不入出厂**——加载/查询走 `mind-private\Project\`（上工用 `scripts/mind-prime.mjs` 自动装配体系主线档；业务项目按需传项目词）。

## TRASH — 回收站（不删只移，规则见 mind\L1\Memory.md §六）

- 实际回收站在 `mind-private\TRASH\`（出厂不登记条目）。

## 更新规则
- 出厂结构变化（增/删/改 mind\ 下文件、L1/L2 清单、规则）→ 同步更新本文件对应段。
- **出厂版不登记 mind-private 具体条目**（记忆主题清单/归档/在跑项目由本机 `_index.md` 与 project.md 自行维护）。
- 版本号/关联变化 → 同步。
- 每轮收工（Power.md 7 步）第 4 步强制检查本文件同步。
