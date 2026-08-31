# DSHOME 客户端设置 UI 重建指南（已同步到当前验证可用版本）

> ⚠️ 历史重建文档：内含当时本机绝对路径（E:\DSH 等），仅作内部参考，路径已过时。
> 本文件与 **`packages/dshome-theme/lib/client.js` 当前状态完全一致**（已验证：插件管理分区渲染、通知开关可持久化）。
> 适用：`packages/dshome-theme/lib/client.js`（profile 经 junction 加载的客户端 bundle）。
> 宿主侧已就绪：`notify.js`（命名空间 `dshome`，字段 `enabled`/`notifyOnTurnCompletion`）、
> `plugin-manager.js`（命名空间 `dshome-pluginmanager`，字段 `entries`/`request`/`result`）。

---

## 0. 关键契约（照这个写，别再踩坑）

- 收 `props` = 渲染器注入的 **`props.controller`**（你 `inject()` 返回的 controller）+ **`props.useSnapshot`**（渲染器提供的 React hook，**勿用 `React.useSyncExternalStore`**）。
- 读：`const state = useSnapshot((s) => s);`，再取 `state.value`（`state.status` 可判断是否 ready）。
- 写：`controller.set("字段", value)`。
- 注册：`ctx.slots.inject(slotKey, () => ctx.slots.register(options, Component))`。
  - `settings.general.item`（列表 slot，通用设置里的条目）：必带 `id`/`order`/`locale`。
  - `settings.section`（列表 slot，设置左侧分区）：必带 `id`/`order`/`label`(函数)/`locale`。
  - `inject: () => ({ controller, hooks: { snapshot: controller.store } })`。
- **本 bundle 无 JSX 转译**：元素全部 `react_jsx_runtime.jsx(...)` 显式调用，**不能写 `<div>...</div>`**。
- `settingsScope` 用 **`ctx.get("settingsScope")`**，缺失则跳过（勿加进 `inject`，那会拖垮主题插件激活）。
- 全程 try/catch + 组件体防御（无 controller/useSnapshot/数据就 `return null`）。
- **host `plugin-manager.js` 的 `snapshot()` 必须给每条 entry 加 `protected` 字段**（`protected: isProtected(entry.options.name)`），客户端靠它决定是否禁停（不是按分类）、未挂载仅是状态不影响启停。

---

## 1. 准绳代码（与当前 client.js 一致）

### 1.1 工具 + 通知设置项（`settings.general.item`）

```js
function ToggleRow({ label, checked, onChange, disabled }) {
  return react_jsx_runtime.jsx("label", {
    style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
             padding: "10px 0", cursor: disabled ? "default" : "pointer",
             borderBottom: "1px solid var(--dsw-alias-border-l1, #e3e9f3)" },
    children: [
      react_jsx_runtime.jsx("span", { children: label }),
      react_jsx_runtime.jsx("input", {
        type: "checkbox", checked: !!checked, disabled: !!disabled,
        onChange: (event) => onChange && onChange(event.target.checked),
      }),
    ],
  });
}

function NotifySettingsItem(props) {
  const { controller, useSnapshot } = props || {};
  if (!controller || typeof useSnapshot !== "function") return null;
  const state = useSnapshot((snapshot) => snapshot);
  if (!state || !state.value) return null;
  const value = state.value;
  return react_jsx_runtime.jsx("div", { style: { width: "100%" }, children: [
    react_jsx_runtime.jsx(ToggleRow, {
      label: "通知", checked: !!value.enabled,
      onChange: (checked) => controller.set("enabled", checked),
    }),
    react_jsx_runtime.jsx(ToggleRow, {
      label: "回合完成提醒", checked: !!value.notifyOnTurnCompletion,
      disabled: !value.enabled,
      onChange: (checked) => controller.set("notifyOnTurnCompletion", checked),
    }),
  ] });
}
```

### 1.2 插件管理分区（`settings.section`）

```js
const PHASE_ZH = { active: "已挂载", loading: "加载中", pending: "待加载", failed: "失败", unloading: "卸载中" };

function pluginMeta(entry) {
  const name = String(entry.moduleName || entry.entryId || "");
  const cat = String(entry.category || "下载");
  const phase = entry.phase == null ? "unmounted" : String(entry.phase);
  const phaseZh = PHASE_ZH[phase] || "未挂载";
  // 禁用与否由 host 的 protected 标记决定（仅核心/骨架不可停用）；内置非保护、未挂载均可启停。
  const core = !!entry.protected;
  return { name, cat, phaseZh, core, entryId: String(entry.entryId || "") };
}

function PluginManagerSection(props) {
  const { controller, useSnapshot } = props || {};
  const [query, setQuery] = _react.useState("");
  const [notice, setNotice] = _react.useState(null);
  if (!controller || typeof useSnapshot !== "function") return null;
  const state = useSnapshot((snapshot) => snapshot);
  if (!state || !state.value) return null;
  const entries = state.value.entries || [];
  const result = state.value.result || null;
  const q = query.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (!q) return true;
    const nm = String(entry.moduleName || "").toLowerCase();
    const id = String(entry.entryId || "").toLowerCase();
    return nm.includes(q) || id.includes(q);
  });
  const groups = ["下载", "自制", "内置"].map((key) => ({
    key,
    rows: filtered.filter((entry) => String(entry.category || "") === key),
  }));
  return react_jsx_runtime.jsx("div", {
    style: { width: "100%", display: "flex", flexDirection: "column", gap: 8 },
    children: [
      react_jsx_runtime.jsx("input", {
        type: "text", placeholder: "搜索插件…",
        value: query,
        onChange: (event) => setQuery(event.target.value),
        style: { width: "100%", padding: "6px 10px", borderRadius: 8,
                 border: "1px solid var(--dsw-alias-border-l1, #e3e9f3)",
                 background: "transparent", color: "var(--dsw-alias-label-primary, #1a2233)" },
      }),
      (result && result.message)
        ? react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-state-info-primary, #4573d2)", fontSize: 12 }, children: result.message })
        : (notice ? react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-state-info-primary, #4573d2)", fontSize: 12 }, children: notice }) : null),
      groups.map((group) => {
        if (!group.rows.length) return null;
        return react_jsx_runtime.jsx("div", { style: { width: "100%" }, children: [
          react_jsx_runtime.jsx("div", { style: { fontWeight: 600, padding: "6px 0",
            color: "var(--dsw-alias-label-secondary, #4a5a78)", fontSize: 13 },
            children: group.key + "（" + group.rows.length + "）" }),
          group.rows.map((entry) => {
            const meta = pluginMeta(entry);
            return react_jsx_runtime.jsx("div", {
              style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                       borderBottom: "1px solid var(--dsw-alias-border-l1, #e3e9f3)" },
              children: [
                react_jsx_runtime.jsx("input", {
                  type: "checkbox", checked: !!entry.enabled, disabled: meta.core,
                  onChange: (event) => controller.set("request", { op: "toggle", id: entry.entryId, enabled: event.target.checked }),
                }),
                react_jsx_runtime.jsx("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: meta.name }),
                react_jsx_runtime.jsx("span", { style: { flex: "0 0 auto", fontSize: 11,
                  color: "var(--dsw-alias-label-tertiary, #6b7a99)", borderRadius: 4, padding: "0 6px",
                  border: "1px solid var(--dsw-alias-border-l1, #e3e9f3)" }, children: meta.cat }),
                react_jsx_runtime.jsx("span", { style: { flex: "0 0 auto", fontSize: 11,
                  color: "var(--dsw-alias-label-tertiary, #6b7a99)" }, children: meta.entryId }),
                react_jsx_runtime.jsx("span", { style: { flex: "0 0 auto", fontSize: 11,
                  color: meta.phaseZh === "已挂载" ? "var(--dsw-alias-state-success-primary, #2ba26a)"
                    : "var(--dsw-alias-label-tertiary, #6b7a99)" }, children: meta.phaseZh }),
              ],
            }, meta.entryId);
          }),
        ] }, group.key);
      }),
    ],
  });
}
```

### 1.3 `apply(ctx)` 里的注册（第 3 步）

```js
// 3) 设置 UI：通知开关行 + 插件管理分区
try {
  const settingsScope = ctx.get("settingsScope");
  if (settingsScope && typeof settingsScope.bind === "function") {
    const notifyController = settingsScope.bind({ namespace: "dshome" });
    ctx.slots.inject("settings.general.item", () => ctx.slots.register({
      name: "settings.general.item", id: "dshome-notify", order: 20, locale: "dshome",
      inject: () => ({ controller: notifyController, hooks: { snapshot: notifyController.store } }),
    }, NotifySettingsItem));

    const pmController = settingsScope.bind({ namespace: "dshome-pluginmanager" });
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section", id: "dshome-pluginmanager", order: 5,
      label: () => "插件管理", locale: "dshome",
      inject: () => ({ controller: pmController, hooks: { snapshot: pmController.store } }),
    }, PluginManagerSection));
  }
} catch (error) {
  console.warn("dshome-theme: settings features failed", error);
}
```

> 另需在文件顶部：`let _react = require("react");`（供 `_react.useState`）；组件内用 `react_jsx_runtime.jsx(...)`（`react_jsx_runtime` 已 require）。

---

## 2. host 端一处改动（插件管理分区必需）

`dshome/lib/host/plugin-manager.js` 的 `snapshot(ctx)`，每条 entry 增加 `protected`：

```js
entries.push({
  entryId: entry.id, moduleName: entry.options.name, enabled: !entry.disabled,
  category: classify(entry.options.name),
  phase: entry.fiber?.state === void 0 ? null : (set[entry.fiber.state] ?? null),
  protected: isProtected(entry.options.name),   // ← 新增
});
```

---

## 3. 验证要点

1. `node --check packages/dshome-theme/lib/client.js` 语法通过。
2. 重启后端（host 改动需重启）；进「设置」：
   - 左侧出现 **「插件管理」**（分组 下载/自制/内置 + 名称/分类徽章/entryId/Cordis 状态/启停开关 + 搜索 + `重启生效` 提示）；
   - 「通用设置」出现 **「通知」+「回合完成提醒」** 两开关。
3. 切换后看 `dshome/probe-rpc.mjs settings.describe`：`dshome.value.enabled/notifyOnTurnCompletion`、`dshome-pluginmanager.value.request` 是否被写入。

## 4. 回退
原始基础版在 `E:\DSH\DSHOME-PACK-2026-08-29\packages\dshome-theme\lib\client.js`；当前可用版也在快照 `E:\DSH\build-stage\dshome-node-snapshot\dshome-theme-client.js`。

## 5. 已证实教训
- 读 store 用 **`props.useSnapshot`**（渲染器注入），**别用 `React.useSyncExternalStore`**（会拿不到数据返回 null）。
- 别写 JSX `<div>` 语法（该 bundle 无 JSX 转译），一律 `react_jsx_runtime.jsx(...)`。
- 禁停依据 **host 的 `protected`**，不是按"内置"分类一刀切；未挂载只是状态，不影响启停。
- `settingsScope` 用 `ctx.get(...)`；组件无 `controller`/`useSnapshot`/数据就 `return null`。
