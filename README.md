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

### 方式一：一键脚本（推荐，新设备/干净环境）
```bat
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
setup-dev.cmd
```

`setup-dev.cmd` 会自动完成：
- 下载免安装版 **node 24.19.0**（npmmirror 镜像 + sha256 校验）到 `%LOCALAPPDATA%\dshome-dev`（不碰系统、无需管理员权限）
- 安装 **pnpm 10** 到同一目录（自包含，删除该目录即完全卸载，无 PATH/注册表残留）
- 自动跑 `pnpm install`（装依赖，workspace 链接三包）+ `pnpm run setup`（下载 electron 二进制，镜像加速）
- 幂等：重复运行秒过，不重复下载

### 方式二：手动（已有 node/pnpm 环境）
```bash
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
pnpm install        # 装依赖（workspace 链接三包）
pnpm run setup      # 下载 electron 二进制（pnpm 默认跳过 postinstall；此脚本用镜像加速）
```

## 发布给他人（GitHub tag）
```bash
pnpm version patch          # 改版本
pnpm publish                # 发布到 registry（如需）
git tag v0.2.0 && git push origin v0.2.0   # GitHub tag
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
- `packages/dshome/docs/NEW-DEVICE.md`：换新设备部署（官方 npm 流程）
- `docs/DSHOME-NPM-PUBLISH-RESTRUCTURE.md`：方案① 私有 verdaccio 发布 + 版本号依赖
- `docs/DSHOME-SETTINGS-UI-RECONSTRUCT.md`：客户端设置 UI（通知/插件管理）重建
- `docs/DSHOME-HANDOVER.md`：开发交接（当前状态、坑、下一步）
- `docs/DSHOME-DESIGN.md`：完整设计文档
