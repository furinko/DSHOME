# DSHOME 换新设备部署指南（官方流程，无需 junction 绕路）

> 结论（2026-08-28 实机验证）：DSHOME 可以走**纯官方安装流程**部署到新机器——
> 关键是把所有 `@deepseek-ai/*` 依赖**钉死 `0.1.1-rc.2`**（npm 的 `latest` 标签是旧版
> 0.0.1-rc.1，旧清单会拉到未发布的 `dsh-compact`，导致 404），配 `autoInstallPeers: true`
> 与 `allowBuilds`。实测：403 包 31.7s 装完、启动成功、皮肤进 roster。
>
> **DSH Desktop 不是必需的**：DSHOME 只依赖 `dsh` CLI + 官方运行时包（都在 npm）。
> 本机早期用 DSH Desktop 只是因为它是现成的 CLI 来源；独立路径见下。

## 新机器前置（二选一）

| 路径 | 前置 | 说明 |
|---|---|---|
| **A. 独立（推荐，无 DSH Desktop）** | Node.js ≥22.19/≥24 + `npm i -g pnpm` + `npm i -g @deepseek-ai/dsh@0.1.1-rc.2` | 官方 CLI 全球装（dsh-tui 同款姿势）；`dsh` 命令进 PATH，launch.vbs 自动回退使用 |
| **B. DSH Desktop** | 官方安装包（自带 CLI + pnpm，免装 Node） | 零 Node 环境；launch.vbs 优先用它 |

其它前置：`DEEPSEEK_API_KEY`（模型访问；本机 `.dsh\.credentials.yaml` 里已有，迁移一并拷走）。
克隆仓库到**任意路径**，运行 `packages\dshome\scripts\deploy-new-device.cmd`（脚本自动把模板 file: 依赖的 `E:/DSH` 占位符重指到实际仓库路径，无需同路径拷贝）。

### 1. 建 profile
`scripts/deploy-new-device.cmd` 自动完成等价操作（也可手动）：
- 在 `%USERPROFILE%\.dsh\profiles\dshome\` 生成 `package.json`（bundles = dsh-base/dsh-web-app/dshome；
  dependencies 全钉 0.1.1-rc.2 + 30 个 preset 工具包 + dshome/dshome-theme file:）、
  `pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: true`、`allowBuilds`）。
- 在 profile 目录执行 `pnpm install`（DSH Desktop 自带 pnpm 11.8，已在 PATH）。
- 创建桌面快捷方式 `DSHOME.lnk`（隐藏启动 → 窗口自动弹出）。

### 2. 启动
- 双击桌面 **DSHOME**（等价 `dsh --profile dshome`），窗口出现即完成。
- 退出：托盘 → 退出（窗口 + 后端一并结束）。

### 3. 账号与数据（可选迁移）
- 模型凭据、会话历史、设置都在 `C:\Users\<你>\.dsh`；整目录拷到新机即迁移
  （注意 `.credentials.yaml` 的保管）。新机首启若拿不到 key，在设置里补配即可。

## 这条路与"别人怎么做的"对照（调研结论）

| 项目 | 新设备安装方式 | 参考点 |
|---|---|---|
| `@deepseek-harness-tui/dsh-tui` | 前置 Nodejs + deepseek-harness；`npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui` 或 `dsh plugin --profile dsh-tui add ...`；README 专门提示 pnpm≥11 的 `ERR_PNPM_IGNORED_BUILDS` 处理 | 纯插件/npm 分发、显式处理 pnpm11 构建策略（与我们同坑） |
| `dsh-clean-desktop-shell` | 两种：Release 安装包（Windows exe / macOS dmg）或 `dsh plugin --profile web add dsh-clean-desktop-shell`（首启联网准备 Electron 运行时 1-2 分钟） | 安装包 + 插件双形态；Electron 运行时按需准备 |
| `ahikl/dsh-desktop` | 插件形态，`dsh desktop` 启动；未装 web-app 时自动拉起官方 Web UI | 自动复用/自启后端 |
| `RAFOLIE/dsh-desktop-windowos` | Tauri v2 单便携 exe（自带运行时，免 Node 环境） | 绿色单文件分发 |
| DSHOME（本项目） | **profile 全钉 0.1.1-rc.2 + pnpm 官方安装 + 桌面快捷方式**（本指南）；长期可发布 `dshome` 到 npm 后走 `dsh plugin --profile dshome add dshome` 一行装 | 已实测通过 |

## 长期路线（把"换设备"变成一行命令）
1. 发布 `dshome` / `dshome-theme` 到 npm（或 GitHub，`dsh plugin ... add github:...`）；
2. dshome 的 package.json 显式依赖 dshome-theme（已加 `file:`，发布时换版本号）；
3. 新机器只做两件事：装 DSH Desktop → `dsh plugin --profile dshome add dshome`。
