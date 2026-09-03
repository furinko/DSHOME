# Concepts.md — 心智概念注册表（L1 契约）

> 版本：1.0 | 2026-09-06 | 语义层落地：概念 → 唯一权威源 的**单一契约**。
> 定位：这是"某一概念的**权威源/入口在哪**"的**唯一挂号处**。系统要查询/流转一个概念，只在本表查一次；
> 加载：按需（查询层，L1 参考文档）——概念权威源/路由表，按需查
> 其他文档（AGENTS.md、Skill、记忆）**引用本表**，**不得各自重复定义**同一概念的权威源。
> 依据唯一 / 索引一致 / 可判定行为能被约束 —— 本表是前两条的"语义挂号处"。

## 概念注册表

| 概念 | 唯一权威源 | 关系（它回答什么） | 接口 | 机器可读薄字段（开放标签，不设死枚举） |
|---|---|---|---|---|
| todo | `mind-private\Project\DSHOME\project.md`「下一步（待办）」 | 需要/要求/该做/计划 | `/api/mind/todos` 读写 | status / priority / source / promotedFrom |
| progress | `mind-private\Project\DSHOME\project.md`「进度状态」 | 现状/阶段/到哪一步 | `/api/mind/read`?zone=private（读 project.md）或 mind-prime | phase / health / updated |
| suggestion | 评估/审计/巡检/判断产出（即时记忆类，落对应产出区 / pending） | 建议/可改/改进点 | 用户裁决后流转 | status=candidate/accepted/rejected/deferred · promotedTo |
| memory | `mind-private\L3\index\<主题>\` + 各目录 `_index` | 教训/偏好/跨会话记忆 | `/api/mind/search` + `/api/mind/dup-check` | kind / importance / scope / topic / tags |
| skill | `mind\L2\Skill\<id>.md` + `_index` | 怎么做/能力/流程/积木 | 关键词触发加载 | name / version / triggers / inputs / outputs |

## 意图 → 概念 → 唯一权威源（路由表）

| 意图（我想…） | 概念 | 去哪里（权威源 / 入口） |
|---|---|---|
| 下一步 / 该做什么 / 有什么待办 | todo | `project.md`「下一步（待办）」 → 经 `/api/mind/todos` 读写 |
| 到哪一步 / 进度 / 项目状态 | progress | `project.md`「进度状态」 |
| 建议 / 可改 / 评估 / 审计 / 巡检 / 改进点 | suggestion | 评估/审计/巡检产出 → 用户裁决（candidate/accepted/rejected/deferred） |
| 教训 / 偏好 / 记忆 / 上次怎么做 | memory | `/api/mind/search?q=` 模糊召回 → `mind-private\L3\index\` grep 深读；写前 `/api/mind/dup-check` |
| 怎么做 / 技能 / 能力 / 流程 / 积木 | skill | `mind\L2\Skill\` + `_index.md`（关键词触发加载） |

## 使用规则

- **依据唯一**：判断某概念的权威源/入口，只在本表查一次；其它文档引用本表，不重复定义。
- **薄契约 + 开放正文**：只把"系统要判断/查询/流转"的字段结构化；`status` / `priority` 等用**开放标签，不设死枚举**；正文自由。
- **改契约流程**：增删概念 / 调整权威源属"自我类文件"改动 → 走 `AGENTS.md` §五 硬流程：**用户放行 → 快照 → `mind-validate.mjs` 通过 → 失败回滚**。

---
_版本：1.0 | 2026-09-06 | 语义层落地：todo / progress / suggestion / memory / skill 唯一权威源_
