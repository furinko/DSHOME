// dshome-conversation — browser client module.
//
// 职责（客户端纯插件，零宿主行为）：
// 1) 卡片隔离：把 Think 行、工具调用、命令/系统注入（含心智 context）块包成卡片。
// 2) Think 12 行窗：官方折叠态**不渲染正文**（primitives DisclosureRow 是 `open && children`），
//    所以纯 CSS 拿不到过程 ⇒ 本插件在 DOM 层触发一次官方 onClick 让 React 真展开，
//    再用 CSS 把正文限高 12 行。跑动中贴末尾（只看较新行），但人一翻历史就松手。
//    用户手动收起过的行记账在 localStorage，之后不再被撑开（尊重人的选择）。
// 3) 容错：任一环节失败只静默降级（最坏＝只剩卡片样式），绝不阻断 UI
//    （照 dshome-theme / dshome-assistant-identity 风格）。
//
// 选择器纪律：只用官方语义属性（data-variant / data-chat-flow-kind / data-disclosure-row /
// data-expanded / data-state / data-chat-flow-key），**不依赖 CSS-Module 哈希类名**（如 lcKema_*），
// 官方重新打包也不失效。
//
// 真机实测依据（2026-09-23，无头 Chrome 探针，本会话 37 个 Think 行）：
//   折叠态 root 高 26px / innerText 93 字符；合成 click 后 data-expanded 出现、
//   正文进 DOM（1398 字符，高度 1478px，行高 21px）⇒ 本机制成立。

window.__ModuleLoader__.load({
  id: "dshome-conversation",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── 选择器与常量 ───────────────────────────────────────────────────────
    var THINK = '[data-variant="think"]';
    var THINK_ROW = '[data-disclosure-row]';
    var THINK_BODY = THINK_ROW + " + div";
    var FLOW = "[data-chat-flow-key]";
    var THINK_LINES = 12;

    /**
     * 卡片化的块（官方 chat node key；用户点名：工具调用 + 命令/系统注入，不含用户消息与最终回答）。
     * `:not([hidden])` 是必需的：官方会给「本回合没有可披露过程」的空 turn-process 块标上 hidden，
     * 但它实际仍是 display:block 的空元素 —— 卡片的内边距+边框会把它垫成一张 22px 空白卡片。
     * （2026-09-23 真机实测：某会话 5 个空 turn-process 被显形，主人截图圈出的空白框就是它。）
     */
    var CARD_KINDS = [
      "tool-call",
      "context",
      "system-prompt",
      "command",
      "manual-compaction",
      "compaction",
      "turn-process",
    ].map(function (kind) {
      return '[data-chat-flow-kind="' + kind + '"]:not([hidden])';
    }).join(",");

    var COLLAPSED_KEY = "dshome.conversation.thinkCollapsed.v1";
    var MAX_COLLAPSED = 400;

    // ── 样式 ───────────────────────────────────────────────────────────────
    // 边框用 border-l2（比 l1 深一档）：浅色主题下 bg-layer-1 白 ≈ 页面底 #f7f9fc，
    // 只靠 l1 边框几乎看不出卡片；配 soft 阴影把卡片"托"起来。
    /** 卡片圆角（一处调全生效：think / 工具 / 命令 / 系统注入卡共用）。 */
    var CARD_RADIUS = 16;
    var CARD = [
      "background:var(--dsw-alias-bg-layer-1,#131a29)",
      "border:1px solid var(--dsw-alias-border-l2,#2a3a5c)",
      "border-radius:" + CARD_RADIUS + "px",
      "box-sizing:border-box",
      "box-shadow:var(--dsw-elevation-soft,none)",
    ].join(";");

    /** 官方 Think 正文行高＝calc(20px + 字体增量)，12 行窗跟着字体设置一起长。 */
    var LINE = "calc(20px + var(--dsh-content-font-delta-secondary,0px))";

    var STYLE = [
      // ① Think 卡片（展开态也在同一张卡片里——卡片包的是官方 root，不是正文）
      THINK + "{" + CARD + ";padding:8px 14px}",
      // ①b 折叠态（人手动收起后）：官方折叠态把高度写死 24px 且 contain:size layout，
      //     我们加了内边距 ⇒ 内容会溢出卡片下边缘（真机实测：卡片 260→286，内容排到 295）。
      //     ⚠️ 必须提权重：官方 chat 的 CSS 是「打开会话」时才懒加载插入的，晚于本插件注入，
      //     同权重（0,2,0）会盖掉我们这条 ⇒ 用 [data-state] 把权重抬到 (0,3,0)。
      //     （data-state 是官方必然输出的语义属性，不影响匹配范围。）
      THINK + "[data-state]:not([data-expanded]){height:auto;contain:layout}",
      // ② 12 行窗：只在「展开态」生效；用户手动收起后官方回落 24px 一行摘要，卡片不塌
      THINK + "[data-expanded] " + THINK_BODY + "{" +
        "max-height:calc(" + THINK_LINES + " * (" + LINE + "));" +
        "overflow-y:auto;overscroll-behavior:contain;padding-right:6px;scrollbar-width:thin;" +
        "scrollbar-color:var(--dsw-alias-border-l2,#2a3a5c) transparent}",
      // ③ 工具/命令/系统注入块卡片
      CARD_KINDS + "{" + CARD + ";padding:10px 14px}",
    ].join("");

    function ensureStyle0() {
      // 以 **DOM 为真源**（2026-09-26 统一纪律）：只看内存 flag 会在客户端热更新后失效——
      // 模块状态重置、`<style>` 节点可能已不在 DOM，flag 却说"注入过" ⇒ 元素裸渲染、看着像丢渲染。
      if (document.querySelector("style[data-plugin='dshome-conversation']")) return;
      try {
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dshome-conversation");
        tag.textContent = STYLE;
        document.head.appendChild(tag);
      } catch (e) {
        console.warn("dshome-conversation: style failed", e);
      }
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
        if (G['conversation']) return;
        G['conversation'] = true;
        var sel = "style[data-plugin='dshome-conversation']";
        var check = function () { try { if (!document.querySelector(sel)) ensureStyle0(); } catch (e) { /* 忽略 */ } };
        check();
        if (typeof MutationObserver === 'function' && document.head) new MutationObserver(check).observe(document.head, { childList: true });
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', check);
      } catch (e) { /* 守卫失败不阻断插件本身 */ }
    }

    /** 幂等入口：样式在位 + 守卫挂起（守卫内部同样调 ensureStyle0 补写）。 */
    function ensureStyle() { ensureStyle0(); guardStyle(); }


    // ── 用户收起记账（localStorage）────────────────────────────────────────
    function readCollapsed() {
      try {
        var a = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
        return Array.isArray(a) ? a : [];
      } catch (e) {
        return [];
      }
    }
    function writeCollapsed(list) {
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(list.slice(-MAX_COLLAPSED)));
      } catch (e) { /* 无 localStorage → 只在内存里记账 */ }
    }
    var collapsed = readCollapsed();

    /** 稳定行标识：外层 flow key + 该 flow 内第几个 Think 行（官方锚点皆稳定，不含哈希类名）。 */
    function keyOf(root) {
      try {
        var flow = root.closest ? root.closest(FLOW) : null;
        if (!flow) return "";
        var flowKey = flow.getAttribute("data-chat-flow-key") || "";
        if (!flowKey) return "";
        var all = flow.querySelectorAll(THINK);
        var idx = Array.prototype.indexOf.call(all, root);
        return flowKey + "#" + idx;
      } catch (e) {
        return "";
      }
    }
    function isCollapsed(key) { return key !== "" && collapsed.indexOf(key) >= 0; }
    function markCollapsed(key) {
      if (key === "" || isCollapsed(key)) return;
      collapsed.push(key);
      writeCollapsed(collapsed);
    }
    function unmarkCollapsed(key) {
      var i = collapsed.indexOf(key);
      if (i < 0) return;
      collapsed.splice(i, 1);
      writeCollapsed(collapsed);
    }

    // ── 展开 / 跟随 ────────────────────────────────────────────────────────
    var autoClicking = false;

    /** 正文容器（官方展开后才存在）。 */
    function bodyOf(root) {
      try {
        return root.querySelector(THINK_BODY);
      } catch (e) {
        return null;
      }
    }

    /**
     * 让一条 Think 行进入官方的「已展开」状态。
     * 用合成点击触发官方 onClick（ReasoningRow 传了 expandOnRowClick，事件冒泡到 React root 委托），
     * 而不是去改 React state —— 不动官方渲染器。
     */
    function expand(root) {
      if (root.hasAttribute("data-expanded")) return;
      var key = keyOf(root);
      if (isCollapsed(key)) return; // 人收过的，不硬撑
      var row = root.querySelector(THINK_ROW);
      if (!row) return;
      autoClicking = true;
      try {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        // 合成点击失败 ⇒ 静默降级：只留卡片样式
      } finally {
        autoClicking = false;
      }
    }

    /**
     * 跑动中贴末尾（只看较新行）——**但人一翻历史就松手**。
     * 2026-09-23 主人报障：「我手动滚上去看你之前的思考，你立刻又把我滚回最新」。
     * 判据不靠 scroll 事件：它异步派发，而流式内容一直在增长 ⇒ 会把我们自己的贴底误判成"人滚了"。
     * 改用「记住我们上次滚到哪」：
     *   - 从没人碰过（lastSet 没有记录）⇒ 跟随；
     *   - scrollTop 偏离我们设的值、且离底还远 ⇒ 人翻上去看历史了 ⇒ 松手；
     *   - 人滚回底部 ⇒ 自动接上继续跟随。
     */
    var FOLLOW_SLACK = 24;
    var lastSet = new WeakMap(); // body -> 我们上次设定的 scrollTop

    function setScrollTop(body, top) {
      body.scrollTop = top;
      lastSet.set(body, body.scrollTop); // 浏览器会 clamp，存「读回的真实值」
    }

    /** 人是否正在自己看历史（偏离我们的落点、且没到底）。 */
    function humanTookOver(body) {
      var mine = lastSet.get(body);
      if (mine === undefined) return false;
      if (Math.abs(body.scrollTop - mine) <= 4) return false;
      return body.scrollHeight - body.scrollTop - body.clientHeight > FOLLOW_SLACK;
    }

    function followEnd(root) {
      var body = bodyOf(root);
      if (!body || body.scrollHeight <= body.clientHeight) return;
      if (humanTookOver(body)) return; // 人在看历史 ⇒ 松手，不把他拽回最新
      setScrollTop(body, body.scrollHeight);
    }

    /** 跑完回顶端：思路起点。人自己滚过就礼让，不把他拽回顶端。 */
    function rewind(root) {
      var body = bodyOf(root);
      if (!body || body.scrollTop === 0) return;
      if (humanTookOver(body)) return;
      setScrollTop(body, 0);
    }

    // ── 扫描循环（rAF 节流）────────────────────────────────────────────────
    var lastState = new WeakMap();
    function sweep() {
      var roots = document.querySelectorAll(THINK);
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        var state = root.getAttribute("data-state");
        if (!root.hasAttribute("data-expanded")) {
          expand(root);
        } else if (state === "running") {
          followEnd(root);
        }
        var prev = lastState.get(root);
        if (prev === "running" && state !== "running") rewind(root);
        lastState.set(root, state);
      }
    }

    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      try {
        requestAnimationFrame(function () {
          scheduled = false;
          try { sweep(); } catch (e) { /* 静默降级 */ }
        });
      } catch (e) {
        scheduled = false;
      }
    }

    // ── 交互识别：分清「我们撑开的」和「人收起的」──────────────────────────
    function onDocumentClick(event) {
      if (autoClicking) return;
      try {
        var t = event.target;
        var row = t && t.closest ? t.closest(THINK_ROW) : null;
        if (!row) return;
        var root = row.closest(THINK);
        if (!root) return;
        var key = keyOf(root);
        // 点击发生在收起方向 ⇒ 这是人的选择，记账；反之是重新展开 ⇒ 解除记账
        if (root.hasAttribute("data-expanded")) markCollapsed(key);
        else unmarkCollapsed(key);
      } catch (e) { /* 静默降级 */ }
    }

    // ── 启动 ───────────────────────────────────────────────────────────────
    var started = false;
    function start() {
      if (started) return;
      started = true;
      try {
        document.addEventListener("click", onDocumentClick, true);
      } catch (e) { /* 静默降级 */ }
      schedule(); // 首轮
      try {
        var observer = new MutationObserver(function () { schedule(); });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true, // 流式思考逐字增长 ⇒ 持续贴末尾
          attributes: true,
          attributeFilter: ["data-state", "data-expanded"],
        });
      } catch (e) {
        console.warn("dshome-conversation: observer failed", e);
      }
    }

    function apply() {
      try { ensureStyle(); } catch (e) { console.warn("dshome-conversation: style init failed", e); }
      try { start(); } catch (e) { console.warn("dshome-conversation: init failed", e); }
    }

    exports.apply = apply;
    return module.exports;
  },
});
