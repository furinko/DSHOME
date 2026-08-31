# DSHOME 客户端设计方案（骨架版）

> 版本：v1.0 ～状态：已与需求方确认，待实施 ～目标读者：实施者（DeepSeek + dsh 代理）与需求方本人
> ⚠️ 历史设计文档：内含当时本机绝对路径（E:\DSH 等）与已移除的调试工具（cdp-*/probe-*/wrapper 等，2026-08-31 清理），仅作设计参考，路径与工具均已过时。

---

## 1. 项目定位

**DSHOME** 是一款面向个人使用的 DeepSeek Harness 桌面客户端：

- **形态**：桌面壳（Desktop Shell），自有客户端 bundle（路径乙）。
- **原则**：骨架先行，能力插件化——MVP 只交付能跑通的骨架 + 预留扩展点，后续所有功能（主题、命令面板、会话置顶、附加面板、远程访问）一律以插件形式生长，不改骨架。
- **开发方式**：使用 DeepSeek + dsh（AI 代理）实施，本方案精确到文件结构、补丁行、依赖清单与验收标准，代理可直接执行。
## 2. 已确认决策
| 决策项 | 定案 |
|---|---|
| 项目名 / npm 包名 | **DSHOME** / `dshome`（npm 名已验证为空闲） |
| profile 名与启动命令 | `dsh --profile dshome` |
| 客户端路径 | 路径乙：独立 profile bundle，官方 client 模块打底 + 自有覆盖层 |
| 外壳形态 | 薄壳：桌面窗口 + 托盘 + 单实例 + 后端监测（参考 dsh-clean-desktop-shell / dsh-plugin-desktop 兼容模式） |
| MVP 范围 | 骨架跑通（A 独立入口 + B 薄壳层 + 扩展点预留），零多余功能 |
| 界面语言 | 中文 |
| 首发平台 | Windows x64；macOS 二期 |
| 目标用户 | 个人自用 |
| 技术栈 | Node 24 + TypeScript（骨架可先纯 JS），Cordis 4 + DSH 核心包（钉死 `0.1.1-rc.2`），Electron（壳运行时） |
| 上游策略 | 跟随 DeepSeek Harness 官方 `@deepseek-ai/*` 包（含 DSH Desktop 的 pin 策略） |

## 3. 背景：DSH "客户端" 的本质（已核实的事实）
以下机制来自对本机 DSH Desktop 2.0.3（`dsh-plugin-desktop`）打包产物的逆向核实，均为真实字段与行为。
1. **Profile = 一个 Cordis 应用**。`dsh --profile <name>` 启动一个独立的 Cordis 运行时（Host 进程），由几个 **bundle 补丁（cordis.patch.yml）** 组装。
   - 第 1 层：`@deepseek-ai/dsh-base`（"every profile's first patch layer"，77 个依赖，插入核心行：timer / hmr / llm / session / typert / …）
   - 第 2 层：模式 bundle——浏览器面 `@deepseek-ai/dsh-web-app`（在 dsh-base 之上叠加 webserver / web-runtime / 官方 client roster）；无头 `@deepseek-ai/dsh-headless`
   - 第 3 层：profile 自己的 `cordis.patch.yml`
   - 第 4 层：CLI `--patch` 覆盖层
   - **行语义**：同一 `id` 的后层补丁**整体替换**该行 config（不合并）；`- insert:` 追加新行；`disabled: true` 停用基座行；`name: pkg` 或 `name: pkg/subpath` 定位插件。
2. **客户端 UI = 一个 client roster**。`cordis.patch.yml` 中以 `insert` 挂载的 `dsh-client-*` 行既是 host 插件节点，也是 **browser roster**：由 `dsh-client-modules` 的 node 半部扫描整棵依赖树，组装成 `window.__DSH_BOOT__`；浏览器端 `dsh-client-runtime` + `dsh-cordis-client-runner` 在页面里启动浏览器端 Cordis。
3. **官方 web roster 全部行**（来自 `dsh-web-app/cordis.patch.yml`，均可按需裁剪/插拔）：
   `modules`、`connection`、`api-remotes`、`client-runtime`、`cordis-client-runner`、`ui-theme`、`locale`、`ui-layout`、`ui-renderer`、`ui-sidebar`、`ui-settings`、`ui-settings-general`、`ui-settings-models`、`ui-settings-plugin-inventory`、`ui-conversation`、`ui-brand-official`、`ui-attachment`、`ui-tool`、`ui-cordis`、`ui-workflow-run`、`ui-deliverables`、`ui-workspace`、`ui-input-trigger`、`ui-commands`、`ui-skill`、`ui-subagent`、`ui-reference`、`ui-jobs`、`ui-goal`、`ui-message-feedback`、`ui-model-selection`、`ui-permission`、`ui-agent-preset`、`ui-settings-plugins`、`ui-plan`、`ui-user-questions`、`ui-trajectory`
4. **补丁覆盖模板（桌面兼容模式）** = `dsh-plugin-desktop/cordis.patch.yml`：在 web bundle 之上 insert `desktop-shell / desktop-terminal / desktop-notifications / desktop-pnpm / desktop-profiles / desktop-updates`，并覆盖 `web-runtime` 为 `openBrowser: false / printUrl: false / surfaceContext: true / trustedHosts: []`。
5. **插件形态薄壳先例** = `dsh-clean-desktop-shell`（Icather）：挂在现有 profile 上，提供系统托盘、单实例、后端活性监测 + 离线页 + 自动重连、托盘一键启停后端、桌面快捷方式、检查更新；Electron 运行时首次联网自动准备（约 1~2 分钟），不做任何视觉改动。
## 4. 总体架构

```
dshome（npm 包，profile bundle）
├─┬─ cordis.patch.yml           # profile 第 3 层补丁：组装下面 4 个行
├─┬─ dshome/shell       (host)  # Electron 薄壳：窗口/托盘/单实例/后端监测/通知
├─┬─ dshome/core        (host)  # DSHOME 服务：commands / panels 注册表（未来插件的扩展点）
├─┬─ dshome/client-core (client)# 浏览器端核心：插槽与命令注册，与 host 服务对应
└─┬─ dshome/theme       (client)# DSHOME 主题（覆盖官方 ui-theme）
         │         │         │
         │  依赖/行引用  │
         ├─  @deepseek-ai/dsh-web-app（第 2 层：webserver / web-runtime / 官方 client roster）
         └─  @deepseek-ai/dsh-base （第 1 层：host 核心行）
```

启动链路：`dsh --profile dshome` 的 composeProfile 依序应用 `dsh-base → dsh-web-app → dshome` 三层补丁 → host 启动（webserver 绑定专属端口）→ `dshome/shell` 拉起 Electron 窗口加载 `http://127.0.0.1:<port>` → 浏览器端 Cordis 用 `__DSH_BOOT__` roster 启动官方 UI + DSHOME 覆盖层。
**取舍说明**：骨架阶段复用官方 web bundle 作为浏览器面（兼容模式），理由：
- 官方对话/输入/审批/设置能力零成本继承，符合"骨架跑通"目标；
- dshome 层可随时覆盖任意行的 config、停用官方行、插入自有 client 插件——"后续长出自己界面"的路径是现成的（替换 roster、插槽注册、自绘组件均可逐步替换官方行实现）；
- 不复用 `dsh-plugin-desktop` 本身，外壳与配置归属全是 DSHOME 自己的。
## 5. 仓库与包结构（骨架）
一个 npm 包（`co type: module`），先纯 JS 最小化，需要时再迁 TS。
```
dshome/
├─ package.json               # name: dshome；dsh.bundle.patch: ./cordis.patch.yml；子路径 exports
├─ cordis.patch.yml           # 组装补丁（核心交付物，见 §6）
├─ lib/
│  ├─ index.js                # 包入口（可空壳，仅在需要时做 host 初始化）
│  ├─ host/
│  │  ├─ shell.js             # dshome/shell：Electron 窗口/托盘/单实例/监测/通知
│  │  └─ core.js              # dshome/core：提供 ctx.dshome 服务（commands/panels 注册表）
│  └─ client/
│     ├─ core.js              # dshome/client-core：slots 注册 + 命令面板
│     └─ theme.js             # dshome/theme：主题 token 覆盖
├─ scripts/
│  ├─ dev.mjs                 # 开发循环：构建 + 启动 dsh --profile dshome
│  └─ safe.mjs                # 恢复模式：--patch 临时禁用全部自有插件，判定崩溃来源（见 §13.5）
├─ docs/                      # 本方案 + 实施笔记
└─ README.md
```

子路径行引用（`dshome/shell` 等）照抄 `dsh-plugin-desktop/terminal`、`dsh-plugin-desktop/notifications` 的命名约定；实施时以 loader 实测为准补全 `package.json exports` 子路径。
## 6. cordis.patch.yml 规格（骨架草案）

```yaml
# dshome：profile dshome 的 bundle 补丁（第 3 层，盖在 dsh-base + dsh-web-app 之上）
# —— 壳与自有服务（host）——
- insert:
    - id: dshome-shell
      name: dshome/shell
      config:
        windowTitle: DSHOME
        # 单实例、托盘、活性监测、离线页、重连、快捷方式、自启开关、通知
    - id: dshome-core
      name: dshome/core

    # —— 自有 client 插件（dsh.client 行，进入 __DSH_BOOT__ roster）——
    - id: dshome-client
      name: dshome/client-core
    - id: dshome-theme
      name: dshome/theme

# —— 覆盖官方行（整体替换 config，不合并）——
# 窗口由 dshome/shell 接管，不再自动开浏览器
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: []

# 专属端口，与现有 web profile（3120）等并存不冲突；后续可改 webStartup 动态分配
- id: webserver
  config:
    host: 127.0.0.1
    port: 3081

# 中文界面
- id: locale
  config:
    locale: zh-CN

# —— 骨架 roster：最小可用集（其余官方行按需 insert 开发）——
# （官方 web-app 层已挂载全量；骨架若需要精简 roster，用 disabled 关掉不用的行，
#   或直接在 dshome 层重建精简 roster。推荐前者：差量关闭，天然可逆）
```

> 实施注意：roster 采用"兼容模式 + 差量关闭"还是"自建精简 roster"，以实施时 dsh-cmdline 的 composeProfile 实测结果定夺；两种都在官方机制内。方案偏向**兼容模式差量关闭**（改动最小、最可逆）。
## 7. 各组件规格
### 7.1 dshome/shell（host）：薄壳层职责（参考 dsh-clean-desktop-shell 功能面）
- Electron 窗口：无边框或默认边框可选，窗口标题 `DSHOME`，关闭窗口最小化到托盘；
- 系统托盘：状态菜单（运行中/启动中/未运行/错误）、启动/重启/关闭后端、显示窗口、刷新、退出；
- 单实例锁：重复启动只聚焦已有窗口；
- 后端活性监测：轮询 webserver；挂掉即窗口显示"未连接"离线页，恢复自动重连加载；
- 桌面快捷方式：可选创建（`dsh --profile dshome` 可双击启动的 .lnk）；
- 开机自启开关（Windows 注册表 Run 键 / lnk 到 Startup 目录）；
- 通知桥：订阅 Host 侧任务/回合/审批事件，弹系统通知（具体事件名实施时参考 `dsh-plugin-desktop/notifications` 源码）；
- Electron 运行时策略：开发期 devDependency 本地跑；个人使用首期"运行时按需准备"（clean-desktop-shell 方式），产品化二期换 Tauri 时移除。
### 7.2 dshome/core（host）：扩展点服务，这是"后续一切皆插件"的地基，提供 `ctx.dshome` 服务：
```js
ctx.dshome = {
  commands: { register({ id, label, run }) },   // 命令注册表（如 Ctrl+K 面板数据源）
  panels:   { register({ id, title, component }) }, // 面板注册表（侧栏/附加面板位）
}
```
未来所有 DSHOME 插件只依赖这个服务 + 官方 `dsh-client-ui-slots`（第三方注册新标签/位点的官方机制，见 `dsh-better-sidebar` 先例），不必改 shell/core。
### 7.3 dshome/client-core（client）
- 浏览器端启动钩子：等待 cordis 就绪后注册插槽项、命令面板占位；
- 通过 connection/remote 与 host 的 `ctx.dshome` 服务对应（方法：经官方 api-gateway Remote 机制注册端点，实施时对照 dsh-community-market 的 client/host 通信样例）。
### 7.4 dshome/theme（client）
- 骨架阶段：读取官方的 `dsh-client-ui-theme` 的主题 seam 并覆盖（主题 token、CSS 变量、明暗两套、强调色）；
- 具体 seam API 实施时直接读 `node_modules/@deepseek-ai/dsh-client-ui-theme/src`；
- 市场皮肤插件（`dsh-client-ui-skin-*`）的注入写法是现成参照。
## 8. 依赖清单（钉死 0.1.1-rc.2）
| 依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-base@^0.1.1-rc.2` | 第 1 层 host 核心（77 依赖的组装节点） |
| `@deepseek-ai/dsh-web-app@^0.1.1-rc.2` | 第 2 层浏览器面（webserver/web-runtime/官方 roster/frontend dist） |
| `@deepseek-ai/cordis@4.0.1` | Cordis 运行框架（peer） |
| `electron` | 壳窗口运行时（devDependency；运行时下载策略另设） |
| `react@18.3.1` | 自绘组件时才需要（官方 renderer 同版本） |

其余官方模块（client-*/host-*）由 `dsh-web-app` 传递带入；DSHOME 需要额外引用的按 roster 裁剪情况在实施期补充。
## 9. 分阶段实施计划（每一步都可由 dsh 代理交付并自检）
### Phase 0 · 环境地基
- 确认本机 `dsh` CLI 可用（DSH Desktop 自带；`dsh --version`）；
- 确认 pnpm、Node 24；建 `E:\DSH\dshome` 工程目录；
- 验证 `dsh plugin --profile dshome add <本地路径>` 是否支持 file:/folder 形式（否则用 GitHub 路径），记录 CLI 实测行为；
- **验收**：`dsh --profile dshome --help` 可解析，无报错。
### Phase 1 · 骨架 bundle（无窗口）
- 搭 package.json（dsh.bundle.patch、exports 子路径、依赖）+ 最小 `cordis.patch.yml`（只 insert dshome-core，其余覆盖项留注释）；
- 跑 `dsh --profile dshome`，浏览器手动访问 `127.0.0.1:3081`；
- **验收**：官方中文 UI 可见、可建会话、可发消息、模型可配置；与 `--profile web`（3120）并存无冲突。
### Phase 2 · 薄壳
- 实现 `dshome/shell`（窗口/托盘/单实例/监测/离线页/重连/快捷方式/自启开关）；
- **验收**：双击快捷方式出窗；关窗不退出；托盘可启停后端；杀掉后端→离线页，重启→自动重连；重复启动只聚焦。
### Phase 3 · 主题 + 扩展点演练
- 实现 `dshome/theme`（明暗 + 强调色，肉眼可辨）；
- 实现 `dshome/client-core` + 一个演示扩展（如注册一条 `/dshome-demo` 命令或侧栏项），用 `ctx.dshome.commands` + 官方 slots；
- **验收**：主题生效；演示扩展可见可用；再装一个市场现成 client 插件（如皮肤）到 profile 不冲突（证明"后续皆插件"成立）。
### Phase 4 · 收尾
- 写 README（安装/启动/开发循环脚本 `scripts/dev.mjs`）；整理实施笔记到 docs/；
- 跑通 §10 全量验证清单；
- 写二期路线（§12）落库。
### 9.1 跑通后的开发循环（如何在壳里持续迭代）

第一版跑通后，用户可直接在 DSHOME 上继续优化与开发，按三层热更节奏：

| 改动对象 | 生效方式 | 频率 |
|---|---|---|
| client 插件（主题/面板/命令/布局） | HMR 热更新：`dev.mjs` 的 watcher + 官方 `client-hmr` 行，改完即刷，窗口不关 | 秒级 |
| host 插件（托盘/监测/通知/core） | 托盘"重启后端"，壳活性监测自动重连窗口 | 重启后端 |
| Electron 壳本身 | 开发模式 `electron .` 直连已跑的后端，改壳不动后端 | 只重启壳 |
| cordis.patch.yml / 依赖变更 | `--patch` 覆盖层实测，确认后合并，重启 profile（checkpoint 可回滚） | 重启 |

**铁律**（防止迭代变事故）：
1. 自研代码只进 `dshome` 包与自有插件；`node_modules/@deepseek-ai/*` 官方 bundle **只读**。
2. 实验一律走 `--patch` 覆盖层，确认后落地；配合 Recovery checkpoint 一键回滚；
3. 开发场地（`dshome` + 工作区）与 `--profile web` 隔离，官方界面始终是安全网；
4. 要 dogfood：在 DSHOME 窗口内开会话，让代理继续开发 DSHOME 自身（代码产物落 `E:\DSH\dshome`）。
**边界提醒**：HMR 仅在 dev watcher 运行期间生效，生产形态改 client 代码需 rebuild + refresh；host/补丁变更必须重启（代价已被壳的自动重连抵消）。
## 10. 验证清单（骨架跑通的定义）
- [ ] `dsh --profile dshome` 一条命令可启动；端口 3081 上线（或配置值）
- [ ] Electron 窗口弹出，标题 DSHOME，页面为中文官方 UI + DSHOME 主题
- [ ] 能新建会话并完成一轮对话；模型/提供方设置可改
- [ ] 托盘存在；单实例生效；关窗最小化到托盘；开机自启开关可用
- [ ] 后端被杀 → 离线页；重启后端 → 自动重连
- [ ] 任务完成/需要审批时弹系统通知
- [ ] 演示扩展（命令/面板）通过 dshome 扩展点注册并可见
- [ ] **故障演练**：注入一个故意抛错的自有插件 → `--profile web` 不受影响 → `scripts/safe.mjs` 禁用该行 → DSHOME 正常启动 → 壳离线页 + 托盘重启后端可恢复（见 §13.5）
- [ ] 与现有的 `--profile web` 实例并存互不干扰
- [ ] 本机其他 .lnk / 双击流程可用

## 11. 扩展点规范（未来插件的接入契约）

| 插件类型 | 接入方式 | 先例 |
|---|---|---|
| 主题/皮肤 | `dsh.client` 注入，覆盖 ui-theme seam | `dsh-client-ui-skin-*` 市场插件 |
| 命令（含 Ctrl+K 面板） | `ctx.dshome.commands.register(...)` | 官方 ui-commands + dshome/core |
| 侧栏/附加面板 | 官方 `dsh-client-ui-slots` 注册位点 / `ctx.dshome.panels.register(...)` | `dsh-better-sidebar` |
| host 能力（托盘项、通知、网关） | `- insert` `name: <pkg>/<subpath>`，注册 dshome 服务或官方服务 | `dsh-plugin-desktop/*` 系列 |
| 直接装市场现成插件 | `dsh plugin --profile dshome add <包名>`（不改 dshome 代码） | —— |

再强调：骨架必须在 Phase 1 就把 **"profile/bundle 标识 + cordis.patch.yml 分层 + ctx.dshome 服务"** 三个扩展点立住，后续插件"只说装就装"。
## 12. 二期路线图（插件化，非骨架内容）

1. **命令面板**（Ctrl+K：切模型/切工作目录/开会话）→ dshome 扩展插件
2. **会话收藏/置顶**：侧栏位点注册插件
3. **附加面板**：工作目录文件树 / 任务看板 / token 用量小卡片（走 panels 注册表插件）
4. **手机远程访问**：参考市场网关类插件（dsh-remote-* / dsh-mobile-pwa）
5. **产品化外壳**：Tauri v2 的 exe（绿色分发，RFC 时评估），或 npm 发布 `dshome` 供市场安装
6. **macOS**、深色/浅色多主题包、自有前端组件逐步替换官方行（利用 roster 可插拔，逐步推进到"全自有界面"）
## 13. 风险与对策
| 风险 | 对策 |
|---|---|
| bundle/插件字段语义与官方文档有出入 | 实施时以本机 `node_modules/@deepseek-ai/dsh-cmdline`、`dsh-app-boot` 源码与 `dsh plugin` 实测为准（本机即有 2.0.3 完整解包副本） |
| Electron 运行时首次下载慢/网络受限 | 手动放置运行时路径选项；或先用系统浏览器验证 Phase 1 再进 Phase 2 |
| 端口冲突（多个 profile 同机） | DSHOME 专属默认端口 + webStartup 动态分配兜底 |
| 上游 `0.1.1-rc.2` 升级漂移 | 跟随 DSH Desktop 的 pin 策略，升版走独立验证 |
| 主题 seam API 未知细节 | 读 `node_modules/@deepseek-ai/dsh-client-ui-theme/src` 后实现（有市场 skin 先例兜底） |
| 自绘 UI 工作量失控 | 骨架禁止自绘；自绘一律进二期并走 roster 替换路线 |

## 13.5 防崩溃与可恢复性设计（骨架硬性要求）

**结论**：插件做崩了 DSHOME 能正常启动——但这是设计保证，不是自动行为。骨架必须实现以下护栏，并把"故障演练"列为验收项（§10）。
**官方已核实的地基**（本机 2.0.3 源码）：
- 配置应用**事务化**：失败自动回滚到"上一个好树"（dsh-app-boot：`the last good tree remains active when rollback succeeds`）；
- boot 安装 **fail-loud Loader 守卫**，启动错误大声失败、不留半残状态（dsh-app-boot lib/index.js）；
- loader 层**聚合错误 + 回滚**（cordis-plugin-loader：entries 失败 → AggregateError → rollback）；
- 官方恢复诊断 `--dump-default-config`：坏的用户层也能出诊断（dsh-app-boot lib/index.js:535-536）；
- DSH Desktop 自带 recovery/setup-wizard 界面与"健康启动 checkpoint"机制（native-ui/recovery.html；dsh-community-market README）。
**DSHOME 五层防护**：
| 层 | 机制 | 归属 |
|---|---|---|
| L0 故障域隔离 | 每个 profile 独立进程；壳（Electron）与后端（Cordis host）进程分离，互不拖垮 | 官方 + DSHOME 壳 |
| L1 事务化启动 | 配置回滚到上一个好树 + fail-loud 守卫 + 恢复诊断 | 官方（直接继承） |
| L2 行级可禁用 | 补丁分层覆盖：`--patch` 覆盖层一行 `disabled: true` 即可禁用任意自有插件；`scripts/safe.mjs` 一键"禁用全部自有插件"启动，秒级判定崩溃来源 | DSHOME 脚本 |
| L3 壳层活性恢复 | 后端被杀 → 离线页 → 托盘一键重启后端 → 自动重连 | DSHOME 壳 |
| L4 自有插件护栏 | 插件登记进 try/catch + 服务降级（找不到官方服务就不注册，绝不 throw 阻断启动）；client 插件崩溃 → 降级为无定制官方 UI（**不是白屏**） | DSHOME 代码规范 |

**崩溃分级与恢复路径**：
- 自有 client 插件崩 → L4 降级 / L2 禁用；
- 自有 host 插件崩 → L0 离线页 + L2 禁用后重启；
- 配置损坏 → L1 回滚 / 官方 recovery 与诊断；
- 上游（官方 bundle）层问题 → pin 版本 + 升级策略，不属于骨架可防范围。
**参考先例（每层都有现有项目背书，非自创）**：
| 层 | DSH 生态内先例（已核实） | 生态外通用做法 |
|---|---|---|
| L0 进程隔离 | profile 独立进程；DSH Desktop 中渲染进程分离 | VS Code 扩展宿主进程隔离；Chrome process-per-extension；Electron render-process-gone 重启窗口 |
| L1 事务化启动 | dsh-app-boot "上一个好树"回滚；**DSH Desktop 的 Recovery checkpoint**：插件安装/移除前生成恢复点，失败提示 "Use a Recovery checkpoint to restore the previous Profile state"（dsh-community-market/service.js:459/526）；desktop-cli.js:43 "Manual plugin commands and Market operations rely on unified checkpoints" | 浏览器配置校验保留 last-good；包管理器原子安装 |
| L2 行级可禁用 | patch 覆盖层 disabled；**DSH Desktop 自带"重启到恢复模式"**：api/desktop/restart/recovery + LifeBuoy 菜单项，lib/client.js:35756/35931 | VS Code `--disable-extensions`（safe.mjs 的 DSH 版）；Chrome 崩溃扩展自动 quarantine |
| L3 壳层活性恢复 | dsh-clean-desktop-shell 已验证：活性监测 + 离线页 + 自动重连 + 托盘重启后端 | Chrome 标签崩溃恢复页；Electron 渲染进程崩溃兜底 |
| L4 降级护栏 | 官方 renderer 用 React 18；自有组件包 Error Boundary（局部崩溃不白屏） | React Error Boundary；浏览器扩展运行时错误隔离（扩展崩溃不拖垮页面） |

> 结论：本方案五层防护每一项都能在现有项目里找到对应先例；骨架不发明新机制，只把已验证模式组装进 DSHOME 并纳入验收。
**护栏编码规范（骨架代码必须遵守）**：
1. 所有自有插件启动逻辑 try/catch，错误只记日志不 rethrow；
2. 依赖官方服务一律 `ctx.get`/可选获取，缺失即跳过注册；
3. client 端注册（slots/命令）失败静默降级，保证官方 UI 可渲染；
4. 每个自有插件独立成行，可单独 `disabled`。
## 14. 参考清单（本机可读的权威参照）

- 官方 web 补丁/roster：`E:\DSH\app.src\node_modules\@deepseek-ai\dsh-web-app\cordis.patch.yml`
- 基座层：`E:\DSH\app.src\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml`（含 77 依赖核心行）
- 桌面兼容模式模板：`E:\DSH\app.src\cordis.patch.yml`
- 客户端注入声明样例：`E:\DSH\app.src\node_modules\dsh-community-market\package.json`（dsh.client.inject 字段）
- 插件形态薄壳功能面：GitHub `Icather/dsh-clean-desktop-shell`（README 已核实）
- 市场生态：1024Store `https://deepseek1024.com/api/v2/plugins`（client/terminal/mobile/desktop shell 分类检索）
- 上游官方：`github.com/deepseek-ai/deepseek-harness`；DSH Desktop 社区实现：`github.com/anywhere-labs/deepseek-harness-desktop`

---

> 本文档即"完整设计方案"。实施时按 Phase 0→ 顺序执行，每阶段验收通过再进下一阶段；任何与本文档"待实施"标注冲突的官方行为，以实测 + 官方源码为准并回填本文档。
---

## 15. 实施记录（Phase 0 起，实测结论 2026-08-28）
**结论先行**：`dsh --profile dshome` 已在本机用**官方 dsh CLI** 跑通；`http://127.0.0.1:3081` 返回 200，`__DSH_BOOT__` 注入完整官方 client roster（38 个模块），与现有 web profile（3120）并存互不干扰。代码在 `E:\DSH\dshome`，profile 在 `C:\Users\kuro\.dsh\profiles\dshome`。
### 15.1 "待实施"项目闭环

| 待实测项 | 结论 |
|---|---|
| profile 目录结构 | `$DSH_HOME/profiles/<name>/`：package.json（`dsh.profile.bundles` 声明补丁层序）、用户层 `cordis.patch.yml` + `cordis.yml`（勿改）+ `pnpm-workspace.yaml`；加载器还会读 `$DSH_HOME/cordis.patch.yml`（home 层） |
| 启动命令 | `dsh --profile dshome [--no-open] [--port <n>\|0]`；`--port 0` 让系统挑空闲端口 |
| 端口策略 | **webserver 的 config 不要写死端口**（会钳制 CLI 参数），一律经 CLI `--port` |
| locale | 不走补丁覆盖行：设置里 `locale.preference: zh\|en`（缺省跟随浏览器），中文 UI 由浏览器 zh 自动生效 |
| profile 依赖 | **重大发现**：CLI 加载器从 profile 自身目录解析所有行，所以官方 bundles 必须**显式写进 profile dependencies**（`dsh-base`/`dsh-web-app` 精确版本 + workspace `autoInstallPeers: true`。web/desktop 的空 dependencies 模式只在 GUI（app.asar 内置依赖）成立；同机 CLI 路径会报 `Cannot find package 'x' imported from <profile>` |
| dump 诊断 | `--dump-config` / `--dump-default-config` 离线组合可用；管道提前关闭（`Select-Object -First`）会造成 EPIPE 误报 exit 1，非真实错误 |

### 15.2 已确认的官方机制（源码级）
- `runProfile` 把 `options.environment`（`loadLayeredEnv` 快照，带 `.get`）注册为 `launchEnvironment` 服务；llm-deepseek 等经它读取 `environment?.get(...)?.value`——诊断脚本**不能**传裸 `process.env`；
- 启动失败只打印顶层消息，子错误藏在 `error.errors`（诊断工具：`dshome/probe.mjs`，可打印任意 profile 的深层错误）；
- 失败发生在行挂载/导入阶段时，报错含 `imported from <profile目录>`，可直接定位缺包/缺 peers。
### 15.3 已知问题与对策
| 问题 | 对策 |
|---|---|
| `pnpm install` 会为 sharp 等跨平台可选 tarball 长时间重试（error 23） | 非致命：依赖树装齐即可启动，无需等重试结束；必要时换镜像 |
| 原生 module build 默认被跳过（node-pty/koffi/protobufjs/@google/genai/dsh-subprocess-local） | Phase 1 无终端等原生能力，不受影响；Phase 2 开终端前需 `allowBuilds: true` 后重装或 `pnpm approve-builds` |
| dshome-core 的 info 日志不出现于 CLI stdout（日志去向封装） | 行挂载无报错即为已激活；Phase 3 用 UI 可见性做运行时验证 |
| 调试残留（probe.mjs / probe-asar.mjs / wrapper.mjs / bisect-1.yml） | 保留为诊断工具；`bisect-1.yml` 是覆盖层禁用二分的实例 |

### 15.4 常用命令

```
dsh --profile dshome --no-open --port 3081   # 启动（桌面壳接入前推荐）
dsh --profile dshome --port 0                # 系统挑空闲端口
dsh --profile dshome --dump-config           # 查看组合后的完整树（含用户层）
node E:\DSH\dshome\scripts\dev.mjs           # 开发循环（等价启动）
node E:\DSH\dshome\scripts\safe.mjs          # 恢复模式（禁用全部自有插件启动）
```

**桌面快捷方式（免终端）**：`DSHOME.lnk`（wscript 隐藏启动 `scripts/launch.vbs`，后端隐藏控制台运行 + 窗口自动弹出）与 `DSHOME 停止.lnk`（`scripts/stop.cmd`，结束 3081 后端）。启动器测试模式：`DSHOME_LAUNCH_TEST=1` 时只写标记文件不启动。
### 15.5 Phase 1 补充验证（端到端聊天 + 运行时解析决策）

**RPC 通道**（与浏览器 UI 同一条传输）：`POST /api/<method>`，信体 `{"type":"client-request","rpcId":"<string>","method":"<domain.method>","params":{...},"payload":{...}}`。
- list/create 走窄接口 `params`；prompt 等 `RequestPayload` 方法还需把业务对象同时放进 `payload` 槽；
- Host 须为 loopback/同源（`Origin` 是 host 即可）；
- `session.history` 返回 `value.events` 事件流：`assistant/chunk`（text-delta / usage / finish）、`assistant/message`、`turn/end`。
**端到端结果**：`session.create → session.prompt("请只回复两个字：你好") → 模型流式回复"你好"（provider opencode-go / deepseek-v4-flash，读 home 凭据与路由）→ turn/end`。`verify-chat.mjs` 绿灯（exit 0）。诊断工具：`probe-rpc.mjs`（任意方法）、`probe-history.mjs`（事件流尾部）。
**运行时解析决策（本机 v1）**：standard/code/cordis/minimal 四个 agent preset 引用约 30 个 `@deepseek-ai/dsh-tool-*` 包，其中少数未发布到 npm（如 auto-peer 的 `dsh-compact` 404），故 pnpm 无法装齐。**本机 v1 采用 junction 方案**：
- `profiles/dshome/node_modules` 指到 `E:\DSH\app.src\node_modules`（app.asar 解包全树，199 个 @deepseek-ai 包）；
- `profiles/dshome/node_modules/dshome` 指到 `E:\DSH\dshome`（包本体）；
- 原生预编译（koffi / node-pty / sharp / node-addon-require-builtin）从 `app.asar.unpacked\node_modules` 拷贝进该树；
- 原 pnpm 树备份为 `node_modules.pnpm`。注意：junction 接管后 `dsh plugin add`（走 pnpm）不适用；上游补发缺失包后应回归 pnpm 安装。启动命令不变。### 15.6 Phase 2 薄壳实施记录（2026-08-28）
**交付**：`dsh --profile dshome` 启动即自动弹出 DSHOME 窗口（官方 UI），托盘常驻、单实例、后端被杀壳存活并切离线页、后端恢复自动重连。
**代码**：
- `dshome/shell-app/`：Electron 窗口应用（main.cjs / offline.html / icon.png）；单实例锁、close 最小化到托盘、3s 轮询活性、离线页 + 自动重连、托盘（显示/刷新/自启开关/退出）、本地通知监听（`DSHOME_NOTIFY_PORT`，POST /notify，v1.1 接线）；
- `dshome/lib/host/shell.js`：host 插件（`dshome/shell` 行），后端就绪后 spawn GUI，`createRequire` 从 dshome 包本地解析 electron；
- electron 依赖：npm registry 极慢/失败 → npmmirror 手动下载 138MB + tar 解包到 `node_modules/electron/dist` + `path.txt=electron.exe`（该机实录；其他机器建议 `npm i -D electron@43.4.0` 配 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。
**三个关键坑（均已修）**：
1. `dsh.cmd` 会把 `ELECTRON_RUN_AS_NODE=1` 带进环境 → spawn GUI 前必须删除，否则 Electron 以 node 模式运行、不出窗口；
2. **必须 `detached: true` + `child.unref()`**：否则后端进程（父）被杀时壳会随进程组陪葬（实测复现后修复）；
3. 后端重启时插件会再次 spawn → 靠壳的 `requestSingleInstanceLock` 幂等：新实例退出、旧窗口自动重连（单实例与活性监测协同）。
**验证结果（headless 实测）**：窗口 spawn ✅；二次启动单实例 1 个 ✅；杀后端 → 壳存活 ✅；重启后端 → 壳不重复开发、端口恢复 ✅；与 web profile（3120）并存 ✅。视觉项（界面/托盘/离线页/通知）待用户实机确认。
**首轮实机反馈修复（"有窗口但后端未连接"）**：
- **根因**：main.cjs 活性检测写成 `Promise.race([fetch, Promise.resolve(false)])`——第二项立刻 resolve，race 恒返回 `false`，fetch 明明 200 也永远离线。属实现 bug，非架构问题；
- **修复**：`AbortController + setTimeout` 超时实现；状态机加 `isOnline`，托盘文案同步；离线页"立即重试"改为导航到后端 URL；新增观测日志 `%APPDATA%\dshome-shell\dshome-shell.log`（每次 fetch/state/load 落盘，后续排障不瞎猜）；
- **完整链路实测**：杀后端 → `fetch fail → state offline`（窗口切离线页）；重启后端 → 3 秒内 `fetch ok → state online → loaded url`（窗口自动重连）；壳保持单例 1 个。
- **第二坑（实机反馈"还是后端未连接"）——端口默认值**：官方 webserver 默认端口是 **3080**（web-app patch `port ?? 3080`），而壳的兜底写死了 3081；命令行显式 `--port 3081` 时一切正常，**裸跑 `dsh --profile dshome` 后端在 3080、窗口看 3081，必然离线**。修复：按官方 `localWebUrl` 思路，从 **`webServer` 服务读真实绑定端口**（可覆盖默认 / `--port N` / `--port 0` 系统分配），兜底改 3080；URL 改在 spawn 延时回调里解析（保证已绑定）。教训：端口等运行事实一律从服务读，不硬编码。
### 15.7 Phase 3 皮肤/品牌/通知/故障演练记录（2026-08-28）
**新增 dshome-theme 客户端皮肤包**（`E:\DSH\packages\dshome-theme`）：
- 机制：client roster 条目 = Loader 补丁行引用的包 + 包内 `dsh.client` 声明（platform web）；client.js 用 `window.__ModuleLoader__.load({id, factory})` 工厂形态手写（无需构建管线），经 `/plugins/<id>/client.js` 服务化；
- 皮肤 API（官方）：`theme.overrideTokens(source, { "--dsw-alias-brand-primary": {light, dark}, ... })`——token 成对（light/dark），别名层覆盖即时生效；
- 品牌替换：禁用 `ui-brand-official` 行 + `ctx.slots.register({name:"sidebar.brand.mark|sidebar.brand.name|conversation.hero.brand.mark"}, 组件)` 注册 DSHOME 品牌（SVG 圆角方块 + D，蓝色取自品牌 token）；
- 实测：roster 含 `dshome-theme`（id/url/rev），`ui-brand-official` 消失，client.js 200。官方前端 token 名（提取自 dist CSS）：`--dsw-alias-brand-primary`、`--dsw-alias-button-primary-fill/-hover`、`--dsw-alias-state-business-primary` 等（全部 requiresLightAndDark）。
**新增通知 v1**：壳内在 32123（`DSHOME_NOTIFY_PORT`）监听 POST /notify；在连接/离线状态切换时壳自身弹系统通知（点击可唤起窗口）。回合结束等业务事件的接线留 v1.1（事件源需再探索）。
**新增故障演练（§10 验收项实证）**：
- `--patch drill-bad.yml`（插入不存在的 `dshome-no-such-plugin-package`）→ 启动失败，报错精确到包名（`Cannot find package 'x' imported from <profile>`）；
- `--patch drill-fix.yml`（`- id: dshome-broken; disabled: true`）→ **正常启动**（3090 监听）。坏插件行级禁用即可恢复，无需改代码/卸载；web profile 不受影响。
**新增关键教训——client factory 必须返回插件本体 + 服务级 inject**：
- **第一坑**：浏览器材料化机制取的是 **`factory(require)` 的返回值**（官方文档原话 `factory(require) → exports`），官方模块结尾都写 `exports.apply=apply; 且 return module.exports;`。早期 dshome-theme client.js 漏了 `return` → 窗口报 "invalid plugin received undefined"；
- **第二坑**：品牌槽注册还要求插件**服务级注入**：官方品牌写 `const inject = ["slots"]; exports.inject = inject;`——只依赖 `dsh.client.inject`（包级依赖）不够，`ctx.slots` 在 apply 前不注入就不可用，报 `cannot get property "slots"`；一切照官方 `ctx.slots.inject(...)` 嵌套生成器模式 + `yield ctx.slots.register(...)` 才声明式成立；
- 这两层都只在**真实浏览器运行时**暴露（host 启动/页面服务/roster 全绿），排障用 **CDP**：`electron shell-app --remote-debugging-port=9222` + `cdp-inspect.mjs`/`cdp-verify.mjs`（读 DOM 文本、抓 console 警告、禁用缓存重载验证）。`check-theme-client.mjs` 无头断言 factory 返回值 + inject。

---

## 15.8 主线 A 第一刀（Ctrl+K 命令面板）实施记录（2026-08-29）

- 新增客户端插件 E:\DSH\packages\dshome-palette（dsh.client / CJS node half / 纯 DOM 无 React）；
- 功能：Ctrl+K 弹出覆盖层（dark 语义、品牌蓝）→ ＋ 新建会话 动作 + 会话列表（点会话 → 列出模型分组 → 点模型 → session.selectModel 切模型）；
- 全部走官方 RPC 信封（session.list / session.create / session.models / session.selectModel），与 UI 同通道；
- 挂载：patch 行 dshome-palette + dshome 包 dsh.client.inject 加 dshome-palette；
- 实测：roster 含 dshome-palette、client.js 200、页面 200；CDP 派发 Ctrl+K → 覆盖层 display:flex、渲染 65 行（1 动作 + 63 会话）；
- 会话置顶/收藏为下一刀；调试工具 dshome/cdp-palette.mjs。

### 15.8.1 绗簩鍒€锛氫細璇濈疆椤?鏀惰棌锛?026-08-29锛?
- dshome-palette 鍐呯疆**鏀惰棌锛堚槄 缃《锛?*锛歭ocalStorage dshome.pinned.sessions 鎸佷箙鍖栵紱
- 闈㈡澘椤堕儴"鈽?鏀惰棌浼氳瘽"鍖猴紙缃《浼氳瘽缃《鏄剧ず锛岀偣杩涘彲鍒囨ā鍨嬶級锛屼細璇濊鍙充晶 鈽?鈽?涓€閿敹钘忥紱
- 绾?DOM銆佹棤 React銆佹棤瀹樻柟浼氳瘽鍒楄〃鏀瑰姩锛涗笌涓婚/鍝佺墝/Ctrl+K 闈㈡澘骞跺彂鏃犲啿绐侊紱
- 瀹炴祴锛圕DP锛夛細鐐?鈽?鈫?鏀惰棌鍖哄嚭鐜?+ ls 鍐欏叆 鈫?**鍒锋柊椤甸潰鍚庝粛鍦紙鎸佷箙鍖?鉁擄級** 鈫?鐐?鈽?鍙栨秷鎭㈠锛?- 宸ュ叿锛歞shome/cdp-favs.mjs銆?

### 15.8.2 鏀惰棌鍗囩骇锛氶潰鏉挎爣棰?+ 渚ф爮鍏ュ彛锛?026-08-29锛?
- Ctrl+K 浼氳瘽琛屾敼鐢?*浼氳瘽鏍囬**锛坉isplayTitle / projections.values.title锛夛紝鏃犳爣棰樺洖閫€ sessionId锛?- 浼氳瘽琛?*鐐瑰嚮鍗虫墦寮€**璇ヤ細璇濓紙DOM 涓粙锛氬畾浣嶅畼鏂?ole=treeitem 琛屽惈鏍囬鐨?aria-label 骞?.click()锛涘け璐ュ洖閫€鍒?鍒囨ā鍨?瑙嗗浘锛夛紱
- 渚ф爮**搴曢儴 鈽?鎸夐挳**锛坰idebar.footer.action 鍒楄〃妲斤紝娉ㄥ唽闇€甯?id锛夌偣鍑绘墦寮€鏀惰棌闈㈡澘锛?- 鏋舵瀯绾︽潫璁板綍锛氬畼鏂逛細璇濆垪琛ㄥ尯 sidebar.workspaces 涓?*鍗曟Ы**锛坲i-workspace 鍗犳湁锛屽閮ㄦ敞鍐岃鎷掞級锛屾晠鏀惰棌鐨?瀹屾暣鍒楄〃"淇濈暀鍦?Ctrl+K 闈㈡澘锛屼晶鏍忔斁 鈽?鍏ュ彛锛?- 瀹炴祴锛圕DP锛夛細鏍囬鏄剧ず 鉁撱€佲槄 鏀惰棌鍖?鎸佷箙鍖?鉁撱€乫ooter 鈽?鎸夐挳=1 鉁撱€佹棤 dshome 鍛婅锛涘伐鍏?dshome/cdp-v3.mjs銆乧dp-footer.mjs銆乧dp-console.mjs銆?


### 15.8.3 第三刀：回合级通知 + 设置开关（2026-08-29）
- 目标：当"由你发起的回合"结束（完成/失败）或后台任务结束，DSHOME 弹系统通知；是否提醒由「设置 → 通知」开关控制。
- host 插件 E:\DSH\dshome\lib\host\notify.js（patch 行 dshome/notify，包导出 ./notify）：
  - ctx.settings.register('dshome', z.object({ enabled, notifyOnTurnCompletion }), { applies:'live' }) 注册设置命名空间（客户端设置行读写同一命名空间）；
  - 订阅 sessions.on('session/event')（turn/start、user/message、turn/end）+ jobs.onJobDone，仿官方 dsh-plugin-desktop/notifications 事件接缝；
  - 开关开启且回合为用户发起（非 subagent）时，fetch POST http://127.0.0.1:<DSHOME_NOTIFY_PORT||32123>/notify {title,body} 投递到壳。
- 客户端设置行：在 packages/dshome-theme/lib/client.js 新增 settings.general.item 项（order=20，locale='dshome'），渲染「通知」主开关 + 「回合完成提醒」开关，经 ctx.settingsScope.bind({namespace:'dshome'}) 读写 host 命名空间（store→useStore，inject→setEnabled/setNotifyOnTurnCompletion）。
- 壳侧通知监听由 shell-app/main.cjs startNotifyListener() 提供（POST /notify 读取 {title,body} → Notification.show()）。
- 依赖：@deepseek-ai/schemastery（3.18.1）与 @deepseek-ai/dsh-settings（0.1.1-rc.2）加入 dshome 包 dependencies（开发机以 junction 到 app.src node_modules 解析）。
- 实测：
  - dsh --profile dshome --no-open --port 3081 重启后端，settings.describe 出现 dshome（enabled/notifyOnTurnCompletion=true）；
  - CDP（9222，Network.setCacheDisabled + reload）打开 设置→通用设置→见「通知」两开关；关主开关 → dshome.enabled=false 持久化到 host；再开回 true；
  - 旧壳载入的 main.cjs 早于通知监听、且持单实例锁 → 重启干净壳后 32123 监听 + POST /notify 返回 204（通知链路端到端可用）。
- 工具：dshome/cdp-notify.mjs、probe-rpc.mjs（settings.describe）。
### 15.8.4 插件管理（block 1：已装插件 列表 + 启/停）（2026-08-29）
- 背景：官方「插件列表」纯只读；其 pluginInventory.list 在 DSHOME web profile 404（桌面端 dsh-host-plugin-inventory 未被 web profile 组合）；平台 apiproxy 固定方法集不路由自定义 RPC。
- 方案：用设置命名空间 dshome-pluginmanager 做 宿主↔客户端 数据/指令总线（通知同款机制）。
- host 插件 dshome/lib/host/plugin-manager.js（patch 行 dshome/plugin-manager；inject=['loader']）：
  - 扫描 ctx.loader.entries()（非 group）→ 分类（自制 dshome-* / 内置 @deepseek-ai/* / 其它=下载）→ scope.update({entries}) 推送；
  - 监听 command（request）→ writeToggle 改写 profile cordis.patch.yml（id 定位 disabled:true 增删）→ result {ok,restartNeeded,message}。
- 实测：settings.describe 的 dshome-pluginmanager.value.entries = **144 项**（自制 6：core/shell/theme/palette/notify/plugin-manager；内置 @deepseek-ai/*；下载），每项 entryId/moduleName/enabled/category/phase。
- 备注：启/停每次需重启 profile 生效（Cordis 启动时组合）；客户端 UI（列表+搜索+开关）为下一步；市场/本地自制为后续增量。
- 增补（同批）：核心插件禁停（PROTECTED_MODULES：dshome-* + 应用骨架；客户端"自制"显示"核心"标签、host 返回"核心插件，不可停用"）；profile cordis.patch.yml 顶层为 flow []、writeToggle 须输出块序列（勿混用 flow/block，否则 YAML missed comma）；entryId include:<id> → patch row id <id>（去前缀）。
- 验收（同批）：停 tool-web → - id: tool-web\n  disabled: true（合法块序列），启 → []；禁停 dshome-shell 返回受保护；dshome/core 保持启用。
### 15.8.5 恢复 + Block B 结论 + junction 陷阱（2026-08-29）
- **网络**：npmjs/GitHub/npmmirror/unpkg 均已通（HTTP 200）。
- **Block B**：dsh-community-market **无 dsh.bundle、不是 profile bundle**；进 bundles 会启动失败（已恢复）。正确组合=依赖 + profile cordis.patch.yml 一行插件补丁 - id: community-market\n  name: dsh-community-market。市场浏览/目录纯 web 可用；安装/卸载需桌面 desktopProfiles/desktopPnpm 服务（web profile 无→503）。
- **⚠️ 教训**：Remove-Item -Recurse -Force 作用在 **junction** 上会**顺着删除目标真实内容**（误删 E:\DSH\packages\dshome-theme，已从 DSHOME-PACK-2026-08-29\packages\dshome-theme 还原并从备份包+重放 client.js 的 通知行/插件管理 两处）。删 junction 勿带 -Recurse。
- 当前：DSHOME 3081 正常、144 插件、dshome/core 启用、patch=[]、插件管理+通知行可用；block B 待做。
### 15.8.6 Block B 组合成功 + 官方市场 UI（2026-08-29）
- 组合方式：profile cordis.patch.yml 用 insert（- id: community-market\n  name: dsh-community-market），非 bundle。市场加载成功，/api/community-market/state 200，内置源就绪。
- 官方市场自带启动器 → 「发现/可安装/已安装/来源」UI 可用（浏览/搜索）；安装需桌面 desktopPnpm（web/CLI 提示"需要 DSH Desktop"）。
- 与 block-1 并存：设置模态 [通用设置, 插件管理, 模型, 插件, Agent 预设,…]；插件管理分区正常（139 开关+自制=核心）；市场启动器为独立入口。
- 已撤自建 MarketPanel（冗余），插件管理分区还原为已装列表版。