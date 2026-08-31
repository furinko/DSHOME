// dshome-plugin-center — 插件管理中心（浏览器 client 模块）。
// 入口：官方左侧边栏 sidebar.footer.action（设置按钮旁），零第三方依赖。
// 面板：Vanilla DOM 浮层（品牌化卡片设计，无 React 渲染），
//       数据/启停走 host 控制面 /api/dshome/plugins（loopback fence，同源）。
window.__ModuleLoader__.load({
  id: "dshome-plugin-center",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");

    // ── 设计系统样式（DSHOME 品牌：深海军蓝 + 品牌蓝 #4D6BFE）──────────────
    var STYLE = [
      // 遮罩 + 面板容器
      ".dshome-pc-root{position:fixed;inset:0;z-index:2147483000;display:none;align-items:flex-start;justify-content:center;padding:9vh 16px 16px;background:rgba(5,8,14,.5);backdrop-filter:blur(2px);animation:dshome-pc-fade .18s ease}",
      "@keyframes dshome-pc-fade{from{opacity:0}to{opacity:1}}",
      ".dshome-pc-panel{width:min(760px,94vw);max-height:80vh;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d3dcea);box-shadow:0 24px 80px rgba(0,0,0,.45);animation:dshome-pc-pop .16s cubic-bezier(.2,.9,.3,1.2)}",
      "@keyframes dshome-pc-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}",
      // 头部
      ".dshome-pc-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-pc-head-icon{flex:none;width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(77,107,254,.18),rgba(77,107,254,.06));color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-pc-head-title{flex:1;min-width:0}",
      ".dshome-pc-title{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#1a2233);letter-spacing:.2px}",
      ".dshome-pc-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99);margin-top:2px}",
      ".dshome-pc-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:9px;padding:6px 11px;font-size:12px;color:var(--dsw-alias-label-secondary,#4a5a78);cursor:pointer;transition:all .15s}",
      ".dshome-pc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08));border-color:var(--dsw-alias-brand-primary,#4D6BFE);color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      // 工具栏
      ".dshome-pc-toolbar{display:flex;gap:8px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3);flex-wrap:wrap;align-items:center}",
      ".dshome-pc-search-wrap{position:relative;flex:1;min-width:170px}",
      ".dshome-pc-search{width:100%;box-sizing:border-box;padding:8px 12px 8px 32px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:13.5px;outline:none;transition:border-color .15s,box-shadow .15s}",
      ".dshome-pc-search:focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 0 0 3px rgba(77,107,254,.14)}",
      ".dshome-pc-search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--dsw-alias-label-tertiary,#6b7a99);pointer-events:none}",
      ".dshome-pc-select{padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:13.5px;outline:none;cursor:pointer;transition:border-color .15s}",
      ".dshome-pc-select:focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      // 列表
      ".dshome-pc-list{flex:1;overflow:auto;padding:6px 14px 16px}",
      ".dshome-pc-list::-webkit-scrollbar{width:8px}.dshome-pc-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#d3dcea);border-radius:99px}",
      ".dshome-pc-group{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-tertiary,#6b7a99);padding:14px 6px 7px;letter-spacing:.5px;text-transform:uppercase}",
      ".dshome-pc-group-count{font-weight:600;font-size:11px;padding:1px 7px;border-radius:99px;background:var(--dsw-alias-border-l1,#e3e9f3);color:var(--dsw-alias-label-secondary,#4a5a78)}",
      // 插件行卡片
      ".dshome-pc-row{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:11px;border:1px solid transparent;transition:background .12s,border-color .12s}",
      ".dshome-pc-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.06));border-color:var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-pc-dot{flex:none;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff}",
      ".dshome-pc-dot-self{background:linear-gradient(135deg,#5b7bff,#3e5bf0)}",
      ".dshome-pc-dot-builtin{background:linear-gradient(135deg,#7c8db5,#5a6a92)}",
      ".dshome-pc-dot-download{background:linear-gradient(135deg,#2fbf8f,#1e9e73)}",
      ".dshome-pc-main{flex:1;min-width:0}",
      ".dshome-pc-name{font-size:14px;color:var(--dsw-alias-label-primary,#1a2233);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshome-pc-mod{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7a99);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;font-family:Consolas,'Cascadia Mono',monospace}",
      ".dshome-pc-desc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7a99);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}",
      // 状态徽章（圆点 + 文字）
      ".dshome-pc-badge{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:99px}",
      ".dshome-pc-badge::before{content:'';width:6px;height:6px;border-radius:50%}",
      ".dshome-pc-badge-active{background:rgba(47,191,143,.12);color:#1e9e73}.dshome-pc-badge-active::before{background:#2fbf8f}",
      ".dshome-pc-badge-loading{background:rgba(240,180,41,.14);color:#b8860b}.dshome-pc-badge-loading::before{background:#f0b429}",
      ".dshome-pc-badge-failed{background:rgba(229,83,75,.12);color:#d64545}.dshome-pc-badge-failed::before{background:#e5534b}",
      ".dshome-pc-badge-disabled{background:var(--dsw-alias-border-l1,#e3e9f3);color:var(--dsw-alias-label-tertiary,#6b7a99)}.dshome-pc-badge-disabled::before{background:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-pc-lock{flex:none;font-size:11px;opacity:.6;cursor:default}",
      // 启停开关（iOS 风格）
      ".dshome-pc-toggle{flex:none;position:relative;width:36px;height:20px;border-radius:99px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2,#d3dcea);transition:background .18s;outline:none}",
      ".dshome-pc-toggle::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .18s}",
      ".dshome-pc-toggle.on{background:#4D6BFE}",
      ".dshome-pc-toggle.on::after{left:18px}",
      ".dshome-pc-toggle:disabled{opacity:.4;cursor:not-allowed}",
      // 空状态 / Toast
      ".dshome-pc-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:42px 16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-pc-empty-ico{font-size:26px;opacity:.5}",
      ".dshome-pc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;padding:9px 18px;border-radius:99px;font-size:12.5px;color:#fff;background:rgba(16,20,30,.94);box-shadow:0 8px 30px rgba(0,0,0,.35);display:none;animation:dshome-pc-fade .15s ease}",
      // 侧边栏入口（footer.action）
      ".dshome-pc-entry{display:inline-flex;align-items:center;gap:8px;height:34px;padding:3px 11px 3px 3px;border-radius:10px;border:none;cursor:pointer;background:transparent;transition:background .15s,transform .1s}",
      ".dshome-pc-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08))}",
      ".dshome-pc-entry:active{transform:scale(.96)}",
      ".dshome-pc-entry-ico{flex:none;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#5b7bff,#3e5bf0);color:#fff;box-shadow:0 2px 8px rgba(77,107,254,.35)}",
      ".dshome-pc-entry-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#4a5a78)}",
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
    function svg(pathD, size) {
      var ns = "http://www.w3.org/2000/svg";
      var s = document.createElementNS(ns, "svg");
      s.setAttribute("width", size || 14);
      s.setAttribute("height", size || 14);
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("fill", "none");
      s.setAttribute("stroke", "currentColor");
      s.setAttribute("stroke-width", "2");
      s.setAttribute("stroke-linecap", "round");
      s.setAttribute("stroke-linejoin", "round");
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", pathD);
      s.appendChild(p);
      return s;
    }
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.style.display = "block";
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(function () { toastEl.style.display = "none"; }, 2600);
    }

    // 分类缩写（图标方块里的字母）
    function catLetter(cat) { return cat === "自制" ? "自" : cat === "内置" ? "内" : "载"; }
    function catDotCls(cat) { return cat === "自制" ? "dshome-pc-dot-self" : cat === "内置" ? "dshome-pc-dot-builtin" : "dshome-pc-dot-download"; }
    function stateText(p) {
      var ph = p.phase || (p.enabled ? "active" : "disabled");
      if (ph === "active") return "运行中";
      if (ph === "failed") return "失败";
      if (ph === "loading") return "加载中";
      return "已停用";
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
      try {
        var res = await fetch("/api/dshome/plugins/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: entryId, enabled: enabled }),
        });
        var data = await res.json();
        if (data && data.ok) toast((enabled ? "已启用" : "已停用") + "，重启后生效");
        else toast((data && data.message) || "操作失败");
      } catch (e) { toast("操作失败"); }
      load();
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────────
    function visible() {
      var q = filters.q.toLowerCase();
      return plugins.filter(function (p) {
        if (filters.cat !== "全部" && p.category !== filters.cat) return false;
        if (filters.state !== "全部") {
          if (filters.state === "protected") { if (!(p.protected && p.enabled)) return false; }
          else if (p.phase !== filters.state) return false;
        }
        if (q && (p.moduleName || "").toLowerCase().indexOf(q) < 0 && (p.entryId || "").toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }
    function render() {
      var rows = visible();
      countEl.textContent = "共 " + plugins.length + " 项 · 显示 " + rows.length;
      listEl.textContent = "";
      if (!rows.length) {
        var e = el("div", "dshome-pc-empty");
        e.appendChild(el("div", "dshome-pc-empty-ico", "🔍"));
        e.appendChild(el("div", null, "没有匹配的插件，换个关键词或筛选条件试试"));
        listEl.appendChild(e);
        return;
      }
      var groups = {};
      rows.forEach(function (p) { (groups[p.category] = groups[p.category] || []).push(p); });
      Object.keys(groups).sort(function (a, b) { return { 下载: 0, 自制: 1, 内置: 2 }[a] - { 下载: 0, 自制: 1, 内置: 2 }[b]; }).forEach(function (cat) {
        var list = groups[cat];
        var g = el("div", "dshome-pc-group");
        g.appendChild(el("span", null, cat));
        g.appendChild(el("span", "dshome-pc-group-count", String(list.length)));
        listEl.appendChild(g);
        list.forEach(function (p) { listEl.appendChild(rowEl(p)); });
      });
    }
    function rowEl(p) {
      var r = el("div", "dshome-pc-row");
      // 分类色块（首字母）
      var dot = el("div", "dshome-pc-dot " + catDotCls(p.category), catLetter(p.category));
      r.appendChild(dot);
      // 名称 + 一句话说明（描述优先；无描述显示 entryId 兜底；moduleName 进悬停提示）
      var main = el("div", "dshome-pc-main");
      var nameEl = el("div", "dshome-pc-name", p.moduleName);
      nameEl.title = p.entryId;
      main.appendChild(nameEl);
      main.appendChild(el("div", "dshome-pc-desc", p.description || p.entryId));
      r.appendChild(main);
      // 状态徽章
      r.appendChild(el("span", "dshome-pc-badge dshome-pc-badge-" + (p.phase || (p.enabled ? "active" : "disabled")), stateText(p)));
      // 受保护：仅运行中的核心插件显示 🔒 且禁停；已停用的核心允许启用
      var coreRunning = p.protected && p.enabled;
      if (coreRunning) r.appendChild(el("span", "dshome-pc-lock", "🔒"));
      // 启停开关
      var t = el("button", "dshome-pc-toggle" + (p.enabled && p.phase !== "disabled" ? " on" : ""));
      t.type = "button";
      t.title = coreRunning ? "核心插件，不可停用" : (p.enabled ? "停用（重启后生效）" : "启用（重启后生效）");
      if (coreRunning) t.disabled = true;
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
      var headIco = el("div", "dshome-pc-head-icon");
      headIco.appendChild(svg("M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", 15));
      head.appendChild(headIco);
      var titleBox = el("div", "dshome-pc-head-title");
      titleBox.appendChild(el("div", "dshome-pc-title", "插件管理"));
      countEl = el("div", "dshome-pc-sub", "");
      titleBox.appendChild(countEl);
      head.appendChild(titleBox);
      var refresh = el("button", "dshome-pc-btn", "刷新");
      refresh.onclick = load;
      head.appendChild(refresh);
      var closeBtn = el("button", "dshome-pc-btn", "关闭");
      closeBtn.onclick = close;
      head.appendChild(closeBtn);
      panel.appendChild(head);
      // 工具栏
      var toolbar = el("div", "dshome-pc-toolbar");
      var sw = el("div", "dshome-pc-search-wrap");
      var ico = el("span", "dshome-pc-search-icon");
      ico.appendChild(svg("M21 21l-4.34-4.34M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z", 13));
      sw.appendChild(ico);
      searchEl = el("input", "dshome-pc-search");
      searchEl.placeholder = "搜索插件名或 id…";
      searchEl.oninput = applyFilters;
      sw.appendChild(searchEl);
      toolbar.appendChild(sw);
      catSel = el("select", "dshome-pc-select");
      ["全部", "下载", "自制", "内置"].forEach(function (c) { var o = el("option", null, c === "全部" ? "全部分类" : c); o.value = c; catSel.appendChild(o); });
      catSel.onchange = applyFilters;
      toolbar.appendChild(catSel);
      stateSel = el("select", "dshome-pc-select");
      [["全部", "全部状态"], ["active", "运行中"], ["loading", "加载中"], ["failed", "失败"], ["disabled", "已停用"], ["protected", "受保护"]].forEach(function (s) { var o = el("option", null, s[1]); o.value = s[0]; stateSel.appendChild(o); });
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
    // 品牌蓝渐变图标块 + 悬停反馈 + 按压缩放；折叠态只显示图标块。
    function PluginCenterAction(props) {
      var wide = !!(props && props.wide);
      return react_jsx_runtime.jsx("button", {
        type: "button",
        title: "插件管理",
        onClick: open,
        className: "dshome-pc-entry",
        style: { padding: wide ? "3px 11px 3px 3px" : "3px" },
        children: [
          react_jsx_runtime.jsx("span", {
            className: "dshome-pc-entry-ico",
            children: react_jsx_runtime.jsx("svg", {
              width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
              stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
              children: react_jsx_runtime.jsx("path", {
                d: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
              }),
            }),
          }),
          wide ? react_jsx_runtime.jsx("span", { className: "dshome-pc-entry-label", children: "插件管理" }) : null,
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
            label: function () { return "插件管理"; },
          }, PluginCenterAction);
        });
      } catch (e) { console.warn("dshome-plugin-center: slot registration failed", e); }
    }

    module.exports = { name: "dshome-plugin-center", inject, apply };
    return module.exports;
  },
});
