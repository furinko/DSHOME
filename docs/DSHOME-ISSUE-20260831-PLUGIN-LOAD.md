# DSHOME 问题说明：插件加载失败导致无法启动

> 问题编号：DSHOME-ISSUE-001 ～发生：2026-08-31 ～状态：**已修复并验证** ～定位：根因复盘 + 预防措施
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）

---

## 1. 摘要

DSHOME 双击 `开发启动.cmd` 后**无窗口出现、后端进程立即退出**。定位为 `dshome-plugin-center` 包（2026-08-31 新开发，commit `18ce32d` 引入根入口）的 host 侧 no-op 入口**缺少 `apply` 方法**，不满足 cordis 插件协议，导致整个插件树加载失败，启动流程中断。

一句话根因：**cordis 插件根入口必须是函数或带 `apply` 方法的对象；只导出普通对象会被判为非法插件。**

## 2. 问题现象

| 项目 | 表现 |
|---|---|
| 启动方式 | 双击 `开发启动.cmd`（或直接跑后端） |
| 可见症状 | Electron 窗口不出现，约 1 秒后进程全部退出 |
| 后端报错 | `dsh: plugin tree failed to load: failed to apply loader entry dshome-plugin-center (dshome-plugin-center): invalid plugin, expect function or object with an "apply" method, received object` |
| 出错阶段 | 插件树加载（`EntryGroup.create`，entry index 141），非依赖缺失、非端口冲突 |
| 影响范围 | DSHOME 完全不可用（后端都起不来，谈不上 UI） |

## 3. 排查过程

1. **环境预检**：node v24.19.0 / pnpm 10.34.5 / `@deepseek-ai/dsh@0.1.1-rc.2` / electron 43.4.0 均在位，依赖完整 → 排除环境问题。
2. **复现**：裸跑后端
   `node node_modules\@deepseek-ai\dsh\lib\bin.js --profile dshome --no-open --port 3099`
   （⚠️ 必须 `set DSH_HOME=E:\DSHOME`，否则报 `profile "dshome" does not exist`，是误导性的前置错误）
3. **读栈**：报错点名 entry `dshome-plugin-center`，且 cordis 断言 `invalid plugin, expect function or object with an "apply" method, received object` → 指向该包的根入口导出形态。
4. **反查引用**：`dshome-plugin-center` 不在 profile `bundles` 数组，而是被 `packages/dshome/cordis.patch.yml` 以 `- insert` 方式挂进插件列表（dshome bundle 的 patch 层）。
5. **对照同类**：`dshome-palette`（同为 client-only 插件、同为 `module.exports = {...}` 对象导出）**带 `apply() {}`**，可正常加载；`dshome-plugin-center` 的 `18ce32d` 新增入口只导出了 `{ name }` → 差异即根因。

## 4. 根因分析

### 4.1 直接原因

`packages/dshome-plugin-center/lib/index.cjs`（`18ce32d` 新增，5 行）：

```js
// ❌ 修复前：纯对象，无 apply
module.exports = { name: 'dshome-plugin-center' };
```

cordis 的 `ctx.plugin()` 协议校验（`node_modules/@deepseek-ai/cordis/lib/index.js:1620`）：

- 合法形态 ①：函数 `(ctx) => {...}`
- 合法形态 ②：对象且**必须有 `apply(ctx)` 方法**

纯对象 `{ name }` 两者都不是 → 抛 `invalid plugin` → 该 entry 失败 → `EntryGroup` 整体失败 → 插件树加载中止 → 后端退出。

### 4.2 为什么当时没发现（过程漏洞）

- commit `18ce32d` 的意图是「补 main 根入口让 roster 扫描能解析包的 `dsh.client` 声明」——**验证只做到了「可解析」，没做到「可加载」**：roster 扫描只看包 manifest，不执行 cordis 插件协议校验；真正执行校验要等完整启动。
- 该包是纯 client 插件，host 侧本无行为，写入口时照抄了「对象导出」的形，漏了 palette 的 `apply` 实。
- 仓库无 `build`/`verify` 脚本（见 §6），启动即唯一验证途径，而**最近一次完整启动发生在该 commit 之前**。

## 5. 修复方案

参照 `dshome-palette/lib/index.cjs` 的既有正确写法，补 `apply` 空实现：

```js
// ✅ 修复后：带 apply 的 no-op 对象（与 dshome-palette 一致）
module.exports = {
  name: 'dshome-plugin-center',
  apply() {},
};
```

改动 1 个文件、4 行，语义不变（host 侧仍为 no-op，client 侧行为不受影响）。

## 6. 验证

| 验证项 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check lib/index.cjs` | ✅ exit=0 |
| 后端 | 裸跑后端，等待 25s | ✅ 输出 `dsh web: http://127.0.0.1:3099` 且进程常驻 |
| HTTP | `Invoke-WebRequest http://127.0.0.1:3099` | ✅ 200 |
| 完整启动 | `开发启动.cmd` | ✅ Electron 多进程（5 个）+ node 后端同时存活 |
| 端口 | `Get-NetTCPConnection -LocalPort 3099` | ✅ LISTENING |

> ⚠️ `pnpm run build` **不可用**：仓库 6 个 workspace 包均未声明 `build` script（`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`），源码直跑架构，「能启动」即「构建通过」。

## 7. 预防措施（建议）

1. **（已做）沉淀协议规范**：client-only 插件的 host 根入口一律 `{ name, apply() {} }`，见本文件 §4；同类新包照抄 palette，不写裸对象。
2. **（建议）启动自检**：新加/改动任何被 `cordis.patch.yml` insert 或 `bundles` 引用的包后，**必须先裸跑后端**（§3.2 命令）确认 `dsh web:` 输出，再双击 `开发启动.cmd`。
3. **（建议，待用户拍板）给根 `package.json` 加 `build` script**，把验证变成可执行命令，例如全仓语法检查：
   ```json
   "build": "pnpm -r exec node --check lib/index.cjs"
   ```
   零运行时副作用，未来可接 CI。

## 8. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/dshome-plugin-center/lib/index.cjs` | 修复（`M`，待提交） |
| `packages/dshome/cordis.patch.yml` | 引用方（未改动，insert 行为正确） |
| 本文档 | 新增（`docs/DSHOME-ISSUE-20260831-PLUGIN-LOAD.md`，待提交） |
