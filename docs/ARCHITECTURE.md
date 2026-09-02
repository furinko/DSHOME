# DSHOME 架构说明（现状）

> 版本：2.0 ～创建：2026-08-31 ～更新：2026-09-02（心智体系重构：dsh-evolve 退役 → mind/ 纯文件心智 + 可视化图谱）
> 定位：**现状架构 + 设计决策记录**（历史设计文档已归档移除，本文为唯一架构参考）
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）

---

## 1. 定位与形态

DSHOME = 基于 DeepSeek Harness 的个人桌面客户端：**独立 profile + Electron 薄壳 + 自主题/品牌 + 市场/插件管理 + 鱼鱼心智体系**。

```
E:\DSHOME\（monorepo，pnpm workspace）
├─ packages/
│  ├─ dshome/            # 主 bundle：host 插件 + client 插件 + Electron shell-app
│  ├─ dshome-theme/      # 客户端皮肤（品牌 token + 设置 UI：通知开关、插件管理分区）
│  ├─ dshome-palette/    # Ctrl+K 命令面板
│  ├─ dshome-plugin-center/  # 插件管理中心（client-only，sidebar 入口）
│  ├─ dshome-assistant-identity/ # 对话区助手形象（client-only，localStorage 持久化）
│  └─ dshome-mind/       # 心智图谱面板（host /api/mind/* + client conversation.view「心智」）
├─ mind/                 # 🧠 鱼鱼心智出厂固件（L0 宪法 / L1 法律 / L2 能力 / L3 记忆 + Project + TRASH）——入库可推送
├─ mind-private/         # 🧠 鱼鱼心智本机实例（真实记忆/项目/Learn 条目/个性化）——gitignore，永不推送
├─ profile-template/     # 示例 profile 脚手架
├─ profiles/dshome/      # 本机开发 profile（package.json + cordis.patch.yml 被跟踪为部署参考；patch 现为本机覆盖位，产品覆盖在 L3）
├─ docs/                 # 文档中心（分类导航见 docs/README.md；退役体系文档在 docs/archive/）
├─ AGENTS.md             # 心智 L0 宪法·每会话注入（$DSH_HOME/AGENTS.md，DSH 机制决定留仓库根）
└─ build-stage/          # 构建产物与迁移备份（gitignore；退役资产在 mind-migration-backup-*/retired/）
```

## 2. Patch 分层组合机制（profile = 4 层 patch 叠加）

```
dsh --profile dshome 启动时 composeProfile 依序应用：
L1  @deepseek-ai/dsh-base      核心行（session/llm/tools/skill-filesystem/agent-loop…）
L2  @deepseek-ai/dsh-web-app   浏览器面（webserver/web-runtime/官方 client roster）
L3  dshome/cordis.patch.yml    自有 host/client 插件 + web-runtime/webserver 覆盖
L4  profiles/dshome/cordis.patch.yml  本机覆盖位（预留；apiKeyEnv 技巧、禁用 dshome-desktop 已并入 L3）
行语义：后层同 id 整体替换 config（不合并）；- insert 追加；disabled: true 停用基座行。
```

## 3. Host 插件职责（packages/dshome/lib/host/ + 独立包）

| 插件 | 职责 | 状态 |
|---|---|---|
| `dshome/core` | 扩展点服务 `ctx.dshome = { commands, panels }`（注册表） | 骨架预留，**暂无消费者**（见 §9） |
| `dshome/shell` | Electron 壳：spawn 后端 + 崩溃自动重启（指数退避）+ 托盘（重启/安全模式/退出） | 活跃 |
| `dshome-theme` | 品牌皮肤 + 设置 UI（通知开关、插件管理分区） | 活跃 |
| `dshome-palette` | Ctrl+K 命令面板 | 活跃 |
| `dshome/notify` | 回合级系统通知（设置命名空间 `dshome`） | 活跃 |
| `dshome/plugin-manager` | 已装插件列表 + 启/停（写 profile patch 文件，重启生效） | 活跃 |
| `dshome/desktop` | 自供 desktop 四服务（旧市场接口） | **已禁用**（接口不匹配 dshmarket） |
| `dshome-plugin-center` | 插件管理中心（client-only） | 活跃 |
| `dshome-assistant-identity` | 对话区助手形象（client-only） | 活跃 |
| `dshome-mind` | 心智图谱：host `/api/mind/{status,read,graph}` + client `conversation.view`「心智」tab | 活跃（v2 图谱） |

**护栏模式**（所有 host 插件一致）：服务挂载 try/catch，失败只记日志、绝不阻断 profile 启动。

## 4. 外部集成

| 包 | 用途 | 来源 |
|---|---|---|
| dshmarket | 插件市场（设置 → Plugin Market） | npm ^1.38.1 |
| dsh-whale-widget | DeepSeek 余额鲸鱼挂件 | npm ^0.2.10 |
| dsh-better-sidebar | 侧边栏工作台（参考 tab 生态，心智面板不依赖它） | npm 0.17.1 |

> dsh-evolve（记忆插件）已于 2026-09-02 **退役**：vendor tgz 与工作区移入 `build-stage/mind-migration-backup-20260902/retired/`，记忆迁移至 `mind-private/L3/`，心智改为**纯文件系统**（零记忆插件依赖）。

## 5. 心智体系（2026-09-02 重构，替代 dsh-evolve/soul）

### 5.1 四阶 + 双区

```
四阶（参考 Cathome CCBP + Hermes 轮级缓冲）：
L0 宪法  SOUL（人格）/ USER（关系，通用模板）/ AGENTS（纪律·常驻注入）/ TOOL（工具索引）
L1 法律  HUB / Wisdom / Tree（全索引）/ Power / Memory（归档规则）/ Dream（灵感）/ Learn（教训）
L2 能力  Skill（方法论·frontmatter 标准化）/ Exp（工具手册）
L3 记忆  index（结晶知识·按主题 + _index）/ history（时间胶囊·只写不改）
Project 行动锚点（project.md，与 L0-L3 平级）
TRASH   不删只移，可恢复

双区（隐私边界）：
mind\         出厂固件 = 架构 + 默认内容 → 入库，可推送 GitHub
mind-private\ 本机实例 = 真实记忆/项目/Learn/个性化 → gitignore，同名私有优先
```

### 5.2 加载模型与记忆流

```
加载：注入层（L0 + AGENTS 每会话首步）→ 强制层（上工读 L1/Tree+Power+Memory+Dream+Learn）
      → 查询层（L2 关键词触发 / L3 grep 按需）
记忆流：正式拍板 → 实时落通用层；未定型 → 轮级缓冲（mind-private/tasks/00_约定）
      → 收工闭环 7 步 → 蒸馏入 L3/通用层（Hermes soyawl 模式）
导入：import-artifact 技能（L2）——其他设备/agent 产物"直接丢给鱼鱼"即插即用
      （识别 → 校验 → 归类落 mind-private → 索引 → git checkpoint → 汇报）
```

### 5.3 自动化与可视化（dshome-mind 插件）

- host：`/api/mind/status`（双区树）、`/api/mind/read`（文件内容，loopback fence + 路径穿越防护）、`/api/mind/graph`（frontmatter related → 节点+边）
- client：注册 `conversation.view` 槽位（与「对话/轨迹」同级）→ SVG 分层图谱（层带/节点自适应/关联线/详情/搜索/缩放）

### 5.4 旧体系退役记录

dsh-evolve（22 工具/JSON 存储/自动召回注入）→ 2026-09-02 退役：40+ 记忆按主题迁 `mind-private/L3/index/` 7 主题 + Project 档案 + Learn 迁移；技能归档 history；插件从 profile 移除；资产备份 `build-stage/mind-migration-backup-20260902/retired/`。

## 6. 数据与存储（均在 DSH_HOME 下）

| 路径 | 内容 | 是否进 git |
|---|---|---|
| `sessions/` | 会话事件日志（jsonl.zstd） | ❌ ignore |
| `storages/` | storage domain（会话缓存等） | ❌ ignore |
| `mind-private/` | 心智本机实例（记忆/项目/Learn） | ❌ ignore（隐私红线） |
| `build-stage/` | 构建产物 + 迁移备份/退役资产（DSHOME.iss 例外入库） | ❌ ignore（!DSHOME.iss） |
| `settings.yaml` | plugin-manager 管理视图（含 apiKeyEnv 配置） | ❌ ignore |
| `router-standard/` `.agent-presets/` | 运行时诊断/preset 状态（开机再生） | ❌ ignore |
| `updates.json` | Electron 壳版本源（version/url/sha256，updater.cjs 从 GitHub raw 固定拉取） | ✅ 发布清单（随版本发布同步） |
| `mind/`（出厂模板） `AGENTS.md` `docs/` | 心智框架/纪律/文档 | ✅ 模板与框架提交（具体条目在 mind-private） |

## 7. 部署模型（三条路径各司其职）

| 场景 | 入口 | 产物 |
|---|---|---|
| 新机器装开发环境 | `setup-dev.cmd` | 免安装 node+pnpm（%LOCALAPPDATA%\dshome-dev）+ 依赖 |
| 新设备部署（给别人用） | clone + `setup-dev.cmd`（见 README「上手」） | 仓库即应用；dsh 首启自建 profile |
| 本机开发启动 | `开发启动.cmd` | Electron 壳拉起后端（DSH_HOME = 仓库根） |

> 注：历史文档曾引用 `packages/dshome/scripts/deploy-new-device.cmd`——**该脚本从未存在**，2026-09-02 已从 README/文档清除；新设备流程以 README「上手」为准。

## 8. 设计决策记录（rationale，别轻易改）

| 决策 | 原因 |
|---|---|
| 端口 **3099** | 与官方 web（3080）错开；旧基线 3081 已弃 |
| `apiKeyEnv: DSHOME_USER_KEY`（指向**不存在**的 env） | 官方 UI 判定"引用的 env 无值 → 需用户提供" → 输入框可编辑；key 存 dsh 凭证库（2026-09-01 起该覆盖在 L3 随包分发） |
| 禁用 `dshome/desktop` | desktopPnpm 接口 `{ run }` 与 dshmarket 期望的 `{ runPlugin }` 不匹配；禁用后回退普通 `dsh plugin` CLI（2026-09-01 起并入 L3） |
| 心智**纯文件化**（弃 dsh-evolve，2026-09-02） | 改 vendor 升级会被覆盖 + 无任务生命周期 + 大文档塞不进；文件系统人可读、可 git、可打包即插即用、隐私边界天然清晰；检索靠 Tree 索引 + grep（宿主工具），蒸馏靠收工闭环 |
| 心智**双区**（mind\ 入库 / mind-private\ ignore） | 上传仓库的是架构 + 默认内容；运行时自进化（记忆/项目/Learn）是本机隐私，永不推送；同名私有优先 |
| 面板注册 `conversation.view`（对话/轨迹同级） | 用户要求的位置；官方 view 槽位（chat/trajectory 同机制），非 better-sidebar 右侧栏 |
| 图谱 **SVG 自绘**（非 cytoscape） | cytoscape 在 client 模块表可用性不确定；分层图谱自绘零依赖且契合 L0-L3 层级 |
| 插件启停写 **patch 文件**（非 settings.yaml） | patch 是加载真相；settings.yaml 只是管理视图（**两者可能漂移，排查以 patch 为准**） |
| 版本全锁定 `0.1.1-rc.2` | 上游 DSH 一致性；升级 = 全量 bump |
| 护栏模式不阻断启动 | 单插件故障不拖垮整个 profile |
| 心智条目**不推仓库** | 框架与流程可推；具体记忆/技能/行为条目是本机私有（mind-private gitignore） |

## 9. 已知设计债 / 风险（2026-09-02 更新）

1. `dshome/core` 扩展点（commands/panels）**零消费者**——契约未经实战；
2. settings.yaml 管理视图与 patch 加载真相可能漂移（已见实例：视图显示 disabled 但实际加载）；
3. 纯文件心智**无自动召回/注入**（dsh-evolve 时代有）——靠 Tree 索引 + 上工强制加载 + grep；任务相关性检索依赖协议纪律，未来可加自研轻量索引（bigram 文件级，可选）；
4. 心智图谱**边稀疏**——frontmatter `related` 需随技能/记忆沉淀持续补充；`_index`/同 tags 关联暂未成边（可扩展 /api/mind/graph）；
5. 面板（conversation.view）为会话作用域——无活跃会话时 view 不可用（官方 view 同约束，心智读文件本可独立，未来可考虑全局挂点）；
6. 部署后出厂模板更新不传播（mind\ 与本地 mind-private 分叉——自进化优先，符合意图）。

---

_版本：2.0 | 2026-09-02 | 心智体系重构：dsh-evolve 退役 → mind/ 双区 + dshome-mind 图谱；文档清理（archive/）_
