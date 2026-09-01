# DSHOME 文档导航

> 目标读者：DSHOME 维护者与接手者（包括未来的自己）。文档按域分类，先读 ARCHITECTURE 建立全局，再按需进入各域。

## 目录

| 域 | 文档 | 内容 |
|---|---|---|
| 架构 | `ARCHITECTURE.md` | 现状架构 + 设计决策记录（patch 分层 / 插件职责 / 部署模型 / rationale / 已知债务） |
| 灵魂体系 | `soul/SOUL-BEHAVIOR.md` | 灵魂行为层：AGENTS.md 纪律 + Learn.md 行为学习（与 dsh-evolve 的分工） |
| 灵魂体系 | `soul/SOUL-MEMORY.md` | 灵魂记忆自研方案（**已归档**，被 dsh-evolve 替代，仅模板可复用） |
| 集成 | `integrations/EVOLVE-SMOKE.md` | dsh-evolve 集成与冒烟测试清单 |
| 事故复盘 | `incidents/DSHOME-ISSUE-20260831-PLUGIN-LOAD.md` | ISSUE-001：插件根入口缺 apply 导致启动失败 |
| 事故复盘 | `incidents/DSHOME-ISSUE-20260831-AGENT-TEAMS-VERSION.md` | ISSUE-002：dsh-agent-teams 跨代版本不兼容 |
| 事故复盘 | `incidents/DSHOME-ISSUE-20260831-INSTALLER-JUNCTION.md` | ISSUE-003：安装包实体化 `profiles\node_modules` 导致首启失败（打包门禁） |
| 部署 | `deployment/NEW-DEVICE.md` | 换新设备部署指南（官方流程，无需 junction 绕路） |

## 约定

- 事故复盘一律进 `incidents/`，命名 `DSHOME-ISSUE-<YYYYMMDD>-<主题>.md`，并在文首写明编号/状态/定位。
- 运行时私有内容（`soul/Learn.md` 具体条目、`skills/` 结晶技能）不入仓库——本目录只放框架与流程文档。
- 新增文档先登记本索引；移动/改名需全仓同步引用（README、ARCHITECTURE、互引）。
