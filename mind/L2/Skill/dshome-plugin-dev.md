---
name: dshome-plugin-dev
description: DSHOME/DeepSeek Harness 结构与插件开发——运行时 Cordis 动态插件（code.host/code.client 纯 JS）、写码前 cordis_inspect 读真实接口、生命周期/修复/回滚；含自有 host 插件落地三步（exports 注册易漏）与安全模式动态化。触发：做/改 DSH 插件、"plugin"、"错误：xxx is not declared"、"host.call 失败"、"slot 注册失败"、"启动崩溃"、"ERR_PACKAGE_PATH_NOT_EXPORTED"。
version: 1.1.0
author: 鱼鱼 (DSHOME)
license: internal
metadata:
  tags: [DSHOME, DSH, harness, cordis, plugin, 插件, code.host, code.client, slot]
  related: [mind/README.md, node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md]
contract:
  id: dshome-plugin-dev
  triggers: [做插件, 改插件, plugin, cordis, slot, host.call 失败, is not declared, client 解析失败]
  inputs: [要做什么/改哪个插件, 目标能力(host/client)]
  outputs: [确定所属平台, 已读真实接口, 插件源码, 版本/修复判断, 失败排查]
  deps: [cordis-plugin-development (upstream), mind/README.md, mind/L1/Power.md]
---

# dshome-plugin-dev — DSHOME 结构与插件开发

## 一、DSHOME 是什么

DSHOME（鱼鱼）运行在 **DeepSeek Harness (DSH)** 之上，本机宿主源码/运行时在 `E:\DSHOME`：

- 宿主包在 `E:\DSHOME\node_modules\@deepseek-ai\*`（`dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-conversation`、`dsh-client-ui-primitives`、`dsh-attachment`、`cordis` 等）。
- 自带/upstream 的 Cordis 插件开发 skill 在
  `E:\DSHOME\node_modules\@deepseek-ai\dsh\config\agent-presets\cordis\skills\`
  （`cordis-plugin-development`、`editing-cordis-compositions`）。
- 我的能力库在 `mind\L2\Skill\`；能力手册见 `mind\L1\Power.md`、行为规程见 `mind\L1\Ritual.md`；知识索引 `mind\L1\Tree.md`。

## 二、第一铁律：先读真实接口，再写码

**绝不**从 Service 名、Event payload、Slot props、theme token、示例、或别人源码反推完整 API。
正确步骤：调用 `cordis_inspect_list` 拿到当前注册的 Providers/methods/schemas，再用尽量少的
`cordis_inspect_query` 读要用到的确切 Service / Event / Builtin / Slot / Theme / Tool。
不要硬编码 Provider 名，不要跳过 list。

## 三、插件形态：动态 Cordis 插件

DSH 插件是**运行时动态插件**，`code.host` / `code.client` 是**纯 JS 函数体**，返回一个 Cordis Plugin。

- **不是** TS / JSX / import / require / 打包产物。
- Client React 必须用 `React.createElement(...)`（不能用 JSX）。
- `apply(ctx)` 注册生命周期贡献，**不能**直接返回 React Element。
- 能力要用 `ctx.get(name)` 可选读取并判空；只有真硬依赖才声明 `inject: ['x']`。
  未声明却访问 `ctx.x` 会被 Guard 拒绝。

```js
// code.client 正确示范
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('target.slot', () => slots.register(
      { name: 'target.slot', id: 'my-view' },
      (props) => React.createElement('div', null, String(props.someValue)),
    ))
  },
}
```

## 四、平台选择

| 需求 | 平台 | 先读 |
|---|---|---|
| 文件/命令/进程/网络 | Host | `Service.listService` (`fs`,`bash`,`subprocess`,`pty`,`web`) |
| Agent/durable 会话/宿主生命周期 | Host | 对应 Service + `Event.listEvents` |
| 注册动态模型 Tool | Host | `Builtin.listBuiltins` (`harness`) + `Tool.listTools` |
| 页面主题/布局 | Client | `Theme.listTokens` + 客户端 `Service.listService` |
| 会话快照/workspace 列表 | Client | 目标 Slot 的 standard props + owner props |
| 设置页/侧栏/输入区/overlay/工具卡 | Client | `Slots.listSubTree` |
| Host 取数、Client 展示 | Both | Host Service + `harness.handle`；Client Slot + `host.call` |

**原则**：选离数据所有者最近的能力。Slot props 已给会话快照就别再去 Host 拉一遍。

## 五、Slot 注册（Client UI）

1. 先 `Slots.listSubTree`（无 root）选目标，再用具体 `root` 读该 Slot 完整契约（protocol:
   single/list/keyed/chain、scope、standard props、owner props、当前占用者、替换风险、descendant）。
2. 用 `ctx.get('slots')`（不用 `ctx.slots` 除非声明 `inject:['slots']`），
   `slots.inject('x.slot', () => slots.register({name, id|key}, (props)=>React.createElement(...)))`。
3. 不要猜 `id`/`key`/selector/props；不要默认替换 root/sidebar/conversation/details 顶层槽
   （替换整个 occupant 会连带移除其声明的 descendant slots）。
4. session 级槽可能通过 standard props 提供 `useSession`/`useSessions`/`useWorkspaces`/`useProjection`/input/actions。
5. 只取真正需要的字段，**不要**复制/整段渲染 Conversation Snapshot / Session / Tool call / 整个 props 对象。

## 六、副作用与生命周期

- `ctx.on()` 监听 Event；`ctx.effect(() => disposer)` 管理外部订阅；保留 Service/Tool/Slot/timer 返回的 disposer。
- 不要在 module 作用域或 `apply()` 之外做页面/进程级副作用；Plugin 停止/更新/删除时自动清理。
- timer 是名为 `timer` 的 **Service**（不是 Builtin），用前先 `Service.listService` 并声明 `inject:['timer']`。
- 不要用全局 `window`/`document`/`process`/`Buffer`/`fetch`/`setTimeout`（非 Builtin 确认前）。

## 七、Host↔Client 通信

Host `harness.handle('method', handler)`，Client `await host.call('method', args)`（JSON RPC）。
参数/返回值必须 **lossless JSON**，不能传函数/React 元素/实例/Context/Service/运行时对象；无数据返回 `null`。

## 八、版本 / 生命周期 / 修复

- `pluginId` 稳定实例；`packageId` 不可变代码版本；每次激活有 `pluginRunId`。
- `currentPackageId`=最近成功版本（不代表正在运行）；`nextPackageId`=待批准/激活/最近失败。
- 激活：无 current 或有 current 同版本 → `cordis_run` mode `run`；不同版本 → `update`；
  更新失败重试 next → `update`；回滚当前 → `run`。
- 授权：单勾仅当前 Package，双勾自动授权未来版本；技术失败后授权仍在。`awaiting-approval`/`starting`
  后**不要在当回合等**，结束流程等系统回报。
- 修复：`cordis_inspect_self` 读失败版本 + 诊断 → 若 unknown capability 先 list/query Provider →
  在**同一 pluginId 下定义新 Package**（别覆盖失败包）→ 用新 `packageId` 按模式 run/update。
  用户拒批后**不要自动重试**。

## 九、常见失败排查

| 失败 | 先查 |
|---|---|
| `service "x" is not declared` | 用 `ctx.x` 未声明 `inject:['x']`；改 `ctx.get('x')` 判空或声明真硬依赖 |
| `cannot get property "timer" without inject` | 查 timer Service + 声明 `inject:['timer']` |
| Client 解析失败 | 是否用了 JSX/TS/import/未知全局 |
| Slot 注册失败 | 是否查过 live subtree、Slot 存在、options/key/selector 满足 protocol |
| UI 加载但页面报错 | 看 `client-render` 诊断与 stack；对应用 `cordis_define` 新 Package 修复 |
| `host.call` 失败 | handler 名、当前 `pluginRunId`、JSON 参数、handler 内 Service 依赖 |
| 更新失败 | 保持 current/next 语义；修 next 后 update，或 run current 回滚 |

## 十、DSHOME 自有 host 插件落地（三步 checklist + 安全模式）

> 2026-09-04 血泪教训：开发 mind-recall host 插件时漏了 exports 注册，宿主启动崩溃循环 7+ 轮；
> 且安全模式静态清单漏 mind 系插件，崩溃时逃生通道形同虚设。以下三步**缺一不可**。

**任何新 host 插件（`packages/dshome/lib/host/<name>.js`）上线必须三步齐：**

1. [ ] **插件文件**：`packages/dshome/lib/host/<name>.js`，`export const name` 与 patch 的 id 一致、格式同既有插件（mind-inject 为模板）
2. [ ] **`package.json` exports**：`packages/dshome/package.json` 的 `exports` 补
      `"./<name>": "./lib/host/<name>.js"` ← **最容易漏的一步**（漏了 → `ERR_PACKAGE_PATH_NOT_EXPORTED` → 宿主启动即死）
3. [ ] **cordis.patch.yml 注册**：insert 块加 `- id: dshome-<name>` / `name: dshome/<name>` 条目
      （还要同步 `settings.yaml` 的 `include:` 启用条目——参考 dshome-mind-inject 行）

**安全模式自动覆盖（v2，2026-09-05 起）**：`scripts/safe.mjs` 与 `shell-app/main.cjs` 的
safeOverlay 已改为**从 cordis.patch.yml 动态解析**自有插件 id（dshome- 前缀）。**加插件后无需再手动
同步安全模式清单**——但若看到这两处出现硬编码 id 数组（回退分支），说明动态解析失败，需排查 patch 路径。

**自检信号**（改完重启宿主后）：
- 有 marker 的插件：marker 时间戳必须刷新（`profiles\dshome\.dsh-market\<name>-marker.txt`）
- 无 marker 的插件：宿主能完整 boot（3099 + HTTP 200）
- ⚠️「插件树能加载到前一插件」≠「本插件正常」——崩溃点用 marker/日志对比定位（崩溃插件在前的插件每轮刷新、它自己不刷新）

**验证流程**：写完逻辑先 `node --check` 语法 → 重启宿主看 boot + marker → 跑对应 itest/verify。
**不要**只测逻辑就收工（本次事故：itest 全绿但宿主加载链没验，上线即崩）。

## 十一、本会话可用性检查

`cordis_*` 工具（`cordis_inspect_list/query/self`、`cordis_define/run/stop/undefine`）与上述 upstream skill
**未必每个会话都注入**。若当前工具集没有：
- 先确认是否在带 cordis 开发能力的会话/配置里；
- 组件渲染/纯逻辑可先单测（本地 node + 匹配 react），但**不要**把从外部源码反推的接口当真实契约。

---
_版本：1.1.0 | 2026-09-05 | 新增 §十 自有 host 插件落地三步 checklist（exports 易漏血泪教训）+ 安全模式动态化说明；触发词补启动崩溃/ERR_PACKAGE_PATH_NOT_EXPORTED_
