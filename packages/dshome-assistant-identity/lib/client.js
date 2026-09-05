// dshome-assistant-identity — browser client module.
//
// 职责（快路径，客户端纯插件）：
// 1) 对话区注入：MutationObserver 监听 div[data-chat-flow-kind="assistant-step"]，
//    行首插入「头像 + 名字」（data-dshome-identity 幂等；流式/翻页重渲染由观察器补灌）。
// 2) 通用设置两行（settings.general.item）：助手名字行 + 助手头像行（预设/上传/无）。
// 3) 持久化：localStorage（key: dshome.assistant.identity），改动即写 + dispatch 变更事件。
// 容错：任一环节失败只静默降级，绝不阻断 UI（照 dshome-theme 风格）。

window.__ModuleLoader__.load({
  id: "dshome-assistant-identity",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    // ── 配置（localStorage）───────────────────────────────────────────────
    var KEY = "dshome.assistant.identity";
    var EVENT = "dshome:assistant-identity-changed";
    var MAX_NAME = 24;
    var MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
    var MAX_AVATAR_EDGE = 256;

    function readConfig() {
      try {
        var v = JSON.parse(localStorage.getItem(KEY) || "null");
        if (v && typeof v === "object") {
          return {
            name: typeof v.name === "string" ? v.name.slice(0, MAX_NAME) : "",
            avatar: v.avatar && typeof v.avatar === "object" ? v.avatar : { kind: "none" },
          };
        }
      } catch (e) { /* corrupted -> default */ }
      return { name: "", avatar: { kind: "none" } };
    }
    function writeConfig(cfg) {
      try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { console.warn("dshome-assistant-identity: save failed", e); }
      try { window.dispatchEvent(new CustomEvent(EVENT)); } catch (e) {}
    }

    // ── 内置预设头像（白图标 + 渐变底，明暗主题通用）──────────────────────
    function presetUri(svg) {
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    }
    var PRESETS = [
      { id: "fish", label: "鲸鱼", bg: "linear-gradient(135deg,#5b7bff,#3e5bf0)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c3.2-4.6 7.2-5 9.4-5 1.9 0 4.6.7 7.1 2.6L14.2 14c-1.3.9-2.6 1.4-3.9 1.4-2.2 0-4.8-.8-7.3-3.4z"/><circle cx="11.2" cy="11" r="1" fill="#ffffff" stroke="none"/><path d="M19.5 9.6l3.5-2v8.8l-3.5-2"/></svg>' },
      { id: "robot", label: "机器人", bg: "linear-gradient(135deg,#7c8db5,#5a6a92)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.2" fill="#ffffff" stroke="none"/><circle cx="9.5" cy="13" r="1" fill="#ffffff" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="#ffffff" stroke="none"/><path d="M9.5 16.5c.8.8 1.6 1.2 2.5 1.2s1.7-.4 2.5-1.2"/></svg>' },
      { id: "star", label: "星星", bg: "linear-gradient(135deg,#f0b429,#d9941a)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6L2.5 9.5l6.6-.8z"/></svg>' },
      { id: "moon", label: "月亮", bg: "linear-gradient(135deg,#8fa3c0,#6b7a99)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>' },
      { id: "cat", label: "猫咪", bg: "linear-gradient(135deg,#2fbf8f,#1e9e73)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l2-4 3 2.2M19 8l-2-4-3 2.2"/><circle cx="12" cy="13" r="7"/><circle cx="9" cy="12.5" r="1" fill="#ffffff" stroke="none"/><circle cx="15" cy="12.5" r="1" fill="#ffffff" stroke="none"/><path d="M9.5 15.5c1.4 1 3.6 1 5 0"/></svg>' },
      { id: "bolt", label: "闪电", bg: "linear-gradient(135deg,#f59e0b,#e5534b)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5z"/></svg>' },
      { id: "paw", label: "爪印", bg: "linear-gradient(135deg,#c084fc,#8b5cf6)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><ellipse cx="12" cy="15.5" rx="4.6" ry="3.4"/><circle cx="5.5" cy="11" r="2"/><circle cx="9.5" cy="6.8" r="2"/><circle cx="14.5" cy="6.8" r="2"/><circle cx="18.5" cy="11" r="2"/></svg>' },
      { id: "gem", label: "宝石", bg: "linear-gradient(135deg,#22d3ee,#0ea5e9)", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"><path d="M7 4h10l4 5-9 11L3 9z"/><path d="M3 9h18M9 4l-2 5 5 11M15 4l2 5-5 11"/></svg>' },
    ];
    PRESETS.forEach(function (p) { p.uri = presetUri(p.svg); delete p.svg; });

    // ── 注入器样式 ─────────────────────────────────────────────────────────
    var STYLE = [
      ".dshome-identity{display:flex;align-items:center;gap:8px;margin:0 0 6px 2px}",
      ".dshome-identity-avatar{width:28px;height:28px;border-radius:50%;overflow:hidden;flex:none;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover,#e3e9f3)}",
      ".dshome-identity-avatar img{width:100%;height:100%;object-fit:cover;display:block}",
      ".dshome-identity-name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-secondary,#4a5a78);max-width:min(60vw,480px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ].join("");
    var styleInjected = false;
    function ensureStyle() {
      if (styleInjected) return;
      styleInjected = true;
      try {
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dshome-assistant-identity");
        tag.textContent = STYLE;
        document.head.appendChild(tag);
      } catch (e) { console.warn("dshome-assistant-identity: style failed", e); }
    }

    // ── 对话区注入器 ───────────────────────────────────────────────────────
    var ROW_SELECTOR = '[data-chat-flow-kind="assistant-step"]';

    /** 当前配置 → 可显示的头像 { src, bg } 或 null。 */
    function avatarOf(cfg) {
      var a = cfg.avatar || { kind: "none" };
      if (a.kind === "preset") {
        var p = PRESETS.find(function (x) { return x.id === a.preset; });
        return p ? { src: p.uri, bg: p.bg } : null;
      }
      if (a.kind === "file" && typeof a.dataUri === "string" && a.dataUri) {
        return { src: a.dataUri, bg: "" };
      }
      return null;
    }

    function injectInto(row, cfg) {
      if (!row || row.querySelector("[data-dshome-identity]")) return;
      var name = (cfg.name || "").trim();
      var avatar = avatarOf(cfg);
      if (!name && !avatar) return; // 关闭态：不注入
      var header = document.createElement("div");
      header.className = "dshome-identity";
      header.setAttribute("data-dshome-identity", "1");
      if (avatar) {
        var wrap = document.createElement("span");
        wrap.className = "dshome-identity-avatar";
        if (avatar.bg) wrap.style.background = avatar.bg;
        var img = document.createElement("img");
        img.src = avatar.src;
        img.alt = "";
        img.setAttribute("aria-hidden", "true");
        img.addEventListener("error", function () { wrap.style.display = "none"; }, { once: true });
        wrap.appendChild(img);
        header.appendChild(wrap);
      }
      if (name) {
        var nm = document.createElement("span");
        nm.className = "dshome-identity-name";
        nm.textContent = name; // textContent：无 XSS 面
        header.appendChild(nm);
      }
      row.insertBefore(header, row.firstChild);
    }

    function sweep(cfg) {
      var rows = document.querySelectorAll(ROW_SELECTOR);
      for (var i = 0; i < rows.length; i++) {
        var old = rows[i].querySelector("[data-dshome-identity]");
        if (old) old.remove();
        injectInto(rows[i], cfg);
      }
    }

    var observer = null;
    function onConfigChange() { sweep(readConfig()); }
    function startInjector() {
      try {
        sweep(readConfig());
        observer = new MutationObserver(function (mutations) {
          var cfg = readConfig();
          for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var n = added[j];
              if (!(n instanceof Element)) continue;
              if (n.matches && n.matches(ROW_SELECTOR)) { injectInto(n, cfg); continue; }
              var inside = n.querySelectorAll ? n.querySelectorAll(ROW_SELECTOR) : [];
              for (var k = 0; k < inside.length; k++) injectInto(inside[k], cfg);
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener(EVENT, onConfigChange);
      } catch (e) { console.warn("dshome-assistant-identity: injector failed", e); }
    }

    // ── 通用设置两行 ───────────────────────────────────────────────────────
    function rowShell(title, children) {
      return react_jsx_runtime.jsx("div", {
        style: { borderBottom: "1px solid var(--dsw-alias-border-l2)", flexDirection: "column", gap: 8, padding: "16px 0", display: "flex" },
        children: [
          react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 14, fontWeight: 400, lineHeight: "22px" }, children: title }),
          children,
        ],
      });
    }

    /** 名字行：标签 + 输入框，改动即存。 */
    function NameRow() {
      var state = react.useState(function () { return readConfig().name; });
      var name = state[0];
      var setName = state[1];
      react.useEffect(function () {
        var on = function () { setName(readConfig().name); };
        window.addEventListener(EVENT, on);
        return function () { window.removeEventListener(EVENT, on); };
      }, []);
      var onInput = function (e) {
        var value = e.target.value.slice(0, MAX_NAME);
        setName(value);
        var cfg = readConfig();
        cfg.name = value;
        writeConfig(cfg);
      };
      return rowShell("助手名字", react_jsx_runtime.jsx("input", {
        type: "text",
        value: name,
        maxLength: MAX_NAME,
        placeholder: "不填则不显示名字",
        onChange: onInput,
        style: {
          boxSizing: "border-box", width: "100%", padding: "8px 12px", borderRadius: 9,
          border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base,#f7f9fc)",
          color: "var(--dsw-alias-label-primary)", fontSize: 13.5, outline: "none",
        },
      }));
    }

    /** 头像行：当前预览 + 预设网格 + 上传 + 无。 */
    function AvatarRow() {
      var state = react.useState(readConfig);
      var cfg = state[0];
      var setCfg = state[1];
      var errState = react.useState("");
      var err = errState[0];
      var setErr = errState[1];
      var fileRef = react.useRef(null);
      react.useEffect(function () {
        var on = function () { setCfg(readConfig()); };
        window.addEventListener(EVENT, on);
        return function () { window.removeEventListener(EVENT, on); };
      }, []);
      var save = function (avatar) {
        var next = readConfig();
        next.avatar = avatar;
        writeConfig(next);
        setCfg(readConfig());
      };
      var pick = function (presetId) { save({ kind: "preset", preset: presetId }); };
      var pickNone = function () { save({ kind: "none" }); };
      var onFile = function (e) {
        var file = e.target.files && e.target.files[0];
        e.target.value = ""; // 允许重复选同一文件
        if (!file) return;
        if (file.size > MAX_UPLOAD_BYTES) { setErr("图片不能超过 2MB"); return; }
        if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) { setErr("仅支持 png / jpg / webp"); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var img = new Image();
          img.onload = function () {
            try {
              var w = img.width, h = img.height;
              var max = MAX_AVATAR_EDGE;
              if (w > max || h > max) {
                var r = Math.min(max / w, max / h);
                w = Math.max(1, Math.round(w * r));
                h = Math.max(1, Math.round(h * r));
              }
              var canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              var cx = canvas.getContext("2d");
              cx.drawImage(img, 0, 0, w, h);
              var out = canvas.toDataURL("image/webp", 0.85);
              if (!/^data:image\/webp/.test(out)) out = canvas.toDataURL("image/jpeg", 0.85);
              if (out.length > 700 * 1024) { setErr("压缩后仍过大，请换一张小图"); return; }
              save({ kind: "file", dataUri: out });
              setErr("");
            } catch (ex) { setErr("图片处理失败"); }
          };
          img.onerror = function () { setErr("图片解码失败"); };
          img.src = reader.result;
        };
        reader.onerror = function () { setErr("读取文件失败"); };
        reader.readAsDataURL(file);
      };

      var avatar = avatarOf(cfg);
      var name = (cfg.name || "").trim();
      var preview = react_jsx_runtime.jsx("div", {
        style: { display: "flex", alignItems: "center", gap: 8, marginTop: 2 },
        children: [
          react_jsx_runtime.jsx("span", {
            style: {
              width: 28, height: 28, borderRadius: "50%", overflow: "hidden", flex: "none",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: avatar ? avatar.bg : "var(--dsw-alias-interactive-bg-hover,#e3e9f3)",
            },
            children: avatar ? react_jsx_runtime.jsx("img", { src: avatar.src, alt: "", style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }) : null,
          }),
          react_jsx_runtime.jsx("span", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-secondary,#4a5a78)" }, children: name || "（未设置名字）" }),
        ],
      });

      var grid = react_jsx_runtime.jsx("div", {
        style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
        children: PRESETS.map(function (p) {
          var active = cfg.avatar && cfg.avatar.kind === "preset" && cfg.avatar.preset === p.id;
          return react_jsx_runtime.jsx("button", {
            type: "button",
            title: p.label,
            "aria-pressed": !!active,
            onClick: function () { pick(p.id); },
            style: {
              width: 36, height: 36, borderRadius: "50%", border: active ? "2px solid var(--dsw-alias-brand-primary,#4D6BFE)" : "1px solid var(--dsw-alias-border-l2)",
              background: p.bg, cursor: "pointer", padding: 0, overflow: "hidden", flex: "none",
              boxShadow: active ? "0 0 0 3px var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.15))" : "none",
            },
            children: react_jsx_runtime.jsx("img", { src: p.uri, alt: "", style: { width: "100%", height: "100%", objectFit: "contain", display: "block" } }),
          }, p.id);
        }),
      });

      var actions = react_jsx_runtime.jsx("div", {
        style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
        children: [
          react_jsx_runtime.jsx("button", {
            type: "button",
            onClick: function () { fileRef.current && fileRef.current.click(); },
            style: {
              border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 9, padding: "6px 12px",
              fontSize: 12.5, color: "var(--dsw-alias-label-secondary,#4a5a78)", cursor: "pointer",
              background: "var(--dsw-alias-bg-base,#f7f9fc)",
            },
            children: "上传本地图片",
          }),
          react_jsx_runtime.jsx("button", {
            type: "button",
            onClick: pickNone,
            style: {
              border: cfg.avatar && cfg.avatar.kind === "none" ? "1px solid var(--dsw-alias-brand-primary,#4D6BFE)" : "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 9, padding: "6px 12px", fontSize: 12.5, cursor: "pointer",
              color: "var(--dsw-alias-label-secondary,#4a5a78)", background: "var(--dsw-alias-bg-base,#f7f9fc)",
            },
            children: "无头像",
          }),
          react_jsx_runtime.jsx("input", {
            ref: fileRef,
            type: "file",
            accept: "image/png,image/jpeg,image/webp",
            style: { display: "none" },
            onChange: onFile,
          }),
          err ? react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary,#e5534b)" }, children: err }) : null,
        ],
      });

      return rowShell("助手头像", react_jsx_runtime.jsx(react.Fragment, { children: [preview, grid, actions] }));
    }

    /** 人设卡编辑：读/写 mind-private\L0\人设卡.md（/api/mind/persona GET+POST），设置里直接填改。 */
    function PersonaEditor() {
      var state = react.useState("");
      var content = state[0];
      var setContent = state[1];
      var statusState = react.useState("idle"); // idle|loading|saving|saved|error
      var status = statusState[0];
      var setStatus = statusState[1];

      react.useEffect(function () {
        fetch("/api/mind/persona").then(function (r) { return r.json(); }).then(function (d) {
          setContent(d && d.ok ? (d.content || "") : "");
        }).catch(function () { setStatus("error"); });
      }, []);

      var save = function () {
        setStatus("saving");
        fetch("/api/mind/persona", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: content || "" }),
        }).then(function (r) { return r.json(); }).then(function () { setStatus("saved"); })
        .catch(function () { setStatus("error"); });
      };

      return rowShell("人设卡（本机私密 · 鱼鱼的专属性格/口癖）", react_jsx_runtime.jsx("div", {
        style: { display: "flex", flexDirection: "column", gap: 8 },
        children: [
          react_jsx_runtime.jsx("textarea", {
            value: content,
            onChange: function (e) { setContent(e.target.value); setStatus("idle"); },
            placeholder: "在这写下鱼鱼的专属性格、口癖、演绎方式……（写给本机，永不推 GitHub；不填=干净通用智能体）",
            rows: 7,
            style: { boxSizing: "border-box", width: "100%", padding: "8px 12px", borderRadius: 9, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base,#f7f9fc)", color: "var(--dsw-alias-label-primary)", fontSize: 13, lineHeight: "20px", outline: "none", resize: "vertical", fontFamily: "inherit" },
          }),
          react_jsx_runtime.jsx("div", { style: { display: "flex", alignItems: "center", gap: 10 }, children: [
            react_jsx_runtime.jsx("button", { type: "button", onClick: save, style: { border: "1px solid var(--dsw-alias-brand-primary,#4D6BFE)", borderRadius: 9, padding: "6px 14px", fontSize: 13, cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base,#f7f9fc)" }, children: "保存人设卡" }),
            status === "saved" ? react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-success-primary,#2fbf8f)" }, children: "已保存" }) : null,
            status === "saving" ? react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,#4a5a78)" }, children: "保存中…" }) : null,
            status === "error" ? react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary,#e5534b)" }, children: "加载/保存失败" }) : null,
          ] }),
          react_jsx_runtime.jsx("span", { style: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary,#4a5a78)", lineHeight: "17px" }, children: "本机私密（mind-private\\L0\\人设卡.md），永不推 GitHub。设了鱼鱼按它演；清空=干净通用智能体。" }),
        ],
      }));
    }

    // ── 插件体 ─────────────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      // 1) 注入器 + 样式
      try { ensureStyle(); startInjector(); } catch (e) { console.warn("dshome-assistant-identity: injector init failed", e); }
      // 2) 通用设置两行
      try {
        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "dshome-assistant-identity-name",
            order: 40,
          }, NameRow);
        });
        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "dshome-assistant-identity-avatar",
            order: 41,
          }, AvatarRow);
        });
        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "dshome-assistant-identity-persona",
            order: 42,
          }, PersonaEditor);
        });
      } catch (e) { console.warn("dshome-assistant-identity: settings rows failed", e); }
    }

    module.exports = { name: "dshome-assistant-identity", inject, apply };
    return module.exports;
  },
});
