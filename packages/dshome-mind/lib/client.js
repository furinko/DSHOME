// dshome-mind — 心智可视化面板 v2：分层知识图谱（浏览器 client 模块）。
// 入口：主界面「对话/轨迹」同级 view（conversation.view 槽位，id=mind）。
// 数据：/api/mind/graph（节点+边）+ /api/mind/read（文件内容），同源 loopback。
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
      ".dshome-mind-root{flex:1;width:100%;min-height:0;max-height:calc(100vh - 220px);display:flex;flex-direction:column;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary,#1a2233)}",
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

    // ── 治理视图：待放行 / 整理候选 ───────────────────────────────────────────
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
    function renderPending(govEl, reload) {
      govEl.innerHTML = "";
      govEl.appendChild(el("div", "dshome-mind-gov-head", "⏳ 待放行 — 鱼鱼提议的记忆，你放行后才入正式库"));
      fetch("/api/mind/pending").then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error);
        if (!d.items || !d.items.length) {
          govEl.appendChild(el("div", "dshome-mind-empty", "🎉 没有待放行的记忆"));
          return;
        }
        d.items.forEach(function (it) {
          var card = el("div", "dshome-mind-gov-card");
          card.appendChild(govChips([
            (it.kind || "note") + "/imp" + (it.importance || 2),
            it.topic ? "主题: " + it.topic : "主题: general",
            it.proposedBy ? "提议: " + it.proposedBy : "",
            it.proposedAt || "",
          ]));
          var body = it.content || "";
          var pre = el("pre", "dshome-mind-pre", body.length > 500 ? body.slice(0, 500) + "\n…" : body);
          pre.style.margin = "8px 0 2px";
          card.appendChild(pre);
          var row = el("div", "dshome-mind-gov-actions");
          var ok = el("button", "dshome-mind-gov-ok", "✓ 放行入 L3");
          var no = el("button", "dshome-mind-gov-no", "✗ 拒绝");
          row.appendChild(ok); row.appendChild(no);
          card.appendChild(row);
          govEl.appendChild(card);
          ok.addEventListener("click", function () {
            postJSON("/api/mind/pending/approve", { file: it.file }).then(function () { reload(); });
          });
          no.addEventListener("click", function () {
            postJSON("/api/mind/pending/reject", { file: it.file }).then(function () { reload(); });
          });
        });
      }).catch(function (e) {
        govEl.appendChild(el("div", "dshome-mind-empty", "⚠️ " + (e.message || e)));
      });
    }
    function renderCurate(govEl, reload) {
      govEl.innerHTML = "";
      govEl.appendChild(el("div", "dshome-mind-gov-head", "🧹 整理建议 — 扫描 L3 的膨胀候选，可归档回收"));
      fetch("/api/mind/curate").then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error);
        if (!d.items || !d.items.length) {
          govEl.appendChild(el("div", "dshome-mind-empty", "🧹 L3 很干净，暂无整理候选"));
          return;
        }
        d.items.forEach(function (it) {
          var card = el("div", "dshome-mind-gov-card");
          var nm = el("div", "dshome-mind-gov-name", "📄 " + it.name + " · " + it.rel);
          card.appendChild(nm);
          it.reasons.forEach(function (r) {
            card.appendChild(el("div", "dshome-mind-gov-reason", "⚠️ " + r.hint));
          });
          var row = el("div", "dshome-mind-gov-actions");
          var arc = el("button", "dshome-mind-gov-arch", "🗄 归档 → history");
          row.appendChild(arc);
          card.appendChild(row);
          govEl.appendChild(card);
          arc.addEventListener("click", function () {
            postJSON("/api/mind/curate/archive", { file: it.file }).then(function () { reload(); });
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
      function findScroller() {
        var el = host.parentElement;
        while (el && el !== document.body) {
          var ov = getComputedStyle(el).overflowY;
          if (ov === "auto" || ov === "scroll") return el;
          el = el.parentElement;
        }
        return null;
      }
      function apply() {
        var sb = findScroller();
        if (sb) {
          host.style.height = Math.max(320, sb.clientHeight - 2) + "px";
        } else {
          host.style.height = Math.max(380, (window.innerHeight || 900) - 260) + "px";
        }
      }
      apply();
      var ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
      var sessionRoot = host.closest("[data-phase]");
      if (ro && sessionRoot) ro.observe(sessionRoot);
      window.addEventListener("resize", apply);
      return function () {
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
      [["graph", "📊 图谱"], ["pending", "⏳ 待放行"], ["curate", "🧹 整理"]].forEach(function (v) {
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
      var govLoaded = { pending: false, curate: false };
      function showView(mode) {
        state.view = mode;
        Object.keys(btns).forEach(function (k) { btns[k].className = k === mode ? "on" : ""; });
        var isGov = mode === "pending" || mode === "curate";
        graphWrap.style.display = isGov ? "none" : "";
        detail.style.display = isGov ? "none" : "";
        govEl.style.display = isGov ? "" : "none";
        legend.style.display = mode === "graph" ? "" : "none";
        zoom.style.display = mode === "graph" ? "" : "none";
        search.placeholder = mode === "graph" ? "搜索节点…" : (mode === "pending" ? "筛选待放行…" : "筛选整理候选…");
        stat.textContent = mode === "graph" && state.graphStat ? state.graphStat : "";
        if (isGov && !govLoaded[mode]) {
          govLoaded[mode] = true;
          if (mode === "pending") renderPending(govEl, loadPending);
          else renderCurate(govEl, loadCurate);
        }
      }
      function loadPending() { renderPending(govEl, loadPending); }
      function loadCurate() { renderCurate(govEl, loadCurate); }
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

      // 治理计数徽标（图谱 stat 之外的待放行/整理数量）
      function refreshCounts() {
        fetch("/api/mind/pending").then(function (r) { return r.json(); }).then(function (d) {
          btns.pending.textContent = "⏳ 待放行" + (d.ok && d.items && d.items.length ? " (" + d.items.length + ")" : "");
        }).catch(function () {});
        fetch("/api/mind/curate").then(function (r) { return r.json(); }).then(function (d) {
          btns.curate.textContent = "🧹 整理" + (d.ok && d.items && d.items.length ? " (" + d.items.length + ")" : "");
        }).catch(function () {});
      }
      refreshCounts();

      host.__mindState = state;
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
      } catch (e) { console.warn("dshome-mind: view registration failed", e); }
    }

    module.exports = { name: "dshome-mind", inject, apply };
    return module.exports;
  },
});
