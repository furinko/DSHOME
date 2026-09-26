// dshome-quick-phrases — browser client module（DSHOME 快捷短语：可编辑短语本 + 点行即发）。
//
// 形态：占官方 `conversation.input.right` 槽（kind list / scope session）的一个常驻小按钮「短语」，
// 贴在输入框「提交键之前」那一带；点开＝全屏遮罩 + 居中卡片的短语面板（纯 DOM，无 JSX 编译依赖）。
// 面板里：搜索 / 点行主体＝立刻把该短语正文作为一条消息发给当前会话 / 每行「改」「删」/ 底部「＋ 新建」。
//
// 契约（本机 @deepseek-ai/dsh 核实，非推测）：
//   · 槽位 `conversation.input.right`：kind list / scope session，官方描述
//     "Compact controls before the composer submit action"
//     → dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:207-211（声明）
//     → dsh-client-ui-conversation/lib/client.js:16205（渲染点：`input/sessionId` 都在才渲染）
//     → dsh-cordis-client-runner/lib/client.js:2943-2992（槽位总表：occupants 为空、replaceRisk none、
//       standardProps 含 sessionId / useSession / useSessions）
//   · list 槽的冲突规则「**同 id + 同 priority** 才抛错，priority 低者渲染」
//     → dsh-client-ui-slots/lib/index.js:82-87 ⇒ 本插件 id 取 "phrases"、priority 默认 0，
//       与 dshome-input 的 "queue"（另一个槽）互不干涉。
//   · 注册形状（含 inject 业务面工厂 + 组件 props）→ packages/dshome-input/lib/client.js:417-459。
//   · 发送必须走 **scope-addressed** 的会话 ctx：`conversation.send` 在 root ctx 上会 fail loud
//     → dsh-client-ui-conversation/lib/types/client/service.d.ts:28-38（send 语义）、:168-172
//       （"Resolve the caller scope's session face or throw on root contexts"）。
//     取 actx 的范式实证 → packages/dshome-input/lib/client.js:424-431（ctx.sessions.scope(id) → actx.get("conversation")）。
//   · 会话标题来源：`useSessions` 是 `SnapshotSelectorHook<SessionListState>`
//     → dsh-client-ui-session/lib/types/client/index.d.ts:7；
//     SessionSummary.title / displayTitle（"durable title, project basename, then session id"）
//     → dsh-api-session-controller/lib/types/client/sessions/service.d.ts:32-37。
//     取不到标题就退回 sessionId 前 8 位。
//   · 面板视觉范式（全屏遮罩 + 居中卡片 + 自带注入 CSS + 弹出动画）→ packages/dshome-plugin-center/lib/client.js:14-76,236-289。
//   · 端点路径与 host 半 `lib/index.cjs` 顶部三个常量**逐字一致**（两侧注释互相指明）。
//
// 懒加载：面板没打开前**不发任何请求**——按钮渲染只读内存里的状态；`openPanel()` 才 fetch list。
//
// 键位与关闭：Esc 关面板；点遮罩（root 自身）关面板；点面板内部不关。
//   · 显式取舍：面板里正在编辑/等待删除确认时，Esc 与点遮罩**照样直接关面板**（照主人规格），
//     编辑中的草稿随之丢弃——就地退出走「取消」按钮。
//
// 容错：任一动作失败只提示（面板底部的轻提示行）+ console.warn，绝不抛断 UI（照 dshome-theme 的降级纪律）。
window.__ModuleLoader__.load({
  id: "dshome-quick-phrases",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var jsxRuntime = require("react/jsx-runtime");
    var jsx = jsxRuntime.jsx;

    /** 本包 host 半注册的同源端点（两侧路径必须逐字一致，见 lib/index.cjs 顶部常量）。 */
    const LIST_PATH = "/dshome-quick-phrases/list";
    const SAVE_PATH = "/dshome-quick-phrases/save";
    const DELETE_PATH = "/dshome-quick-phrases/delete";

    /** 「没有可发送的会话」用错误码标记，避免拿文案当协议。 */
    const NO_SESSION_CODE = "NO_SESSION";
    const NO_SESSION_MESSAGE = "当前没有打开的会话";

    // ── 样式（DSHOME 主题 token，缺失回退；只注入一次）────────────────────────
    var STYLE = [
      // 入口按钮（输入框提交键前的紧凑控件）
      ".dshome-qp-entry{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#4a5a78);font-size:12.5px;font-weight:600;line-height:1;cursor:pointer;transition:background .15s,border-color .15s,color .15s,transform .1s}",
      ".dshome-qp-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08));border-color:var(--dsw-alias-border-l2,#d3dcea);color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-qp-entry:active{transform:scale(.96)}",
      ".dshome-qp-entry-ico{display:inline-flex;align-items:center;justify-content:center}",
      // 遮罩 + 面板
      ".dshome-qp-root{position:fixed;inset:0;z-index:2147483000;display:none;align-items:flex-start;justify-content:center;padding:9vh 16px 16px;background:rgba(5,8,14,.5);backdrop-filter:blur(2px);animation:dshome-qp-fade .18s ease}",
      "@keyframes dshome-qp-fade{from{opacity:0}to{opacity:1}}",
      ".dshome-qp-panel{width:min(640px,94vw);max-height:80vh;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d3dcea);box-shadow:0 24px 80px rgba(0,0,0,.45);animation:dshome-qp-pop .16s cubic-bezier(.2,.9,.3,1.2)}",
      "@keyframes dshome-qp-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}",
      // 头部
      ".dshome-qp-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-qp-head-icon{flex:none;width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(77,107,254,.18),rgba(77,107,254,.06));color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-qp-head-title{flex:1;min-width:0}",
      ".dshome-qp-title{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#1a2233);letter-spacing:.2px}",
      ".dshome-qp-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      // 通用按钮
      ".dshome-qp-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:9px;padding:6px 11px;font-size:12px;color:var(--dsw-alias-label-secondary,#4a5a78);cursor:pointer;transition:all .15s;white-space:nowrap}",
      ".dshome-qp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08));border-color:var(--dsw-alias-brand-primary,#4D6BFE);color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-qp-primary{border-color:var(--dsw-alias-brand-primary,#4D6BFE);color:var(--dsw-alias-brand-primary,#4D6BFE)}",
      ".dshome-qp-primary:hover{background:var(--dsw-alias-brand-primary,#4D6BFE);color:#fff}",
      ".dshome-qp-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}",
      ".dshome-qp-danger:hover{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}",
      ".dshome-qp-btn:disabled{opacity:.45;cursor:not-allowed}",
      // 搜索行
      ".dshome-qp-searchbar{padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-qp-search-wrap{position:relative}",
      ".dshome-qp-search{width:100%;box-sizing:border-box;padding:8px 12px 8px 32px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-base,#f7f9fc);color:var(--dsw-alias-label-primary,#1a2233);font-size:13.5px;outline:none;transition:border-color .15s,box-shadow .15s}",
      ".dshome-qp-search:focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 0 0 3px rgba(77,107,254,.14)}",
      ".dshome-qp-search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--dsw-alias-label-tertiary,#6b7a99);pointer-events:none}",
      // 编辑表单
      ".dshome-qp-editor{display:none;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e9f3);background:var(--dsw-alias-bg-base,#f7f9fc)}",
      ".dshome-qp-editor-title{font-size:12px;font-weight:700;color:var(--dsw-alias-label-tertiary,#6b7a99);letter-spacing:.4px;margin-bottom:8px}",
      ".dshome-qp-input,.dshome-qp-textarea{width:100%;box-sizing:border-box;padding:8px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a2233);font-size:13.5px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}",
      ".dshome-qp-input:focus,.dshome-qp-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 0 0 3px rgba(77,107,254,.14)}",
      ".dshome-qp-textarea{margin-top:8px;min-height:96px;resize:vertical;line-height:1.55}",
      ".dshome-qp-editor-acts{display:flex;align-items:center;gap:8px;margin-top:10px}",
      ".dshome-qp-hint{flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#e5484d)}",
      // 列表
      ".dshome-qp-list{flex:1;overflow:auto;padding:6px 14px 10px}",
      ".dshome-qp-list::-webkit-scrollbar{width:8px}.dshome-qp-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#d3dcea);border-radius:99px}",
      ".dshome-qp-row{display:flex;align-items:center;gap:10px;padding:6px 8px 6px 4px;border-radius:11px;border:1px solid transparent;transition:background .12s,border-color .12s}",
      ".dshome-qp-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.06));border-color:var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-qp-main{flex:1;min-width:0;display:block;width:100%;text-align:left;background:none;border:none;padding:6px 8px;border-radius:9px;font-family:inherit;cursor:pointer}",
      ".dshome-qp-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:1px}",
      ".dshome-qp-name{display:block;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1a2233);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshome-qp-text{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}",
      ".dshome-qp-acts{flex:none;display:inline-flex;align-items:center;gap:6px}",
      // 空状态 / 底部
      ".dshome-qp-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:38px 16px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#6b7a99)}",
      ".dshome-qp-empty-ico{font-size:26px;opacity:.5}",
      ".dshome-qp-foot{display:flex;align-items:center;gap:10px;padding:11px 18px;border-top:1px solid var(--dsw-alias-border-l1,#e3e9f3)}",
      ".dshome-qp-toast{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7a99);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshome-qp-toast-err{color:var(--dsw-alias-state-error-primary,#e5484d)}",
    ].join("");

    /** 样式注入：**以 DOM 为真源**（`querySelector` 找不到才注入），不再只看内存 flag。
     *  病史（2026-09-26）：原写法是"先看内存标志位、看过就 return"，在**客户端热更新（HMR）后失效**——
     *  模块状态被重置、而 `<style>` 节点可能已随旧模块/文档生命周期消失，于是"标志位说注入过、
     *  DOM 里其实没有"⇒ 入口按钮以裸样式渲染（看着像"丢渲染"）。同 dshome-input / dshome-mind 的纪律。 */
    function ensureStyle0() {
      if (document.querySelector("style[data-dshome-plugin='dshome-quick-phrases']")) return;
      var css = document.createElement("style");
      css.setAttribute("data-dshome-plugin", "dshome-quick-phrases");
      css.textContent = STYLE;
      document.head.appendChild(css);
    }
    // ── 样式**常驻守卫**（2026-09-26 加）──────────────────────────────────────
    // 病史：主人报「短语按钮 / 插队图标会掉外观和布局」。上一版把注入改成"以 DOM 为真源"只覆盖了
    //   **HMR 后模块状态重置**那一类；但 ensureStyle 仍只在 apply 那一刻跑一次 —— 之后若 <style>
    //   节点被**别人删掉/整批替换**（上游重挂界面、安全模式、别的插件清 head），**没人再补**，
    //   元素退回裸样式（外观 + 布局一起掉），刷新才恢复。现在：head 一有变动就查一次，缺了就补。
    function guardStyle() {
      try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        var G = window.__dshomeStyleGuard || (window.__dshomeStyleGuard = {});
        if (G['quick-phrases']) return;
        G['quick-phrases'] = true;
        var sel = "style[data-dshome-plugin='dshome-quick-phrases']";
        var check = function () { try { if (!document.querySelector(sel)) ensureStyle0(); } catch (e) { /* 忽略 */ } };
        check();
        if (typeof MutationObserver === 'function' && document.head) new MutationObserver(check).observe(document.head, { childList: true });
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', check);
      } catch (e) { /* 守卫失败不阻断插件本身 */ }
    }

    /** 幂等入口：样式在位 + 守卫挂起（守卫内部同样调 ensureStyle0 补写）。 */
    function ensureStyles() { ensureStyle0(); guardStyle(); }


    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function svg(pathD, size) {
      var ns = "http://www.w3.org/2000/svg";
      var s = document.createElementNS(ns, "svg");
      s.setAttribute("width", String(size || 14));
      s.setAttribute("height", String(size || 14));
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("fill", "none");
      s.setAttribute("stroke", "currentColor");
      s.setAttribute("stroke-width", "2");
      s.setAttribute("stroke-linecap", "round");
      s.setAttribute("stroke-linejoin", "round");
      s.setAttribute("aria-hidden", "true");
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", pathD);
      s.appendChild(p);
      return s;
    }

    var ICON_BUBBLE = "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z";
    var ICON_SEARCH = "M21 21l-4.34-4.34M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z";

    /**
     * React 侧图标：槽组件的子树是 React 树，**不能**塞原生 DOM 节点
     * （`svg()` 那个 helper 只给纯 DOM 面板用——把 DOM 元素当 React child 会直接抛错）。
     * 写法照 packages/dshome-plugin-center/lib/client.js:303-311。
     */
    function reactIcon(pathD, size) {
      return jsx("svg", {
        width: size || 14,
        height: size || 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        children: jsx("path", { d: pathD }),
      });
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ── 面板状态（单例：同一时刻只开一个；状态留在模块作用域，关闭不清空列表缓存）──
    var mounted = false;
    var root = null;
    var subEl = null;
    var listEl = null;
    var searchEl = null;
    var editorEl = null;
    var editorTitleEl = null;
    var nameInput = null;
    var textInput = null;
    var hintEl = null;
    var footBtn = null;
    var toastEl = null;

    var target = { sessionId: null, label: "", send: null };
    var phrases = [];
    var query = "";
    /** 编辑态：null＝不在编辑；{ id: null, ... }＝新建；{ id: "..." }＝改这一条。 */
    var editing = null;
    var editorToken = 0;
    var renderedEditorToken = -1;
    var confirmingId = null;
    var confirmTimer = 0;
    var toastTimer = 0;
    var busy = false;
    /** 面板当前是否可见（Esc 键位只看这个标志，不去猜 DOM 的 display 值）。 */
    var panelOpen = false;

    /** 面板底部轻提示（错误用红字）；只提示，绝不抛。 */
    function notify(text, isError) {
      if (toastEl === null) return;
      toastEl.textContent = text;
      toastEl.className = isError ? "dshome-qp-toast dshome-qp-toast-err" : "dshome-qp-toast";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        if (toastEl !== null) toastEl.textContent = "";
      }, 2600);
    }

    /** 同源 JSON 调用：非 2xx 或 ok!==true 一律抛 Error(message)，文案取宿主给的 message。 */
    async function api(path, options) {
      var response = await fetch(path, options);
      var payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (response.ok && payload !== null && payload.ok === true) return payload;
      throw new Error(errorText(payload, response.status));
    }

    /** 宿主两种错误形状都认：字符串（loopback 拒绝）与 { code, message }（业务错误）。 */
    function errorText(payload, status) {
      if (payload !== null && payload !== undefined && payload.error) {
        if (typeof payload.error === "string") return payload.error;
        if (typeof payload.error.message === "string") return payload.error.message;
      }
      return "请求失败（HTTP " + String(status) + "）";
    }

    /** 搜索过滤：name / text 里出现关键字即可（大小写不敏感）。 */
    function filtered() {
      if (query.length === 0) return phrases;
      var q = query.toLowerCase();
      return phrases.filter(function (phrase) {
        return String(phrase.name).toLowerCase().indexOf(q) >= 0
          || String(phrase.text).toLowerCase().indexOf(q) >= 0;
      });
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────────
    function render() {
      if (!mounted) return;
      // 「有没有目标会话」以 sessionId 为准；label 只是显示用（缺标题时退回 id 前 8 位）。
      subEl.textContent = target.sessionId === null
        ? "未选中会话：可以管理短语，发送会被拦下"
        : "发送到：" + (target.label || target.sessionId.slice(0, 8)) + " · 点短语行立刻发送";
      renderEditor();
      renderList();
      renderFoot();
    }

    function renderList() {
      listEl.textContent = "";
      if (phrases.length === 0) {
        var empty = el("div", "dshome-qp-empty");
        empty.appendChild(el("div", "dshome-qp-empty-ico", "💬"));
        empty.appendChild(el("div", null, "还没有短语——点下面「＋ 新建」写第一条"));
        empty.appendChild(el("div", null, "写好后，点短语那一行就会把它作为一条消息发出去"));
        listEl.appendChild(empty);
        return;
      }
      var rows = filtered();
      if (rows.length === 0) {
        var none = el("div", "dshome-qp-empty");
        none.appendChild(el("div", "dshome-qp-empty-ico", "🔍"));
        none.appendChild(el("div", null, "没有匹配的短语，换个关键词试试"));
        listEl.appendChild(none);
        return;
      }
      for (var i = 0; i < rows.length; i += 1) listEl.appendChild(rowEl(rows[i]));
    }

    function rowEl(phrase) {
      var row = el("div", "dshome-qp-row");
      // 行主体＝发送键：用真按钮，键盘也能触发（Enter/空格）。
      var main = el("button", "dshome-qp-main");
      main.type = "button";
      main.title = "点一下立刻发送：「" + String(phrase.name) + "」";
      main.appendChild(el("span", "dshome-qp-name", String(phrase.name)));
      main.appendChild(el("span", "dshome-qp-text", String(phrase.text)));
      main.onclick = function () { sendPhrase(phrase); };
      row.appendChild(main);

      var acts = el("div", "dshome-qp-acts");
      if (confirmingId === phrase.id) {
        // 删除前二次确认（不用 window.confirm）：就地换按钮，4 秒后自动复位。
        var yes = el("button", "dshome-qp-btn dshome-qp-danger", "确认删除");
        yes.type = "button";
        yes.onclick = function () { void doDelete(phrase); };
        var no = el("button", "dshome-qp-btn", "取消");
        no.type = "button";
        no.onclick = function () {
          confirmingId = null;
          clearTimeout(confirmTimer);
          render();
        };
        acts.appendChild(yes);
        acts.appendChild(no);
      } else {
        var edit = el("button", "dshome-qp-btn", "改");
        edit.type = "button";
        edit.title = "编辑这条短语";
        edit.onclick = function () { startEdit(phrase); };
        var del = el("button", "dshome-qp-btn", "删");
        del.type = "button";
        del.title = "删除这条短语（会再问一次）";
        del.onclick = function () { askDelete(phrase.id); };
        acts.appendChild(edit);
        acts.appendChild(del);
      }
      row.appendChild(acts);
      return row;
    }

    function renderEditor() {
      if (editing === null) {
        editorEl.style.display = "none";
        renderedEditorToken = -1;
        return;
      }
      editorEl.style.display = "block";
      // 只在「刚打开编辑态」时回填输入框：否则搜索/删除后的重渲染会把用户正在敲的字重置掉。
      if (renderedEditorToken === editorToken) return;
      renderedEditorToken = editorToken;
      editorTitleEl.textContent = editing.id === null ? "新建短语" : "编辑短语";
      nameInput.value = editing.name;
      textInput.value = editing.text;
      hintEl.textContent = "";
    }

    function renderFoot() {
      footBtn.textContent = editing === null ? "＋ 新建" : "＋ 新建（先结束上面那条编辑）";
      footBtn.disabled = editing !== null;
    }

    // ── 动作 ─────────────────────────────────────────────────────────────────
    function hint(text) {
      hintEl.textContent = text;
      if (nameInput !== null) {
        if (nameInput.value.trim().length === 0) nameInput.focus();
        else textInput.focus();
      }
    }

    function startEdit(phrase) {
      editing = phrase === null || phrase === undefined
        ? { id: null, name: "", text: "" }
        : { id: String(phrase.id), name: String(phrase.name), text: String(phrase.text) };
      editorToken += 1;
      confirmingId = null;
      clearTimeout(confirmTimer);
      render();
    }

    function cancelEdit() {
      editing = null;
      editorToken += 1;
      render();
    }

    async function submitEdit() {
      if (busy || editing === null) return;
      var name = String(editing.name || "").trim();
      var text = String(editing.text || "");
      if (name.length === 0) { hint("给这条短语起个名字（列表里显示这一行）"); return; }
      if (text.trim().length === 0) { hint("短语正文不能为空"); return; }
      var payload = { phrase: { name: name, text: text } };
      if (editing.id !== null) payload.phrase.id = editing.id;
      busy = true;
      try {
        var result = await api(SAVE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        phrases = Array.isArray(result.phrases) ? result.phrases : phrases;
        editing = null;
        editorToken += 1;
        render();
        notify("已保存：" + name);
      } catch (error) {
        hint("保存失败：" + messageOf(error));
      } finally {
        busy = false;
      }
    }

    function askDelete(id) {
      confirmingId = id;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(function () {
        confirmingId = null;
        render();
      }, 4000);
      render();
    }

    async function doDelete(phrase) {
      if (busy) return;
      busy = true;
      confirmingId = null;
      clearTimeout(confirmTimer);
      try {
        var result = await api(DELETE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: String(phrase.id) }),
        });
        phrases = Array.isArray(result.phrases) ? result.phrases : phrases;
        notify("已删除：" + String(phrase.name));
      } catch (error) {
        notify("删除失败：" + messageOf(error), true);
      } finally {
        busy = false;
        render();
      }
    }

    /**
     * 点行主体＝立刻发送。发送成功**面板保持打开**（方便连发），只在底部提示一行。
     * 刻意**不**用 busy 闸：连发是主人点名的场景，把第二次点击悄悄吃掉是缺陷——
     * 发送本身由会话侧排队，重复点击只会多排一条，不会互相踩。
     */
    async function sendPhrase(phrase) {
      if (typeof target.send !== "function") {
        notify("当前没有打开的会话", true);
        return;
      }
      try {
        await target.send(String(phrase.text));
        notify("已发送：" + String(phrase.name));
      } catch (error) {
        if (error && error.code === NO_SESSION_CODE) notify(NO_SESSION_MESSAGE, true);
        else notify("发送失败：" + messageOf(error), true);
      }
    }

    /** 打开面板时拉一次全量列表（懒加载：这是本插件唯一的读请求入口）。 */
    async function load() {
      try {
        var result = await api(LIST_PATH);
        phrases = Array.isArray(result.phrases) ? result.phrases : [];
      } catch (error) {
        notify("读取短语失败：" + messageOf(error), true);
      }
      render();
    }

    // ── 浮层生命周期 ─────────────────────────────────────────────────────────
    function openQuickPhrasesPanel(next) {
      try {
        ensureStyles();
        mount();
        target = next || { sessionId: null, label: "", send: null };
        query = "";
        editing = null;
        editorToken += 1;
        renderedEditorToken = -1;
        confirmingId = null;
        busy = false;
        clearTimeout(confirmTimer);
        if (searchEl !== null) searchEl.value = "";
        if (toastEl !== null) toastEl.textContent = "";
        panelOpen = true;
        root.style.display = "flex";
        render();
        if (searchEl !== null) {
          try { searchEl.focus(); } catch { /* 焦点拿不到不影响使用 */ }
        }
        void load();
      } catch (error) {
        // 打不开面板也绝不抛断 UI：只落一条告警。
        console.warn("dshome-quick-phrases: open failed", error);
      }
    }

    function close() {
      if (!mounted) return;
      panelOpen = false;
      root.style.display = "none";
      editing = null;
      confirmingId = null;
      clearTimeout(confirmTimer);
      clearTimeout(toastTimer);
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      ensureStyles();
      root = el("div", "dshome-qp-root");
      root.onclick = function (event) { if (event.target === root) close(); };

      var panel = el("div", "dshome-qp-panel");

      // 头部：标题 + 目标会话
      var head = el("div", "dshome-qp-head");
      var headIcon = el("div", "dshome-qp-head-icon");
      headIcon.appendChild(svg(ICON_BUBBLE, 15));
      head.appendChild(headIcon);
      var titleBox = el("div", "dshome-qp-head-title");
      titleBox.appendChild(el("div", "dshome-qp-title", "快捷短语"));
      subEl = el("div", "dshome-qp-sub", "");
      titleBox.appendChild(subEl);
      head.appendChild(titleBox);
      var closeBtn = el("button", "dshome-qp-btn", "关闭");
      closeBtn.type = "button";
      closeBtn.onclick = close;
      head.appendChild(closeBtn);
      panel.appendChild(head);

      // 搜索
      var searchBar = el("div", "dshome-qp-searchbar");
      var searchWrap = el("div", "dshome-qp-search-wrap");
      var searchIco = el("span", "dshome-qp-search-icon");
      searchIco.appendChild(svg(ICON_SEARCH, 13));
      searchWrap.appendChild(searchIco);
      searchEl = el("input", "dshome-qp-search");
      searchEl.type = "search";
      searchEl.placeholder = "搜索名称或正文…";
      searchEl.oninput = function () {
        query = searchEl.value;
        render();
      };
      searchWrap.appendChild(searchEl);
      searchBar.appendChild(searchWrap);
      panel.appendChild(searchBar);

      // 编辑表单（默认隐藏）
      editorEl = el("div", "dshome-qp-editor");
      editorTitleEl = el("div", "dshome-qp-editor-title", "新建短语");
      editorEl.appendChild(editorTitleEl);
      nameInput = el("input", "dshome-qp-input");
      nameInput.type = "text";
      nameInput.placeholder = "名称（列表里显示这一行，例如：微信收款码）";
      nameInput.oninput = function () { if (editing !== null) editing.name = nameInput.value; };
      editorEl.appendChild(nameInput);
      textInput = el("textarea", "dshome-qp-textarea");
      textInput.placeholder = "短语正文——点短语行时，这段文字会原样作为一条消息发出去";
      textInput.oninput = function () { if (editing !== null) editing.text = textInput.value; };
      editorEl.appendChild(textInput);
      var editorActs = el("div", "dshome-qp-editor-acts");
      hintEl = el("div", "dshome-qp-hint", "");
      editorActs.appendChild(hintEl);
      var cancelBtn = el("button", "dshome-qp-btn", "取消");
      cancelBtn.type = "button";
      cancelBtn.onclick = cancelEdit;
      editorActs.appendChild(cancelBtn);
      var saveBtn = el("button", "dshome-qp-btn dshome-qp-primary", "保存");
      saveBtn.type = "button";
      saveBtn.onclick = function () { void submitEdit(); };
      editorActs.appendChild(saveBtn);
      editorEl.appendChild(editorActs);
      panel.appendChild(editorEl);

      // 列表
      listEl = el("div", "dshome-qp-list");
      panel.appendChild(listEl);

      // 底部：轻提示 + 新建
      var foot = el("div", "dshome-qp-foot");
      toastEl = el("div", "dshome-qp-toast", "");
      foot.appendChild(toastEl);
      footBtn = el("button", "dshome-qp-btn dshome-qp-primary", "＋ 新建");
      footBtn.type = "button";
      footBtn.onclick = function () { startEdit(null); };
      foot.appendChild(footBtn);
      panel.appendChild(foot);

      root.appendChild(panel);
      document.body.appendChild(root);

      // Esc 关面板（面板没开时不动任何键）
      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        if (!panelOpen) return;
        close();
      });
    }

    // ── 入口按钮 ─────────────────────────────────────────────────────────────
    /** 标题解析：durable title → displayTitle（≠id 时）→ id 前 8 位（照 service.d.ts:32-37 的口径）。 */
    function sessionLabel(state, sessionId) {
      if (sessionId === undefined || sessionId === null) return "";
      var id = String(sessionId);
      var row = state && state.byId ? state.byId[id] : null;
      if (row) {
        if (typeof row.title === "string" && row.title.length > 0) return row.title;
        if (typeof row.displayTitle === "string" && row.displayTitle.length > 0 && row.displayTitle !== id) {
          return row.displayTitle;
        }
      }
      return id.slice(0, 8);
    }

    /** 最近一次渲染读到的会话标题（点击时用；标题异步变化会自动跟着更新）。 */
    var currentLabel = "";

    /**
     * 槽组件：输入框提交键前的常驻小按钮「短语」。
     * props 三块：standard（useSessions / sessionId）+ 本插件 inject 面（send）+ owner（本槽无）。
     */
    function QuickPhrasesButton(props) {
      var sessionId = props.sessionId;
      var useSessions = props.useSessions;
      // standardProps 表里 `useSessions` 是这个槽的既定标准件（dsh-cordis-client-runner/lib/client.js:2975）；
      // 仍做一次类型保险：标准件缺席时按钮照常可用，只是标题退回 id 前 8 位。
      var label = typeof useSessions === "function"
        ? useSessions(function (state) { return sessionLabel(state, sessionId); })
        : "";
      currentLabel = label || "";
      var send = props.send;
      var open = function () {
        openQuickPhrasesPanel({
          sessionId: sessionId === undefined || sessionId === null ? null : String(sessionId),
          label: currentLabel,
          send: typeof send === "function" ? send : null,
        });
      };
      return jsx("button", {
        type: "button",
        className: "dshome-qp-entry",
        title: "快捷短语：点开面板，点短语行立刻发送",
        // 不抢输入框焦点（同官方 composer 内按钮的 keepFocus 纪律）
        onMouseDown: function (event) { if (event && typeof event.preventDefault === "function") event.preventDefault(); },
        onClick: function (event) {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          if (event && typeof event.stopPropagation === "function") event.stopPropagation();
          open();
        },
        children: [
          jsx("span", { key: "ico", className: "dshome-qp-entry-ico", children: reactIcon(ICON_BUBBLE, 13) }),
          jsx("span", { key: "label", className: "dshome-qp-entry-label", children: "短语" }),
        ],
      });
    }

    /** 所需服务：槽注册表 + 会话 scope 解析 + 对话服务（root 单例，实际发送走 actx）。 */
    const inject = ["slots", "sessions", "conversation"];

    function apply(ctx) {
      ensureStyles();
      try {
        ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register({
            name: "conversation.input.right",
            id: "phrases",
            order: 30,
            label: function () { return "快捷短语"; },
            inject: function (sessionId) {
              var id = sessionId === undefined || sessionId === null ? null : String(sessionId);
              return {
                sessionId: id,
                /**
                 * 发送：**必须在 session scope 的 ctx 上取 conversation**
                 * （root ctx 上的 send 会 fail loud，见 service.d.ts:168-172）。
                 * 作用域在**点击发送时**才解析：注册期的 scope 可能在会话切换后被回收。
                 */
                send: function (text) {
                  if (id === null) return Promise.reject(noSessionError());
                  var actx = ctx.sessions.scope(id);
                  if (actx === undefined) return Promise.reject(noSessionError());
                  var conversation = actx.get("conversation");
                  if (conversation === undefined) {
                    return Promise.reject(new Error("对话服务不可用（会话作用域里没有 conversation）"));
                  }
                  return conversation.send(text);
                },
              };
            },
          }, QuickPhrasesButton);
        });
      } catch (error) {
        console.warn("dshome-quick-phrases: slot registration failed", error);
      }
    }

    /** 没有可发送的会话：带错误码，面板据此只显示「当前没有打开的会话」而不是包一层「发送失败」。 */
    function noSessionError() {
      var error = new Error(NO_SESSION_MESSAGE);
      error.code = NO_SESSION_CODE;
      return error;
    }

    module.exports = { name: "dshome-quick-phrases", inject, apply };
    return module.exports;
  },
});
