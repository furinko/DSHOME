# DSHOME

DSHOME = 基于 DeepSeek Harness 的**个人桌面客户端**（独立 profile + Electron 薄壳 + 自主题/品牌 + 市场/插件管理 + 心智体系）。

- **产品模型**：每个新安装都自带一个**初始伴生体**（`mind/` 出厂固件＝同一份起点）；使用者各自把它养成**属于自己的那一个**；本机实例（`mind-private/`）**永不外流、不可复制**。
- **本仓库的分发形态＝GitHub 源码**（clone 即用）。**"给别人用 / 市场安装"是附带的源码路径，不是产品形态**（不投 CI / 签名 / 装机链）——详见文末附录。
- **本机自用为主**：同一套仓库在多台设备上各自演化（心智**不跨设备同步**，同步的是项目产物；见 `docs/DESIGN.md` §十）。

本仓库是 **monorepo**：`pnpm workspace` 管理 **9 个本地包**。

## 结构

```
dshome-monorepo/
├─ packages/
│  ├─ dshome/                    # 主 bundle（core/shell/desktop/notify/plugin-manager + Electron shell-app）
│  ├─ dshome-theme/              # 客户端皮肤（品牌色 token + 品牌槽 + 通知/插件管理设置 UI）
│  ├─ dshome-palette/            # Ctrl+K 命令面板
│  ├─ dshome-plugin-center/      # 插件管理中心（client-only，sidebar 入口）
│  ├─ dshome-assistant-identity/ # 对话区助手形象（client-only，localStorage 持久化）
│  ├─ dshome-input/              # 三档输入队列 dock（client-only，遮蔽官方 QueueDock）
│  ├─ dshome-conversation/       # 对话区卡片化（client-only，Think 8 行窗 + 块卡片隔离）
│  ├─ dshome-mind/               # 心智图谱面板（/api/mind/* 双区读取 + conversation.view「心智」）
│  └─ imagegen-plugin/           # 图像生成插件（ComfyUI 桥，包名 dsh-imagegen）
├─ mind/                         # 心智出厂固件（L0 宪法 / L1 法律 / L2 能力 / L3 记忆 + TRASH）
├─ mind-private/                 # 心智本机实例（记忆/项目/Learn——gitignore，永不推送）
├─ profile-template/             # 示例 profile（dsh 运行时 profile 脚手架）
├─ docs/                         # 文档中心（索引见 docs/README.md；设计总纲 docs/DESIGN.md）
├─ build-stage/                  # 构建产物暂存（gitignore；DSHOME.iss 为在管例外）
├─ pnpm-workspace.yaml           # packages/* + profiles/* + allowBuilds
├─ .npmrc                        # 镜像源
└─ .gitignore
```

## 九个包

| 包 | 说明 |
|---|---|
| `dshome` | host 插件 + Electron 壳 + 客户端 bundle 入口 |
| `dshome-theme` | 品牌/主题 + 设置 UI（通知开关、插件管理分区） |
| `dshome-palette` | Ctrl+K 命令面板 |
| `dshome-plugin-center` | 插件管理中心（client-only，`sidebar.footer.action` 入口） |
| `dshome-assistant-identity` | 对话区助手形象（client-only） |
| `dshome-input` | 三档输入队列 dock（client-only，排队 / 插话 / 立即） |
| `dshome-conversation` | 对话区卡片化（client-only，Think 8 行窗 + 块卡片隔离） |
| `dshome-mind` | 心智图谱（host `/api/mind/*` + client `conversation.view` 面板） |
| `imagegen-plugin` | 图像生成（ComfyUI 桥，包名 `dsh-imagegen`） |

## 怎么让伴生体记住"关于你"的东西（一句话）

想让伴生体**记你的事 / 存私密 / 加人设** → 都放 `mind-private/`：它在**本机、永不推 GitHub**，放心放；出厂 `mind/` 是通用逻辑，**别把私密写在这**。**用就是了，不用先懂"双区架构"**——真要存私密/加人设时，Assistant 会直接指点你放哪。

## 上手

### 方式一：一键脚本（推荐，新设备/干净环境）

```bat
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
setup-dev.cmd
```

`setup-dev.cmd` 会自动完成：
- 下载免安装版 **node 24.19.0**（npmmirror 镜像 + sha256 校验）到 `%LOCALAPPDATA%\dshome-dev`（不碰系统、无需管理员权限）
- 安装 **pnpm 10** 到同一目录（自包含，删除该目录即完全卸载，无 PATH/注册表残留）
- 自动跑 `pnpm install`（装依赖，workspace 链接各包）+ `pnpm run setup`（下载 electron 二进制，镜像加速）
- 幂等：重复运行秒过，不重复下载

### 方式二：手动（已有 node/pnpm 环境）

```bash
git clone https://github.com/furinko/DSHOME.git
cd DSHOME
pnpm install        # 装依赖（workspace 链接各包）
pnpm run setup      # 下载 electron 二进制（pnpm 默认跳过 postinstall；此脚本用镜像加速）
```

### 方式三：日常更新（多机同步后）

在另一台机器改了依赖 / 插件版本后，回家**双击根目录的 `更新DSHOME.cmd`**：

1. `git pull --ff-only`（工作区有**已跟踪文件**的改动时会先拦下，不会硬拉）
2. `pnpm install` —— **真正把另一台机器改的插件版本装到本机的那一步**（只拉 git 不 install，会安静地停在旧版本）
3. 校验 `profiles/dshome` 的精确版本 pin 与 `node_modules` 实体是否一致（`scripts/verify-pin-vs-installed.mjs`）

只想看状态、不动任何文件：`更新DSHOME.cmd check`。
`pnpm` 本体需要更新时才用 `update-pnpm.cmd`（默认钉 10.x；跨大版本会改写 `pnpm-lock.yaml` 的 lockfileVersion，多机共用慎用）。

## 发布与版本（自己发版）

各包均为 `private: true`，**不走 npm 发布**；分发载体是 GitHub 仓库 + 版本 tag。

```bash
node scripts/sync-version.mjs          # 版本单源同步（packages / 品牌 / updates.json 的 version 与 url）
git tag vX.Y.Z && git push origin vX.Y.Z
git push origin main
```

> 根 `package.json` **没有 `version` 字段** ⇒ `pnpm version patch` 不可用，版本一律走上面的脚本。
>
> Electron 壳（`shell-app/updater.cjs`）的版本源是仓库根 `updates.json`（固定从 GitHub raw 拉取）——
> 发布新版安装包（`build-stage/DSHOME-setup-*.exe`）后需同步其中的 `version` / `url` / **`sha256`**
> （更新器**硬校验** sha256，不一致即拒绝安装）。
>
> ⚠️ **已知缺口**：`updates.json` 的 `sha256` 目前**没有出厂门禁对账**（只有版本号有），需人工核对——
> 记在 `docs/DESIGN.md` §12.2 待订正口径里。
>
> 打包门禁（ISSUE-003）：出包前必跑 `node scripts\verify-payload.mjs`（断言 payload 不含
> `profiles\node_modules` 实体树、固件与 payload 一致，`--fix` 可隔离毒树）；启动/卸载 exe 用
> `scripts\build-launchers.cmd` 重建（`DSHOME.exe` / `UninstallDSHOME.exe`）；安装/启动冒烟见
> `docs/incidents/`（含 junction 断言与发布清单）。

## 相关文档

- `docs/DESIGN.md`：**设计总纲（现行）**——为什么这么设计 + 现行设计决策的权威汇总
- `docs/ARCHITECTURE.md`：现状架构说明与设计决策记录（patch 分层 / 插件职责 / 部署模型 / rationale）
- `docs/README.md`：文档导航索引（架构 / 心智体系 / 历史快照 / 历史归档 / 事故复盘 / 部署）
- `mind/README.md`：心智体系（出厂固件：L0 宪法 / L1 法律 / L2 能力 / L3 记忆 + TRASH；运行时记忆在本机 `mind-private/` 不入仓库）
- `docs/incidents/`：**5 份事故复盘**（插件加载 / 版本族不兼容 / 安装包 junction / 插件安装崩溃 / 双包同装），编号与状态见 `docs/README.md`

## 开发注意事项（沉淀自历史交接文档，2026-08-31 归档后保留）

- 🔴 别在本机 profile 目录直接跑 `pnpm add`/`pnpm install`（`file:` 依赖会 ERR_PNPM_ENOENT；装插件用 `dsh plugin --profile dshome add <pkg>`）
- 🔴 删 junction 用 `Remove-Item`（不带 `-Recurse`），勿用 `rmdir /s /q`（会顺 junction 删真实内容）
- ℹ️ 构建产物统一在 gitignored 的 `build-stage/`（出包原料按 `build-stage/DSHOME.iss` 配方重组）

---

## 附录：分发与他人使用（可选，源码形态）

> 本仓**不做** CI / 签名 / 装机链；以下是"别人自己拿到源码跑起来"的最短路径。

- **别人（手动）**：`dsh plugin --profile dshome add github:furinko/DSHOME`，或 `git clone` + `pnpm install` + `pnpm run setup`（同「上手」方式二）。
- **拿到后**：按「上手」执行一次；`dsh` 首启会自建 profile（仓库即应用）。
- **注意**：本仓的部分门禁装在作者本机的 `git hook` 里（`.git/hooks/pre-commit`），**新克隆不会有**——你自己的仓库里请自行按需启用（`pnpm install` 会通过 `prepare` 装 hook）。
