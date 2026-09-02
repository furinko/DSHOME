# DSHOME 问题说明：安装包携带实体化 profiles\node_modules 导致首启失败

> 问题编号：DSHOME-ISSUE-003 ～发生：2026-08-31 ～状态：**已修复并验证；发布版已重建覆盖（2026-09-01，sha `54d2c586…`）** ～定位：根因复盘 + 打包/发布预防
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）
> 原始情况说明：`E:\DSH\DSHOME安装包问题情况说明_2026-08-31.md`（干净环境实测记录）

---

## 1. 摘要

v0.2.0 安装包（当时为 **7-Zip SFX** 自解压包）在完全干净环境首装后，后端启动自检失败：
`profiles\node_modules`（dsh 的**扁平模块 fallback 自愈目录**）随包分发并经打包/解压**实体化**，
启动时 `ensureSymlink` 逐包校验命中实体目录即抛 `exists and is not a symlink` 退出。

一句话根因：**运行时自愈目录（junction 集合）被当作普通文件树打进了安装包；7-Zip/Inno 等打包器
均不保留 junction 语义，解压即实体化 → dsh 自检拒绝启动。**

用户侧修复（已验证）：删除 `profiles\node_modules` 后重启，dsh 首启自愈自动重建全部 junction。
打包侧根治（本次落地）：payload 排除 + 打包前门禁 + 冒烟 junction 断言 + Inno 排除兜底。

## 2. 问题现象

| 项目 | 表现 |
|---|---|
| 安装包 | `DSHOME-setup-0.2.0.exe`（约 218MB，7-Zip SFX 特征） |
| 安装 | 双击展开至 `E:\DSHOME`（根目录文件同一秒创建） |
| 启动 | `开发启动.cmd` → Electron 弹窗「后端连续 3 次启动失败」 |
| 后端完整报错 | `Error: dsh: E:\DSHOME\profiles\node_modules\@deepseek-ai\dsh exists and is not a symlink; remove it so dsh can manage the installation fallback`（ensureSymlink / healProfilesModuleFallback 堆栈） |
| 与机器/网络/配置的关系 | 无关——任何用户经该 exe 安装都会复现（包内结构问题） |

## 3. 排查过程

1. **识别安装形态**：exe 前/尾部 128KB 扫描命中 "7-Zip" 特征（非 Inno/NSIS/WinRAR；无注册表卸载项、无安装日志）。
2. **读源码**：`@deepseek-ai/dsh-app-boot/lib/index.js`
   - `ensureSymlink`（:371-389）：条目存在且非符号链接 → 直接抛错（:379）；
   - `healProfilesModuleFallback`（:409-438）：BFS 依赖闭包逐包 `ensureSymlink` 到 `$DSH_HOME\profiles\node_modules`（:436）。
3. **实测**：`E:\DSHOME\profiles\node_modules` 为 168MB 实体目录树（数百个真实复制目录）；逐删除后重启继续报下一个 → 确认整树实体化。

## 4. 根因分析

- `profiles\node_modules` 是 dsh 的**运行时自愈目录**：首启由 `healProfilesModuleFallback` 自动生成全依赖闭包的 junction，指向包的真实位置——**本不应随包分发**；
- 打包器不保留 NTFS junction 语义：7z 归档不保存 junction 属性，Inno 同样按实体文件打包；
- 两者叠加 = 解压后全为实体目录 → 自检逐一报错，清空才能启动。

> 与 ISSUE-001（插件根入口缺 apply）/ ISSUE-002（插件版本族不兼容）无关——本问题是**包内结构/打包流程**问题。

## 5. 修复（用户侧，已验证）

1. 删除 `E:\DSHOME\profiles\node_modules`（实体复制树）；
2. 重启后端；
3. dsh 自愈自动重建全部 junction（Windows junction 无需管理员）；
4. 验证：端口 3099 LISTENING、HTTP 200、`Get-Item ...\@deepseek-ai\dsh` → `LinkType: Junction`、Electron 壳正常。

应急办法（约 1 分钟）：遇同款报错 → 删除 `profiles\node_modules` 后重启即可。

## 6. 打包侧根治（2026-09-01 落地）

| 动作 | 落点 | 说明 |
|---|---|---|
| 打包前门禁 | `scripts/verify-payload.mjs`（新增） | 断言 `build-stage\payload` 不含 `profiles\node_modules` 实体树；`--fix` 重命名隔离（可逆，不删除）；隔离备份 `profiles\node_modules.stale-*` 需人工确认后删除 |
| 安装/启动冒烟 | `scripts/smoke.mjs`（扩展） | 后端启动成功 + HTTP 200 之外，断言 `profiles\node_modules\@deepseek-ai\dsh`、`@deepseek-ai\dsh-app-boot` 为 junction；未设 `DSH_HOME` 时自动注入 repoRoot（承接 ISSUE-001 的误导性报错教训） |
| Inno 排除兜底 | `build-stage/DSHOME.iss` | `[Files]` 加 `Excludes: "profiles\node_modules;profiles\node_modules.stale-*"`——即使 payload 漏清也不进包 |
| 启动/卸载 exe（源码+安装包） | `scripts/launcher.cs`、`scripts/uninstaller.cs`、`scripts/build-launchers.cmd`（新增） | `DSHOME.exe`：布局无关启动器（逻辑同 开发启动.cmd；`--selfcheck` 自检），源码根与 `{app}` 通用；`UninstallDSHOME.exe`：卸载器（删快捷方式 + junction 安全删除 + 目录即卸载）；用 Windows 自带 csc 编译，零第三方依赖 |
| 安装器入口 exe 化 | `build-stage/DSHOME.iss` | 启动快捷方式/装后启动指向 `{app}\DSHOME.exe`（无控制台闪烁）；`Uninstallable=yes` + `CreateUninstallRegKey=no` 生成卸载 exe（`unins000.exe`）且零注册表残留；`[UninstallDelete]` 整目录清理（目录即卸载哲学） |

### 发布门禁清单（每次发版必做）

0. 改动启动/卸载逻辑后先 `scripts\build-launchers.cmd` 重建，并确认 `DSHOME.exe --selfcheck` 通过；
1. `node scripts\verify-payload.mjs` → 必须 PASS（或先 `--fix` 隔离毒树）；
2. `node scripts\smoke.mjs` → PASS（含 junction 断言）；
3. `ISCC.exe build-stage\DSHOME.iss` 出包；
4. 静默安装冒烟：`DSHOME-setup-*.exe /VERYSILENT` → 启动 → HTTP 200 + `profiles\node_modules` 条目 `LinkType=Junction`；
5. 同步 `updates.json` 的 `version/url/sha256`（url 须精确匹配 asset 名）；
6. 同步左上角品牌版本号（`packages/dshome-theme/lib/client.js` 的 `DSHOME_VERSION`）——须与 `updates.json` version 一致（曾因漏同步停留在 v0.1.0，2026-09-01 起列入门禁）。

## 7. 预防措施 / 沉淀

- 打包前先跑 `verify-payload.mjs`，**不靠肉眼检查 payload**；
- 安装包冒烟必须断言 junction（HTTP 200 只代表后端起来，不代表自愈目录形态正确——承接 ISSUE-002 的教训）；
- junction 运维纪律：删 junction 用 `Remove-Item`（不带 `-Recurse`），勿用 `rmdir /s /q`（会顺 junction 删真实内容）；
- 源码与安装包统一 exe 入口：启动 `DSHOME.exe`、卸载 `UninstallDSHOME.exe`（源码）/ `unins000.exe`（安装包）；
- 原始情况说明已归档至本 incidents 文档；打包细节（robocopy staging / ISCC / gh release）见记忆库与 README 发布段落。

## 8. 发布版实测与重建（2026-09-01）

审计确认：**已发布的 v0.2.0（Inno，sha `273dd19c`）依然损坏**——静默安装后启动即报
`profiles\node_modules\@earendil-works\pi-ai exists and is not a symlink`（包内残留
`@aws-sdk`、`@earendil-works` 部分毒树）。换 Inno 只解决了打包器，没解决根因。

重建过程（3 轮）：
1. Excludes 掩码写成 `profiles\node_modules` 被 Inno 当作 `\n` 换行转义 → 掩码失效，毒树进包（构建日志 29,441 行，两轮 sha 相同）；
2. 改用 **payload 组装侧根治**：毒树 `--fix` 隔离并移出 payload（不依赖 Excludes），基线名掩码仅作兜底；
3. 最终包：**sha256 `54d2c586a0f8a283678424f8ae81e8380d5396d83afa1915e4ffa71a53126777`，211,399,028 字节**。

干净安装冒烟（全绿）：`profiles/` 仅 `dshome`；`DSHOME.exe` + `unins000.exe` 在包；启动 **HTTP 200**；
`profiles\node_modules` 自愈为 Junction（含原失败点 `@earendil-works\pi-ai`、`@aws-sdk\client-bedrock-runtime`）。

已覆盖发布：`gh release upload v0.2.0 DSHOME-setup-0.2.0.exe --repo furinko/DSHOME --clobber`
（线上 asset 211,399,028 字节确认）；`updates.json` sha256 已同步为 `54d2c586…`。

## 9. 证据附录

| 项目 | 证据 |
|---|---|
| 安装包 | `C:\Users\wjthq\Downloads\DSHOME-setup-0.2.0.exe`（218MB，2026-08-31 22:57:42） |
| 打包器识别 | exe 前/尾部 128KB 扫描命中 "7-Zip" 特征 |
| 问题目录 | `E:\DSHOME\profiles\node_modules`（修复前 168MB 实体树；修复后 junction 集合） |
| 修复验证 | 端口 3099 LISTENING；HTTP 200；`LinkType=Junction` |
| 打包快照现状 | `build-stage\payload\profiles\node_modules` 曾含 29,494 实体文件（打包前门禁 `--fix` 隔离为 `node_modules.stale-*`，待人工确认删除） |
| 门禁落地 | `scripts/verify-payload.mjs`、`scripts/smoke.mjs`、`build-stage/DSHOME.iss` |
| 启动/卸载 exe | `E:\DSHOME\DSHOME.exe`（5.6KB）、`E:\DSHOME\UninstallDSHOME.exe`（4.6KB）；`DSHOME.exe --selfcheck` 实测通过（路径解析正确） |
| 重建发布 | 新包 sha256 `54d2c586…`、211,399,028 字节；线上 asset 已覆盖确认；干净安装冒烟全绿（HTTP 200 + junction 自愈） |
