# DSHOME

DSHOME = 基于 DeepSeek Harness 的个人桌面客户端（独立 profile + Electron 薄壳 + 自主题/品牌 + 市场/插件管理）。
本仓库是 **monorepo**：`pnpm workspace` 管理三个本地包，供**两台设备研发 + 给别人用 + 市场真实安装**。

## 结构
```
dshome-monorepo/
├─ packages/
│  ├─ dshome/          # 主 bundle（core/shell/desktop/notify/plugin-manager + Electron shell-app）
│  ├─ dshome-theme/    # 客户端皮肤（品牌色 token + 品牌槽 + 通知/插件管理设置 UI）
│  └─ dshome-palette/  # Ctrl+K 命令面板
├─ profile-template/   # 示例 profile（dsh 运行时 profile 脚手架）
├─ pnpm-workspace.yaml # packages/* + allowBuilds
├─ .npmrc              # 镜像源
└─ .gitignore
```

## 上手（两台都这样）
```bash
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
pnpm install                 # 装依赖（workspace 链接三包）
node node_modules/electron/install.js   # electron 二进制（pnpm 默认跳过 postinstall，需手动一次；或设 ELECTRON_MIRROR）
```
- 改 `packages/dshome` 等源码 → 另一台 `git pull` → 即生效（`workspace:*` 互引，无 `file:+junction` 的 churn/删源码问题）。
- 铁律：需要市场真实安装时，别在 dsh 的 profile 目录里跑 `pnpm`；发布/装插件走「发布 + 版本依赖」或 GitHub 源。

## 发布给他人（GitHub tag）
```bash
pnpm version patch          # 改版本
pnpm publish                # 发布到 registry（如需）
git tag v0.1.0 && git push origin v0.1.0   # GitHub tag
git push origin main
```
别人：`dsh plugin --profile dshome add github:furinko/DSHOME`（或 `git clone` + `pnpm install`）。

## 三包
| 包 | 说明 |
|---|---|
| `dshome` | host 插件 + Electron 壳 + 客户端 bundle 入口 |
| `dshome-theme` | 品牌/主题 + 设置 UI（通知开关、插件管理分区） |
| `dshome-palette` | Ctrl+K 命令面板 |

## 相关文档
- `docs/NEW-DEVICE.md`：换新设备部署（官方 npm 流程）
- `DSHOME-HANDOVER.md`、`DSHOME-DESIGN.md`（在开发机 `E:\DSH`）
