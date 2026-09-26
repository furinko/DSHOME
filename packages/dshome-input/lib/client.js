// dshome-input — browser client module（DSHOME 三档输入队列 dock）。
//
// 形态：shadow 官方 `conversation.input.dock`（同 id "queue"、priority -1，低者胜），
// 用 DSHOME 自有视觉渲染「排队 / 插话 / 立即」三档 + 上移下移调序 / 打回输入框 / 删除 / 清空。
//
// 契约（本机 @deepseek-ai/dsh 0.1.5-rc.2 核实，非推测）：
//   - slot `conversation.input.dock`（kind list / scope session）→ ui-conversation/lib/client.js:14369
//     覆盖规则「同 cell 同 priority 抛错，priority 低者渲染」→ ui-slots/lib/index.js:112-122
//   - `QueueAction = edit | remove | steer` → dsh-api-session-controller types.d.ts:135
//   - 队列快照 `snapshot.queue`（placement: queued|steering|context / text / preview / id）→ contract/snapshot.d.ts:73
//   - 服务面 `conversation.send / updateQueue / cancel` → ui-conversation types/client/service.d.ts:38-50
//   - **宽度与贴合照抄官方 dock 容器**（不再硬编码 780px）：官方 QueueDock 的 `_dock` 用
//     `--dsh-composer-card-max-width` / `--dsh-composer-side-clearance` / `--dsh-composer-dock-inset`
//     / `--dsh-composer-stack-gap` 四个官方变量算宽度与负边距贴合 —— 本文件同式复用 ⇒ 与输入框天然同宽同贴合。
//   - 调序走宿主侧 inbox（官方 remote 面没有重排通道）：POST `/dshome-input/reorder`，由本包 host 半注册。
//
// 三档语义（走官方既有通道）：
//   绿 later = 保持排队；黄 next = updateQueue(id,{kind:'steer'})；
//   红 now = cancel() → updateQueue(id,{kind:'remove'}) → send(text)（inbox 禁止重复插队，故须重发）。
//
// 键盘（2026-09-23 主人点名）：焦点不在输入面时，敲一下裸 Enter → 把光标送回官方输入框。
//   - 选择器 `[data-composer-input]` 是官方 ComposerContentEditable 的语义属性（全页唯一；
//     类名 `uV2eYG_input` 是 CSS-Module 哈希，不可依赖——同 dshome-conversation 的选择器纪律）。
//   - 真机实测（无头 Chrome 连本机 3099，焦点在 BODY 时派发 Enter）：**无人处理**
//     （defaultPrevented 捕获前/后皆 false，焦点不动）⇒ 这个键位是空的，可安全接管。
//   - 保守接管（任一条命中就完全不碰，宁可漏也不抢别人的回车）：带 Ctrl/Alt/Meta/Shift ·
//     IME 组合中 · 事件已被别人 preventDefault · 焦点已在输入面或按钮上 · 输入框不存在或
//     当前不可编辑（无会话/未选工作区时它 contentEditable=false）。
//
// 容错：任一动作失败只 notify 提示、绝不抛断 UI（照 dshome-theme 的降级纪律）。
window.__ModuleLoader__.load({
  id: "dshome-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let jsxRuntime = require("react/jsx-runtime");
    let jsx = jsxRuntime.jsx;
    let jsxs = jsxRuntime.jsxs;

    /** 本包 host 半注册的同源重排端点（两侧路径必须一致）。 */
    const REORDER_PATH = "/dshome-input/reorder";

    /** 档位外观：绿排队 / 黄插话 / 红立即（走 DSHOME 主题 token，缺失时回退）。 */
    const TIERS = {
      later: { label: "排队", color: "var(--dsw-alias-state-success-primary, #30a46c)" },
      next: { label: "插话", color: "var(--dsw-alias-state-warning-primary, #e0a03a)" },
      now: { label: "立即", color: "var(--dsw-alias-state-error-primary, #e5484d)" },
    };

    /** 队列项当前档位：steering = 已插话（黄），其余 = 排队（绿）。 */
    function tierOf(item) {
      return item.placement === "steering" ? "next" : "later";
    }

    function bodyOf(item) {
      const text = item.text;
      if (typeof text === "string" && text.length > 0) return text;
      return typeof item.preview === "string" ? item.preview : "";
    }

    /** 线性描边图标（16 格 / 1.5px / currentColor）——与官方、DSHOME 同一路数，不用 emoji 字符。 */
    function icon(paths) {
      return jsx("svg", {
        viewBox: "0 0 16 16",
        width: 15,
        height: 15,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        children: paths.map((d, index) => jsx("path", { d: d }, String(index))),
      });
    }

    const ICON = {
      up: () => icon(["M4.5 9.5 8 6l3.5 3.5"]),
      down: () => icon(["M4.5 6.5 8 10l3.5-3.5"]),
      now: () => icon(["M8.8 2 4 9h3.2L7 14l4.8-7H8.6z"]),
      draft: () => icon(["M6.5 5 3 8.5 6.5 12", "M3 8.5h6.2a3.8 3.8 0 0 1 3.8 3.8v.7"]),
      trash: () => icon(["M3.5 5h9", "M6.5 5V3.6h3V5", "M5.2 5l.5 8h4.6l.5-8"]),
    };

    /** 外层容器＝官方 dock 的宽度/间距公式（与输入框对齐）；内层＝DSHOME 自有面板。 */
    const CSS = [
      ".dshome-input-dock{box-sizing:border-box;",
      "width:calc(100% - var(--dsh-composer-side-clearance,0px)*2 - var(--dsh-composer-dock-inset,0px)*2);",
      "max-width:calc(var(--dsh-composer-card-max-width,780px) - var(--dsh-composer-dock-inset,0px)*2);",
      "margin:0 auto calc(0px - var(--dsh-composer-stack-gap,0px) - 3px);",
      "padding:0 var(--dsh-composer-dock-inset,0px);flex:none}",
      ".dshome-input-panel{background:var(--dsw-alias-bg-layer-2,#172032);",
      "border:1px solid var(--dsw-alias-border-l1,#1e2a44);border-bottom:0;border-radius:12px 12px 0 0;",
      "overflow:hidden;box-shadow:0 -8px 22px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary,#dbe4f0);",
      "font-family:inherit}",
      ".dshome-input-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;",
      "color:var(--dsw-alias-label-tertiary,#8fa3c0)}",
      ".dshome-input-hint{color:var(--dsw-alias-label-tertiary,#8fa3c0);opacity:.85}",
      ".dshome-input-clear{margin-left:auto;border:0;background:0 0;color:var(--dsw-alias-label-secondary,#c3d0e4);",
      "font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;cursor:pointer}",
      ".dshome-input-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(107,132,255,.1));",
      "color:var(--dsw-alias-label-primary,#dbe4f0)}",
      ".dshome-input-confirm{display:none;margin-left:auto;align-items:center;gap:6px}",
      "[data-confirming='1'] .dshome-input-confirm{display:inline-flex}",
      "[data-confirming='1'] .dshome-input-clear{display:none}",
      ".dshome-input-danger{border:0;border-radius:6px;cursor:pointer;font:inherit;font-size:12px;padding:2px 8px;",
      "background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 16%, transparent);",
      "color:var(--dsw-alias-state-error-primary,#e5484d)}",
      ".dshome-input-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 28%, transparent)}",
      ".dshome-input-row{display:flex;align-items:center;gap:10px;padding:7px 12px;",
      "border-top:1px solid var(--dsw-alias-border-l1,#1e2a44)}",
      ".dshome-input-bar{width:3px;height:18px;border-radius:2px;flex:none}",
      ".dshome-input-chip{flex:none;font:inherit;font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;",
      "border:1px solid currentColor;background:transparent;cursor:pointer}",
      ".dshome-input-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(107,132,255,.1))}",
      ".dshome-input-text{flex:1;min-width:0;font-size:14px;color:var(--dsw-alias-label-primary,#dbe4f0);",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshome-input-acts{display:flex;gap:2px;flex:none;align-items:center;opacity:0;transition:opacity .12s}",
      ".dshome-input-row:hover .dshome-input-acts,.dshome-input-row:focus-within .dshome-input-acts{opacity:1}",
      ".dshome-input-act{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;",
      "border:0;border-radius:7px;background:transparent;cursor:pointer;padding:0;",
      "color:var(--dsw-alias-label-secondary,#c3d0e4)}",
      ".dshome-input-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(107,132,255,.1));",
      "color:var(--dsw-alias-label-primary,#dbe4f0)}",
      ".dshome-input-act:disabled{opacity:.35;cursor:default}",
      ".dshome-input-sep{width:1px;height:14px;background:var(--dsw-alias-border-l2,#2a3a5c);margin:0 2px;flex:none}",
    ].join("");

    function ensureStyle0() {
      try {
        if (typeof document === "undefined" || !document.head) return;
        if (document.querySelector("style[data-dshome-input]")) return;
        const tag = document.createElement("style");
        tag.setAttribute("data-dshome-input", "1");
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        console.warn("dshome-input: style inject failed", error);
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
        if (G['input']) return;
        G['input'] = true;
        var sel = "style[data-dshome-input='1']";
        var check = function () { try { if (!document.querySelector(sel)) ensureStyle0(); } catch (e) { /* 忽略 */ } };
        check();
        if (typeof MutationObserver === 'function' && document.head) new MutationObserver(check).observe(document.head, { childList: true });
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', check);
      } catch (e) { /* 守卫失败不阻断插件本身 */ }
    }

    /** 幂等入口：样式在位 + 守卫挂起（守卫内部同样调 ensureStyle0 补写）。 */
    function ensureStyles() { ensureStyle0(); guardStyle(); }


    /** 官方输入框（ComposerContentEditable 的语义属性；真机核实全页唯一）。 */
    const COMPOSER_SELECTOR = "[data-composer-input]";

    /** 焦点已经落在"输入面或可点控件"上时，Enter 归它们（输入框自己提交、按钮自己点击）。 */
    const INTERACTIVE_SELECTOR = [
      "input", "textarea", "select", "button", "a",
      "[contenteditable='']", "[contenteditable='true']",
      "[role='textbox']", "[role='combobox']", "[role='menu']", "[role='listbox']",
      "[role='option']", "[role='tab']", "[role='switch']", "[role='menuitem']",
    ].join(",");

    function inInteractiveTarget(node) {
      if (node === null || node === undefined || typeof node.closest !== "function") return false;
      try {
        return node.isContentEditable === true || node.closest(INTERACTIVE_SELECTOR) !== null;
      } catch {
        return false;
      }
    }

    /**
     * 全局键盘：焦点在输入框外按裸 Enter → 聚焦官方输入框（主人点名 2026-09-23）。
     *
     * 挂**冒泡阶段**（capture 为 false）：别人若在 target 上处理了这个 Enter 并 preventDefault，
     * 我们这里就看得到、直接放手——绝不抢在别人前面。失败静默降级，绝不影响 UI。
     *
     * @returns 卸载函数（重复 load 时先卸旧的，避免叠加监听）。
     */
    function installEnterToFocus() {
      if (typeof document === "undefined") return () => {};
      const onKeyDown = (event) => {
        if (event.key !== "Enter" || event.repeat === true) return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (event.defaultPrevented === true) return;
        if (inInteractiveTarget(event.target) || inInteractiveTarget(document.activeElement)) return;
        const composer = document.querySelector(COMPOSER_SELECTOR);
        // 无会话 / 未选工作区时官方把同一个 div 渲染成 inert（contentEditable=false）⇒ 不抢键。
        if (composer === null || composer.isContentEditable !== true) return;
        event.preventDefault();
        composer.focus();
        // Lexical 自己会接手选区（真机实测：focus 后选区已在框内）；只在它没接住时兜底放到末尾，
        // 不覆盖它恢复出来的光标位置。
        const selection = window.getSelection();
        if (selection === null) return;
        const anchor = selection.anchorNode;
        if (anchor !== null && composer.contains(anchor)) return;
        try {
          const range = document.createRange();
          range.selectNodeContents(composer);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch { /* 兜底失败不影响已完成的聚焦 */ }
      };
      try {
        document.addEventListener("keydown", onKeyDown);
      } catch (error) {
        console.warn("dshome-input: enter-to-focus install failed", error);
        return () => {};
      }
      return () => {
        try { document.removeEventListener("keydown", onKeyDown); } catch { /* 卸载失败无需上报 */ }
      };
    }

    /** 全局键盘监听只装一次（client 半重复 load 时先卸旧的，不留叠加监听）。 */
    let enterToFocusOff = null;

    /** 三档规划 dock 本体（props 由 slot 的 inject 面提供）。 */
    function DshomeInputDock(props) {
      const useSession = props.useSession;
      const updateQueue = props.updateQueue;
      const cancel = props.cancel;
      const send = props.send;
      const setDraft = props.setDraft;
      const notify = props.notify;
      const reorder = props.reorder;

      const queue = useSession((s) => s.queue) ?? [];
      const running = useSession((s) => s.running) ?? false;
      const subagent = useSession((s) => s.subagent) ?? null;
      // 与官方 QueueDock 同口径：子代理不可续时队列只读。
      const mutable = subagent === null || (subagent.address && subagent.address.mode === "continuable");

      if (queue.length === 0) return null;

      const message = (error) => (error instanceof Error ? error.message : String(error));
      const fail = (what) => (error) => notify("error", `${what}失败：${message(error)}`);
      const textOnly = (item, what) => {
        if (item.text === null) {
          notify("error", `该条目含非文本内容，无法${what}`);
          return null;
        }
        return bodyOf(item);
      };

      const toNext = (item) => {
        updateQueue(item.id, { kind: "steer" }).catch(fail("改为插话"));
      };
      const toLater = (item) => {
        const text = textOnly(item, "收回排队");
        if (text === null) return;
        updateQueue(item.id, { kind: "remove" }).then(() => send(text)).catch(fail("收回排队"));
      };
      const toNow = (item) => {
        if (!running) {
          notify("error", "会话空闲，无需打断");
          return;
        }
        const text = textOnly(item, "立即发送");
        if (text === null) return;
        cancel().then(() => updateQueue(item.id, { kind: "remove" })).then(() => send(text)).catch(fail("立即发送"));
      };
      const remove = (item) => {
        updateQueue(item.id, { kind: "remove" }).catch(fail("删除"));
      };
      const backToDraft = (item) => {
        const text = textOnly(item, "打回输入框");
        if (text === null) return;
        updateQueue(item.id, { kind: "remove" }).then(() => setDraft(text)).catch(fail("打回输入框"));
      };
      /** 调序：把宿主侧实时顺序一并送上，队列在调用中变了会被拒（绝不打乱）。 */
      const move = (item, delta) => {
        const ids = queue.map((row) => String(row.id));
        const from = ids.indexOf(String(item.id));
        const to = from + delta;
        if (from < 0 || to < 0 || to >= ids.length) return;
        reorder(item.id, to, ids).catch(fail("调整顺序"));
      };
      /** 清空：两段确认（不用浏览器原生 confirm）；确认态由 data-confirming 驱动、4 秒自动复位。 */
      const clearAll = (event) => {
        const scope = event.currentTarget.closest("[data-confirm-scope]");
        if (scope === null) return;
        if (scope.getAttribute("data-confirming") !== "1") {
          scope.setAttribute("data-confirming", "1");
          setTimeout(() => scope.removeAttribute("data-confirming"), 4000);
          return;
        }
        scope.removeAttribute("data-confirming");
        Promise.all(queue.map((item) => updateQueue(item.id, { kind: "remove" }))).catch(fail("清空"));
      };
      const cancelClear = (event) => {
        const scope = event.currentTarget.closest("[data-confirm-scope]");
        if (scope !== null) scope.removeAttribute("data-confirming");
      };

      const rows = queue.map((item, index) => {
        const tier = tierOf(item);
        const meta = TIERS[tier];
        const body = bodyOf(item);
        return jsxs("div", {
          className: "dshome-input-row",
          children: [
            jsx("span", { className: "dshome-input-bar", style: { background: meta.color } }),
            jsx("button", {
              type: "button",
              className: "dshome-input-chip",
              style: { color: meta.color },
              disabled: !mutable,
              title: tier === "next" ? "点一下收回排队（绿）" : "点一下改为插话（黄，当前动作结束后注入下一步）",
              onClick: () => (tier === "next" ? toLater(item) : toNext(item)),
              children: meta.label,
            }),
            jsx("span", { className: "dshome-input-text", title: body, children: body }),
            jsxs("span", {
              className: "dshome-input-acts",
              children: [
                jsx("button", {
                  type: "button",
                  className: "dshome-input-act",
                  title: "上移一位",
                  disabled: !mutable || index === 0,
                  onClick: () => move(item, -1),
                  children: ICON.up(),
                }),
                jsx("button", {
                  type: "button",
                  className: "dshome-input-act",
                  title: "下移一位",
                  disabled: !mutable || index === queue.length - 1,
                  onClick: () => move(item, 1),
                  children: ICON.down(),
                }),
                jsx("span", { className: "dshome-input-sep" }),
                jsx("button", {
                  type: "button",
                  className: "dshome-input-act",
                  title: "立即打断并发送",
                  disabled: !mutable || !running,
                  onClick: () => toNow(item),
                  children: ICON.now(),
                }),
                jsx("button", {
                  type: "button",
                  className: "dshome-input-act",
                  title: "打回输入框继续编辑",
                  disabled: !mutable,
                  onClick: () => backToDraft(item),
                  children: ICON.draft(),
                }),
                jsx("button", {
                  type: "button",
                  className: "dshome-input-act",
                  title: "删除这条",
                  disabled: !mutable,
                  onClick: () => remove(item),
                  children: ICON.trash(),
                }),
              ],
            }),
          ],
        }, String(item.id));
      });

      return jsx("div", {
        className: "dshome-input-dock",
        "data-dshome-input-dock": "",
        children: jsxs("div", {
          className: "dshome-input-panel",
          "data-confirm-scope": "",
          children: [
            jsxs("div", {
              className: "dshome-input-head",
              children: [
                jsx("span", { children: `${String(queue.length)} 条待发` }),
                jsx("span", { className: "dshome-input-hint", children: "绿排队 · 黄插话 · 上移/下移调序" }),
                jsx("button", {
                  type: "button",
                  className: "dshome-input-clear",
                  disabled: !mutable,
                  onClick: clearAll,
                  children: "清空",
                }),
                jsxs("span", {
                  className: "dshome-input-confirm",
                  children: [
                    jsx("button", {
                      type: "button",
                      className: "dshome-input-danger",
                      onClick: clearAll,
                      children: `确认清空 ${String(queue.length)} 条`,
                    }),
                    jsx("button", {
                      type: "button",
                      className: "dshome-input-clear",
                      style: { marginLeft: 0 },
                      onClick: cancelClear,
                      children: "取消",
                    }),
                  ],
                }),
              ],
            }),
            ...rows,
          ],
        }),
      });
    }

    /** 所需服务：槽注册表 + 会话 scope + 对话服务（三档与调序全部经官方/宿主公开面）。 */
    const inject = ["slots", "sessions", "conversation"];

    function apply(ctx) {
      ensureStyles();
      // 键盘增强：与 dock 无关、不依赖任何服务——独立 try 包住，装不上也不影响 dock 注册。
      try {
        if (typeof enterToFocusOff === "function") enterToFocusOff();
        enterToFocusOff = installEnterToFocus();
      } catch (error) {
        console.warn("dshome-input: enter-to-focus failed", error);
      }
      try {
        ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
          name: "conversation.input.dock",
          id: "queue",
          order: 20,
          // 低于官方（默认 0）＝遮蔽官方 QueueDock；同 id 同 priority 会抛错，故必须 -1。
          priority: -1,
          inject: (sessionId) => {
            const actx = ctx.sessions.scope(sessionId);
            if (actx === undefined) throw new Error(`dshome-input: session "${String(sessionId)}" resolved no scope`);
            const conversation = actx.get("conversation");
            if (conversation === undefined) throw new Error("dshome-input: conversation service unavailable");
            return {
              updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
              cancel: () => conversation.cancel(),
              send: (text) => conversation.send(text),
              setDraft: (text) => {
                conversation.input.for(actx).actions.setDraft(text);
              },
              notify: (level, text) => {
                conversation.input.for(actx).notify(level, text);
              },
              /** 调序走本包 host 半的同源路由（官方 remote 面没有重排通道）。 */
              reorder: (itemId, toIndex, expectedOrder) => fetch(REORDER_PATH, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  sessionId: String(sessionId),
                  itemId: String(itemId),
                  toIndex,
                  expectedOrder: expectedOrder.map((id) => String(id)),
                }),
              }).then(async (response) => {
                if (response.ok) return;
                let text = `HTTP ${String(response.status)}`;
                try {
                  const payload = await response.json();
                  if (payload && payload.error && payload.error.message) text = payload.error.message;
                } catch { /* 保留 HTTP 状态兜底 */ }
                throw new Error(text);
              }),
            };
          },
        }, DshomeInputDock));
      } catch (error) {
        console.warn("dshome-input: dock registration failed", error);
      }
    }

    module.exports = { name: "dshome-input", inject, apply };
    return module.exports;
  },
});
