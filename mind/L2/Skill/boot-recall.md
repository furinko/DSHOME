---
name: boot-recall
description: 上工自动召回——会话/任务开始时把 project.md + L3 相关记忆 + Learn + user-rules 装配成注入上下文。触发：每次会话/任务开始（上工）、"我忘了/你想起来/有什么待办"。
version: 1.0.0
author: 鱼鱼 (DSHOME)
license: internal
metadata:
  tags: [boot, recall, 召回, 上工, 记忆, 待办]
  related: [mind/L1/Memory.md, mind/L1/Tree.md, mind/L1/Concepts.md, scripts/mind-prime.mjs]
contract:
  id: boot-recall
  triggers: [上工, 会话开始, 你想起来了, 有什么待办, 我忘了]
  inputs: [项目/任务关键词]
  outputs: [注入上下文（进度+待办+相关 L3+教训+用户偏好）, 一次 refresh/update]
  deps: [scripts/mind-prime.mjs, mind-private/]
---

# boot-recall — 上工自动召回（boot recall）

## 一、使用流程

会话/任务开始时，**先召回再动手**（这是 AGENTS 的《上工自动召回》规则的机器版）：

1. 确定当前上下文关键词（默认 `DSHOME 心智` = 心智体系主线；谈用户业务项目时传对应项目词，如具体游戏项目名）。
2. 跑确定性回召：`node scripts/mind-prime.mjs "<关键词>"` —— 输出可注入上下文（体系主线档进度+待办、相关 L3 记忆 top-N、最近教训）。
3. 把这段上下文**纳入思考**（作为初始上下文），再进入用户问题。
4. 需要刷新时重跑（`--json` 可结构化，供 build 后注入）。
5. **新设备首启检查**：若输出里没有「■ project.md」区段（= `mind-private\Project\DSHOME\project.md` 尚未初始化）→ 按 `mind\L1\Memory.md` §四 模板补建体系主线档（「进度状态」表 + 「下一步」`- [ ]`），让 todo/progress 权威源落位（见 `mind\L1\Concepts.md`）。

## 二、核心规则

- 🔴 **上工必做**：每次新会话/任务开始，先跑 `mind-prime` 再答用户；**别等用户写报告/附件来补记忆**。
- 🔴 **走确定性脚本**：不靠"我记得该搜哪"，由 `scripts/mind-prime.mjs` 机械装配。
- 🟡 **体系主线 vs 业务项目分开**：todo/progress 只承载心智体系自身待办（权威源 = `Project\DSHOME\project.md`，跨设备）；用户业务项目待办在各自 `Project\<项目>\project.md`，不混入 todo API。
- 🟡 **查询词选准**：默认项目主线关键词；跨项目时用任务/主题关键词，否则召回会偏。
- 🟡 **注入量克制**：默认 top-N（可 `--limit` 调）+ 进度表 + 待办前 8；太长的按需再 grep 深读。
- 🟡 **问答后回写**：如果发现知识缺失/新结论 → 走蒸馏闭环（Skill/Exp/L3），让下次召回更准。

## 三、行为准则

- 召回是"接住上下文"，不是替代思考：注入后仍要对着用户问题做判断。
- 召回命中弱不代表没有 —— 阈值 0.03 较宽，保召回；精度不足再 grep 深读。
- 隐私：`mind-prime` 只读 `mind-private\`（本机），产出不进出厂区。

## 四、踩坑记录

- 忘了上工召回 → 像这次"待办猜错源"，靠用户写报告；`mind-prime` 就是防这个。
- `related` 死链 → `mind-validate.mjs` 会拦（改记忆前先跑它）。
- 查询词太窄 → 召回空；换主题词或默认主线词。

## 五、关联索引

- **L1**：`mind\L1\Power.md` §九（行为纪律）· `mind\L1\Tree.md`（索引）· `mind\L1\Invariants.md`（确定性内核）
- **脚本**：`scripts/mind-prime.mjs`（回召）· `scripts/mind-validate.mjs`（自写校验/事务门禁验证一半）
- **L3**：`mind-private\Project\`（体系主线档 `DSHOME\project.md` + 业务项目各自目录）· `mind-private\L3\index\`（记忆按主题分目录，各目录 `_index.md`）· `mind-private\L1\Learn.md`

---
_版本：1.1.0 | 2026-09-06 | 上工自动召回积木化（新增体系主线档初始化检查；todo/progress 权威源语义对齐 Concepts）_
