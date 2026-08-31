# DSHOME 交接文档（2026-08-29 更新：安装器双链路交付，安装路径可选）

> ⚠️ 历史交接文档：内含当时本机绝对路径（E:\DSH、C:\Users\kuro 等），仅作内部交接参考，路径已过时。
> 给"回家的你"：整个项目现状、怎么续、坑在哪。压缩包自包含，除 Node/网络外零依赖。

## 一、一句话

DSHOME = 基于 DeepSeek Harness 的个人桌面客户端（独立 profile + Electron 壳 + 自主题/品牌 + 一键安装器），代码全在 `E:\DSH`（本仓库即工作区）。

## 二、已完成（全部实测过）

| 阶段 | 结果 |
|---|---|
| Phase 1 独立 profile | `dsh --profile dshome`（本机 3081）跑通；与 web profile（43120）并存 |
| Phase 2 桌面壳 | 窗口/托盘/单实例/杀后壳存活/离线页自动重连/系统通知（在线离线）+ 桌面快捷方式（隐藏启动） |
| Phase 3 皮肤与品牌 | 深海军蓝主题（#0f1420/#dbe4f0）、品牌蓝强调、侧栏官方鲸鱼图标 + DSHOME + v0.1.0 徽章、client 插件机制打通（roster/inject/return 契约） |
| 防崩 | 故障演练实证：坏插件 → `--patch` 覆盖层禁用即恢复 |
| 换设备 | 干净官方流程验证（npm 全钉 0.1.1-rc.2 31s 装 403 包）；部署文档 `dshome/docs/NEW-DEVICE.md` |
| 安装器① | SFX 版 `build-stage/DSHOME-Setup.exe`（181MB，C# 自解压）——端到端 CI 通过；2026-08-29 补齐自定义安装路径适配 + electron 内置免下载 |
| 安装器② | **Inno UI 版 `build-stage/DSHOME-Setup-0.1.0.exe`（132MB）——2026-08-29 QA 完成、显式目录选择页（DisableDirPage=no）、自定义路径端到端验证通过，已交付** |

## 三、安装路径选择 + Inno QA —— 已于 2026-08-29 完成并验证

> 本节原为「回家收尾 Inno QA」，已在开发机上全部完成：两条安装链路端到端静默验证通过，并补上「安装时选择路径」能力。

**需求落地**

1. **Inno 主链路（`DSHOME-Setup-0.1.0.exe`，132MB）**
   - `DSHOME.iss` 显式加 `DisableDirPage=no`：向导「选择目标位置」页**必然显示**，用户可自定义安装目录（原来靠 auto 默认行为，虽也显示，但显式声明防止将来权限配置变化把页面吞掉）。
   - `install-core.bat` 已支持任意安装路径：把 profile 模板与 dshome 包内写死的 `E:/DSH` file: 依赖自动改写为实际安装目录。
2. **SFX 老链路（`DSHOME-Setup.exe`，181MB）**
   - `setup.bat` 补两处 `E:/DSH → 实际安装路径` 改写（dshome 包内 + profile 模板），自定义 `DSHOME_INSTALL` 不再依赖默认 `E:\DSH`。
   - electron 段重构：① 优先用 payload 内置 `embedded-electron`（robocopy 免下载，3s 拷贝 347MB）② 无内置再 `pnpm add` ③ pnpm 跳过 postinstall 时手动 `install.js` 兜底。实测修复了原版 `ELECTRON DOWNLOAD FAILED`（pnpm v11 默认跳过 electron postinstall）。

**验证结果（均静默安装到自定义路径 + 隔离 profile，装完已卸载/清除）**

- **Inno**：exit 0；`install.env` 写入自定义目录；`@deepseek-ai/dsh-base` 装齐；electron 就绪；卸载器干净退出。
- **SFX**：三环境变量全自定义（`DSHOME_EXTRACT`/`DSHOME_INSTALL`/`DSHOME_PROFILE`）；electron 本地免下载就绪；file: 依赖改写核对通过。

**重打包方法（防失传，很重要）**

- Inno：`"C:\InnoSetup7\ISCC.exe" build-stage\DSHOME.iss`（lzma2，约 5 分钟）。
- SFX：`DSHOME-Setup.exe` **不是 iexpress 产物**（`installer.sed` 是早期废案；iexpress `/N /Q` 无人值守在本机实测 exit 1）。真实结构 = `sfx-core.exe` + 文本 marker `DSHOMESFX|` + `payload.zip` 字节拼接。重打两步：
  1. 重新生成 `payload.zip`（压缩整个 `build-stage\payload\`，.NET `ZipFile.CreateFromDirectory`，约 55s）；
  2. PowerShell 读三块字节（core → marker → zip）顺序拼写回 `DSHOME-Setup.exe`。

## 四、命令速查（开发机/新机）

```
dsh --profile dshome                    # 启动（开发形态，本机用）
托盘 → 退出                             # 窗口+后端一并结束
E:\DSH\dshome\scripts\launch.vbs       # 隐藏启动（双击快捷方式即此）
E:\DSH\dshome\scripts\safe.mjs         # 恢复模式（禁用自有插件）
E:\DSH\dshome\scripts\dev.mjs          # 开发循环
node dshome\check-theme-client.mjs     # 皮肤包无头自检
node dshome\probe-rpc.mjs 会话方法      # RPC 探针（信封见 docs）
node dshome\cdp-verify.mjs             # 需配 --remote-debugging-port=9222 的窗口
```

## 五、目录地图

```
E:\DSH\
├─ dshome\                    ← 主项目（bundle/壳/脚本/模板）
│  ├─ lib\host\     core.js 扩展点服务；shell.js 壳插件（spawn窗口）
│  ├─ lib\client\   （预留）
│  ├─ shell-app\    Electron 窗口应用（main.cjs/offline.html/图标）
│  ├─ scripts\      dev/safe/launch.vbs/make-shortcut.vbs/deploy-new-device.cmd
│  ├─ profile-template\   在家部署用的 profile 清单（34 依赖全钉 0.1.1-rc.2）
│  └─ docs\NEW-DEVICE.md   换设备指南
├─ packages\dshome-theme\   客户端皮肤包（brand+主题 token）
├─ build-stage\            安装器工程（iss/sed/sfx.cs + 两个成品 exe + payload）
├─ DSHOME-DESIGN.md        完整设计文档（§15 实施记录）
└─ DSHOME-HANDOVER.md      本文件
```

## 六、网络要点（这台机器的教训，在家网络正常可跳过大部分）

- **npm 官方 registry 在本机卡死**（zero 产出、sharp 跨平台 tarball error-23 重试圈）→ **安装器与部署一律用 pnpm + `https://registry.npmmirror.com`**（0.4s 可达、electron 1MB/s）。
- GitHub 直连不通 → 需镜像：`https://ghfast.top/` 或 `https://gh-proxy.com/`（Inno 就是这么装上的）。
- Electron 二进制：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
- 若 npm/registry 恢复可用，可回退官方源（模板里 .npmrc 的 registry 是写死的镜像，注意）。

## 七、走过的坑（防再踩）

1. npm vs pnpm：本项目依赖安装只用 pnpm（含 allowBuilds 列表，electron 已加）。
2. profile 依赖必须**钉死 0.1.1-rc.2**：`latest` 是旧 0.0.1-rc.1，会拉到未发布的 `dsh-compact` → 404。
3. client 插件三条铁律：工厂必须 `return module.exports`；必须 `exports.inject=['slots']`；端子必须返回插件对象。自检用 check-theme-client.mjs。
4. 端口：DSHOME 默认 3081（补丁 `ctx.webStartup.port ?? 3081`），不与官方 web 3080 撞；壳从 webServer 服务读真实端口。
5. 壳 spawn Electron 必须 `detached:true` + 删 `ELECTRON_RUN_AS_NODE`（否则后端死壳陪葬/不出窗口）。
6. install-core/部署脚本注意 **环境变量尾随空格**（cmd `set` 与 Inno env 传递都可能带上；已 trim）。
7. 本机开发用的 junction（app.src 解包树）是**早期绕路**；新机/家机直接走干净 npm 流程，不需要 app.src。
8. **pnpm v11+ 默认跳过 electron postinstall**（allowBuilds 白名单机制）→ `pnpm add -D electron` 后 electron.exe 不会出现；必须手动 `node node_modules\electron\install.js` 兜底，或直接用 payload 内置 `embedded-electron` 免下载（推荐，零网络）。
9. **SFX 的 setup.bat 曾缺 `E:/DSH → 实际路径` 改写**（而 install-core.bat 有）→ 换自定义安装目录时 file: 依赖指向不存在的 E:/DSH，pnpm 拉不到。**两条链路都要有这步改写**，已补齐。
10. **iexpress 无人值守不可用**（`/N /Q SED` 实测 exit 1，含完整 [SourceFiles0] 清单也失败）→ 别在 iexpress 上浪费时间；SFX 用 `sfx-core.exe + DSHOMESFX| marker + payload.zip` 拼接（见第三节重打包方法）。

## 八、下一步（主线选择，开工前定）

1. ~~收尾 Inno QA~~ → **已完成（2026-08-29），安装器双链路交付、安装路径可选**（见第三节）；
2. **主线 A**：Ctrl+K 命令面板 + 会话置顶（走 dshome/core 扩展点）；
3. 回合级通知接线；npm 发布 dshome/dshome-theme（包名 `dshome` 已确认空闲）。

## 九、注意事项

- **凭据与个人数据不在压缩包里**（`C:\Users\kuro\.dsh` 留在原机）：家机需 `DEEPSEEK_API_KEY` 或从原机安全拷贝 `.credentials.yaml`。
- 本机现有 DSHOME（3081）与 web（43120）仍在运行；交接后请勿在线上改 profile 关键文件（改前先托盘退出）。
- 压缩包不含 `E:\DSH\app.src`（约 800MB 解包树，仅本机 junction 需要；家机用干净路径）。

—— 2026-08-29 更新：安装器双链路已交付（安装路径可选），详见第三节。解压后直接开工即可。

## 十、回合级通知 + 设置开关（2026-08-29 交付）

- **特性**：当"由你发起的回合"结束（完成/失败）或后台任务结束，DSHOME 弹系统通知；是否提醒由 **设置 → 通知** 开关控制。
- **文件**：
  - `dshome\lib\host\notify.js`（host 插件 `dshome/notify`）：注册 `dshome` 设置命名空间（enabled/notifyOnTurnCompletion）；订阅 `sessions.on('session/event')`（turn/start、user/message、turn/end）+ `jobs.onJobDone`；开关开启且为用户回合（非 subagent）时 `POST /notify` 到壳（`DSHOME_NOTIFY_PORT||32123`）。
  - `packages\dshome-theme\lib\client.js`：新增「通知」设置行（`settings.general.item`，order=20，locale='dshome'），经 `ctx.settingsScope.bind({namespace:'dshome'})` 读写 host 命名空间。
  - `shell-app\main.cjs`：`startNotifyListener()` 已在位（`POST /notify` 读取 {title,body} → Notification.show()）。
- **依赖注意**：`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-settings` 已加入 dshome 包 `dependencies`（host 插件需要）。本机开发经 junction 到 `app.src\node_modules` 解析；干净安装由 pnpm 链接。
- **验收**（重启后端 + CDP 验证）：settings.describe 出现 `dshome`；设置→通用设置 见「通知」两开关；关主开关 → `dshome.enabled=false` 持久化到 host；重启干净壳后 32123 监听 + `POST /notify` 返回 204。
- 工具：`dshome\cdp-notify.mjs`、`probe-rpc.mjs settings.describe`。
## 十一、插件管理 block 1（已装插件 列表 + 启/停）（2026-08-29 交付）
- **界面**：设置 → 插件管理（settings.section，order=5），读 dshome-pluginmanager.entries 渲染 自制/下载/内置 分组 + 搜索 + 详情 + 启停开关。
- **机制**：平台 apiproxy 固定方法集不路由自定义 RPC、官方 pluginInventory.list 在 web profile 404 → 用 **settings 命名空间总线** dshome-pluginmanager：
  - host dshome/lib/host/plugin-manager.js（inject=['loader']）扫 ctx.loader.entries() 推 entries；监听 equest（toggle）改写 profile cordis.patch.yml；回 esult {ok, restartNeeded, message}。
  - 客户端 packages/dshome-theme/lib/client.js 读 value + 写 equest。
- **核心插件禁停**：dshome-* 全部 + 应用骨架（webserver/web-app/connection/modules/client-runtime/cordis-runner/apiproxy/ui-settings/ui-layout/ui-sidebar/ui-renderer/locale）列入 PROTECTED_MODULES；客户端对「自制」显示"核心"标签（无开关），host 对受保护插件返回"核心插件，不可停用"。
- **坑（已修，勿再踩）**：profile cordis.patch.yml 顶层是 **flow []**，往里插 block - id: 是非法 YAML（missed comma）。writeToggle 需输出**块序列**（有条目时 - id: X\n  disabled: true，无条目时 []）。entryId 是 include:<id>，patch row id 是 <id>（去前缀）。
- **验收**：entries=144；禁停保护返回"核心插件，不可停用"且 patch 不变；非核心插件 停→- id: tool-web\n  disabled: true、启→[]（YAML 均合法）；dshome/core 保持启用。
- 待办：市场安装/卸载、本地自制管理（B/C）为后续增量。
## 十二、恢复记录 + Block B 结论 + junction 陷阱（2026-08-29）

### 网络状态（已更新）
- npm 官方源、npmmirror、GitHub(网页/API/raw)、unpkg、通用外网 **现在都通**（HTTP 200）。之前挡路的 npm 卡死 + GitHub 不可达已解除。ghfast/gh-proxy 403（不需要，直连已通）。

### Block B（社区市场）结论 —— 不能走 bundle 列表
- dsh-community-market 的 package.json **没有 dsh.bundle**，所以**不是 profile bundle**。直接塞进 $DSH_HOME/profiles/<name>/package.json 的 dsh.profile.bundles 会让 profile 启动失败（declares no dsh.bundle in its package.json）。
- 正确组合方式：装为依赖 + 在 profile 的 cordis.patch.yml 加一行 **插件补丁**：- id: community-market
  name: dsh-community-market（而非加进 bundles）。
- 能力边界：市场**浏览/目录**(GET /api/community-market/catalog|state|installable) 纯 web 可用；**安装/卸载**(POST /api/community-market/operations/preview|execute + desktop/request-restart) 依赖桌面端 desktopProfiles/desktopPnpm/desktopPlugins 服务，**CLI/web profile 没有 → 503**。安装流程 = preview→execute(pnpm add+改 bundles)→restartToken→request-restart。
- 本次尝试：把市场临时加入 bundles 导致 boot 失败，**已恢复**（bundles 还原为 @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dshome；profile 正常）。市场包仍作为依赖留在 profile node_modules（无害，未组合）。

### ⚠️ 血泪教训：不要对 junction 用 Remove-Item -Recurse
- Windows 上 Remove-Item -Recurse -Force 作用在 **junction** 上会**顺着 junction 删除目标目录的真实内容**（不是只删链接）。
- 本次误删 E:\DSH\packages\dshome-theme（一个真实源码目录），该目录被 profile node_modules 的 junction 指向。
- **安全做法**：删 junction 用 Remove-Item（不带 -Recurse），或先 Remove-Item -Force 链接本体；-Recurse 只用于真目录。
- **恢复**：从 DSHOME-PACK-2026-08-29\packages\dshome-theme 还原整套包，并**重放**了 client.js 里本次会话加的「通知设置行 + 插件管理分区」两处代码（已实测渲染/启停正常）。host 插件 dshome/notify、dshome/plugin-manager 在 dshome\lib\host\ 未受影响。

### 当前状态
- 后端 3081 正常；profile patch=[]；144 插件；dshome/core 启用；插件管理（含 cordis:include 归内置 + 核心保护）+ 通知设置行可用。
- block B 尚未做（需按 patch 行方式另做）。
## 十三、Block B 组合成功（2026-08-29 更新）
- **正确组合方式（已验证）**：在 profile 的 cordis.patch.yml 用 insert 列表，非 bundle、非裸行：
  \\\yaml
  - insert:
      - id: community-market
        name: dsh-community-market
  \\\
- **效果**：市场插件加载成功（库存 145 项含 dsh-community-market）；GET /api/community-market/state → 200，内置源（dsh-1024store / dsh-marketplace / dshfind）就绪。
- **官方市场 UI 可用**：市场插件自带一个**启动器**（ria-haspopup 图标按钮），点开是官方「发现 / 可安装 / 已安装 / 来源」界面——浏览/搜索直接用；**安装/卸载**在 web/CLI 会提示"需要 DSH Desktop"（依赖桌面 desktopPnpm 等），真正的 DSHOME 桌面客户端具备这些服务、安装可跑。
- **与 block-1 并存**：设置模态导航为 [通用设置, 插件管理, 模型, 插件, Agent 预设, …]；「插件管理」分区正常工作（139 开关 + 自制=核心）。市场启动器是**独立入口**，不冲突。
- **已撤**：自建的 MarketPanel 标签（冗余，避免与官方市场 UI 冲突），插件管理分区已还原为"只读已装列表"版本。
- 注意：设置模态与市场启动器是**两个不同** ria-haspopup 图标按钮；CDP 自检需区分（见 cdp-find-plugins.mjs）。
## 十四、本次会话收尾 · 当前状态与下一步（新会话从这里接）

### 已验证可用（本会话成果）
1. **回合级通知 + 设置开关**：host dshome/lib/host/notify.js（订阅 session/event 的 turn/start·user/message·turn/end + jobs.onJobDone→POST /notify 到壳 DSHOME_NOTIFY_PORT||32123）；设置→通知 两个开关（设置命名空间 dshome）。已实测：开关持久化 + /notify 204。
2. **插件管理 block 1（已装）**：host dshome/lib/host/plugin-manager.js（settings 总线 dshome-pluginmanager：扫 ctx.loader.entries() 推 entries；启停改 profile cordis.patch.yml）；客户端 设置→插件管理 分区（145 项、自制=核心、其余可启停；启停需重启生效；cordis:include 归内置+保护）。已实测。
3. **社区市场组合（block B 浏览）**：profile cordis.patch.yml 用 insert 加入 dsh-community-market；/api/community-market/state 200、内置源就绪；官方市场启动器（发现/可安装/已安装/来源）可用。安装/卸载需桌面 desktopPnpm（web/CLI 提示"需要 DSH Desktop"）。

### 网络
- npm 官方源 / npmmirror / GitHub(网页/API/raw) / unpkg / 通用外网 **都通**（HTTP 200）。ghfast/gh-proxy 403（不需要）。

### 当前运行状态
- 后端 dsh --profile dshome --no-open --port 3081（**后台任务 pwsh-16**，若会话结束被停，用此命令重启）。3081 在线、145 插件、dshome/core 启用。
- 市场补丁：C:\Users\kuro\.dsh\profiles\dshome\cordis.patch.yml = - insert:\n    - id: community-market\n      name: dsh-community-market。
- 壳通知监听在 DSHOME 窗口（需带 DSHOME_NOTIFY_PORT=32123 重开壳；旧壳无监听）。
- profile node_modules：dshome→E:\DSH\dshome(junction)、dshome-theme→E:\DSH\packages\dshome-theme、dshome-palette→E:\DSH\packages\dshome-palette、dsh-community-market(依赖,已装未强制)、@deepseek-ai(199)。

### ⚠️ 关键陷阱（新会话务必注意）
1. **勿对 junction 用 Remove-Item -Recurse**（会顺删目标真实内容）；删 junction 用 Remove-Item（不带 -Recurse）。本会话因此误删过 E:\DSH\packages\dshome-theme 源码，已从 DSHOME-PACK-2026-08-29\packages\dshome-theme 还原 + 重放客户端两处代码（通知行+插件管理）。
2. **市场不是 profile bundle**（无 dsh.bundle）：只能走 insert patch 行，**别**塞进 dsh.profile.bundles（会导致 boot 失败，已验证并已恢复）。
3. 启/停插件**每次需重启 profile 生效**（Cordis 启动时组合）；核心/骨架插件已加保护、客户端"自制"显示"核心"。
4. dshome 的 file: 依赖让 pnpm install 报 ERR_PNPM_ENOENT（junction+file: 问题）；**别在 profile 目录跑 pnpm install**（会弄坏 node_modules 的 dshome 链接，需手动重建 junction）。
5. dshome 包依赖 @deepseek-ai/schemastery(3.18.1)、dsh-settings(0.1.1-rc.2)（本机经 junction 到 pp.src\node_modules 解析；已写入 dshome package.json deps）。

### 下一步（用户将新会话做）
- **block C**：本地自制插件管理（dshome-* 信息/更新）。
- **市场安装/卸载实测**：在 DSHOME 桌面客户端（走 DSH Desktop 启动 profile）具备 desktopPnpm 等，可真正装/卸。
- 可选：把市场是否长期装机、以及 block-1 启停的 UI 细节再打磨。

### 调试工具（已就绪）
- dshome/probe-rpc.mjs <method>（RPC 探针）、cdp-nav.mjs/cdp-plugins.mjs/cdp-find-plugins.mjs/cdp-market-diag.mjs（CDP 自检；注意设置 vs 市场是两个 aria-haspopup 图标按钮，用 cdp-find-plugins.mjs 区分）。

## 十五、2026-08-29 会话：市场装/卸 DSHOME 原生尝试 + 关键教训

### 做了什么
新写 **`dshome/lib/host/desktop.js`**（`dshome/desktop` 宿主插件），用 `ctx.provide` 注册社区市场需要的四个 cordis 服务，让装/卸**脱离 DSH Desktop**：
- `desktopProfiles.current` → `{name, dir}`（`DSH_HOME/profiles/<DSH_PROFILE||dshome>`）
- `desktopPnpm.run(args,signal)` → 在 profile 目录 spawn pnpm，返回 `{stdout,stderr,done,cancel}`
- `desktopPlugins.list()` → 同步返回 `{bundleId,packageName,status,mutable,uninstallable}[]`（**必须同步返回数组**，market 用 `.list().find()`/`reconcileInstallations()`；用 readFileSync）
- `desktopActions` → `openTerminal()`（no-op）/`requestRestart()`（只发信号，POST 壳通知端口，不真重启）
包 `package.json` exports 加了 `"./desktop"`；`cordis.patch.yml` 曾加 `dshome-desktop` 行（**本次已移除，勿再直接加，见下**）。

### 结果（重要）

**✅ 服务层证明可行（脱离 DSH Desktop），且已稳定启用**——注入这四个服务后（`ctx.provide` + 屏蔽未提供服务的 `ctx.get`），社区市场：
- `state.desktopActions={openTerminal:true, requestRestart:true}`；`/installable`、`/installations` 200（此前全是 503/404「desktop only」）。
- 安装 **preview** 200（`dsh-project-memory@0.3.0`，`profileName=dshome`）。
- **该插件当前已接回 `cordis.patch.yml` 并启用**（`dshome-desktop` 行），profile 正常启动、服务层可用。

**❌ 真正安装 execute 卡死（502）**——`MarketInstallService.runPnpm` 跑 `pnpm add` 报：
```
[ERR_PNPM_ENOENT] importPackage ...\node_modules\dshome — ENOENT scandir '...\dshome_tmp_*\node_modules'
```
即 **`dshome` 的 `file:E:/DSH/dshome` 依赖**（其 package 自带 `node_modules`）让 pnpm 在 profile 目录 staging 失败。**与 §7#4 / §14#4 警告完全一致**：`dshome` 是 `file:` 依赖 + 本机这个 dev 源目录带 junction/嵌套 node_modules → pnpm 装不了。**纯新机走 NEW-DEVICE.md 的干净 pnpm 流程能装，本机这个 dev 源不行。** 所以市场装/卸在本机 profile 真正跑通前，得先解决 `dshome` 的 `file:` 依赖（改成发布到 npm / 干净 link，别用带 node_modules 的 dev 目录做 file: 源）。

**❌→✅ 曾挂启动，已修复**——把 `dshome-desktop` 加进 `cordis.patch.yml` 后首次启动报：
```
plugin tree failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply
AggregateError ... ≥1 个 entry create 失败
```
定位（用 `--dump-config` 对照 + `--patch` 二分）：**根因是 `provideIfAbsent` 先调 `ctx.get(未提供服务)` 抛 "cannot get required service" 且把 fiber 置入异常态，触发 include-apply 级联失败**。改为**直接 `ctx.provide`（不再 `ctx.get`）**后 profile 正常启动、服务层可用。**经典教训：宿主插件里别对未提供的服务调 `ctx.get`，直接 `ctx.provide` 并用 try/catch 兜底。**

### ⚠️ 血泪教训（本次造成的）
- **又一次误删 `E:\DSH\packages\dshome-theme` 真实源码**（junction 陷阱）：对 `node_modules\dshome-theme` 用 `Remove-Item -Recurse` / `cmd rmdir /s /q`（当它其实是到该源码目录的 junction 时）会顺删源码。**再次确认：删除 node_modules 里的包一律用 `Remove-Item`（不带 -Recurse），或用 `cmd rmdir /s /q` 时确保它确为真实目录；junction 用 `Remove-Item`（无 -Recurse）只删链接。**
- 已从 `DSHOME-PACK-2026-08-29\packages\dshome-theme` 还原为**基础版**；但 **此前会话加进客户端 `lib/client.js` 的两处代码（「通知」设置行 + 「插件管理」分区）不在备份里，本次未能重放，属已知回归**（下次会话需按 §10/§11 重新加到 `packages\dshome-theme\lib\client.js`）。

### 当前运行状态（已恢复）
- `dsh --profile dshome --no-open --port 3081`（本会话后台任务 **pwsh-21**）**正常启动**；`/api/community-market/state` 200、浏览可用；`desktopActions={openTerminal:false,requestRestart:false}`（dshome/desktop 未加载 → 装/卸回到「desktop only」）。
- profile node_modules 三个 junction 均已还原：`dshome→E:\DSH\dshome`、`dshome-theme→E:\DSH\packages\dshome-theme`(基础版)、`dshome-palette→E:\DSH\packages\dshome-palette`；`@yolk_vat-y` 已清；`@deepseek-ai` 199 项。
- profile `cordis.patch.yml` = `- insert: { - id: community-market, name: dsh-community-market }`（未变）。
- 备份：`E:\DSH\dshome\package.json` 的 `./desktop` export 仍保留（惰性）；profile 仅存既有 `package.json.bak`/`cordis.patch.yml.bak`。

### 下一步（给下一会话）
- 真正打通市场装/卸：先解决 `dshome` 的 `file:` 依赖（建议把 `dshome`/`dshome-theme` 发布至 npm，或为市场测试做一个不含嵌套 node_modules 的干净 `dshome` file: 源），再重新接 `dshome/desktop`。
- 排查 `dshome/desktop` 介入引起的 include-apply 级联失败（可用 `--dump-config` 对照 + `--patch` 覆盖层二分定位，复用 probe-asar.mjs 思路，但需在 Electron/asar 环境跑）。
- 重放 `packages\dshome-theme\lib\client.js` 的「通知设置行 + 插件管理分区」（首次进入会话别漏，先读 §10/§11）。

## 十五补记（本会话实测：市场装/卸 + 教训）——务必先读这里再动手

> 上面 §十五「结果」里的「（且已稳定启用）」**已不成立**。如下是**当前真实状态**，本会话做了完整的市场装/卸实测，结论如实记录：

### ✅ 服务层确实能脱离 DSH Desktop（已证明）
- 新写 `dshome/lib/host/desktop.js` 用 `ctx.provide` 注册 `desktopProfiles/desktopPnpm/desktopPlugins/desktopActions`。注入后：`state.desktopActions={openTerminal:true,requestRestart:true}`、`/installable`、`/installations`、安装 **preview** 全 **200**（此前全 503/404）。**这是真实、可重复的证明**——市场装/卸的 API 层不再需要 DSH Desktop。
- 修复启动崩溃的钥匙：**别对未提供的服务调 `ctx.get`**（会抛 "cannot get required service" 且污染 fiber → include-apply 级联失败）；直接 `ctx.provide` + try/catch 即可（`dshome/desktop` 已按此写）。

### ❌ 真正安装 execute 依然卡死（这是**真屏障**）
- `MarketInstallService.runPnpm` 跑 `pnpm add` 报 `[ERR_PNPM_ENOENT] importPackage ...\node_modules\dshome — scandir '...\dshome_tmp_*\node_modules'`。
- 即使把 profile `package.json` 的 `dshome: file:` **指向一个不含 node_modules 的干净副本**（`build-stage\dshome-clean`，实测 MD5 与源一致、preview 也变 200），execute **仍 502**：因为 `node_modules/dshome` 这个**junction 仍指向 `E:\DSH\dshome`（自带 node_modules）**，pnpm 的 `importPackage dshome` 是在处理**这个已存在的链接**而非 file: 声明。要它成功就得把 `node_modules/dshome` 也改成指向干净源——而这正是 repeatedly 触发 junction 陷阱/节点损坏的地方。
- **结论：不做 packaging 层面的修复（发布 dshome 到 npm，或彻底改进 profile 对 dshome/dshome-theme 的链接方式，去掉「带 node_modules 的 file: 源 + junction」组合），市场装/卸在本机 profile 就是跑不通。纯新机 NEW-DEVICE.md 干净流程能装。**

### ❗本会话实测造成的回归（重要）
- 为测装/卸在本机 profile 里跑了多次 `pnpm add`/`pnpm install`，这在该 `file:`+junction 组合下**每次都会 churn node_modules 并反复删空 `E:\DSH\packages\dshome-theme` 源码**（本会话共删空 3 次，已从 `DSHOME-PACK-2026-08-29\packages\dshome-theme` 还原 3 次，均为**基础版**）。
- **后果**：本会话早期 `dshome/desktop` 是**能稳定启用且服务层可用**的（pwsh-22 验证过：desktopActions=true、market 服务全 200）。（**关于"post-boot 崩溃"：那是误报**——由 `Remove-Item/Set-Content` 写坏的 `cordis.patch.yml`（中文注释与 `- id:` 同行、被注释吞掉）+ `Start-Job` 后台进程随 pwsh 进程退出消失共同造成。**修正 `cordis.patch.yml` 为合法 YAML（用 Node 写、`\n` 分行、UTF-8 无 BOM）+ 用 pwsh 工具后台任务**后，`dshome/desktop` 稳定运行、市场服务层可用。）
- **✅ 已重新启用并确认稳定**：`cordis.patch.yml` 已重新加入 `dshome-desktop` 行（用 Node 写入、合法 YAML）。`dshome/desktop.js` + `"./desktop"` export 保留且启用。
- **铁律（务必牢记）**：**别在本机 profile 目录跑 `pnpm add`/`pnpm install`**——它一定会 churn node_modules + 删空 `packages\dshome-theme`。市场装/卸要么走「打包/发布修复」，要么在**独立/干净环境**测，**不要在本机这个 `file:`+junction profile 上跑 pnpm**。

### 当前真实运行状态（dshome/desktop 已启用，稳定；客户端设置 UI 已重建并可用）
- `dsh --profile dshome --no-open --port 3081`（后台任务每次重启会变，用这条命令即可）稳定运行；`/api/community-market/state` 200、`desktopActions={openTerminal:true,requestRestart:true}`；`/installable`、`/installations`、安装 **preview** 全 **200**（`dsh-project-memory@0.3.0`、`profileName=dshome`）。**市场装/卸服务层已脱离 DSH Desktop 且稳定可用。**
- 三 junction 全对：`dshome→E:\DSH\dshome`、`dshome-theme→E:\DSH\packages\dshome-theme`(基础版)、`dshome-palette→E:\DSH\packages\dshome-palette`；`@yolk_vat-y` 已清；`@deepseek-ai` 199；顶层 280。
- profile `package.json` 已还原 `dshome: file:E:/DSH/dshome`（无 BOM）；`cordis.patch.yml` = community-market insert + `dshome-desktop` 行（dshome bundle 层）+ 各 dshome host 插件行。
- **客户端设置 UI 已重建并可用**：`packages\dshome-theme\lib\client.js` 现在含
  - 「通知」设置项（`settings.general.item`）：`通知`/`回合完成提醒` 两开关，写 `dshome` 命名空间（实测可持久化，当前 `dshome.enabled` 为测试时关闭的 **false**，如需默认开可重新打开）；
  - 「插件管理」分区（`settings.section`）：分组「下载/自制/内置」+ 每项 名称/分类徽章/entryId/Cordis 状态/启停开关 + 搜索 + `重启生效` 状态提示；**146 项、仅 21 个受保护（骨架/核心）禁停，其余可启停**。
  - **正确写法**：组件用渲染器注入的 **`props.useSnapshot`**（勿用 `useSyncExternalStore`）+ 元素全用 **`react_jsx_runtime.jsx(...)`**（本 bundle 无 JSX 转译）；`settingsScope` 用 `ctx.get("settingsScope")`，缺失则不注册；全程 try/catch + 组件体防御（无 controller/useSnapshot/数据就 `return null`）。**完整可照做的重建代码 + host 加 `protected` 的改动，见 `E:\DSH\DSHOME-SETTINGS-UI-RECONSTRUCT.md`（已与当前 client.js 同步，含回退路径）。**
- **node_modules 健康/一致**（已验证：关键依赖可解析、无孤儿残留、无独立 .pnpm 存储、无 tmp 目录）；**「pnpm 重装干净」在本机做不了**（`file:` 依赖 ERR_PNPM_ENOENT，其安全绕过=churn 源，已避免）。**铁律：别再在本机 profile 目录跑 `pnpm add`/`pnpm install`**。
- **可恢复快照**：`E:\DSH\build-stage\dshome-node-snapshot\`（`profile-package.json`/`profile-pnpm-lock.yaml`/`profile-cordis.patch.yml`/`junctions.txt` + `dshome-package.json`/`dshome-cordis.patch.yml`/`dshome-theme-*`/`dshome-palette-package.json`）；`junctions.txt` 里写明删 junction 用 `Remove-Item`（不带 -Recurse）、勿用 `rmdir /s /q`。
## 十六、市场迁移 dshmarket + desktop 服务接口冲突（2026-08-29 晚）

### 背景
旧市场链（dsh-community-market → dshome/desktop 替身服务）已废弃。本次将市场切换为社区 dshmarket（★149，npm 包名 dshmarket，v1.38.1），并安装 dsh-whale-widget（DeepSeek 余额鲸鱼挂件）。**重要：本节环境是 E:\DSHOME（monorepo + nodeLinker hoisted + workspace:* 依赖），与上文大部分记录的旧环境 E:\DSH（file: 依赖 + junction）不同，旧铁律勿套用到新环境。**

### 当前 profile 最终状态（E:\DSHOME\profiles\dshome）
- bundles（5 个）：@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dshome, dshmarket, dsh-whale-widget
- 依赖：dshmarket ^1.38.1（npm 源）、dsh-whale-widget ^0.2.10（npm 源）
- 市场 UI 入口：设置 → Plugin Market（dshmarket）
- 鲸鱼挂件：右下角（dsh-whale-widget，npm 0.2.10）
- **dshome/desktop 已禁用**（见下）——profile cordis.patch.yml 追加：
  `- id: dshome-desktop
    disabled: true`
- 备份：package.json.pre-workshop.bak / pre-dshmarket.bak / pre-cleanup.bak / cordis.patch.yml.pre-desktop-off.bak；git 已跟踪 package.json + pnpm-lock.yaml，可回滚

### ⚠️ 关键坑：service.runPlugin is not a function（已解决）
- **根因**：dshmarket 检测到 desktopProfiles 服务存在就走 DSH Desktop 分支（src/index.ts:62→87），调用 desktopPnpm.runPlugin(...)；而 DSHOME 的 dshome/desktop 提供的是**旧接口 { run }**（为已卸载的官方市场设计），没有 runPlugin 方法 → 报错。
- **修复**：禁用 dshome/desktop 插件。dshmarket 检测不到桌面服务后回退**普通 dsh plugin CLI 路径**（README 明确 'Ordinary DSH keeps the existing CLI path above'）——该路径已验证可用（装 dshmarket / whale-widget 都成功，5~12s）。
- **恢复**：若将来重装官方 dsh-community-market，需把 profile cordis.patch.yml 里 dshome-desktop 的 disabled: true 去掉。
- **教训**：DSHOME 的 dshome/desktop 替身服务只兼容旧官方市场接口；第三方市场（dshmarket）期望 DSH Desktop 新契约（runPlugin），接口不匹配时宁可直接禁用替身走 CLI。

### 本次安装/卸载实录（全部成功）
- 装 dsh-plugin-workshop（github 源）→ 体验：无安装功能（仅浏览+手动命令）→ 已卸
- 卸 @sanqi-normal/dsh-webui-market-plugin（旧市场）→ 依赖/lock/node_modules 全清
- 装 dshmarket ^1.38.1（npm 源）→ bundles 第 4 个
- 装 dsh-whale-widget ^0.2.10（npm 源）→ bundles 第 5 个
- 组合验证：dsh --profile dshome --dump-config 每次均 exit 0

### 待办
- 重启 profile 后验收：Plugin Market 安装功能恢复正常（不再报 runPlugin 错）、右下角鲸鱼挂件出现。
- 可选：把本节并入 DSHOME-DESIGN.md；清理 4 个 .bak 备份（确认稳定后）。
### 改动归属（重要：哪些改动不会被更新覆盖）
- 禁用 dshome/desktop 的修复在 **profile cordis.patch.yml**（DSHOME 自己的配置），不在 dshmarket 包里——dshmarket 更新（dsh plugin update / 面板更新）只动 node_modules/dshmarket + package.json 版本 + lock，**不会碰 cordis.patch.yml**，修复不会被覆盖。
- DEEPSEEK_API_KEY 凭据在 **/.credentials.yaml**（被 .gitignore 忽略，零凭据原则），同样不受任何插件更新影响。
- 唯一会丢失改动的场景：**删 profile 目录重装**（正常更新流程不会）。

### 版本锁定与升级顺序（重要）
- profile 依赖版本写法（2026-08-29 晚）：dshmarket **^1.38.1**（latest=1.38.1，无更新可拉）、dsh-whale-widget **^0.2.10**、dsh-better-sidebar **0.17.1（精确锁定）**、DSH 核心全部 **0.1.1-rc.2**。
- **better-sidebar 0.17.1 的 peer 是 ^0.1.0-rc.8，兼容 DSH 0.1.1-rc.2；但 GitHub main 的 0.18.0-alpha.0 peer 是 ^0.1.2-alpha.2，不兼容当前 DSH——切勿手动升级 better-sidebar 到 0.18.0-alpha.0，除非先升 DSH 核心。**
- 正确升级顺序：先升 @deepseek-ai/dsh* 到 0.1.2-alpha.2 → 再升 better-sidebar。
- 可选加固：把 dshmarket / dsh-whale-widget 也改成精确版本（去掉 ^），防止意外自动升级。

### 本会话补充实录
- 装 dsh-better-sidebar 0.17.1（npm 源）：dshmarket 面板默认走 GitHub 源会报 nothing installable（prepare 构建被 pnpm 拦截），**改走 npm 源（自带预构建 lib）即成功**；node-pty 构建已在根 pnpm-workspace.yaml allowBuilds 放行。
- 修复鲸鱼挂件未配置 API：小鲸鱼硬编码读 DEEPSEEK_API_KEY（lib/index.js:1527），DSHOME 只有 DSHOME_USER_KEY → 在 .credentials.yaml 补 DEEPSEEK_API_KEY（复用原值）；凭据 describe() 返回 source=file、writable=true，**模型设置输入框仍可编辑**（只有环境变量提供时才会锁定只读）。
- 安全确认：.credentials.yaml 被 .gitignore 排除（git check-ignore 命中），git 未跟踪、历史无泄露；已删所有 .bak 残留。
- react-dom 19.2.8 vs react 18.3.1 peer 警告：官方链原有（trajectory→@tanstack/react-virtual 引入 19），装 better-sidebar 前就存在，GUI 一直正常；如重启后白屏再考虑 overrides 锁 18。

### 待办（更新）
- 重启 profile 后验收：Plugin Market 安装、鲸鱼挂件余额、better-sidebar 右侧栏（终端页如报 node-pty 加载失败跑 pnpm rebuild node-pty）。
- 可选：把本节并入 DSHOME-DESIGN.md。
