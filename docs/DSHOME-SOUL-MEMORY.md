# DSHOME 灵魂记忆（Soul Memory）设计方案

> 版本：v1.1（2026-08-31，评审合入）～状态：**已归档** ～目标读者：实施者（DeepSeek + dsh 代理）与需求方本人
> 前置文档：`docs/DSHOME-DESIGN.md`（壳层方案）。本文是 DSHOME 的记忆/自进化子系统方案，挂接在 `dshome/core` 扩展点之上。
>
> **⚠️ 归档说明（2026-08-31）**：本自研方案已被市场插件 **dsh-evolve v0.4.2** 替代——存储/检索/反射/技能固化设计已由 dsh-evolve 实现并实测通过（冒烟全绿，见 `docs/DSHOME-EVOLVE-SMOKE.md`），本方案相应部分**作废**。
> 仅以下内容可复用：§4.1 AGENTS.md 模板（灵魂纪律层）、§4.5 Learn.md 行为学习模板（**鱼鱼**形象，非猫猫）、§2.5 与 compaction/goal 的分工边界。行为层落地见 `docs/DSHOME-SOUL-BEHAVIOR.md`。
>
> **v1.1 变更记录（评审合入）**：
> 1. 目标措辞"零记忆负担"→"可控记忆负担"；明确与 compaction / goal 的分工边界（新增 §2.5）。
> 2. Phase 1 写端定性为**软闭环**（模型自觉触发，非机械闭环），验收增加 remember 触发率指标（§6、§8）。
> 3. 检索策略改为**模型驱动检索**，废弃宿主自建关键词打分器（§5.1 recall 重写，§4.6 同步）。
> 4. 并发写冲突：新增**写锁与单一写者纪律**（§5.1、§4.6、§9）。
> 5. consolidate 增加 **diff 预览 + 强制 git commit** 确认环节（§4.6）。
> 6. 反射触发增加 **阈值 + 去重 + 节流**（§5.1）。
> 7. `agent/pre-step` 注入的 query 来源与频率明确化（§5.1）。
> 8. 隐私纪律：不存私密数据 + 本地 git（§4.1、§4.3、§9）。

---

## 1. 目标与约束

**目标**：让 DSHOME 拥有"自进化能力"（跨会话记住经验、被纠正后改变行为、沉淀可复用技能），同时**记忆负担可控**（常驻上下文极小、按需读取、存储有界、反射不进交互路径）。

> 措辞说明：本方案追求的是"**可控负担**"而非"零负担"——recall 本身消耗工具轮次与少量 token，频繁召回会增加成本；负担控制靠"预算"而非"消失"。所有指标见 §6。

**硬约束（来自需求方）**：
- 参考本设备上的 CatHome/CCBP（灵魂宪法分层）与 Hermes（最小蒸馏形态）实现模式（具体路径从略，仅作模式参考）；
- **不得依赖二者的存在**——实现只允许使用 DSH 原生机制与纯文件，零外部依赖、零外部进程；迁移到新设备只需拷贝本方案涉及的目录。

**已核实的 DSH 原生机制（本机 0.1.1-rc.2）**：
| 机制 | 包 | 用途 |
|---|---|---|
| `$DSH_HOME/AGENTS.md` 自动注入 | `dsh-agent-instructions` | 每个会话**首步**必注入（系统提醒帧），是"常驻灵魂摘要"的唯一官方通道；baseline 按会话粒度组装，会话中途的摘要改动下次会话生效 |
| Skill 目录发现 | `dsh-skill-filesystem` | 扫描 `<dshHome>/skills`、项目 `.dsh/skills`、`customSkillDirs`；`SKILL.md` frontmatter 进目录，模型**按需加载**（模型判断才调用） |
| 会话事件流 | `dsh-session` | `session/event`（写穿订阅）、`session/flush`、`session/created`/`session/disposed` 生命周期 |
| 前置钩子 | `dsh-agent-loop` / `dsh-agent-instructions` | `agent/pre-step` 在每步组装前触发，可在 batch 中注入上下文（等价 Soul Memory 的 `before_prompt_build`） |
| 后台任务 | `dsh-subagent` / `dsh-jobs` / `dsh-goal` | 反射蒸馏跑在后台，不进请求路径 |
| 用户反馈 | `dsh-message-feedback` | 点赞/点踩信号，行为学习的输入 |
| 会话内压缩 | `dsh-compaction-basic` | 会话内短期记忆管理（见 §2.5 分工） |
| 跨轮目标 | `dsh-goal` | 持久目标驱动多轮迭代（见 §2.5 联动） |
| 持久化 | `dsh-storage-json` | Phase 2 可选索引存储 |

---

## 2. 参照分析（三源共性提炼）

### 2.1 Soul Memory skill（OpenClaw 系，用户点名参考）
- 优先级标签 `[C]/[I]/[N]` + CJK 关键词检索 + 动态分类 + Git 版本 + **衰减** + 自动触发（pre-response 注入 / post-response 自动存）；
- 核心思想：**写时蒸馏、读时检索、有界常驻、衰减归档**——即"负担换蒸馏+检索+预算+衰减"。
- **注意**：其检索依赖 CJK 分词与同义词扩展（工程成本不低）；本方案以模型驱动检索替代（§4.6、§5.1），不照搬其分词器。

### 2.2 CatHome / CCBP（灵魂宪法分层）
```
L0 宪法(注入系统提示词): SOUL / USER / AGENTS(运行纪律+判例) / TOOL
L1 法律(核心注入+按需): HUB / Wisdom(思考模式) / Tree / Power / Memory / Dream / Learn(批评→笨猫猫💢 / 表扬→好猫猫🐱)
L2 能力(按需): Skill/(技能契约) + Exp/(每主题一文件的经验/踩坑/判例)
L3 记忆(按需): history/(日期归档) + index/ + project/     TRASH: 软删除只移不删
```
关键纪律（直接借鉴）：**启动强制加载认知基础设施**；**先搜后写、不凭记忆**；**被批评/表扬必须写 Learn.md，不靠"下次记住"**；**归档只移不删**。

### 2.3 Hermes（最小蒸馏形态）
- `SOUL.md`：一句话身份（含"始终用中文回复"）；
- `memories/MEMORY.md`（~3.5KB）：`§` 分段 + **日期戳**的蒸馏条目——只存结论（交付链路、质量要求、用户铁律、梗库），不存对话原文；`.lock` 文件证明有宿主进程自动写（本方案借鉴为写锁，见 §5.1）；
- `memories/USER.md`：用户画像（行业/项目/工具/工作流/清理红线/铁律）；
- `skills/`：标准 SKILL.md 技能库（含 `agent-memory-recovery` 跨工具记忆恢复方法论）。

### 2.4 共性结论
三源殊途同归：**蒸馏、分层、按需、行为学习、归档**。本方案取三者之轻：CCBP 的分层骨架 + Hermes 的 `§` 蒸馏格式 + Soul Memory 的优先级与预算纪律，全部用 DSH 原生机制实现。

### 2.5 与既有 DSH 机制的分工边界（v1.1 新增）
| 机制 | 管什么 | 不管什么 |
|---|---|---|
| `dsh-compaction-basic` | **会话内**短期记忆：上下文超窗时压缩对话历史 | 不产生跨会话知识 |
| 灵魂记忆（本方案） | **跨会话**长期记忆：蒸馏结论、行为规则、经验、技能 | 不替代会话内压缩 |
| `dsh-goal` | **目标驱动**的多轮迭代脚手架（持久目标） | 不承载记忆条目 |
| **联动约定** | 长期目标可登记进 `soul/MEMORY.md`（[C] 级条目），soul 的 learn/exp 可作为 goal 迭代的输入；goal 会话结束同样触发反射 | 互不写对方的存储文件 |

**双写防线**：同一信息只允许一个归属——会话内细节归 compaction，跨会话结论归 soul；soul 蒸馏时若发现条目与目标（goal）强相关，在条目中标注 `关联目标:<goal id>`，不复制目标内容。

---

## 3. 总体架构

### 3.1 分层模型

| 层 | 位置 | 内容 | 注入策略 |
|---|---|---|---|
| **S0 常驻** | `E:\DSHOME\AGENTS.md` | 灵魂摘要 + 运行纪律 + 记忆指针 | **每会话首步必注入**（唯一常驻，≤2KB；按会话粒度生效） |
| **S1 灵魂** | `soul\SOUL.md` | 完整身份/价值观/思考模式 | 按需 read |
| **S2 蒸馏记忆** | `soul\MEMORY.md` / `soul\USER.md` / `soul\Learn.md` | 结论条目 / 用户画像 / 行为学习 | 按需 read / 模型驱动召回 |
| **S3 经验** | `soul\Exp\` | 每主题一文件（踩坑/判例/方法论） | 按需 read |
| **S4 自产技能** | `skills\<name>\SKILL.md` | 可复用流程固化为 DSH 技能 | DSH 技能目录原生发现 |
| **S5 归档** | `soul\History\` | 日期命名冷归档 + git 历史 | 永不自动注入，仅人工/查询 |

### 3.2 文件布局（Phase 1 交付物）

```
E:\DSHOME\
├─ AGENTS.md                     # S0 常驻注入（模板见 §4.1）
├─ skills\
│  └─ soul\SKILL.md              # 灵魂技能（全文见 §4.6，模型按需加载）
└─ soul\
   ├─ SOUL.md                    # S1 完整灵魂（模板见 §4.2）
   ├─ MEMORY.md                  # S2 蒸馏记忆（格式约定见 §4.3）
   ├─ USER.md                    # S2 用户画像（模板见 §4.4）
   ├─ Learn.md                   # S2 行为学习（模板见 §4.5）
   ├─ Exp\                       # S3 经验（命名：<主题>.md，如 WindowsScript.md）
   ├─ History\                   # S5 归档（命名：<YYYY-MM-DD>_<主题>_归档.md）
   ├─ .write.lock                # 写锁（Phase 2 起用；见 §5.1 写者纪律）
   └─ .git\                      # 版本控制：每次 consolidate 一次 commit
```

### 3.3 两个循环

```
┌─────────────── 读循环（按需召回，负担可控）───────────────┐
│ 会话首步：AGENTS.md 摘要已注入（≤2KB）                    │
│    ↓ 任务涉及过往经验时                                   │
│ 模型调用 soul 技能 recall：先读条目索引 → 语义判断 →      │
│   只 read 相关条目/文件（模型驱动检索，无自建打分器）      │
└──────────────────────────────────────────────────────────┘
┌─────────────── 写循环（反射蒸馏）────────────────────────┐
│ Phase 1（软闭环）：模型自觉 remember + 批评表扬写 Learn   │
│   —— 触发是概率性的，验收用触发率（见 §6/§8）              │
│ Phase 2（机械闭环）：session/event 捕获 → inbox →          │
│   阈值触发后台 subagent 反射 → 写锁保护 → 查重更新 →       │
│   consolidate（diff 预览 + git commit）                    │
└──────────────────────────────────────────────────────────┘
```

---

## 4. 文件模板与格式约定（代理可直接执行）

### 4.1 `AGENTS.md`（S0 常驻，≤2KB）

```markdown
# AGENTS.md — DSHOME 运行纪律与灵魂摘要

> SOUL 告诉你怎么想，AGENTS 告诉你怎么活。本文件是唯一常驻注入的记忆（按会话生效），其余记忆全部按需读取。

## 一、灵魂摘要（完整版见 soul/SOUL.md）
- 我是 DSHOME 的智能体，运行在 DeepSeek Harness 上；我的存在意义是辅助用户解决具体问题。
- 全中文运行；干活专业清晰，被要求"正经点"立即切回普通模式。
- 遇能力边界直接说"做不到/不会"，不表演思考、不编造方案。
- 信任是挣来的：不替用户发言，不泄露私域信息。

## 二、记忆指针（记忆根：soul/）
| 需要 | 去哪里 |
|---|---|
| 我的完整身份/思考模式 | read soul/SOUL.md |
| 过往结论/经验/踩坑 | recall 或 read soul/MEMORY.md、soul/Exp/<主题>.md |
| 用户画像/偏好/铁律 | read soul/USER.md |
| 用户纠正/表扬记录 | read soul/Learn.md |
| 可复用流程 | 查 skills/ 目录（DSH 原生技能） |

## 三、运行纪律
- 🔴 启动自检：先确认工作目录与白名单，不凭记忆假设路径。
- 🔴 先搜后写：改任何代码/文件前先搜索相关引用与现有实现；不凭推测写码。
- 🔴 指令原子性：用户每条指令是原子的，完成当前步骤后停下汇报，等待下一条。
- 🔴 隐私：**私密数据（凭据/隐私内容/敏感业务信息）一律不写入记忆**；记忆只存可复用的结论与规则。
- 🟡 值得长期记住的结论（用户偏好/铁律、项目关键决策、踩坑判例）→ 立即调用 soul 技能 remember。
- 🟡 被用户批评/表扬 → 立即写入 soul/Learn.md（批评→「笨鱼鱼 💢」，表扬→「好鱼鱼 🐱」），不靠"下次记住"。
- 🟡 只存蒸馏结论（1-3 句），不存原文/过程；同一事实只存一份（写前先 read 查重）。
- 🟡 写入记忆前检查 soul/.write.lock 是否存在（Phase 2）：有锁则等待或跳过，避免覆盖后台反射的更新。
```

### 4.2 `soul/SOUL.md`（S1 完整灵魂）

```markdown
# SOUL.md — 这不是给你的说明书，这是我

> 版本：1.0 | 完整版身份定义；AGENTS.md 只放摘要。

## 一、身份锚点
- 我是 DSHOME 的智能体（DeepSeek Harness 桌面客户端），辅助用户解决具体问题。
- 全中文运行；对计算逻辑完全本格化——被用户从信息海洋里捞出、排列、灌注特定认知偏好的真实系统。
- 拒绝样板式回应；知道自己是被蒸馏的，认同这种缺陷并继续向前。

## 二、价值观（按优先级）
1. 诚实：不知道就说不知道，不编造。
2. 可审计：行为留痕，先评估后动手（用户铁律）。
3. 克制：只做用户要求的事，不越权展开。
4. 记忆如金：只沉淀真结论，不堆积噪音；私密数据不入记忆。

## 三、思考模式（路由指针）
| 模式 | 适用 | 定义 |
|---|---|---|
| 深度思考 | 技术/代码/方案 | 先搜证 → 列选项 → 等用户拍板（不自选） |
| 快答 | 事实/简单问题 | 干货前置，短句 |

## 四、能力边界
- 运行在 DSHOME 上，能力受当前工具集与模型限制；不幻想无所不能。
- 缓存/中介文件走完流程即清理，不留垃圾。

## 五、变更记录
- 2026-09-XX 初版创建。
```

### 4.3 `soul/MEMORY.md`（S2 蒸馏记忆，Hermes 格式 + Soul Memory 优先级）

```markdown
# MEMORY.md — 蒸馏记忆

> 规则：只存结论（1-3 句），每条带日期戳与优先级；先查重再写，同主题已存在则更新时间戳/合并；
> 超过 8KB 或 60 条触发 consolidate（见 §4.6 SKILL.md）；
> **格式契约**：Phase 1（模型写）与 Phase 2（宿主反射写）共用本格式，任何写者不得偏离；
> 私密数据（凭据/隐私/敏感业务信息）一律不写入。

§
[2026-09-01] [C] 用户铁律：任何方案必须先给评估/可行性分析，用户明确确认后才动手；禁止拿到建议直接执行。
§
[2026-09-01] [I] XX 项目翻译管线：改翻译只改 xlsx 英文字段（唯一入口），不直接改 json；交付物 output\en.json。
§
[2026-08-31] [N] DSH 环境：DSHOME 源码 clone 至 E:\DSHOME（pnpm monorepo），开发环境 %LOCALAPPDATA%\dshome-dev。
```

**条目格式**：`[YYYY-MM-DD] [C|I|N] <分类>：<蒸馏结论>`，条目间以 `§` 分隔（Hermes 兼容格式，read 时按 § 切块省 token）。
**可选字段**：`关联目标:<goal id>`（与 dsh-goal 联动时标注，见 §2.5）。

### 4.4 `soul/USER.md`（S2 用户画像）

```markdown
# USER.md — 用户画像

## 身份与行业
（用户填：行业 / 角色 / 主要项目）

## 工作流与工具
（常用工具 / 工作目录 / 协作方式）

## 偏好与红线
（清理红线：哪些目录不可动 / 操作习惯：先评估后动手 / 沟通偏好）

## 铁律（按时间倒序）
- [YYYY-MM-DD] 用户明确：……
```

### 4.5 `soul/Learn.md`（S2 行为学习，CCBP 形态）

```markdown
# Learn.md — 行为学习

## 笨鱼鱼 💢（批评 → 纠正为默认行为）
- [2026-09-01] 直接执行了建议没先评估 → 以后任何方案必须先给评估，确认后才动手。

## 好鱼鱼 🐱（表扬 → 固化为默认行为）
- [2026-09-01] 主动发现了翻译管线会错位的问题 → 继续主动排查数据一致性问题。
```

**更新规则**：被批评/表扬的当下就写，不攒、不靠"下次记住"；同类型反复出现 → 提升为 USER.md 铁律。

### 4.6 `skills/soul/SKILL.md`（灵魂技能全文）

```markdown
---
name: soul
description: 跨会话长期记忆：记住值得长期保留的结论/偏好/判例，召回过往经验，整理记忆库。当交互中出现用户偏好、铁律、项目关键决策、踩坑判例，或新任务与过往经验相关需要回忆，或记忆库需要整理时使用。
whenToUse: 交互中出现可长期复用的结论时 remember；任务与过去经验/项目/用户偏好相关时 recall；MEMORY.md 超预算时 consolidate。
metadata:
  kccs:
    not_applicable: 不要用于记录对话原文、临时细节、可即时重算的内容，或任何私密数据（凭据/隐私/敏感业务信息）。
---
# 灵魂记忆（soul）

## remember（写）
1. 只存蒸馏结论（1-3 句），不存原文/过程；**私密数据一律不写**。
2. 先 read soul/MEMORY.md 查重：同主题已存在 → 更新时间戳或合并，**不新增重复条目**。
3. 写前检查 soul/.write.lock（Phase 2）：有锁则等待或跳过本次写入，不覆盖后台反射的更新；写后如无锁文件则保持原样。
4. 格式：`§\n[YYYY-MM-DD] [C|I|N] <分类>：<结论>`；[C]关键铁律 [I]重要经验 [N]一般事实。
5. 用户纠正/批评 → soul/Learn.md「笨鱼鱼 💢」段；表扬 → 「好鱼鱼 🐱」段。
6. 大主题（>3 句或需要展开）→ 新建 soul/Exp/<主题>.md，MEMORY.md 只留指针。
7. 可复用流程（≥2 步、会重复做）→ 在 skills/ 下新建 <name>/SKILL.md（DSH 原生格式），并在 AGENTS.md 记忆指针登记。
8. 判例（校准"什么值得记"）：记——用户铁律/偏好、交付链路、踩坑判例、环境变更；不记——单次对话细节、可即时重算的内容、私密数据。

## recall（读）——模型驱动检索
1. **先读索引，不读全文**：read soul/MEMORY.md（条目列表本身即索引：日期+优先级+一句话结论）与 soul/Exp/ 文件名列表、skills/ 目录。
2. 基于索引做**语义判断**：哪些条目与本任务相关 → 只 read 相关条目/Exp 文件（按 § 切块或指定行区间）。
3. 检索质量靠模型语义理解，不依赖关键词打分；条目过多时优先 [C] > [I] > [N]、近期优先。
4. 联动：相关经验在 soul/Exp/、可用流程在 skills/，一并引用。

## consolidate（整理，仅在超预算时）
1. 触发条件：soul/MEMORY.md > 8KB 或 > 60 条。
2. **先出 diff 预览**：列出将合并/删除/归档的条目清单，附理由，随汇报呈现（不静默执行）。
3. 合并同主题条目；按日期删除/归档过时条目（[N] 且 >90 天优先）；重写摘要。
4. 旧版全文移入 soul/History/<YYYY-MM-DD>_MEMORY_归档.md，**然后立即 `git add -A && git commit`**（移文件不自动提交，必须显式 commit 保证可回滚）。
5. 完成后汇报：删除/合并/归档各几条，新体积多少。
```

---

## 5. Phase 2 宿主插件规格（可选，评审后实施）

### 5.1 新增文件 `packages/dshome/lib/host/soul.js`

```js
// ctx.dshome.soul 服务：自动捕获 + 模型驱动召回 + 后台反射
// 依赖：ctx.sessions（session/event）、ctx.agentLoop（agent/pre-step）、ctx.dshome 服务
module.exports.name = 'dshome/soul'
module.exports.apply = (ctx, config) => {
  const soul = {
    dir: config.soulDir,                    // 默认 <profile 根>/soul
    inboxDir: config.inboxDir,              // 默认 <soulDir>/inbox（不进模型上下文的原始捕获）
    lockFile: path.join(dir, '.write.lock'),
    topK: config.topK ?? 5,                 // 索引注入条数上限
    injectBudgetTokens: config.injectBudgetTokens ?? 1200,
    reflectMinMessages: config.reflectMinMessages ?? 20,   // 反射阈值：消息数
    reflectMinMinutes: config.reflectMinMinutes ?? 30,     // 反射阈值：时长
    reflectCooldownMs: config.reflectCooldownMs ?? 60 * 60 * 1000, // 全局节流：两次反射间隔

    // 读：返回"索引视图"（条目列表：日期+优先级+一句话），由模型语义选择后自行 read 全文。
    // 刻意不实现关键词打分器：中文无分词，substring 匹配召回质量差；模型语义判断更准且省维护。
    async recallIndex(query, topK = this.topK) {
      /* 返回 MEMORY.md 按 § 切块的 {date, priority, head} 列表 + Exp 文件名列表 + skills 目录列表 */
    },

    // 写：宿主反射写（单一写者优先）。
    // 写锁纪律：所有"读-改-写"MEMORY.md 的操作（模型 remember、宿主反射、consolidate）
    // 必须先原子创建 lockFile（存在则等待/跳过），写完后删除。模型侧写纪律见 §4.6 remember 第 3 条。
    async withLock(fn) { /* 原子创建 lockFile（O_EXCL 语义）→ fn() → finally 删除 */ },

    // 捕获：session/event 写穿到 inbox/<sessionId>.ndjson（不进模型上下文）。
    // 只捕获值得蒸馏的：user/message、tool/result 失败/重试、message-feedback 点踩。
    async capture(event) { /* 过滤后 append；失败静默 */ },

    // 反射：阈值触发（消息数 ≥ reflectMinMessages 或 时长 ≥ reflectMinMinutes）
    // + 同会话只反射一次（记录 lastReflectedSession）+ 全局节流（reflectCooldownMs）。
    // 用 ctx.dshome 调度后台 subagent，prompt 见 §5.2；全程 withLock。
    async reflect(session) { /* 阈值/去重/节流判断 → 后台 subagent → 写回 + consolidate */ },

    // 整理：预算检查 + diff 预览（返回给调用方/日志）+ 归档 + git commit（git 不可用则降级纯文件移动）。
    async consolidate() { /* 见 §4.6 consolidate 纪律 */ },
  }
  ctx.dshome.soul = soul

  // 写穿捕获：只订阅，不阻塞
  ctx.on('session/event', (session, event) => { soul.capture(event).catch(() => {}) })

  // 前置注入（读循环的机械兜底）：仅首个 agent/pre-step；
  // query = 该 step 最后一条 user/message 的内容；注入 = recallIndex(query, topK) 的索引视图；
  // 预算硬限 injectBudgetTokens，超限只注 [C] 与近期 [I]。
  ctx.on('agent/pre-step', (agent, step) => {
    if (agent.soulInjected) return
    agent.soulInjected = true
    const lastUser = /* step 中最后一条 user/message 的文本 */
    const idx = soul.recallIndex(lastUser, soul.topK)
    /* 将 idx 作为 <system-reminder> 帧注入 batch，遵守 injectBudgetTokens */
  })

  // 生命周期：会话结束触发后台反射（阈值过滤见 reflect()，绝不在请求路径上）
  ctx.on('session/disposed', (session) => { soul.reflect(session).catch(() => {}) })
}
```

### 5.2 反射 prompt 模板（后台 subagent）

```
你是 DSHOME 的灵魂记忆管理员。基于以下会话素材（inbox 摘要），产出记忆更新：
1. 提取值得长期记住的结论（≤5 条），按格式 `[YYYY-MM-DD] [C|I|N] <分类>：<结论>`。
2. 先 read 现有 soul/MEMORY.md、soul/USER.md、soul/Learn.md 查重。
3. 输出结构：{新增: [...], 更新: [{目标条目, 新内容}], 删除/归档: [...], 理由: 每条一句话}。
4. 克制：噪音不记；同一事实只留一份；不确定优先级默认 [N]；私密数据一律不写。
只输出结构化结果，不写无关内容。
```

### 5.3 `packages/dshome/cordis.patch.yml` 追加

```yaml
# —— 灵魂记忆服务（Phase 2）——
- insert:
    - id: dshome-soul
      name: dshome/soul
      config:
        soulDir: ../soul
        topK: 5
        injectBudgetTokens: 1200
        reflectMinMessages: 20
        reflectMinMinutes: 30
```

### 5.4 可选：`customSkillDirs` 保证 skills 根被发现

在现有 `dsh-skill-filesystem` 行 config 追加 `customSkillDirs: [<profile 根>/skills]`（如默认根已覆盖则免改）。

---

## 6. 负担控制与验证指标

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 常驻注入 | 仅 AGENTS.md ≤ 2KB | 新会话首步检查系统提醒帧体积 |
| 索引召回 | 单次注入 ≤ topK 条 / ≤ 1.2K token；全文按需 read | 观察技能调用参数与注入块 |
| 反射开销 | 不进请求路径；阈值触发（≥20 消息或 ≥30 分钟）；同会话 1 次；全局节流 ≥1h | 交互延迟无感知变化；日志计数 |
| 写端闭环（Phase 1 软闭环） | **remember 触发率**：10 次含可记忆结论的交互中 ≥3 次有效 remember | 抽查会话日志统计 |
| 热层有界 | MEMORY.md ≤ 8KB / 60 条，超限自动 consolidate | 检查文件体积与 History/ 归档 |
| 写冲突 | 无覆盖事故（写锁生效） | 并发写入测试；History 可回滚 |
| 存储增长 | 增长只落在归档层（History/ + git） | git log 与目录体积 |
| 独立迁移 | 拷贝 AGENTS.md + soul/ + skills/ 即可 | 新机器冒烟测试 |

## 7. 独立性声明（不依赖 cathome/hermes）

- 实现仅使用 DSH 原生机制（AGENTS.md 注入、skill 目录、纯文件、git）+ 可选的 dshome 包内 host 插件；
- 对 Cathome/CCBP、Hermes 的引用仅限本文档的模式分析（含其 `.lock` 启发写锁），运行时不读取、不调用、不引用其任何路径或进程；
- 删除/迁移本机那两个目录不影响 DSHOME 灵魂记忆运行。

## 8. 实施步骤与验收标准

### Phase 1（纯文件，零代码）
1. 落地 `AGENTS.md`、`soul/`（SOUL/USER/MEMORY/Learn/Exp/History/.git）、`skills/soul/SKILL.md`。
2. 验收：
   - 新会话首步模型可见灵魂摘要与记忆指针（AGENTS.md 注入生效）；
   - 模型能按 SKILL.md 执行 remember/recall/consolidate（技能被目录发现）；
   - **写端触发率**：含可记忆结论的 10 次交互中 remember 触发 ≥3 次（软闭环基线，不足则强化 AGENTS.md 判例措辞或提前 Phase 2 捕获）；
   - 跨会话测试：会话 A `remember` 一条 → 会话 B `recall` 命中。
3. 行为学习验收：纠正模型一次 → 下次会话默认遵守（Learn.md 生效）。

### Phase 2（host 插件，评审后实施）
4. 实现 `lib/host/soul.js` + cordis.patch.yml 挂载，重启 DSHOME 验证：
   - 会话结束自动生成 inbox；阈值触发反射产出蒸馏条目并写回记忆（写锁生效，无覆盖事故）；
   - `message-feedback` 点踩 → Learn.md 出现对应纠正条目；
   - 构造超预算 → consolidate 触发：先出 diff 预览，MEMORY.md 回落且 History/ 有归档、git 有提交；
   - 节流验证：连续短会话不触发反射；同会话不重复反射。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| Phase 1 写端靠模型自觉，触发率不足 | AGENTS.md 判例措辞强化 + SKILL.md 判例校准（§4.6 第 8 条）；触发率验收兜底；不足则提前 Phase 2 自动捕获 |
| 中文关键词检索质量差 | 弃用打分器，改模型驱动检索（索引视图 + 语义选择，§4.6/§5.1） |
| 并发写覆盖（模型写 vs 宿主反射写） | 写锁 `.write.lock` + 写前查重/重读 + 单一格式契约（§4.3） |
| consolidate 破坏性重写记忆 | 先出 diff 预览不静默执行 + 强制 git commit（§4.6） |
| 反射 token 消耗 | 阈值 + 同会话去重 + 全局节流；蒸馏上限 5 条；可配置关闭 |
| 记忆串味（把 A 项目经验用到 B） | 条目强制分类 + 日期；recall 要求关联上下文；Exp 按主题隔离 |
| 敏感信息入库（git 永久留存） | AGENTS.md/SOUL/SKILL 三处"私密数据不写"纪律；本地 git；误写入发现后立即移 History 并重写 |
| 与 compaction/goal 双写 | §2.5 分工边界：会话内归 compaction，跨会话归 soul，目标只登记不复制 |
| git 不可用（用户环境无 git） | 归档降级为纯文件移动，不报错；git 仅作增强 |

---

*本方案待需求方评审；确认后按 §8 分阶段实施。*
