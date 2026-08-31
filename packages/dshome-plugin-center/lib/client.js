// dshome-plugin-center — 插件管理中心（浏览器 client 模块）。
// 入口：官方左侧边栏 sidebar.footer.action（设置按钮旁），零第三方依赖。
// 面板：Vanilla DOM 浮层（dshome-palette 同款模式，无 React 渲染），
//       数据/启停走 host 控制面 /api/dshome/plugins（loopback fence，同源）。
window.__ModuleLoader__.load({
  id: "dshome-plugin-center",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");

    // ── 样式（DSHOME 主题 token；与 palette/theme 一致的 CSS 变量）────────────
    var STYLE = [
      ".dshome-pc-root{position:fixed;inset:0;z-index:2147483000;display:none;align-items:flex-start;justify-content:center;padding:10vh 16px 16px;background:rgba(5,8,14,.45)}",
      ".dshome-pc-panel{width:min(720px,94vw);max-height:78vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d3dcea);box-shadow:0 18px 60px rgba(0,0,0,.35)}",
      ".dshome-pc-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-pc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1a2233);flex:1}",
      ".dshome-pc-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-pc-btn{background:none;border:1px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:8px;padding:5px 10px;font-size:12px;color:var(--dsw-alias-label-primary,#1a2233);cursor:pointer}",
      ".dshome-pc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08))}",
      ".dshome-pc-toolbar{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3);flex-wrap:wrap}",
      ".dshome-pc-search{flex:1;min-width:160px;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:12px}",
      ".dshome-pc-select{padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:12px}",
      ".dshome-pc-list{flex:1;overflow:auto;padding:4px 16px 12px}",
      ".dshome-pc-group{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#6b7a99);padding:12px 2px 6px;text-transform:uppercase;letter-spacing:.4px}",
      ".dshome-pc-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px}",
      ".dshome-pc-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.06))}",
      ".dshome-pc-main{flex:1;min-width:0}",
      ".dshome-pc-name{font-size:13px;color:var(--dsw-alias-label-primary,#1a2233);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshome-pc-mod{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7a99);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshome-pc-badge{flex:none;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600}",
      ".dshome-pc-badge-active{background:rgba(52,168,83,.14);color:#2f9e44}",
      ".dshome-pc-badge-loading{background:rgba(240,180,41,.16);color:#b8860b}",
      ".dshome-pc-badge-failed{background:rgba(230,80,80,.14);color:#d64545}",
      ".dshome-pc-badge-disabled{background:var(--dsw-alias-border-l1,#e3e9f3);color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-pc-badge-protected{background:rgba(77,107,254,.12);color:#4d6bfe}",
      ".dshome-pc-lock{flex:none;font-size:12px;opacity:.7;cursor:default;title:'受保护'}" +
      ".dshome-pc-toggle{flex:none;position:relative;width:34px;height:18px;border-radius:99px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2,#d3dcea);transition:background .15s}",
      ".dshome-pc-toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}",
      ".dshome-pc-toggle.on{background:#4d6bfe}",
      ".dshome-pc-toggle.on::after{left:18px}",
      ".dshome-pc-toggle:disabled{opacity:.45;cursor:not-allowed}",
      ".dshome-pc-empty{padding:26px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-pc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;padding:8px 16px;border-radius:99px;font-size:12px;color:#fff;background:rgba(20,24,34,.92);display:none}",
    ].join("");

    // ── 状态 ─────────────────────────────────────────────────────────────────
    var plugins = [];
    var filters = { q: "", cat: "全部", state: "全部" };
    var root, panel, listEl, searchEl, catSel, stateSel, countEl, toastEl;
    var mounted = false;

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.style.display = "block";
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(function () { toastEl.style.display = "none"; }, 2600);
    }
    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    // ── 数据 ─────────────────────────────────────────────────────────────────
    async function load() {
      try {
        var res = await fetch("/api/dshome/plugins", { headers: { Accept: "application/json" } });
        var data = await res.json();
        plugins = (data && data.ok && Array.isArray(data.plugins)) ? data.plugins : [];
      } catch (e) { plugins = []; }
      render();
    }
    async function toggle(entryId, enabled) {
      var row = null;
      try {
        var res = await fetch("/api/dshome/plugins/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: entryId, enabled: enabled }),
        });
        var data = await res.json();
        if (data && data.ok) toast((enabled ? "已启用" : "已停用") + "（重启生效）");
        else toast((data && data.message) || "操作失败");
      } catch (e) { toast("操作失败：" + (e && e.message ? e.message : e)); }
      load();
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────────
    function visible() {
      var q = filters.q.toLowerCase();
      return plugins.filter(function (p) {
        if (filters.cat !== "全部" && p.category !== filters.cat) return false;
        if (filters.state !== "全部") {
          if (filters.state === "protected") { if (!p.protected) return false; }
          else if (p.phase !== filters.state) return false;
        }
        if (q && (p.moduleName || "").toLowerCase().indexOf(q) < 0 && (p.entryId || "").toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }
    function render() {
      var rows = visible();
      countEl.textContent = rows.length + " / " + plugins.length + " 项";
      listEl.textContent = "";
      if (!rows.length) { listEl.appendChild(el("div", "dshome-pc-empty", "没有匹配的插件")); return; }
      var groups = { 自制: [], 内置: [], 下载: [] };
      rows.forEach(function (p) { (groups[p.category] = groups[p.category] || []).push(p); });
      Object.keys(groups).forEach(function (cat) {
        var list = groups[cat];
        if (!list || !list.length) return;
        listEl.appendChild(el("div", "dshome-pc-group", cat + "（" + list.length + "）"));
        list.forEach(function (p) { listEl.appendChild(rowEl(p)); });
      });
    }
    function rowEl(p) {
      var r = el("div", "dshome-pc-row");
      var main = el("div", "dshome-pc-main");
      main.appendChild(el("div", "dshome-pc-name", p.moduleName));
      main.appendChild(el("div", "dshome-pc-mod", p.entryId));
      r.appendChild(main);
      // 状态徽章
      var phase = p.phase || (p.enabled ? "active" : "disabled");
      var badgeCls = "dshome-pc-badge dshome-pc-badge-" + phase;
      r.appendChild(el("span", badgeCls, phase === "active" ? "运行中" : phase === "failed" ? "失败" : phase === "loading" ? "加载中" : "已停用"));
      if (p.protected) r.appendChild(el("span", "dshome-pc-lock", "🔒"));
      // 启停开关
      var t = el("button", "dshome-pc-toggle" + (p.enabled && phase !== "disabled" ? " on" : ""));
      t.type = "button";
      t.title = p.protected ? "核心插件，不可停用" : (p.enabled ? "停用（重启生效）" : "启用（重启生效）");
      if (p.protected) t.disabled = true;
      t.onclick = function () { toggle(p.entryId, !p.enabled); };
      r.appendChild(t);
      return r;
    }
    function applyFilters() {
      filters.q = searchEl.value;
      filters.cat = catSel.value;
      filters.state = stateSel.value;
      render();
    }

    // ── 浮层生命周期 ─────────────────────────────────────────────────────────
    function open() {
      if (!mounted) mount();
      root.style.display = "flex";
      searchEl.value = "";
      catSel.value = "全部";
      stateSel.value = "全部";
      filters = { q: "", cat: "全部", state: "全部" };
      load();
    }
    function close() { root.style.display = "none"; }
    function mount() {
      mounted = true;
      var css = el("style"); css.textContent = STYLE;
      document.head.appendChild(css);
      root = el("div", "dshome-pc-root");
      root.onclick = function (e) { if (e.target === root) close(); };
      panel = el("div", "dshome-pc-panel");
      // 头部
      var head = el("div", "dshome-pc-head");
      head.appendChild(el("div", "dshome-pc-title", "插件管理"));
      countEl = el("span", "dshome-pc-sub", "");
      head.appendChild(countEl);
      var refresh = el("button", "dshome-pc-btn", "刷新");
      refresh.onclick = load;
      head.appendChild(refresh);
      var closeBtn = el("button", "dshome-pc-btn", "关闭");
      closeBtn.onclick = close;
      head.appendChild(closeBtn);
      panel.appendChild(head);
      // 工具栏
      var toolbar = el("div", "dshome-pc-toolbar");
      searchEl = el("input", "dshome-pc-search");
      searchEl.placeholder = "搜索插件名 / id…";
      searchEl.oninput = applyFilters;
      toolbar.appendChild(searchEl);
      catSel = el("select", "dshome-pc-select");
      ["全部", "自制", "内置", "下载"].forEach(function (c) { var o = el("option", null, c); o.value = c; catSel.appendChild(o); });
      catSel.onchange = applyFilters;
      toolbar.appendChild(catSel);
      stateSel = el("select", "dshome-pc-select");
      ["全部", "active", "loading", "failed", "disabled", "protected"].forEach(function (s) { var o = el("option", null, s === "active" ? "运行中" : s === "loading" ? "加载中" : s === "failed" ? "失败" : s === "disabled" ? "已停用" : s === "protected" ? "受保护" : "全部状态"); o.value = s; stateSel.appendChild(o); });
      stateSel.onchange = applyFilters;
      toolbar.appendChild(stateSel);
      panel.appendChild(toolbar);
      // 列表
      listEl = el("div", "dshome-pc-list");
      panel.appendChild(listEl);
      root.appendChild(panel);
      document.body.appendChild(root);
      toastEl = el("div", "dshome-pc-toast");
      document.body.appendChild(toastEl);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && root.style.display !== "none") close();
      });
    }

    // ── 入口按钮（sidebar.footer.action 槽组件：props.wide = 展开/折叠）──────
    function PluginCenterAction(props) {
      var wide = !!(props && props.wide);
      return react_jsx_runtime.jsx("button", {
        type: "button",
        title: "插件管理",
        onClick: open,
        style: {
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          gap: 6, height: 28, padding: wide ? "0 10px" : "0", minWidth: wide ? "auto" : 28,
          borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, lineHeight: 1,
          color: "var(--dsw-alias-label-secondary, #4a5a78)",
          background: "transparent",
        },
        children: [
          react_jsx_runtime.jsx("span", { style: { fontSize: 15 }, children: "🧩" }),
          wide ? react_jsx_runtime.jsx("span", { style: { fontSize: 12 }, children: "插件" }) : null,
        ],
      });
    }

    // ── 插件体 ───────────────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      try {
        ctx.slots.inject("sidebar.footer.action", function () {
          return ctx.slots.register({
            name: "sidebar.footer.action",
            id: "dshome-plugin-center",
            order: 5,
            label: function () { return "插件"; },
          }, PluginCenterAction);
        });
      } catch (e) { console.warn("dshome-plugin-center: slot registration failed", e); }
    }

    module.exports = { name: "dshome-plugin-center", inject, apply };
    return module.exports;
  },
});
