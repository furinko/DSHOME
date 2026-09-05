// dshome-mind — 心智体系面板 v2（浏览器 client 模块）。
// 入口：conversation.view 槽位注册两个顶级 view——
//   「心智」(id=mind，图谱 / 待放行 / 整理 / 待办 四个视图)
//   「定时」(id=cron，cron 自治任务管理，独立于心智面板)
// 数据：/api/mind/*（graph/read/pending/curate/cron/todos 等），同源 loopback。
// 渲染：SVG 分层图谱（L0→L3/Project 纵向层带 + related 关联连线），零依赖自绘。
window.__ModuleLoader__.load({
  id: "dshome-mind",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let React = require("react");

    // ── 样式（DSHOME 品牌 + 图谱视觉）────────────────────────────────────────
    var STYLE = [
      ".dshome-mind-root{flex:1;width:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary,#1a2233)}",
      ".dshome-mind-header{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3);flex:none}",
      ".dshome-mind-title{font-size:14px;font-weight:700;letter-spacing:.2px;display:inline-flex;align-items:center;gap:6px}",
      ".dshome-mind-stat{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7a99);margin-left:auto;white-space:nowrap}",
      ".dshome-mind-toolbar{display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3);flex:none;flex-wrap:wrap}",
      ".dshome-mind-search{flex:1;min-width:140px;box-sizing:border-box;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:12px;outline:none}",
      ".dshome-mind-search:focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 0 0 3px rgba(77,107,254,.14)}",
      ".dshome-mind-legend{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-mind-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:3px;vertical-align:-1px}",
      ".dshome-mind-zoom{display:inline-flex;align-items:center;gap:2px}",
      ".dshome-mind-zoom button{width:22px;height:22px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-secondary,#4a5a78);cursor:pointer;font-size:13px;line-height:1}",
      ".dshome-mind-zoom button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08));color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-mind-main{flex:1;min-height:0;display:flex;overflow:hidden;align-items:stretch}",
      ".dshome-mind-graph{flex:1 1 0;min-width:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fbfcfe);position:relative}",
      ".dshome-mind-graph svg{display:block}",
      ".dshome-mind-detail{flex:0 0 350px;width:350px;min-height:0;align-self:stretch;overflow-y:auto;overflow-x:hidden;border-left:1px solid var(--dsw-alias-border-l1,#e3e9f3);padding:10px 14px 18px;background:var(--dsw-alias-bg-layer-1,#fbfcfe);box-sizing:border-box}",
      ".dshome-mind-detail-head{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;margin-bottom:8px;word-break:break-all}",
      ".dshome-mind-detail-close{margin-left:auto;border:none;background:none;color:var(--dsw-alias-label-tertiary,#6b7a99);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}",
      ".dshome-mind-detail-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08))}",
      ".dshome-mind-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}",
      ".dshome-mind-chip{padding:2px 7px;border-radius:99px;font-size:10.5px;background:var(--dsw-alias-border-l1,#e3e9f3);color:var(--dsw-alias-label-secondary,#4a5a78)}",
      ".dshome-mind-chip-tag{padding:2px 7px;border-radius:99px;font-size:10.5px;background:rgba(77,107,254,.1);color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-mind-chip-link{padding:2px 7px;border-radius:99px;font-size:10.5px;background:rgba(47,191,143,.12);color:#1e9e73}",
      ".dshome-mind-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#4a5a78);font-family:Consolas,'Cascadia Mono',monospace}",
      ".dshome-mind-graph{cursor:grab}",
      ".dshome-mind-graph.panning{cursor:grabbing;user-select:none}",
      ".dshome-mind-vswitch{display:inline-flex;gap:2px;background:var(--dsw-alias-border-l1,#e3e9f3);border-radius:9px;padding:2px}",
      ".dshome-mind-vswitch button{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7a99);font-size:11.5px;font-weight:600;padding:4px 11px;border-radius:7px;cursor:pointer;white-space:nowrap}",
      ".dshome-mind-vswitch button.on{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 1px 3px rgba(0,0,0,.1)}",
      ".dshome-mind-gov{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 24px;background:var(--dsw-alias-bg-layer-1,#fbfcfe)}",
      ".dshome-mind-gov-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,#6b7a99);margin:2px 2px 12px}",
      ".dshome-mind-gov-card{border:1px solid var(--dsw-alias-border-l1,#e3e9f3);border-radius:11px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2,#fff)}",
      ".dshome-mind-gov-card .dshome-mind-chips{margin-bottom:0}",
      ".dshome-mind-gov-name{font-size:13px;font-weight:600;margin-bottom:6px;word-break:break-all}",
      ".dshome-mind-gov-reason{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#b8860b);margin:3px 0}",
      ".dshome-mind-gov-actions{display:flex;gap:8px;margin-top:8px}",
      ".dshome-mind-gov-ok{padding:4px 13px;border-radius:8px;border:none;background:rgba(47,191,143,.16);color:#1e9e73;font-size:12px;font-weight:600;cursor:pointer}",
      ".dshome-mind-gov-no{padding:4px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:transparent;color:var(--dsw-alias-label-tertiary,#6b7a99);font-size:12px;cursor:pointer}",
      ".dshome-mind-gov-arch{padding:4px 13px;border-radius:8px;border:none;background:rgba(240,180,41,.18);color:#b8860b;font-size:12px;font-weight:600;cursor:pointer}",
      ".dshome-mind-gov-ok:hover,.dshome-mind-gov-arch:hover{filter:brightness(.97)}",
      ".dshome-mind-empty{padding:30px 14px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-mind-graph-node{cursor:pointer}",
      ".dshome-mind-graph-node text{user-select:none}",
      ".dshome-mind-graph-node.sel>rect:first-of-type{stroke:var(--dsw-alias-brand-primary,#4D6BFE);stroke-width:2;stroke-dasharray:none}",
      ".dshome-mind-graph-node.hovered>rect:first-of-type{stroke:#4D6BFE;stroke-width:2.2;stroke-dasharray:none}",
      ".dshome-mind-graph-node.hovered{filter:drop-shadow(0 1px 6px rgba(77,107,254,.45))}",
      // ── 添加定时任务表单（标签 + 控件对齐）─────────────────────────────
      ".dshome-mind-cron-head{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#1a2233);margin:0 0 12px}",
      ".dshome-mind-cron-row{display:flex;align-items:center;gap:10px;margin-bottom:11px}",
      ".dshome-mind-cron-label{flex:0 0 58px;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99);text-align:right;white-space:nowrap;line-height:1.2}",
      ".dshome-mind-cron-ctrl{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0;flex:1}",
      ".dshome-mind-cron-ctrl select,.dshome-mind-cron-ctrl input:not([type=checkbox]){height:30px;box-sizing:border-box;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:12.5px;outline:none;vertical-align:middle}",
      ".dshome-mind-cron-ctrl select:focus,.dshome-mind-cron-ctrl input:not([type=checkbox]):focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 0 0 3px rgba(77,107,254,.14)}",
      ".dshome-mind-cron-ctrl select{flex:0 1 auto;max-width:230px}",
      ".dshome-mind-cron-ctrl input:not([type=number]):not([type=checkbox]){flex:1;min-width:60px}",
      ".dshome-mind-cron-ctrl input[type=number]{flex:0 0 72px}",
      ".dshome-mind-cron-ctrl input[type=date]{flex:0 0 auto;min-width:126px}",
      ".dshome-mind-cron-check{width:15px;height:15px;flex:0 0 15px;accent-color:var(--dsw-alias-brand-primary,#4D6BFE);cursor:pointer}",
      ".dshome-mind-cron-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-mind-cron-sep{color:var(--dsw-alias-label-tertiary,#6b7a99);font-size:12.5px;white-space:nowrap}",
      ".dshome-mind-cron-preview{font-size:11px;color:var(--dsw-alias-state-warn-primary,#b8860b);margin:0 0 12px 68px}",
      ".dshome-mind-cron-foot{display:flex;justify-content:flex-end;margin-top:2px}",
    ].join("");

    function ensureStyle() {
      if (document.getElementById("dshome-mind-style")) return;
      var s = document.createElement("style");
      s.id = "dshome-mind-style";
      s.textContent = STYLE;
      document.head.appendChild(s);
    }

    function el(tag, cls, html) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html !== undefined) e.textContent = html;
      return e;
    }
    function svgEl(tag, attrs) {
      var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    // ── frontmatter 轻解析（chips 用）────────────────────────────────────────
    function parseFrontmatter(text) {
      var meta = {};
      var m = /^---\n([\s\S]*?)\n---/.exec(text);
      if (m) {
        m[1].split("\n").forEach(function (line) {
          var i = line.indexOf(":");
          if (i <= 0) return;
          var k = line.slice(0, i).trim();
          var v = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "").slice(0, 120);
          if (k === "name" || k === "version" || k === "author" || k === "license" || k === "description") meta[k] = v;
        });
        var tags = /^[ \t]*tags:\s*\[([^\]]*)\]/m.exec(m[1]);
        if (tags) meta.tags = tags[1].split(",").map(function (t) { return t.trim().replace(/['"\[\]]/g, ""); }).filter(Boolean);
        var related = /^[ \t]*related:\s*\[([^\]]*)\]/m.exec(m[1]);
        if (related) meta.related = related[1].split(",").map(function (t) { return t.trim().replace(/['"\[\]]/g, ""); }).filter(Boolean);
      }
      return meta;
    }

    // ── 详情侧栏 ─────────────────────────────────────────────────────────────
    function openDetail(zone, rel) {
      var panel = document.querySelector(".dshome-mind-detail");
      if (!panel) return;
      panel.innerHTML = "";
      panel.appendChild(el("div", "dshome-mind-empty", "读取中…"));
      fetch("/api/mind/read?zone=" + zone + "&rel=" + encodeURIComponent(rel))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) throw new Error(d.error);
          panel.innerHTML = "";
          var head = el("div", "dshome-mind-detail-head");
          var tag = document.createElement("span");
          tag.textContent = zone === "private" ? "🔒" : "📄";
          head.appendChild(tag);
          head.appendChild(document.createTextNode(d.rel));
          var close = el("button", "dshome-mind-detail-close", "✕");
          close.addEventListener("click", function () {
            panel.innerHTML = "";
            panel.appendChild(el("div", "dshome-mind-empty", "点击图谱节点查看内容"));
            var sel = document.querySelectorAll(".dshome-mind-graph-node.sel");
            for (var i = 0; i < sel.length; i++) sel[i].classList.remove("sel");
          });
          head.appendChild(close);
          panel.appendChild(head);
          var meta = parseFrontmatter(d.content);
          var chips = el("div", "dshome-mind-chips");
          ["name", "version", "author", "license"].forEach(function (k) {
            if (meta[k]) chips.appendChild(el("span", "dshome-mind-chip", k + ": " + meta[k]));
          });
          if (meta.description) chips.appendChild(el("span", "dshome-mind-chip", meta.description));
          (meta.tags || []).forEach(function (t) { chips.appendChild(el("span", "dshome-mind-chip-tag", "#" + t)); });
          (meta.related || []).forEach(function (t) { chips.appendChild(el("span", "dshome-mind-chip-link", "🔗 " + t)); });
          if (chips.childNodes.length) panel.appendChild(chips);
          var bodyText = d.content.replace(/^---\n[\s\S]*?\n---\n?/, "");
          panel.appendChild(el("pre", "dshome-mind-pre", bodyText));
        })
        .catch(function (e) {
          panel.innerHTML = "";
          panel.appendChild(el("div", "dshome-mind-empty", "⚠️ 读取失败: " + e));
        });
    }

    // ── 治理视图：待放行 / 剪枝候选 ───────────────────────────────────────────
    function postJSON(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
    }
    function govChips(parts) {
      var c = el("div", "dshome-mind-chips");
      parts.forEach(function (p) { if (p) c.appendChild(el("span", "dshome-mind-chip", p)); });
      return c;
    }
    function renderApproval(govEl, reload) {
      govEl.innerHTML = "";
      govEl.appendChild(el("div", "dshome-mind-gov-head", "🛡 放行 — 自我类「高危规则/宪法/门禁」改动，你放行后才生效（护栏真拦，凭此记录）"));
      fetch("/api/mind/approvals").then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error);
        var items = d.items || [];
        var pending = items.filter(function (x) { return x.status === "pending"; });
        var decided = items.filter(function (x) { return x.status !== "pending"; });

        // 栏1：待裁决
        govEl.appendChild(el("div", "dshome-mind-gov-head", "⏳ 待裁决（护栏拦截待你放行）"));
        if (!pending.length) {
          govEl.appendChild(el("div", "dshome-mind-empty", "🎉 没有待裁决的动作"));
        }
        pending.forEach(function (it) {
          var card = el("div", "dshome-mind-gov-card");
          // chips 只放类别/路径（concise 摘要）；完整"为什么改"用下面的 reason 行，放行前就能看到。
          card.appendChild(govChips([
            "action/" + (it.op || "edit"),
            it.path || "",
          ]));
          var pre = el("pre", "dshome-mind-pre", "路径: " + (it.path || "") + "  操作: " + (it.op || "edit"));
          pre.style.margin = "8px 0 2px";
          card.appendChild(pre);
          if (it.reason) {
            var pendingLab = el("div", "dshome-mind-gov-reason", it.reason);
            pendingLab.style.margin = "2px 0 6px";
            card.appendChild(pendingLab);
          }
          var row = el("div", "dshome-mind-gov-actions");
          var ok = el("button", "dshome-mind-gov-ok", "✓ 放行");
          var no = el("button", "dshome-mind-gov-no", "✗ 拒绝");
          row.appendChild(ok); row.appendChild(no);
          card.appendChild(row);
          govEl.appendChild(card);
          ok.addEventListener("click", function () {
            postJSON("/api/mind/approvals/decide", { id: it.id, decision: "approved" }).then(function () { reload(); });
          });
          no.addEventListener("click", function () {
            postJSON("/api/mind/approvals/decide", { id: it.id, decision: "denied" }).then(function () { reload(); });
          });
        });

        // 栏2：已裁决（可撤销）
        if (decided.length) {
          govEl.appendChild(el("div", "dshome-mind-gov-head", "✅ 已裁决"));
          decided.forEach(function (it) {
            var card = el("div", "dshome-mind-gov-card");
            card.appendChild(govChips([
              it.status === "approved" ? "已放行" : "已拒绝",
              it.path || "",
              it.op || "edit",
            ]));
            if (it.reason) {
              var lab = el("div", "dshome-mind-gov-reason", it.reason);
              lab.style.margin = "2px 0 6px";
              card.appendChild(lab);
            }
            var row = el("div", "dshome-mind-gov-actions");
            if (it.status === "approved") {
              var revoke = el("button", "dshome-mind-gov-arch", "↺ 撤销");
              row.appendChild(revoke);
              revoke.addEventListener("click", function () {
                postJSON("/api/mind/approvals/revoke", { id: it.id }).then(function () { reload(); });
              });
            }
            card.appendChild(row);
            govEl.appendChild(card);
          });
        }
      }).catch(function (e) {
        govEl.appendChild(el("div", "dshome-mind-empty", "⚠️ " + (e.message || e)));
      });
    }
    function renderTodos(govEl, reload) {
      govEl.innerHTML = "";
      govEl.appendChild(el("div", "dshome-mind-gov-head", "📋 待办 — project.md「下一步」清单（自主巡检发现的问题也入这）"));
      fetch("/api/mind/todos").then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error);
        if (!d.todos || !d.todos.length) govEl.appendChild(el("div", "dshome-mind-empty", "🎉 没有待办"));
        (d.todos || []).forEach(function (t, i) {
          var card = el("div", "dshome-mind-gov-card");
          var row = el("div", "dshome-mind-gov-actions");
          var cb = el("input"); cb.type = "checkbox"; cb.checked = !!t.done;
          var label = el("span", null, (t.done ? "✅ " : "⬜ ") + t.text);
          var del = el("button", "dshome-mind-gov-no", "🗑");
          row.appendChild(cb); row.appendChild(label); row.appendChild(del);
          card.appendChild(row); govEl.appendChild(card);
          cb.addEventListener("change", function () { postJSON("/api/mind/todos/toggle", { index: i }).then(function () { reload(); }); });
          del.addEventListener("click", function () { if (window.confirm("删除这条待办？")) postJSON("/api/mind/todos/remove", { index: i }).then(function () { reload(); }); });
        });
        var add = el("div", "dshome-mind-gov-card");
        add.appendChild(el("div", "dshome-mind-gov-name", "➕ 添加待办"));
        var inp = el("input", "dshome-mind-search"); inp.placeholder = "新待办内容";
        var addBtn = el("button", "dshome-mind-gov-ok", "➕ 添加");
        add.appendChild(inp); add.appendChild(addBtn); govEl.appendChild(add);
        addBtn.addEventListener("click", function () { if (!inp.value.trim()) return; postJSON("/api/mind/todos/add", { text: inp.value.trim() }).then(function () { reload(); }); });
      }).catch(function (e) { govEl.appendChild(el("div", "dshome-mind-empty", "⚠️ " + (e.message || e))); });
    }

    function renderCron(govEl, reload) {
      govEl.innerHTML = "";
      govEl.appendChild(el("div", "dshome-mind-gov-head", "⏰ 定时任务 — cron 自治：到点自动拉起 agent 会话执行。对话里说『每天 9 点做 X』我帮你加"));
      fetch("/api/mind/cron").then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error);
        if (!d.tasks || !d.tasks.length) {
          govEl.appendChild(el("div", "dshome-mind-empty", "暂无定时任务"));
        }
        (d.tasks || []).forEach(function (t) {
          var card = el("div", "dshome-mind-gov-card");
          card.appendChild(el("div", "dshome-mind-gov-name", "⏱ " + t.id + " · " + t.cron + " · " + (t.preset || "standard") + (t.once ? " · 单次" : "") + (t.enabled ? "" : "（已停用）")));
          card.appendChild(el("div", "dshome-mind-gov-reason", (t.prompt || "").slice(0, 140)));
          card.appendChild(el("div", "dshome-mind-gov-reason", t.nextRun ? "下次: " + t.nextRun.replace("T", " ").slice(0, 16) : "（无下次）"));
          var row = el("div", "dshome-mind-gov-actions");
          var run = el("button", "dshome-mind-gov-ok", "▶ 立即运行");
          var tg = el("button", "dshome-mind-gov-arch", t.enabled ? "⏸ 停用" : "▶ 启用");
          var edit = el("button", "dshome-mind-gov-arch", "✏️ 编辑");
          var del = el("button", "dshome-mind-gov-no", "🗑 删除");
          row.appendChild(run); row.appendChild(tg); row.appendChild(edit); row.appendChild(del); card.appendChild(row);
          var editZone = el("div");
          card.appendChild(editZone);
          govEl.appendChild(card);
          run.addEventListener("click", function () {
            postJSON("/api/mind/cron/run", { id: t.id }).then(function (r) {
              window.alert(r && r.ok ? ("✅ 已触发执行，session=" + (r.sessionId || "?")) : ("⚠️ 触发失败：" + ((r && r.error) || "未知")));
            });
          });
          tg.addEventListener("click", function () { postJSON("/api/mind/cron/toggle", { id: t.id }).then(function () { reload(); }); });
          edit.addEventListener("click", function () {
            editZone.innerHTML = "";
            var ec = el("div", "dshome-mind-gov-card");
            cronForm(ec, {
              title: "编辑任务 · " + t.id, submitLabel: "💾 保存", reload: reload,
              initial: { cron: t.cron, prompt: t.prompt, preset: t.preset, once: !!t.once },
              onSubmit: function (data) { postJSON("/api/mind/cron/update", { id: t.id, cron: data.cron, prompt: data.prompt, preset: data.preset, once: data.once }).then(function () { reload(); }); }
            });
            var cancel = el("button", "dshome-mind-gov-no", "✖ 取消编辑");
            cancel.style.marginTop = "6px";
            ec.appendChild(cancel);
            editZone.appendChild(ec);
            cancel.addEventListener("click", function () { editZone.innerHTML = ""; });
          });
          del.addEventListener("click", function () { if (window.confirm("删除定时任务 " + t.id + "？")) postJSON("/api/mind/cron/remove", { id: t.id }).then(function () { reload(); }); });
        });
        // 添加区：频率下拉 + 时间选择自动生成 cron（保留自定义 cron 兜底）
        var add = el("div", "dshome-mind-gov-card");
        cronForm(add, {
          title: "添加定时任务", submitLabel: "➕ 添加", reload: reload,
          onSubmit: function (data) { postJSON("/api/mind/cron/add", data).then(function () { reload(); }); }
        });
        govEl.appendChild(add);
      }).catch(function (e) {
        govEl.appendChild(el("div", "dshome-mind-empty", "⚠️ " + (e.message || e)));
      });
    }

    // ── 添加定时任务：友好下拉构建 cron（免手写五字段）──────────────────────────
    function mkIntSelect(min, max, pad) {
      var s = document.createElement("select");
      for (var i = min; i <= max; i++) {
        var o = document.createElement("option");
        o.value = String(i);
        o.textContent = pad && i < 10 ? "0" + i : String(i);
        s.appendChild(o);
      }
      return s;
    }
    function mkWeekSelect() {
      var s = document.createElement("select");
      var names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      for (var i = 0; i < 7; i++) {
        var o = document.createElement("option");
        o.value = String(i); o.textContent = names[i]; s.appendChild(o);
      }
      return s;
    }
    // ── cron 五字段反解析（编辑时回填频率/时间；解析失败回退自定义）─────────────
    function parseCron(str) {
      var p = String(str || '').trim().split(/\s+/);
      if (p.length !== 5) return null;
      var m = p[0], h = p[1], d = p[2], mo = p[3], w = p[4];
      var num = /^\d+$/;
      if (/^\*\/(\d+)$/.test(m) && h === '*' && d === '*' && mo === '*' && w === '*') return { freq: 'interval', n: +RegExp.$1 };
      if (num.test(m) && h === '*' && d === '*' && mo === '*' && w === '*') return { freq: 'hourly', m: +m };
      if (num.test(m) && num.test(h) && d === '*' && mo === '*' && w === '*') return { freq: 'daily', m: +m, h: +h };
      if (num.test(m) && num.test(h) && num.test(w) && d === '*' && mo === '*') return { freq: 'weekly', m: +m, h: +h, w: +w };
      if (num.test(m) && num.test(h) && num.test(d) && mo === '*' && w === '*') return { freq: 'monthly', m: +m, h: +h, d: +d };
      if (num.test(m) && num.test(h) && num.test(d) && num.test(mo) && w === '*') return { freq: 'once', m: +m, h: +h, d: +d, mo: +mo };
      return null;
    }
    // ── 添加/编辑定时任务共用的表单（opts: title/submitLabel/reload/initial/onSubmit）─
    function cronForm(add, opts) {
      opts = opts || {};
      var reload = opts.reload || function () {};
      var initial = opts.initial || null;
      var parsed = (initial && initial.cron) ? parseCron(initial.cron) : null;
      var initFreq = parsed ? parsed.freq : (initial ? 'custom' : 'daily');

      add.appendChild(el("div", "dshome-mind-cron-head", opts.title || "➕ 添加定时任务"));

      // 触发行：频率 + 动态时间并排（同一 flex 行，平级不嵌套，不会换行散开）
      var row1 = el("div", "dshome-mind-cron-row");
      row1.appendChild(el("div", "dshome-mind-cron-label", "⏱ 触发"));
      var ctrl1 = el("div", "dshome-mind-cron-ctrl");
      var freq = document.createElement("select");
      [["daily", "每天"], ["weekly", "每周"], ["monthly", "每月"], ["once", "单次"], ["hourly", "每小时"], ["interval", "每 N 分钟"], ["custom", "自定义 cron"]].forEach(function (p) {
        var o = document.createElement("option"); o.value = p[0]; o.textContent = p[1]; freq.appendChild(o);
      });
      freq.value = initFreq;
      ctrl1.appendChild(freq);
      row1.appendChild(ctrl1);
      add.appendChild(row1);

      // 任务行
      var row2 = el("div", "dshome-mind-cron-row");
      row2.appendChild(el("div", "dshome-mind-cron-label", "📋 任务"));
      var ctrl2 = el("div", "dshome-mind-cron-ctrl");
      var inpPrompt = el("input", "dshome-mind-cron-text");
      inpPrompt.placeholder = "到点执行的内容（给鱼鱼的指令）";
      if (initial && initial.prompt) inpPrompt.value = initial.prompt;
      ctrl2.appendChild(inpPrompt);
      row2.appendChild(ctrl2);
      add.appendChild(row2);

      // 类型行
      var row3 = el("div", "dshome-mind-cron-row");
      row3.appendChild(el("div", "dshome-mind-cron-label", "🧩 类型"));
      var ctrl3 = el("div", "dshome-mind-cron-ctrl");
      var inpPreset = document.createElement("select");
      [["standard", "标准模式（全量工具 · 推荐）"], ["router-standard", "Router Standard · 阶段化 + 门禁"], ["code", "PTC 模式"], ["minimal", "极简模式"], ["cordis", "创造模式"]].forEach(function (p) {
        var o = document.createElement("option"); o.value = p[0]; o.textContent = p[1]; inpPreset.appendChild(o);
      });
      if (initial && initial.preset) inpPreset.value = initial.preset;
      ctrl3.appendChild(inpPreset);
      row3.appendChild(ctrl3);
      add.appendChild(row3);

      // 只跑一次开关（对周期型也生效）
      var rowOnce = el("div", "dshome-mind-cron-row");
      rowOnce.appendChild(el("div", "dshome-mind-cron-label", "⚡ 只跑一次"));
      var ctrlOnce = el("div", "dshome-mind-cron-ctrl");
      var onceChk = document.createElement("input");
      onceChk.type = "checkbox"; onceChk.className = "dshome-mind-cron-check";
      if (initial && initial.once) onceChk.checked = true;
      ctrlOnce.appendChild(onceChk);
      ctrlOnce.appendChild(el("span", "dshome-mind-cron-hint", "到点执行一次后自动移除（周期型也能勾）"));
      rowOnce.appendChild(ctrlOnce);
      add.appendChild(rowOnce);

      // cron 预览
      var cronOut = el("div", "dshome-mind-cron-preview");
      add.appendChild(cronOut);

      // 提交脚
      var foot = el("div", "dshome-mind-cron-foot");
      var addBtn = el("button", "dshome-mind-gov-ok", opts.submitLabel || "➕ 添加");
      foot.appendChild(addBtn);
      add.appendChild(foot);

      var curCron = (initial && initial.cron) ? initial.cron : "0 0 * * *";
      function show() { cronOut.textContent = "cron → " + curCron; }
      function sep(t) { return el("span", "dshome-mind-cron-sep", t); }
      function refresh() {
        // 只清空频率之后的动态时间控件（保留频率在下拉首位，平级并排）
        while (ctrl1.lastChild && ctrl1.lastChild !== freq) ctrl1.removeChild(ctrl1.lastChild);
        var f = freq.value;
        var compute;
        function setSel(sel, val) { if (val !== undefined && val !== null) sel.value = String(val); }
        if (f === "daily") {
          var h = mkIntSelect(0, 23, true); var m = mkIntSelect(0, 59, true);
          if (parsed && parsed.freq === "daily") { setSel(h, parsed.h); setSel(m, parsed.m); }
          ctrl1.appendChild(h); ctrl1.appendChild(sep(":")); ctrl1.appendChild(m);
          compute = function () { return m.value + " " + h.value + " * * *"; };
        } else if (f === "weekly") {
          var wd = mkWeekSelect(); var h = mkIntSelect(0, 23, true); var m = mkIntSelect(0, 59, true);
          if (parsed && parsed.freq === "weekly") { setSel(wd, parsed.w); setSel(h, parsed.h); setSel(m, parsed.m); }
          ctrl1.appendChild(wd); ctrl1.appendChild(sep(" · ")); ctrl1.appendChild(h); ctrl1.appendChild(sep(":")); ctrl1.appendChild(m);
          compute = function () { return m.value + " " + h.value + " * * " + wd.value; };
        } else if (f === "monthly") {
          var dd = mkIntSelect(1, 31, false); var h = mkIntSelect(0, 23, true); var m = mkIntSelect(0, 59, true);
          if (parsed && parsed.freq === "monthly") { setSel(dd, parsed.d); setSel(h, parsed.h); setSel(m, parsed.m); }
          ctrl1.appendChild(dd); ctrl1.appendChild(sep("日 · ")); ctrl1.appendChild(h); ctrl1.appendChild(sep(":")); ctrl1.appendChild(m);
          compute = function () { return m.value + " " + h.value + " " + dd.value + " * *"; };
        } else if (f === "once") {
          var d = el("input");
          d.type = "date"; d.className = "dshome-mind-cron-date";
          var dt = new Date();
          if (parsed && parsed.freq === "once") {
            var pad2 = function (x) { return (x < 10 ? "0" : "") + x; };
            d.value = dt.getFullYear() + "-" + pad2(parsed.mo) + "-" + pad2(parsed.d);
          } else {
            dt.setDate(dt.getDate() + 1); // 默认明天
            d.value = dt.toISOString().slice(0, 10);
          }
          var h = mkIntSelect(0, 23, true); var m = mkIntSelect(0, 59, true);
          if (parsed && parsed.freq === "once") { setSel(h, parsed.h); setSel(m, parsed.m); }
          ctrl1.appendChild(d); ctrl1.appendChild(h); ctrl1.appendChild(sep(":")); ctrl1.appendChild(m);
          compute = function () {
            var mo, da;
            if (d.value) { var p = d.value.split("-"); mo = parseInt(p[1], 10); da = parseInt(p[2], 10); }
            if (!mo || !da) { var now = new Date(); now.setDate(now.getDate() + 1); mo = now.getMonth() + 1; da = now.getDate(); }
            return m.value + " " + h.value + " " + da + " " + mo + " *";
          };
        } else if (f === "hourly") {
          var m = mkIntSelect(0, 59, true);
          if (parsed && parsed.freq === "hourly") setSel(m, parsed.m);
          ctrl1.appendChild(sep("每时第 ")); ctrl1.appendChild(m); ctrl1.appendChild(sep(" 分"));
          compute = function () { return m.value + " * * * *"; };
        } else if (f === "interval") {
          var n = el("input");
          n.type = "number"; n.min = 1; n.max = 59; n.value = "5";
          if (parsed && parsed.freq === "interval") n.value = String(parsed.n);
          ctrl1.appendChild(n); ctrl1.appendChild(sep("分钟一次"));
          compute = function () { var v = parseInt(n.value, 10); if (!v || v < 1) v = 1; return "*/" + v + " * * * *"; };
        } else {
          var c = el("input", "dshome-mind-cron-text");
          c.placeholder = "cron 五字段（如 0 9 * * *）";
          c.value = (initial && initial.cron) ? initial.cron : curCron;
          ctrl1.appendChild(c);
          compute = function () { return c.value.trim(); };
        }
        var els = Array.prototype.slice.call(ctrl1.children).filter(function (x) {
          return x !== freq && (x.tagName === "SELECT" || x.tagName === "INPUT");
        });
        var recalc = function () { curCron = compute(); show(); };
        els.forEach(function (x) { x.addEventListener("change", recalc); x.addEventListener("input", recalc); });
        recalc();
      }
      freq.addEventListener("change", refresh);
      refresh();

      addBtn.addEventListener("click", function () {
        var cron = curCron.trim();
        if (!cron || !inpPrompt.value.trim()) return;
        opts.onSubmit({ cron: cron, prompt: inpPrompt.value.trim(), preset: inpPreset.value, once: freq.value === "once" || onceChk.checked });
      });
    }

    function renderCurate(govEl, reload) {
      govEl.innerHTML = "";
      var head = el("div", "dshome-mind-gov-head", "🧹 剪枝建议 — 扫描 L3 的膨胀候选");
      head.appendChild(el("div", "dshome-mind-gov-reason", "操作说明：归档=移入 history（可找回）；保留=以后不再提示；合并/蒸馏/改写等内容级处理→在对话里告诉鱼鱼来做"));
      govEl.appendChild(head);
      fetch("/api/mind/curate").then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error);
        if (!d.items || !d.items.length) {
          govEl.appendChild(el("div", "dshome-mind-empty", "🧹 L3 很干净，暂无剪枝候选"));
          return;
        }
        d.items.forEach(function (it) {
          var card = el("div", "dshome-mind-gov-card");
          var nm = el("div", "dshome-mind-gov-name", "📄 " + it.name + " · " + it.rel);
          card.appendChild(nm);
          it.reasons.forEach(function (r) {
            card.appendChild(el("div", "dshome-mind-gov-reason", "⚠️ " + r.hint));
          });
          if (it.assigned) {
            card.appendChild(el("div", "dshome-mind-gov-reason", "🤝 已交给鱼鱼处理中（收工时处理，完成后汇报）"));
            govEl.appendChild(card);
            return;
          }
          var row = el("div", "dshome-mind-gov-actions");
          var task = el("button", "dshome-mind-gov-ok", "🤝 让鱼鱼处理");
          var keep = el("button", "dshome-mind-gov-no", "⏭ 保留（不再提示）");
          var arc = el("button", "dshome-mind-gov-arch", "🗄 归档 → history");
          row.appendChild(task);
          row.appendChild(keep);
          row.appendChild(arc);
          card.appendChild(row);
          govEl.appendChild(card);
          task.addEventListener("click", function () {
            postJSON("/api/mind/curate/assign", { file: it.file }).then(function (r) { reload(); });
          });
          keep.addEventListener("click", function () {
            postJSON("/api/mind/curate/keep", { file: it.file }).then(function (r) { reload(); });
          });
          arc.addEventListener("click", function () {
            // 整文件归档是重操作：先确认（误归档可经 history 找回，但避免手滑）
            if (!window.confirm("把整个文件「" + it.name + "」移入 history 归档？\n（不删只移，可手动移回）")) return;
            postJSON("/api/mind/curate/archive", { file: it.file }).then(function (r) {
              var tip = el("div", "dshome-mind-gov-reason", r && r.ok ? "✅ 已归档 → " + r.movedTo + "（history 可找回）" : "⚠️ 归档失败");
              govEl.insertBefore(tip, govEl.firstChild.nextSibling);
              setTimeout(function () { reload(); }, 600);
            });
          });
        });
      }).catch(function (e) {
        govEl.appendChild(el("div", "dshome-mind-empty", "⚠️ " + (e.message || e)));
      });
    }

    // ── 图谱布局 + SVG ───────────────────────────────────────────────────────
    var LAYER_ORDER = [
      { id: "L0", label: "L0 宪法", color: "#8b5cf6" },
      { id: "L1", label: "L1 法律", color: "#4D6BFE" },
      { id: "L2S", label: "L2 技能", color: "#10b981" },
      { id: "L2E", label: "L2 经验", color: "#14b8a6" },
      { id: "L3I", label: "L3 记忆", color: "#f97316" },
      { id: "L3H", label: "L3 历史", color: "#f59e0b" },
      { id: "PJ", label: "Project", color: "#ef4444" },
      { id: "TR", label: "TRASH", color: "#64748b" },
      { id: "TK", label: "任务缓冲", color: "#ec4899" },
    ];
    var CANVAS_W = 1240;
    var NODE_H = 36;
    var LINE_H = 17;
    var MAX_NODE_W = 230;
    var ROW_GAP = 46;
    var LAYER_GAP = 34;
    var LAYER_TITLE_H = 34;
    var SIDE_PAD = 24;

    // 精确测宽（canvas，匹配 SVG 文字字体，防中英文混合溢出）
    var textCtx = null;
    function textWidth(s) {
      if (!textCtx) {
        var cv = document.createElement("canvas");
        textCtx = cv.getContext("2d");
        textCtx.font = "12.5px system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
      }
      return textCtx.measureText(String(s)).width;
    }

    function nodeWidth(label) {
      return Math.max(120, Math.min(MAX_NODE_W, 34 + textWidth(label) + 28));
    }

    // 按可用宽断行（canvas 测宽，中英文混排安全）
    function splitLines(text, maxW) {
      var lines = [];
      var cur = "";
      var chars = Array.from(String(text));
      for (var i = 0; i < chars.length; i++) {
        var test = cur + chars[i];
        if (textWidth(test) > maxW && cur !== "") { lines.push(cur); cur = chars[i]; }
        else cur = test;
      }
      if (cur !== "") lines.push(cur);
      return lines.length ? lines : [String(text)];
    }

    function layoutGraph(nodes) {
      // layer -> nodes（同层排序：factory 先、private 后，各自按名）
      var byLayer = {};
      nodes.forEach(function (n) {
        (byLayer[n.layer] = byLayer[n.layer] || []).push(n);
      });
      var pos = {};
      var maxRight = 0;
      var yCursor = 20;
      var layerRects = [];
      LAYER_ORDER.forEach(function (lay) {
        var list = byLayer[lay.id] || [];
        if (!list.length) return;
        list.sort(function (a, b) {
          if (a.zone !== b.zone) return a.zone === "factory" ? -1 : 1;
          return a.label.localeCompare(b.label, "zh");
        });
        var titleTop = yCursor;
        yCursor += LAYER_TITLE_H;
        var x = SIDE_PAD;
        var lineBottom = yCursor;
        list.forEach(function (n) {
          var textPad = (n.zone === "private" ? 30 : 14) + 8;
          var w = Math.min(MAX_NODE_W, nodeWidth(n.label));
          var availText = w - textPad - 4;
          var lines = textWidth(n.label) > availText ? splitLines(n.label, availText) : [n.label];
          var h = lines.length > 1 ? 12 + lines.length * LINE_H : NODE_H;
          if (x + w > CANVAS_W - SIDE_PAD) { x = SIDE_PAD; yCursor = lineBottom + 12; }
          pos[n.id] = { x: x, y: yCursor, w: w, h: h, lines: lines, tx: textPad - 8 };
          lineBottom = Math.max(lineBottom, yCursor + h);
          maxRight = Math.max(maxRight, x + w);
          x += w + 14;
        });
        yCursor = lineBottom + LAYER_GAP;
        layerRects.push({ top: titleTop, bottom: lineBottom + 8, color: lay.color, label: lay.label });
      });
      return { pos, width: Math.max(CANVAS_W, maxRight + SIDE_PAD), height: yCursor + 10, layerRects };
    }

    function renderGraph(graph, mountEl, onPick, state) {
      var laid = layoutGraph(graph.nodes);
      state.pos = laid.pos;
      var svg = svgEl("svg", { xmlns: "http://www.w3.org/2000/svg", width: laid.width, height: laid.height, style: "min-width:" + laid.width + "px" });
      mountEl.innerHTML = "";
      mountEl.appendChild(svg);

      // 层带背景
      laid.layerRects.forEach(function (lr) {
        svg.appendChild(svgEl("rect", {
          x: 8, y: lr.top - 8, width: laid.width - 16, height: lr.bottom - lr.top + 8,
          rx: 12, fill: lr.color, "fill-opacity": "0.05",
        }));
        var lt = svgEl("text", { x: 18, y: lr.top + 6, "font-size": 12, "font-weight": 700, fill: lr.color });
        lt.textContent = lr.label;
        svg.appendChild(lt);
        svg.appendChild(svgEl("circle", { cx: laid.width - 22, cy: lr.top + 1, r: 3, fill: lr.color, opacity: 0.4 }));
      });

      var nodeById = {};
      graph.nodes.forEach(function (n) { nodeById[n.id] = n; });

      // 边（贝塞尔，画在节点下层）
      var edgeById = {};
      graph.edges.forEach(function (e, idx) {
        var a = laid.pos[e.source], b = laid.pos[e.target];
        if (!a || !b) return;
        var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
        var bx = b.x + b.w / 2, by = b.y + b.h / 2;
        var my = (ay + by) / 2;
        var d = "M " + ax + " " + ay + " C " + ax + " " + my + ", " + bx + " " + my + ", " + bx + " " + by;
        var path = svgEl("path", {
          d, fill: "none", stroke: "#10b981", "stroke-width": 1.4,
          "stroke-opacity": "0.4", "data-edge": "1",
        });
        edgeById[idx] = path;
        svg.appendChild(path);
      });

      // 节点
      var nodeEls = {};
      graph.nodes.forEach(function (n) {
        var p = laid.pos[n.id];
        var g = svgEl("g", { class: "dshome-mind-graph-node", transform: "translate(" + p.x + "," + p.y + ")" });
        var priv = n.zone === "private";
        // 卡片底
        g.appendChild(svgEl("rect", {
          x: 0, y: 0, width: p.w, height: p.h, rx: 9,
          fill: priv ? n.color + "1f" : "var(--dsw-alias-bg-layer-2,#ffffff)",
          stroke: priv ? n.color : "var(--dsw-alias-border-l2,#d3dcea)",
          "stroke-width": priv ? 1.1 : 1,
          "stroke-dasharray": priv ? "4 3" : "none",
        }));
        // 左侧色条
        g.appendChild(svgEl("rect", { x: 0, y: 7, width: 4, height: p.h - 14, rx: 2, fill: n.color }));
        // 私有锁标
        var tx = 14;
        if (priv) {
          var lock = svgEl("text", { x: 12, y: 23, "font-size": 11 });
          lock.textContent = "🔒";
          g.appendChild(lock);
          tx = 30;
        }
        // 标签：文字自适应——单行/多行换行完整显示（不截断省略）
        var lines = p.lines || [n.label];
        var baseY = lines.length === 1 ? 23 : (p.h - lines.length * LINE_H) / 2 + 13;
        var t = svgEl("text", { "font-size": 12.5, fill: "var(--dsw-alias-label-primary,#1a2233)" });
        for (var li = 0; li < lines.length; li++) {
          var ts = svgEl("tspan", { x: p.tx, dy: li === 0 ? 0 : LINE_H });
          ts.textContent = lines[li];
          t.appendChild(ts);
        }
        t.setAttribute("y", baseY);
        g.appendChild(t);
        g.appendChild(t);
        g.appendChild(svgEl("title", null)).textContent = (priv ? "🔒 " : "") + n.rel;
        g.addEventListener("click", function () {
          var sel = svg.querySelectorAll("g.sel");
          for (var i = 0; i < sel.length; i++) sel[i].classList.remove("sel");
          g.classList.add("sel");
          onPick(n);
        });
        nodeEls[n.id] = g;
        svg.appendChild(g);
      });

      state.nodeEls = nodeEls;
      state.edgeById = edgeById;
      state.svg = svg;

      // 悬停：强调当前节点（描边+光晕）+ 关联边加粗提亮；其他节点保持原样
      var conn = {};
      graph.edges.forEach(function (e, idx) {
        (conn[e.source] = conn[e.source] || []).push(idx);
        (conn[e.target] = conn[e.target] || []).push(idx);
      });
      Object.keys(nodeEls).forEach(function (id) {
        var g = nodeEls[id];
        g.addEventListener("mouseenter", function () {
          g.classList.add("hovered");
          (conn[id] || []).forEach(function (ei) {
            var e = edgeById[ei];
            e.setAttribute("stroke-width", "2.4");
            e.setAttribute("stroke-opacity", "0.95");
          });
        });
        g.addEventListener("mouseleave", function () {
          g.classList.remove("hovered");
          (conn[id] || []).forEach(function (ei) {
            var e = edgeById[ei];
            e.setAttribute("stroke-width", "1.4");
            e.setAttribute("stroke-opacity", "0.4");
          });
        });
      });

      // 搜索过滤（主动搜索时才淡化未命中；清空即恢复）
      state.applyQuery = function (q) {
        var ql = (q || "").toLowerCase();
        Object.keys(nodeEls).forEach(function (id) {
          var n = nodeById[id];
          var hit = !ql || n.label.toLowerCase().indexOf(ql) >= 0 || n.rel.toLowerCase().indexOf(ql) >= 0;
          nodeEls[id].setAttribute("opacity", hit ? "1" : "0.12");
          if (hit && !ql) nodeEls[id].classList.remove("hovered");
        });
      };
    }

    // ── 面板挂载 ─────────────────────────────────────────────────────────────
    // 会话区 = header + scrollBody(可视滚动容器) + composer。官方 scrollBody 内容可撑开页面
    // （chat 整页滚是官方模式）——面板必须锁在 scrollBody 的【可视高度】内：图内部滚、
    // 详情与图等高、页面不滚。动态测真正滚动容器（找 overflow-y auto/scroll 的祖先）。
    function fitViewport(host) {
      // 只认"真正可视滚动区"：overflow auto/scroll 且 clientHeight ≤ 视口的容器。
      // 内容撑高的大容器 clientHeight 会超过视口（不是固定可视区），直接排除；
      // 否则"最小者"会误选内容撑高容器 → 面板被撑长。
      function findScroller() {
        var best = null;
        var el = host.parentElement;
        while (el && el !== document.body) {
          var ov = getComputedStyle(el).overflowY;
          if ((ov === "auto" || ov === "scroll") && el.clientHeight > 0 && el.clientHeight <= window.innerHeight + 2) {
            if (!best || el.clientHeight < best.clientHeight) best = el;
          }
          el = el.parentElement;
        }
        return best;
      }
      var lastSb = null;
      var ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
      function apply() {
        var sb = findScroller();
        if (sb) {
          host.style.height = Math.max(320, sb.clientHeight - 2) + "px";
          if (lastSb !== sb) { lastSb = sb; if (ro) { try { ro.observe(sb); } catch (err) {} } }
        } else {
          host.style.height = Math.max(380, (window.innerHeight || 900) - 260) + "px";
        }
      }
      apply();
      // 布局稳定后二次校正（初次测量可能早于会话区排版完成）
      var t1 = setTimeout(apply, 120);
      var t2 = setTimeout(apply, 500);
      var sessionRoot = host.closest("[data-phase]");
      if (ro && sessionRoot) ro.observe(sessionRoot);
      window.addEventListener("resize", apply);
      return function () {
        clearTimeout(t1); clearTimeout(t2);
        if (ro) ro.disconnect();
        window.removeEventListener("resize", apply);
      };
    }

    function mount(host) {
      host.innerHTML = "";
      var state = { scale: 1 };
      var unlisten = fitViewport(host);
      state.dispose = function () { if (unlisten) unlisten(); };

      // header
      var header = el("div", "dshome-mind-header");
      header.appendChild(el("div", "dshome-mind-title", "🐟 心智图谱"));
      var stat = el("div", "dshome-mind-stat", "加载中…");
      header.appendChild(stat);
      host.appendChild(header);

      // toolbar：视图切换 + 搜索 + 图例 + 缩放
      var toolbar = el("div", "dshome-mind-toolbar");
      var viewSw = el("div", "dshome-mind-vswitch");
      var btns = {};
      [["graph", "📊 图谱"], ["approval", "🛡 放行"], ["curate", "🧹 剪枝"], ["todos", "📋 待办"]].forEach(function (v) {
        var b = el("button", v[0] === "graph" ? "on" : "", v[1]);
        btns[v[0]] = b;
        viewSw.appendChild(b);
      });
      toolbar.appendChild(viewSw);
      var search = el("input", "dshome-mind-search");
      search.placeholder = "搜索节点…";
      toolbar.appendChild(search);
      var legend = el("div", "dshome-mind-legend");
      [["L0 宪法", "#8b5cf6"], ["L1 法律", "#4D6BFE"], ["L2", "#10b981"], ["L3 记忆", "#f97316"], ["Project", "#ef4444"]].forEach(function (x) {
        var s = el("span");
        var i = document.createElement("i");
        i.style.background = x[1];
        s.appendChild(i);
        s.appendChild(document.createTextNode(x[0]));
        legend.appendChild(s);
      });
      legend.appendChild(el("span", null, "🔒 私有"));
      toolbar.appendChild(legend);
      var zoom = el("div", "dshome-mind-zoom");
      var zIn = el("button", null, "+"), zOut = el("button", null, "−");
      zoom.appendChild(zIn); zoom.appendChild(zOut);
      toolbar.appendChild(zoom);
      host.appendChild(toolbar);

      // main：图 + 详情 / 治理
      var main = el("div", "dshome-mind-main");
      var graphWrap = el("div", "dshome-mind-graph");
      var detail = el("div", "dshome-mind-detail");
      detail.appendChild(el("div", "dshome-mind-empty", "点击图谱节点查看内容"));
      var govEl = el("div", "dshome-mind-gov");
      govEl.style.display = "none";
      main.appendChild(graphWrap);
      main.appendChild(detail);
      main.appendChild(govEl);
      host.appendChild(main);

      // 视图切换：图谱 / 待放行 / 整理
      state.view = "graph";
      function showView(mode) {
        state.view = mode;
        Object.keys(btns).forEach(function (k) { btns[k].className = k === mode ? "on" : ""; });
        var isGov = mode === "approval" || mode === "curate" || mode === "todos";
        graphWrap.style.display = isGov ? "none" : "";
        detail.style.display = isGov ? "none" : "";
        govEl.style.display = isGov ? "" : "none";
        legend.style.display = mode === "graph" ? "" : "none";
        zoom.style.display = mode === "graph" ? "" : "none";
        search.placeholder = mode === "graph" ? "搜索节点…" : (mode === "approval" ? "筛选放行…" : "筛选剪枝候选…");
        stat.textContent = mode === "graph" && state.graphStat ? state.graphStat : "";
        // 治理视图共用一个容器：每次切入都重渲染，避免残留上一个视图的内容
        if (isGov) {
          if (mode === "approval") renderApproval(govEl, loadApproval);
          else if (mode === "curate") renderCurate(govEl, loadCurate);
          else renderTodos(govEl, loadTodosView);
        }
      }
      function loadApproval() { renderApproval(govEl, loadApproval); }
      function loadCurate() { renderCurate(govEl, loadCurate); }
      function loadTodosView() { renderTodos(govEl, loadTodosView); }
      Object.keys(btns).forEach(function (k) {
        btns[k].addEventListener("click", function () { showView(k); });
      });

      // 拖拽平移画布（空白/层带拖动；节点上留给点击）
      var pan = null;
      graphWrap.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        if (e.target.closest(".dshome-mind-graph-node")) return;
        pan = { x: e.clientX, y: e.clientY, sl: graphWrap.scrollLeft, st: graphWrap.scrollTop };
        graphWrap.classList.add("panning");
        try { graphWrap.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });
      graphWrap.addEventListener("pointermove", function (e) {
        if (!pan) return;
        graphWrap.scrollLeft = pan.sl - (e.clientX - pan.x);
        graphWrap.scrollTop = pan.st - (e.clientY - pan.y);
      });
      function endPan(e) {
        if (!pan) return;
        pan = null;
        graphWrap.classList.remove("panning");
        try { graphWrap.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      graphWrap.addEventListener("pointerup", endPan);
      graphWrap.addEventListener("pointercancel", endPan);

      zIn.addEventListener("click", function () { zoomSvg(1.15); });
      zOut.addEventListener("click", function () { zoomSvg(1 / 1.15); });
      function zoomSvg(f) {
        state.scale = Math.max(0.5, Math.min(2.5, state.scale * f));
        var svg = graphWrap.querySelector("svg");
        if (svg) { svg.style.width = (svg.getAttribute("width") * state.scale) + "px"; svg.style.height = (svg.getAttribute("height") * state.scale) + "px"; }
      }

      search.addEventListener("input", function () {
        if (state.applyQuery) state.applyQuery(search.value.trim());
      });

      fetch("/api/mind/graph")
        .then(function (r) { return r.json(); })
        .then(function (g) {
          if (!g.ok) throw new Error(g.error);
          stat.textContent = g.nodes.length + " 节点 · " + g.edges.length + " 关联";
          state.graphStat = stat.textContent;
          renderGraph(g, graphWrap, function (n) {
            openDetail(n.zone, n.rel);
          }, state);
        })
        .catch(function (e) {
          stat.textContent = "加载失败";
          graphWrap.appendChild(el("div", "dshome-mind-empty", "⚠️ " + (e.message || e)));
        });

      // 治理计数徽标（图谱 stat 之外的放行/整理数量）
      function refreshCounts() {
        fetch("/api/mind/approvals").then(function (r) { return r.json(); }).then(function (d) {
          var pcount = d.ok && d.items ? d.items.filter(function (x) { return x.status === "pending"; }).length : 0;
          btns.approval.textContent = "🛡 放行" + (pcount > 0 ? " (" + pcount + ")" : "");
        }).catch(function () {});
        fetch("/api/mind/curate").then(function (r) { return r.json(); }).then(function (d) {
          btns.curate.textContent = "🧹 剪枝" + (d.ok && d.items && d.items.length ? " (" + d.items.length + ")" : "");
        }).catch(function () {});
      }
      refreshCounts();

      host.__mindState = state;
    }

    // ── 独立「⏰ 定时」视图（conversation.view id=cron）───────────────────────
    function mountCron(host) {
      host.innerHTML = "";
      var header = el("div", "dshome-mind-header");
      header.appendChild(el("div", "dshome-mind-title", "⏰ 定时任务"));
      host.appendChild(header);
      var gov = el("div", "dshome-mind-gov");
      host.appendChild(gov);
      var reload = function () { renderCron(gov, reload); };
      renderCron(gov, reload);
    }

    // ── React 壳 ─────────────────────────────────────────────────────────────
    function MindView() {
      var ref = React.useRef(null);
      var disposed = React.useRef(null);
      React.useEffect(function () {
        if (ref.current) mount(ref.current);
        return function () {
          if (ref.current && ref.current.__mindState && ref.current.__mindState.dispose) ref.current.__mindState.dispose();
          if (ref.current) ref.current.innerHTML = "";
        };
      }, []);
      return react_jsx_runtime.jsx("div", { className: "dshome-mind-root", ref });
    }

    // ── 独立「⏰ 定时」view React 壳（conversation.view id=cron）───────────────
    function CronView() {
      var ref = React.useRef(null);
      React.useEffect(function () {
        if (ref.current) mountCron(ref.current);
        return function () { if (ref.current) ref.current.innerHTML = ""; };
      }, []);
      return react_jsx_runtime.jsx("div", { className: "dshome-mind-root", ref });
    }

    // ── 插件体：conversation.view（对话/轨迹同级）───────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      try {
        ensureStyle();
        ctx.slots.inject("conversation.view", function () {
          return ctx.slots.register({
            name: "conversation.view",
            id: "mind",
            order: 15,
            label: function () { return "心智"; },
          }, MindView);
        });
        ctx.slots.inject("conversation.view", function () {
          return ctx.slots.register({
            name: "conversation.view",
            id: "cron",
            order: 16,
            label: function () { return "定时"; },
          }, CronView);
        });
      } catch (e) { console.warn("dshome-mind: view registration failed", e); }
    }

    module.exports = { name: "dshome-mind", inject, apply };
    return module.exports;
  },
});
