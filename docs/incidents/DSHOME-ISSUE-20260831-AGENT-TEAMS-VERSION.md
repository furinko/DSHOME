# DSHOME 问题说明：dsh-agent-teams 版本不兼容导致界面无法打开

> 问题编号：DSHOME-ISSUE-002 ～发生：2026-08-31 ～状态：**已修复并验证** ～定位：根因复盘 + 插件安装护栏
> 关联：DSHOME-ISSUE-001（插件加载失败）→ `docs/incidents/DSHOME-ISSUE-20260831-PLUGIN-LOAD.md`
> 目标读者：DSHOME 的维护者与接手者（包括未来的自己）

---

## 1. 摘要

通过 dshmarket 安装 `@nanmicoder/dsh-agent-teams@^0.1.15` 后，DSHOME **后端正常但界面打不开**（web boot 阶段 1 个插件 entry 无法激活）。根因：**0.1.15 是面向新版 dsh（0.1.2-alpha）的 alpha 族版本，与 DSHOME 的 rc 族（0.1.1-rc.2）跨代不兼容**——它等待的 `uiConversation` 服务在 rc 环境不存在，永久 pending。修复：**精确锁版降级到 0.1.14**（rc 族），功能保留、界面恢复。

一句话根因：**`^0.1.15` 的 caret 语义把插件拉到了跨代版本；装 DSH 插件必须先核对 peerDependencies 的版本族。**

## 2. 问题现象

| 项目 | 表现 |
|---|---|
| 安装方式 | dshmarket（或 `dsh plugin add`），版本 `^0.1.15` |
| 可见症状 | Electron 窗口出现但界面打不开，显示 `Failed to load plugins` |
| web boot 报错 | `web boot: 1 entry did not activate` / `@nanmicoder/dsh-agent-teams: pending (waiting for service: uiConversation)` |
| 出错阶段 | client 侧插件激活（web-runtime boot），**host 后端正常**（HTTP 200 可达） |
| 影响范围 | DSHOME UI 完全不可用；后端与数据不受影响 |

## 3. 排查过程

1. **进程/健康检查**：后端 node + electron 均在跑，`http://127.0.0.1:3099` 返回 200 → 排除后端故障，问题在 client 侧。
2. **定位插件**：`@nanmicoder/dsh-agent-teams` 出现在 profile `dependencies`（`^0.1.15`）与 `bundles` 数组；`pnpm-lock.yaml` 锁定 `0.1.15`。
3. **读声明**：插件 package.json 的 client 入口 `inject = ['uiConversation', 'slots', 'sessions', 'locale', 'modelDirectories']`——`uiConversation` 是它启动的前置服务。
4. **版本族对比（关键）**：
   - 插件 0.1.15 peerDependencies 全部 `^0.1.2-alpha.2`（**alpha 族**）
   - 插件 0.1.14 及以前 peerDependencies 全部 `^0.1.0-rc.6`（**rc 族**）
   - DSHOME 全家桶 `0.1.1-rc.2`（**rc 族**）
5. **服务名验证**：`npm view` 历史 + 本机 `dsh-client-ui-conversation@0.1.1-rc.2` 代码中**不存在** `uiConversation` 服务；0.1.14 的 client 代码用 `conversationEvents`（rc 系服务）→ 0.1.15 在 rc 环境必然 pending。

## 4. 根因分析

### 4.1 直接原因

| 维度 | 0.1.15（装了它） | 0.1.14（应该装它） |
|---|---|---|
| 版本族 | alpha（`^0.1.2-alpha.2` peerDeps） | rc（`^0.1.0-rc.6` peerDeps） |
| client 前置服务 | `uiConversation`（0.1.2-alpha 新 API） | `conversationEvents`（rc 系 API） |
| 与 DSHOME 0.1.1-rc.2 | ❌ 不兼容 | ✅ 同族兼容 |

`^0.1.15` caret 语义 = `>=0.1.15 <0.2.0`，市场安装时取到当时最新 0.1.15。作者在 0.1.15 把 API 基线从 rc 跳到 alpha（面向 dsh 0.1.2-alpha 开发），但 DSHOME 仍停留在 rc——**服务名不存在 → 插件永久等待 → web boot 判定激活失败 → 整个界面拒绝加载**。

### 4.2 为什么当时没发现（过程漏洞）

- dshmarket 安装流程**只校验安装成功，不校验版本族兼容性**；peerDependencies 冲突在 pnpm 侧仅是 WARN（不阻断）。
- 界面加载失败报错出现在 client 侧（窗口内），后端日志无异常，容易误判为「环境问题」而非「插件版本问题」。
- 本机无 0.1.2-alpha 环境可对照，`uiConversation` 服务缺失只能通过查 registry 版本历史 + 读 0.1.1-rc.2 源码确认。

## 5. 修复方案

**精确锁版降级到 rc 族 0.1.14**（保留插件功能，代价最小）：

```diff
- "@nanmicoder/dsh-agent-teams": "^0.1.15",
+ "@nanmicoder/dsh-agent-teams": "0.1.14",
```

- **必须用精确版本**（不带 `^`）：否则未来 `pnpm install` 仍可能被 caret 拉回跨代版本。
- 执行：改 `profiles/dshome/package.json` → `pnpm install`（`+6 -62`）→ 重启。
- 放弃的方案：移除插件（丢功能）；升级 dsh 全家桶到 0.1.2-alpha（需联动验证自研 dshome 系插件 + vendor dsh-evolve，风险高，未采用）。

## 6. 验证

| 验证项 | 方法 | 结果 |
|---|---|---|
| 版本落地 | 读 `node_modules/@nanmicoder/dsh-agent-teams/package.json` | ✅ 0.1.14 |
| 服务名匹配 | grep 0.1.14 `client.js` 的 `inject` | ✅ `conversationEvents`（rc 系，非 uiConversation） |
| 依赖安装 | `pnpm install` | ✅ `Packages: +6 -62`，Done in 11.6s |
| 后端 | 裸跑后端，等待 20s | ✅ `dsh web: http://127.0.0.1:3099`，进程常驻，无报错 |
| HTTP | `Invoke-WebRequest http://127.0.0.1:3099` | ✅ 200 |
| Electron 壳 | `Start-Process electron shell-app` | ✅ 5 进程存活 |

## 7. 预防措施（建议）

1. **（已做）装插件前核对版本族**：任何 dsh 生态插件，安装前 `npm view <pkg> peerDependencies --json`，确认与当前 dsh 版本同族（rc ↔ rc、alpha ↔ alpha），跨族直接换版本。
2. **（已做）社区插件精确锁版**：非官方插件一律写精确版本（不带 `^`），防止 caret 静默拉跨代；官方 `@deepseek-ai/*` 保持跟随仓库基线。
3. **（建议）market 安装后自检**：装完插件重启后端，若 web boot 出现 `pending (waiting for service: xxx)` → 立即查版本族与服务名。
4. **（已实施 2026-08-31，用户拍板 L1+L2）验证脚本化**：根 `package.json` 新增 `build`（`node scripts/syntax-check.mjs`，全仓插件入口语法检查）、`smoke`（`node scripts/smoke.mjs`，裸跑后端 + 断言 `dsh web:` / 失败标记 / HTTP 200，含 `--expect-fail` 阴性自测）、`verify`（`pnpm build && pnpm smoke`）。syntax-check 顺带暴露并清理了 `packages/dshome/package.json` exports 里两个指向不存在文件的死声明（`./client-core`、`./theme`）。⚠️ 边界：syntax-check 只查语法，抓不住协议/运行时问题（本次两次事故均为运行时形态），真正防再犯的是 smoke 的失败标记断言与后端退出检测。

## 8. 涉及文件

| 文件 | 动作 |
|---|---|
| `profiles/dshome/package.json` | 修复（`M`，`^0.1.15` → `0.1.14`，待提交） |
| `packages/dshome/lib/host/plugin-store.js` | 配套（`M`）：`DESC_CN` 增加「多agent团队协作（AgentTeams，社区插件）」（插件中心列表中文名） |
| `pnpm-lock.yaml` | 随 install 更新（`M`，待提交） |
| `package.json`（根） | 工程化（`M`）：`build` / `smoke` / `verify` 脚本接线 |
| `scripts/syntax-check.mjs` | 新增（`A`）：全仓插件入口语法检查 |
| `scripts/smoke.mjs` | 新增（`A`）：裸跑冒烟断言（含 `--expect-fail` 阴性自测） |
| `packages/dshome/package.json` | 清理（`M`）：移除指向不存在文件的 exports 死声明（`./client-core`、`./theme`） |
| `node_modules/@nanmicoder/dsh-agent-teams/` | 降级后实体（不入库） |
| 本文档 | 新增（`docs/incidents/DSHOME-ISSUE-20260831-AGENT-TEAMS-VERSION.md`，待提交） |

## 9. 未提交改动汇总（截至本文档）

```
M packages/dshome-plugin-center/lib/index.cjs    ← ISSUE-001 修复（apply 方法）
M profiles/dshome/package.json                   ← ISSUE-002 修复（0.1.14 锁版）
M packages/dshome/lib/host/plugin-store.js       ← 配套：插件中心中文说明（DESC_CN）
M pnpm-lock.yaml                                 ← ISSUE-002 随动
M package.json（根）                              ← 工程化：build/smoke/verify 脚本接线
M packages/dshome/package.json                   ← 清理 exports 死声明（client-core/theme）
A scripts/syntax-check.mjs                        ← 工程化：全仓插件入口语法检查
A scripts/smoke.mjs                               ← 工程化：裸跑冒烟断言（含阴性自测）
?? docs/incidents/DSHOME-ISSUE-20260831-PLUGIN-LOAD.md     ← ISSUE-001 说明
?? docs/incidents/DSHOME-ISSUE-20260831-AGENT-TEAMS-VERSION.md  ← 本文档
```
