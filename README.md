# DSHOME

DSHOME = 基于 DeepSeek Harness 的个人桌面客户端（独立 profile + Electron 薄壳 + 自主题/品牌 + 市场/插件管理 + 心智图谱）。
本仓库是 **monorepo**：`pnpm workspace` 管理六个本地包，供**两台设备研发 + 给别人用 + 市场真实安装**。

## 结构
```
dshome-monorepo/
├─ packages/
│  ├─ dshome/               # 主 bundle（core/shell/desktop/notify/plugin-manager + Electron shell-app）
│  ├─ dshome-theme/         # 客户端皮肤（品牌色 token + 品牌槽 + 通知/插件管理设置 UI）
│  ├─ dshome-palette/       # Ctrl+K 命令面板
│  ├─ dshome-plugin-center/ # 插件管理中心（client-only，sidebar 入口）
│  ├─ dshome-assistant-identity/ # 对话区助手形象（client-only，localStorage 持久化）
│  └─ dshome-mind/          # 心智图谱面板（/api/mind/* 双区读取 + conversation.view「心智」）
├─ mind/                    # 鱼鱼心智出厂固件（L0 宪法/L1 法律/L2 能力/L3 记忆 + Project + TRASH）
├─ mind-private/            # 鱼鱼心智本机实例（记忆/项目/Learn——gitignore，永不推送）
├─ profile-template/        # 示例 profile（dsh 运行时 profile 脚手架）
├─ pnpm-workspace.yaml      # packages/* + profiles/* + allowBuilds
├─ .npmrc                   # 镜像源
└─ .gitignore
```

## 上手（两台都这样）

### 方式一：一键脚本（推荐，新设备/干净环境）
```bat
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
setup-dev.cmd
```

`setup-dev.cmd` 会自动完成：
- 下载免安装版 **node 24.19.0**（npmmirror 镜像 + sha256 校验）到 `%LOCALAPPDATA%\dshome-dev`（不碰系统、无需管理员权限）
- 安装 **pnpm 10** 到同一目录（自包含，删除该目录即完全卸载，无 PATH/注册表残留）
- 自动跑 `pnpm install`（装依赖，workspace 链接四包）+ `pnpm run setup`（下载 electron 二进制，镜像加速）
- 幂等：重复运行秒过，不重复下载

### 方式二：手动（已有 node/pnpm 环境）
```bash
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
pnpm install        # 装依赖（workspace 链接四包）
pnpm run setup      # 下载 electron 二进制（pnpm 默认跳过 postinstall；此脚本用镜像加速）
```

## 发布给他人（仅 GitHub tag 分发）

各包均为 `private: true`，**不走 npm 发布**；分发载体是 GitHub 仓库 + 版本 tag：

```bash
pnpm version patch          # 改版本号
git tag v0.2.0 && git push origin v0.2.0   # GitHub tag
git push origin main
```

> Electron 壳（shell-app/updater.cjs）的版本源是仓库根 `updates.json`（固定从 GitHub raw 拉取）——
> 发布新版安装包（build-stage/DSHOME-setup-*.exe）后需同步其中的 `version` / `url` / `sha256`。
>
> 打包门禁（ISSUE-003）：出包前必跑 `node scripts\verify-payload.mjs`（断言 payload 不含
> `profiles\node_modules` 实体树，`--fix` 可隔离毒树）；启动/卸载 exe 用
> `scripts\build-launchers.cmd` 重建（`DSHOME.exe` / `UninstallDSHOME.exe`）；安装/启动冒烟见
> `docs/incidents/DSHOME-ISSUE-20260831-INSTALLER-JUNCTION.md`（含 junction 断言与发布清单）。

新设备拿到本仓库后：按上「上手」执行（`setup-dev.cmd` 一键，或 `pnpm install` + `pnpm run setup`）。
别人（手动）：`dsh plugin --profile dshome add github:furinko/DSHOME`（或 `git clone` + `pnpm install`）。

## 四包
| 包 | 说明 |
|---|---|
| `dshome` | host 插件 + Electron 壳 + 客户端 bundle 入口 |
| `dshome-theme` | 品牌/主题 + 设置 UI（通知开关、插件管理分区） |
| `dshome-palette` | Ctrl+K 命令面板 |
| `dshome-plugin-center` | 插件管理中心（client-only，sidebar.footer.action 入口） |

## 相关文档
- `docs/README.md`：文档导航索引（按域分类：架构 / 灵魂体系 / 集成 / 事故复盘 / 部署）
- `docs/ARCHITECTURE.md`：现状架构说明与设计决策记录（patch 分层 / 插件职责 / 部署模型 / rationale）
- `mind/README.md`：鱼鱼心智体系（出厂固件：L0 宪法 / L1 法律 / L2 能力 / L3 记忆 + Project + TRASH；运行时记忆在本机 `mind-private/` 不入仓库；旧 soul / dsh-evolve 文档已归档 `docs/archive/`）
- `docs/incidents/`：事故复盘（ISSUE-001 插件加载失败 / ISSUE-002 版本族不兼容 / ISSUE-003 安装包 junction）

## 开发注意事项（沉淀自历史交接文档，2026-08-31 归档后保留）
- 🔴 别在本机 profile 目录直接跑 `pnpm add`/`pnpm install`（`file:` 依赖会 ERR_PNPM_ENOENT；装插件用 `dsh plugin --profile dshome add <pkg>`）
- 🔴 删 junction 用 `Remove-Item`（不带 `-Recurse`），勿用 `rmdir /s /q`（会顺 junction 删真实内容）
- ℹ️ 构建产物、迁移备份统一在 gitignored 的 `build-stage/`（出包原料按 DSHOME.iss 配方重组；历史/退役资产在 `build-stage/mind-migration-backup-20260902/retired/`）
