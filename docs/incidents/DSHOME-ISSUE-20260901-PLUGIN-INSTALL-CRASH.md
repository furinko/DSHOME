# DSHOME 问题说明：安装 dsh-input-traffic 后界面起不来（L4 覆盖文件空化 + pnpm lock 被重写）

> 问题编号：DSHOME-ISSUE-004 ～发生：2026-09-01 ～状态：**已修复并验证** ～定位：根因复盘 + 插件安装流程预防
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）
> 原始情况说明：装社区插件 dsh-input-traffic@0.2.9 后 DSHOME 界面崩（electron 无进程）；回滚保底备份在 `%TEMP%\dshome-rollback-20260901-152432`

---

## 1. 摘要

2026-09-01 15:24 经插件管理流程安装社区插件 `dsh-input-traffic@0.2.9`（DeepSeek Harness 输入队列，
GitHub drscrewdriver/dsh-input-traffic），随后 DSHOME 界面起不来：electron 进程消失、后端启动即崩。
回滚保底备份（package.json / pnpm-lock.yaml / cordis.patch.yml）后仍起不来，进一步定位出**双根因**：

1. **L4 覆盖层 `profiles/dshome/cordis.patch.yml` 被清成纯注释（零条目）**——覆盖内容并入 L3
   （`packages/dshome/cordis.patch.yml`）时未保留顶层 YAML 数组形态。dsh-app-boot 的
   `parsePatchList` 要求 patch 文件顶层必须是 YAML 数组，纯注释解析为 null → **任何新启动即崩**。
   这是**主根因**，与装插件无关，只是装插件触发了重启才暴露。
2. 装插件的 `pnpm install` 把 `pnpm-lock.yaml` 的 `settings.autoInstallPeers` 从 `true` 改成 `false`
   并全量重解析依赖图（大量包哈希重算）——社区插件的 peer 依赖（`@deepseek-ai/dsh-client-*`、
   `cordis`）全靠 autoInstallPeers 兜底，关闭后运行时找不到 peer。

一句话根因：**L4 patch 文件"空化"成纯注释（boot 层硬校验）+ 插件安装流程破坏 lock 的 peer 安装策略。**

## 2. 问题现象

| 项目 | 表现 |
|---|---|
| 操作 | 安装 `dsh-input-traffic@0.2.9`（profile package.json +1 依赖、+1 bundle；pnpm install 全量重解析 lock） |
| 启动 | electron 界面起不来（主进程短暂出现后退出）；后端 node 进程消失 |
| 后端完整报错 | `Error: dsh: overlay E:\DSHOME\profiles\dshome\cordis.patch.yml must be a top-level YAML array of loader patch entries`（parsePatchList / dsh-app-boot/lib/index.js:841） |
| 进程残留 | 两个 node 孤儿进程：3099 端口实例（9:58 起，HTTP 200 正常——旧配置未重启）、8643 端口实例（12:40 起，端口未监听 + CPU 满载 11212s ≈ boot pending 卡死） |
| 与配置/网络关系 | 无关；L4 空化后任何机器任何配置都会启动即崩 |

## 3. 排查过程

1. **找备份**：`%TEMP%\dshome-rollback-20260901-152432`（15:24:32 创建，3 文件齐）；
   - `package.json`（2490B，name=`dshome-profile`）→ 对应 `profiles/dshome/package.json`（装插件前一刻状态）；
   - `pnpm-lock.yaml`（651KB）→ 对应根 lock；
   - `cordis.patch.yml`（467B）→ 对应 L4 覆盖层。
2. **哈希对比**：当前 `profiles/dshome/package.json`（2554B）与备份差 64B = `"dsh-input-traffic": "^0.2.9",` 一行 + bundles 一项；lock 哈希不同；L4 文件哈希与备份一致（未被装插件过程改动）。
3. **git diff 精确确认**：改动面仅 `profiles/dshome/package.json`（+2 行）与 `pnpm-lock.yaml`（settings.autoInstallPeers true→false + 依赖图全量重解析；packages/dshome 的 cordis 条目消失）。
4. **版本兼容性核对**：dsh-input-traffic@0.2.9 peer 要求 `@deepseek-ai/dsh-client-* ^0.1.0-rc.5`、`cordis ^4.0.1`；实际 `0.1.1-rc.2` / `0.1.0-rc.8` / `4.0.1` —— **peer 全部满足**，排除版本不兼容（与 ISSUE-002 的 0.1.15 alpha 族不同）。
5. **手动跑后端暴露真凶**：`node node_modules\@deepseek-ai\dsh\lib\bin.js --profile dshome --no-open --port 3099` → parsePatchList 报错启动即崩。
6. **L4 文件检查**：13:39:22 被改为纯注释（覆盖内容并入 L3 时清空，未留 `[]`）；文件为 UTF-8 无 BOM（PowerShell 5.1 按 GBK 显示乱码为假象）。

## 4. 根因分析

- **根因 A（主）**：`profiles/dshome/cordis.patch.yml`（L4 本机覆盖层）语义上是"补丁数组"，
  协议上被 dsh-app-boot 硬校验为**顶层 YAML 数组**。2026-09-01 把原两条覆盖（llm-deepseek 的
  `apiKeyEnv: DSHOME_USER_KEY`、dshome-desktop `disabled: true`）并入 L3 后，L4 只剩注释——
  解析为 null → `loadOverlayPatches` 抛错。旧后端实例（9:58 起，启动时文件尚有内容）不受影响，
  **重启即暴露**，所以"装插件导致崩"的直觉是错的：装插件只是触发了重启这个动作。
- **根因 B（次）**：插件安装流程跑的 `pnpm install` 用了与 lock 生成时不同的配置/版本语义，
  重写 lock 时 `settings.autoInstallPeers: true → false` 且全量重解析（依赖图哈希全变）。
  peer 依赖不再自动安装 → 即便根因 A 不存在，插件运行时也会因缺 peer 而崩（与 ISSUE-002 的
  "web boot pending" 同族症状）。
- **8643 卡死实例**：12:40 启动（早于 L4 空化的 13:39），与本次双根因无关，疑为 DSHOME.exe /
  手动启动的另一实例 boot pending（端口未监听 + CPU 满载重试），已清理，未深究。

## 5. 修复（已验证）

1. 杀全部 node/electron 进程（含"健康"的 3099 旧实例——它跑的是旧配置，留着会掩盖问题）；
2. 备份覆盖回滚：`profiles/dshome/package.json` + `pnpm-lock.yaml`（哈希与备份一致）；
3. `pnpm install`（dshome-dev 的 pnpm 10.34.5）：Lockfile is up to date（lock 与 package.json 匹配），
   node_modules +315 -60，dsh-input-traffic 移除，lock 哈希保持不变（install 未再重写）；
4. **L4 修复**：`profiles/dshome/cordis.patch.yml` 重写为「注释 + 显式空数组 `[]`」（UTF-8 无 BOM），
   语义不变（本机覆盖位，plugin-manager 行级启停写入不受影响）；原 13:39 版本备份为
   `cordis.patch.yml.l4-original-1339`；
5. 重启 `开发启动.cmd` → 验证：3099 HTTP 200、node CPU 正常（20s ≈ 5s，无满载）、
   electron 全套进程正常、8643 端口无残留。

## 6. 预防措施 / 沉淀

- **L4 覆盖位清空时必须留显式空数组 `[]`**，纯注释 = 启动即崩（boot 层硬校验，无任何绕行）；
- 装社区插件后检查 `pnpm-lock.yaml` 第 4 行 `settings.autoInstallPeers`，被改 `false` 立即改回并重跑 install；
- 老后端实例 HTTP 200 ≠ 环境健康（旧配置未重启）；改配置/装插件后必须重启验证，别信"还活着"；
- 装插件前先做回滚保底（3 件套：profile package.json + 根 pnpm-lock.yaml + L4 cordis.patch.yml）；
- dsh-input-traffic 如需再装：先读其 README 确认 DSHOME 0.1.1-rc.2 兼容性；装完立即核对 lock settings；
  安装用 dshome-dev 的 pnpm 10（与 lock 生成环境一致），避免 lock 被不同 pnpm 版本重写；
- 排查速查（进程/端口/手动起后端看报错/git diff/lock settings）见 `dshome-dev-env` 技能
  `references/plugin-install-incident-20260901.md`。

## 7. 证据附录

| 项目 | 证据 |
|---|---|
| 回滚保底备份 | `%TEMP%\dshome-rollback-20260901-152432`（15:24:32；package.json 2490B / pnpm-lock.yaml 651KB / cordis.patch.yml 467B） |
| 改动面 | `git diff profiles/dshome/package.json`（+`"dsh-input-traffic": "^0.2.9",` + bundles 项）；`git diff pnpm-lock.yaml`（settings.autoInstallPeers true→false，依赖图全量重算） |
| 后端报错 | `dsh-app-boot/lib/index.js:841 parsePatchList` → `must be a top-level YAML array of loader patch entries` |
| L4 原文件 | 13:39:22 纯注释版（备份 `cordis.patch.yml.l4-original-1339`）；修复后 UTF-8 无 BOM + `[]` |
| 版本核对 | dsh-input-traffic@0.2.9 peer（dsh-client-* ^0.1.0-rc.5、cordis ^4.0.1）⊂ 实际（0.1.1-rc.2 / 0.1.0-rc.8 / 4.0.1）——排除 ISSUE-002 式版本不兼容 |
| 回滚验证 | package.json `7CE1154F…`、pnpm-lock.yaml `BE01E8D5…`（哈希与备份一致）；install 后 lock 哈希不变 |
| 修复验证 | 3099 HTTP 200；node CPU 正常；electron 主进程 + renderer 正常；8643 无监听 |