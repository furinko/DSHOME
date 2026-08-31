# DSHOME 架构说明（现状）

> 版本：1.0 ～创建：2026-08-31 ～定位：**现状架构 + 设计决策记录**（历史设计文档已归档移除，本文为唯一架构参考）
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）

---

## 1. 定位与形态

DSHOME = 基于 DeepSeek Harness 的个人桌面客户端：**独立 profile + Electron 薄壳 + 自主题/品牌 + 市场/插件管理 + 灵魂记忆体系**。

```
E:\DSHOME\（monorepo，pnpm workspace）
├─ packages/
│  ├─ dshome/            # 主 bundle：host 插件 + client 插件 + Electron shell-app + 部署脚本
│  ├─ dshome-theme/      # 客户端皮肤（品牌 token + 设置 UI：通知开关、插件管理分区）
│  └─ dshome-palette/    # Ctrl+K 命令面板
├─ profiles/dshome/      # 本机开发 profile（package.json + cordis.patch.yml 被跟踪为部署参考）
├─ vendor/               # 仓库内依赖（dsh-evolve tgz，消除 GitHub 下载依赖）
├─ docs/                 # 灵魂记忆体系文档（行为层 / 冒烟 / 归档方案）
├─ AGENTS.md             # 灵魂行为层：每会话注入的纪律与记忆指针（$DSH_HOME/AGENTS.md）
└─ soul/Learn.md         # 行为学习模板（笨鱼鱼💢 / 好鱼鱼🐱，条目本机私有不推仓库）
```

## 2. Patch 分层组合机制（profile = 4 层 patch 叠加）

```
dsh --profile dshome 启动时 composeProfile 依序应用：
L1  @deepseek-ai/dsh-base      核心行（session/llm/tools/skill-filesystem/agent-loop…）
L2  @deepseek-ai/dsh-web-app   浏览器面（webserver/web-runtime/官方 client roster）
L3  dshome/cordis.patch.yml    自有 host 插件 + web-runtime/webserver 覆盖
L4  profiles/dshome/cordis.patch.yml  本机覆盖（apiKeyEnv 技巧、禁用 dshome-desktop）
行语义：后层同 id 整体替换 config（不合并）；- insert 追加；disabled: true 停用基座行。
```

## 3. Host 插件职责（packages/dshome/lib/host/）

| 插件 | 职责 | 状态 |
|---|---|---|
| `dshome/core` | 扩展点服务 `ctx.dshome = { commands, panels }`（注册表） | 骨架预留，**暂无消费者**（见 §10） |
| `dshome/shell` | Electron 壳：spawn 后端 + 崩溃自动重启（指数退避）+ 托盘（重启/安全模式/退出） | 活跃 |
| `dshome-theme` | 品牌皮肤 + 设置 UI（通知开关、插件管理分区） | 活跃 |
| `dshome-palette` | Ctrl+K 命令面板 | 活跃 |
| `dshome/notify` | 回合级系统通知（设置命名空间 `dshome`） | 活跃 |
| `dshome/plugin-manager` | 已装插件列表 + 启/停（写 profile patch 文件，重启生效） | 活跃 |
| `dshome/desktop` | 自供 desktop 四服务（旧市场接口） | **已禁用**（接口不匹配 dshmarket） |

**护栏模式**（所有 host 插件一致）：服务挂载 try/catch，失败只记日志、绝不阻断 profile 启动。

## 4. 外部集成

| 包 | 用途 | 来源 |
|---|---|---|
| dshmarket | 插件市场（设置 → Plugin Market） | npm ^1.38.1 |
| dsh-whale-widget | DeepSeek 余额鲸鱼挂件 | npm ^0.2.10 |
| dsh-better-sidebar | 侧边栏工作台 | npm 0.17.1 |
| dsh-evolve | 跨会话记忆 + 技能固化（22 工具、审批门、零 token 召回、git checkpoint） | **vendor/**（仓库内 tgz，避免 GitHub 依赖） |

## 5. 灵魂记忆体系（2026-08-31 落地）

```
机制层  dsh-evolve       记忆存储（storage domain + MEMORY.md 镜像 + evolve-workspace/.git checkpoint）
                        召回（bigram+FTS5+RRF 零 token）→ agent/pre-step 注入
                        审批门（pending/auto-confirm）→ 技能固化（crystallize/refine/archive/rollback）
灵魂层  AGENTS.md        每会话首步注入（≤2KB：身份摘要 + 记忆指针 + 运行纪律），按会话粒度生效
行为层  soul/Learn.md    批评→「笨鱼鱼💢」/表扬→「好鱼鱼🐱」即时记录（双写 evolve lesson）
运维层  skills/dsh-evolve-integration  结晶的运维知识技能
```
细节见 `docs/DSHOME-SOUL-BEHAVIOR.md`、`docs/DSHOME-EVOLVE-SMOKE.md`。

## 6. 数据与存储（均在 DSH_HOME 下）

| 路径 | 内容 | 是否进 git |
|---|---|---|
| `sessions/` | 会话事件日志（jsonl.zstd） | ❌ ignore |
| `storages/` | storage domain（会话缓存、evolve 记忆 JSON） | ❌ ignore |
| `evolve-workspace/` | dsh-evolve 私有工作区（MEMORY.md 镜像 + 独立 git + 备份） | ❌ ignore |
| `settings.yaml` | plugin-manager 管理视图（含 apiKeyEnv 配置） | ❌ ignore |
| `AGENTS.md` / `soul/` / `skills/` | 灵魂层（模板提交，**具体条目本机私有**） | ✅ 模板提交 |

## 7. 部署模型（三条路径各司其职）

| 场景 | 入口 | 产物 |
|---|---|---|
| 新机器装开发环境 | `setup-dev.cmd` | 免安装 node+pnpm（%LOCALAPPDATA%\dshome-dev）+ 依赖 |
| 新设备部署（给别人用） | `packages/dshome/scripts/deploy-new-device.cmd` | 用户级 profile（%USERPROFILE%\.dsh\profiles\dshome，基于 profile-template）+ 灵魂层拷贝 + 桌面快捷方式 |
| 本机开发启动 | `开发启动.cmd` | Electron 壳拉起后端（DSH_HOME = 仓库根） |

**注意**：开发（仓库内 profile，DSH_HOME=E:\DSHOME）与部署（用户级 profile，DSH_HOME=%USERPROFILE%\.dsh）是**两套 DSH_HOME**——灵魂层/记忆按 DSH_HOME 隔离，各自自进化，不串味。

## 8. 设计决策记录（rationale，别轻易改）

| 决策 | 原因 |
|---|---|
| 端口 **3099** | 与官方 web（3080）错开；旧基线 3081 已弃（stop.cmd 已同步） |
| `apiKeyEnv: DSHOME_USER_KEY`（指向**不存在**的 env） | 官方 UI 判定"引用的 env 无值 → 需用户提供" → 输入框可编辑；key 存 dsh 凭证库。若指向真实 env 则 UI 锁定只读 |
| 禁用 `dshome/desktop` | 其 desktopPnpm 接口 `{ run }` 与 dshmarket 期望的 `{ runPlugin }` 不匹配 → service.runPlugin is not a function；禁用后 dshmarket 回退普通 `dsh plugin` CLI 路径（已验证可用） |
| dsh-evolve **vendor** 进仓库 | 作者无 npm 包；vendor 后 pnpm install 全本地，作者删库/网络不可达均不影响部署 |
| 插件启停写 **patch 文件**（非 settings.yaml） | patch 是加载真相；settings.yaml 只是 plugin-manager 的管理视图（**两者可能漂移，排查以 patch 为准**） |
| 版本全锁定 `0.1.1-rc.2` | 上游 DSH 一致性；升级 = 全量 bump（preset-pkgs.txt） |
| 护栏模式不阻断启动 | 单插件故障不拖垮整个 profile |
| 记忆/灵魂内容**不推仓库** | 框架与流程可推；具体记忆/技能/行为条目是本机私有（.gitignore + 脱敏约定） |

## 9. 已知设计债 / 风险（2026-08-31 记录）

1. `dshome/core` 扩展点（commands/panels）**零消费者**——契约未经实战，未来插件接入前先验证；
2. settings.yaml 管理视图与 patch 加载真相可能漂移（已见实例：视图显示 disabled 但实际加载）；
3. 记忆内容正确性依赖审批门 + 人工确认（模型可谎报 anchoredToUser 绕过低重要性 auto-confirm，高重要性仍人工）；
4. 灵魂层（AGENTS.md）是静态模板，不随经验进化（行为层进化、身份层恒定——有意取舍）；
5. 部署后模板更新不传播（本地 AGENTS.md 与仓库模板分叉——自进化优先，符合意图）。
