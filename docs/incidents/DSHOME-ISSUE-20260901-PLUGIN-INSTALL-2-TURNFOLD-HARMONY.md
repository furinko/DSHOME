# DSHOME 问题说明：装 turn-fold（依赖 dsh-harmony 启动器）等 4 插件后界面起不来

> 问题编号：DSHOME-ISSUE-005 ～发生：2026-09-01（同日第二次） ～状态：**已修复并验证** ～定位：根因复盘 + 插件依赖链排查
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）
> 原始情况说明：装 dsh-input-traffic + @bananasoldier01/dsh-tidychat + @ch4acko3/dsh-turn-fold + 自研 dshome-assistant-identity 后 DSHOME boot 崩；同日上午已处理过 ISSUE-004（装 dsh-input-traffic 崩）

---

## 1. 摘要

2026-09-01 下午（ISSUE-004 修复后）又装了 4 个插件：`dsh-input-traffic@0.2.9`（复活）、
`@bananasoldier01/dsh-tidychat@0.2.5`、`@ch4acko3/dsh-turn-fold@0.4.4`、自研工作区包
`dshome-assistant-identity@0.2.0`（对话区助手形象，packages/ 下新建），连 L3 工作区包
（`packages/dshome/package.json` + `cordis.patch.yml`）也被改了（inject 新增
dshome-assistant-identity）。启动后 boot 失败：

```
Error: dsh: plugin tree failed to load: 1 entry did not activate
@ch4acko3/dsh-turn-fold: pending (waiting for service: harmony)
```

一句话根因：**turn-fold 是 dsh-harmony provider（patch 声明 `inject: [harmony]`），必须由
dsh-harmony 先注册 harmony 服务；而 dsh-harmony 的激活要求"全局启动器"（npm install -g
@deepseek-ai/dsh + dsh-harmony，installShim 替换全局 dsh 命令，ensureBootstrap 写 home 层
cordis.patch.yml）——本地开发环境跑不通，硬设 `DSH_HARMONY_ACTIVE=1` 又因 profile 未初始化
而报错。最终弃车保帅：移除 turn-fold + dsh-harmony，保留其余 3 个插件。**

## 2. 问题现象

| 项目 | 表现 |
|---|---|
| 操作 | 装 4 插件：input-traffic / tidychat / turn-fold / assistant-identity（assistant-identity 为自研 workspace 包） |
| 启动 | 界面起不来；新起后端 boot 失败；残留一个 node 实例（端口 3101）CPU 满载空转 |
| 后端完整报错 | `Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate @ch4acko3/dsh-turn-fold: pending (waiting for service: harmony)` |
| 误导性报错 | 未设 DSH_HOME 手动跑后端时报 `profile "dshome" does not exist`（resolveDshHome 落到 ~/.dsh，非真实问题） |
| 与配置/网络关系 | 无关；turn-fold 的 harmony 依赖链在本地开发环境必然炸 |

## 3. 排查过程

1. **git diff 改动面**：profile package.json（+4 依赖、+4 bundles）+ L3 packages/dshome（inject 与
   dependencies 加 assistant-identity）+ pnpm-lock.yaml（turn-fold 带 `dsh-harmony@0.8.8` peer）；
   L4 cordis.patch.yml 哈希与备份一致。
2. **workspace 链接"消失"假象**：根 node_modules 下 dshome-palette/theme/plugin-center/
   assistant-identity 全"缺失"——实际 pnpm hoisted 模式的 workspace 链接在
   `profiles/dshome/node_modules/` 与 `packages/*/node_modules/`（junction），根目录只有 dshome
   一个历史 junction。**排查方向一度被带偏**。
3. **版本兼容性核对**：turn-fold peer（dsh-client-ui-conversation ^0.1.0-rc.8、dsh-settings、
   dsh-harmony ^0.7.0||^0.8.0）全部满足；dsh-harmony@0.8.8 已由 autoInstallPeers 装进根 node_modules。
4. **读 dsh-harmony 源码定位激活链**：
   - `plugin.js:196`：`if (process.env.DSH_HARMONY_ACTIVE !== '1') return waitForRuntimeChoice(ctx)`
   - `installer.js:175-190`：非 web 调用 + 非 TTY → 抛"启动器尚未启用"；TTY 下交互 1-4（安装/安装并重启/移除/忽略）
   - `installer.js:61`：installRuntime = `npm install -g dsh-harmony`；install-shim.cjs 要求全局
     `@deepseek-ai/dsh` 存在（否则抛错），并 installShim 替换全局 dsh 命令 + ensureBootstrap 写
     `$DSH_HOME/cordis.patch.yml`
   - 硬设 `DSH_HARMONY_ACTIVE=1` 实测 → 新错 `dsh-harmony: profile is not initialized`
     （runtime.js:698 currentProfile，profileSnapshot 需安装流程初始化）
5. **确认依赖面**：只有 turn-fold 依赖 harmony；tidychat（lock 解析无 dsh-harmony）、
   input-traffic、assistant-identity 均不依赖 → 移除 turn-fold 即可救活。

## 4. 根因分析

- **根因（唯一）**：turn-fold（Codex 风格 turn 折叠）是 dsh-harmony provider，patch 声明
  `inject: [harmony]`，boot 时等待 harmony 服务。harmony 服务由 dsh-harmony 的 harmony.patch.yml
  注册，但 dsh-harmony 的激活不是"加进 bundles"这么简单：
  - 它要求全局启动器（npm install -g @deepseek-ai/dsh + dsh-harmony，shim 替换全局 dsh 命令，
    bootstrap 写 home 层 patch）——**本地开发环境（DSHOME 源码 + dshome-dev node）跑不通**；
  - 硬设 `DSH_HARMONY_ACTIVE=1` 跳过 choice 后，currentProfile 需要安装流程写入的 profile
    snapshot，否则报 profile is not initialized。
- 结论：**DSHOME 0.1.1-rc.2 本地环境装不了 harmony 系插件（turn-fold），装必炸**；官方
  错误提示"npm install -g dsh-harmony"指向的全局链路与本地开发环境不兼容。

## 5. 修复（已验证）

弃车保帅：
1. `profiles/dshome/package.json`：dependencies 移除 `@ch4acko3/dsh-turn-fold` +
   `dsh-harmony`，bundles 移除对应两项；**保留** dsh-input-traffic / dsh-tidychat /
   dshome-assistant-identity（含 L3 对 assistant-identity 的注入）；
2. `pnpm install`（dshome-dev pnpm 10.34.5）：+66 -77，移除 harmony/turn-fold 依赖；
3. 清理空 scope 目录 `node_modules/@ch4acko3`；
4. 验证：`pnpm run build`（20 入口全过）、`pnpm run smoke`（PASS：HTTP 200 + 无
   plugin tree failed / did not activate / pending 标记 + junction 断言）、主实例 3099
   HTTP 200 + CPU 正常、lock `autoInstallPeers: true` 保持。

## 6. 预防措施 / 沉淀

- **harmony 系插件（turn-fold、及依赖 dsh-harmony 的插件）在 DSHOME 本地开发环境装不了**，
  安装前先查依赖链（`pnpm why dsh-harmony` / 看插件的 peerDependencies）；
- 插件 patch 里 `inject: [xxx]` 是服务依赖声明——被依赖的服务插件必须作为 bundle 先注册，
  且其激活方式要提前核实（不是所有插件"加进 bundles 就行"）；
- **workspace 链接在 `profiles/*/node_modules` 与 `packages/*/node_modules`（junction）**，
  不在根 node_modules——排查"链接缺失"先看这两个位置；
- **手动跑后端必须设 `$env:DSH_HOME`**（开发启动.cmd 会设），否则报误导性的
  `profile "dshome" does not exist`；
- 自研 workspace 包（assistant-identity）的 L3/L4 注入改动与社区插件安装混在一起时，
  用 git diff 区分，别把自研成果一起回滚；
- 完整排查速查见 `dshome-dev-env` 技能 `references/plugin-install-incident-20260901.md`。

## 7. 证据附录

| 项目 | 证据 |
|---|---|
| 改动面 | `git diff`：profile package.json（+4 依赖 +4 bundles）、packages/dshome（+assistant-identity 注入）、pnpm-lock.yaml（turn-fold↔dsh-harmony peer） |
| boot 报错 | `1 entry did not activate @ch4acko3/dsh-turn-fold: pending (waiting for service: harmony)`（dsh-app-boot assertEntriesActivated） |
| harmony 激活链 | plugin.js:196 `DSH_HARMONY_ACTIVE`；installer.js:175 非 TTY 抛错；installer.js:61 `npm install -g`；runtime.js:698 profile is not initialized |
| workspace 链接 | `profiles/dshome/node_modules/dshome-*` 全部 Junction；根 node_modules 仅 dshome 一个 junction |
| 修复验证 | build EXIT=0（20 入口）；smoke PASS（HTTP 200 + junction 断言）；主实例 3099 HTTP 200 |
| 插件存活 | input-traffic / tidychat / assistant-identity 均在；turn-fold + harmony 已清除（lock 0 引用） |
