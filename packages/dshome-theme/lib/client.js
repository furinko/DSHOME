// ═══════════════════════════════════════════════════════════════════════════════
// 【缩略导航 · 设计约定】（2026-09-26 与主人逐轮校正后定下；改之前先读这六条）
//
//   ① **两个高度必须分开**（踩过最久的坑）：
//      比例尺 / 滑块高 / 画布总长 → 取**标准条高** `bandPx`（由视口算，与会话无关）
//      视窗自身高度 / 滑块的行走行程 → 取**当前视窗高** `box.clientHeight`（短会话会被截断）
//      混用这两个高度 = 短会话里"内容都显示全了还在动"（真事，主人报过）。
//      由此得到：滑块恒占 8% 标准条高（会话多长都不变）；内容装得下视窗时平移量**强制为 0**。
//
//   ② **位置只取浏览器真值**：`fromEnd = scrollHeight − rect.top − rect.height`。
//      不许自己按字数估高——估算与真实排版不是一把尺子，会让"点哪条"和"屏幕上显示哪条"错位。
//
//   ③ **脏值不入缓存**：块的 rect 高度为 0（还没渲染出来）时，不给它建缓存条目，
//      只用临时高度兜这一帧；真值一到立刻替换。
//
//   ④ **长高的过程没有 DOM 事件**：块高度（markdown/高亮/图片/字体）是长出来的，不改 DOM ⇒ 没有 mutation。
//      所以必须有「复核」：内容变化后按 500ms 跟，**连续 3 次块表不变**才停（一次没变不算稳定）。
//      它不是周期轮询：稳定即停，静止后零读取、零重绘。
//
//   ⑤ **官方导轨（`nav[…_frame]`）只用来对齐右边缘**：它不存在/太小时**不隐藏缩略条**，
//      兜底贴右边缘 8px（原来在这里隐藏 ⇒ 表现是"其他会话没有缩略条"）。
//      选滚动容器时要挑**与视口相交**的那个（面板切换时旧会话的容器可能还留在 DOM 里且有高度）。
//
//   ⑥ **`content-visibility` 平时不挂**：它是本插件为"侧栏开合卡顿"加的，但会让视口外的块
//      **压根不排版**、尺寸变成占位值（`contain-intrinsic-size` 兜底）⇒ 缩略图/滚动条拿到假数据。
//      现在只在**列宽正在变**时临时挂上、静默 180ms 后摘掉（挂锁期间缩略图冻结不重画）。
// ═══════════════════════════════════════════════════════════════════════════════
// dshome-theme — browser client module.
//
// 1) 服务级注入 ["slots"]：保证 apply 时 ctx.slots 就绪（官方品牌同款契约）；
// 2) 通过 theme 服务 overrideTokens 注入 DSHOME 品牌蓝强调色（light/dark 成对）；
// 3) 按官方模式注册 DSHOME 品牌槽（sidebar.brand.mark/name、conversation.hero.brand.mark），
//    替换官方/回退品牌显示；
// 4) 会话右侧的「轮次缩略导航」（VSCode minimap 形态，见 ensureTurnMinimap）：官方 TurnNavigator
//    那列等距刻度视觉藏起来，由自绘的缩略条接管——按内容真实高度画缩略、半透明视口滑块、
//    点哪滚哪/按住连续拖。
// 容错：任一环节失败只静默降级，绝不阻断 UI。

window.__ModuleLoader__.load({
  id: "dshome-theme",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 当前 DSHOME 版本（发布版本号：与 packages/dshome package.json version、updates.json、DSHOME.iss MyAppVersion、shell-app 一致；由 scripts/sync-version.mjs 单源同步，勿手改——曾漏更停留在 v0.1.0 / v0.2.0）。 */
    const DSHOME_VERSION = "v0.3.5";

    /** 侧栏品牌标记：暂用官方鲸鱼图标（DSHOME 自有图标定稿后替换）。 */
    function DshomeMark({ size = 24, className }) {
      return react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.FishLogo, {
        size,
        className,
      });
    }

    /** 侧栏品牌名：DSHOME 横排字标 + 版本号徽章（同官方 buildRevision 底板样式）。 */
    function DshomeName() {
      return react_jsx_runtime.jsx(
        "span",
        {
          style: { display: "inline-flex", alignItems: "center", gap: 6, height: 24 },
          children: [
            react_jsx_runtime.jsx("span", {
              style: { color: "var(--dsw-alias-brand-primary, #4D6BFE)" },
              children: "DSHOME",
            }),
            react_jsx_runtime.jsx("span", {
              style: {
                height: 16,
                lineHeight: "16px",
                fontSize: 9,
                fontWeight: 500,
                fontFamily: "Consolas, 'Cascadia Mono', monospace",
                letterSpacing: 0,
                color: "var(--dsw-alias-label-primary-inverted, #0f1115)",
                background: "var(--dsw-alias-label-primary, #f4f6fb)",
                borderRadius: 3,
                padding: "0 4px",
                whiteSpace: "nowrap",
                alignSelf: "center",
              },
              children: DSHOME_VERSION,
            }),
          ],
        },
      );
    }

    /** 所需服务：UI 槽注册表（官方品牌同款）。 */
    const inject = ["slots"];

    // ── 通用设置 · 「通知」开关组（设置命名空间 `dshome`）─────────────────────────
    // 为什么在这儿：`cordis.patch.yml` 与本包描述一直宣称"通知开关在设置里"，但此前
    // **没有任何客户端卡片认领 `dshome` 命名空间** ⇒ 开关在界面上根本看不到（能力在、入口没露）。
    // host 侧 schema 由 `dshome/notify` 注册（enabled / notifyOnTurnCompletion /
    // notifyOnApproval / notifyOnUserQuestion），本行只是把它的入口露出来。
    // 依赖 `settingsScope` 走**动态 inject**（不是写进上面的 inject 数组）：该服务缺失时
    // 只少这一行，品牌皮肤与缩略导航照常——硬依赖会让整包不加载。
    /** 绑定后的设置 scope（apply 时绑；未就绪则保持 null ⇒ 组件渲染"不可用"文案）。 */
    var notifyScope = null;

    /** 通知栏的四项：`sub` = 受总开关管辖的分项。 */
    var NOTIFY_FIELDS = [
      { field: "enabled", label: "系统通知", hint: "总开关；关掉后下列提醒全部静音。" },
      { field: "notifyOnTurnCompletion", label: "回合完成时提醒", hint: "你发起的回合处理完毕时弹一条系统通知。", sub: true },
      { field: "notifyOnApproval", label: "需要我确认时提醒", hint: "出现确认弹窗（危险操作 / 沙箱放行）时弹通知。", sub: true },
      { field: "notifyOnUserQuestion", label: "有问题等我回答时提醒", hint: "模型提问、等你在选项里挑时弹通知。", sub: true },
    ];

    /** 设置行的外壳（与 dshome-assistant-identity 的通用设置行同款，视觉一致）。 */
    function notifyRowShell(title, children) {
      return react_jsx_runtime.jsx("div", {
        style: { borderBottom: "1px solid var(--dsw-alias-border-l2)", flexDirection: "column", gap: 8, padding: "16px 0", display: "flex" },
        children: [
          react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 14, fontWeight: 400, lineHeight: "22px" }, children: title }),
          children,
        ],
      });
    }

    /** 开关控件（原生 button + role=switch：键盘可聚焦、读屏可识别，不引第三方组件）。 */
    function NotifyToggle(props) {
      var on = props.on === true;
      var disabled = props.disabled === true;
      return react_jsx_runtime.jsx("button", {
        type: "button",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": props.label,
        disabled: disabled,
        onClick: disabled ? void 0 : props.onToggle,
        style: {
          flex: "0 0 auto", width: 40, height: 22, padding: 0, borderRadius: 11, position: "relative",
          border: "1px solid var(--dsw-alias-border-l2)",
          background: on ? "var(--dsw-alias-brand-primary,#4D6BFE)" : "var(--dsw-alias-bg-layer-3,#d5dbe6)",
          cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
          transition: "background .15s",
        },
        children: react_jsx_runtime.jsx("span", {
          style: {
            position: "absolute", top: 2, left: on ? 20 : 2, width: 16, height: 16, display: "block",
            borderRadius: "50%", background: "#fff", transition: "left .15s",
          },
        }),
      });
    }

    /** 「通知」行：读 scope 快照渲染，写回走 scope.set（host 侧同一命名空间）。 */
    function NotifySettingsRow() {
      var state = react.useState(function () { return notifyScope ? notifyScope.getSnapshot() : null; });
      var snap = state[0];
      var setSnap = state[1];
      react.useEffect(function () {
        if (!notifyScope) return void 0;
        setSnap(notifyScope.getSnapshot());
        return notifyScope.subscribe(function () { setSnap(notifyScope.getSnapshot()); });
      }, []);
      var status = snap ? snap.status : "loading";
      var value = (snap && snap.value) || {};
      var writable = snap ? snap.writable === true : false;
      // schema 默认全 true ⇒ 字段缺席即"开"（只有显式 false 才算关）。
      var master = value.enabled !== false;
      var setField = function (field, next) {
        if (!notifyScope || !writable) return;
        var pending = notifyScope.set(field, next);
        if (pending && typeof pending.catch === "function") {
          pending.catch(function (error) { console.warn("dshome-theme: notify setting write failed", error); });
        }
      };
      var body = status === "unavailable"
        ? react_jsx_runtime.jsx("div", {
            style: { color: "var(--dsw-alias-label-tertiary,#6b7a99)", fontSize: 12, lineHeight: "18px" },
            children: "当前不可用：Host 未提供 `dshome` 设置命名空间（通知仍按默认值工作）。",
          })
        : react_jsx_runtime.jsx("div", {
            style: { flexDirection: "column", gap: 14, display: "flex" },
            children: NOTIFY_FIELDS.map(function (item) {
              var on = value[item.field] !== false;
              return react_jsx_runtime.jsx("div", {
                key: item.field,
                style: { alignItems: "center", gap: 12, display: "flex" },
                children: [
                  react_jsx_runtime.jsx("div", {
                    style: { flex: 1, minWidth: 0 },
                    children: [
                      react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 13.5, lineHeight: "20px" }, children: item.label }),
                      react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary,#6b7a99)", fontSize: 11.5, lineHeight: "17px" }, children: item.hint }),
                    ],
                  }),
                  NotifyToggle({
                    on: on,
                    disabled: !writable || (item.sub === true && !master),
                    label: item.label,
                    onToggle: function () { setField(item.field, !on); },
                  }),
                ],
              });
            }),
          });
      return notifyRowShell("通知", body);
    }

    /** DSHOME 侧 CSS 覆盖（稳定属性选择器，升级/重装免疫）：
     *  ① input-traffic 插队 dock 限宽；
     *  ② 隐藏会话内容列两侧的宽度拖拽手柄——DSH 的 ConversationRoot 把它渲染在
     *     「对话/轨迹/心智/定时」**共用**的外壳层（body 内、viewArea 之外），与当前选中哪个页签无关，
     *     于是非对话页签也带着一个拖了没用、却会偷偷改掉对话宽度的隐形控件；全关后各页签一致
     *     （`data-width-handle` 是官方语义属性，非打包哈希，官方重新打包也不失效）。 */
    function ensureOverrides() {
      try {
        if (typeof document === "undefined" || !document.head) return;
        // 会话宽度恢复默认：清掉历史拖拽偏好。手柄关掉后该偏好已无法再被修改，
        // 留着只会让对话停在旧宽度；清掉后回落 clamp(680px, 列宽*0.64, 920px)。
        try { localStorage.removeItem("dsh.conversation.contentWidth"); } catch { /* 无 localStorage → 跳过 */ }
        if (document.querySelector("style[data-dshome-overrides]")) return;
        const tag = document.createElement("style");
        tag.setAttribute("data-dshome-overrides", "1");
        // ③ 会话区布局隔离（2026-09-23 主人报「开/没开侧边栏的会话来回切换很卡」）：
        //     成因链（源码已证）——侧栏开合会改会话列宽 → ConversationRoot 用
        //     resolveContentWidth() 重算 --dsh-chat-user-width（clamp(680, 列宽*0.64, 920)）
        //     → 整列文本重新折行；而官方 conversation 的 CSS 里 content-visibility /
        //     contain 是 0 处 ⇒ 屏幕外几千条消息也一起参与重排（真机实测：每次切换
        //     280~600ms 长任务，7 簇）。这里让「不在视口附近」的消息块跳过布局：宽度变化时
        //     它们根本不参与计算，只排眼前那几十块。contain-intrinsic-size 的 auto 关键字
        //     让浏览器记住实测高度，减少滚动条修正。
        //     ⚠️ 选择器用官方语义属性 [data-chat-turn]（非打包哈希，升级/重装免疫）；实测该
        //     属性落在 chat 的**每个消息块**（flowItem，见 ui-chat client.js:1603-1612）上，
        //     故粒度＝单块，估算高度取单块典型值 200px（助手回复/工具块/思考块的中位量级）。
        //     ⚠️ content-visibility 官方未声明，无需提权重；改动纯样式，删本行即回滚。
        // ⏸️【2026-09-26 暂时停用，等主人测准确度】下面这条已注释掉：
        //     `[data-chat-turn]{content-visibility:auto;contain-intrinsic-size:auto 200px}`
        //     停用原因：它让「不在视口附近」的块**压根不排版**，尺寸变成占位值（从没渲染过=200px 兜底），
        //     而 `scrollHeight` 也按这些占位值算 ⇒ 缩略图/滚动条拿到的"不可见部分高度"是假的，
        //     表现就是「要等排版」「往上加载更早后偏」「缩略条总在变」。
        //     恢复方法：把下面那一行加回 tag.textContent（已留在 ${''} 注释里），或直接搜 "⏸️"。
        //     [data-chat-turn]{content-visibility:auto;contain-intrinsic-size:auto 200px}
        // ④ 藏起官方「轮次导轨」（dsh-client-ui-chat 的 TurnNavigator）：交给下面自绘的缩略导航接管。
        //    为什么不自绘在它旁边而是取代它：官方按「轮」**等距**排刻度（每轮固定 10px，见 TURN_SPACING_PX），
        //    天生做不出"长段落占得多"的缩略比例，位置又由它内联算，两条并排只会互相打架。
        //    这里只压视觉与指针、**一根手指都没碰 React 的树**——删掉这一行官方导轨立刻回来。
        //    特异性 (0,1,2) 高于官方 `.eGxaPq_frame` 的 (0,1,0)，官方 CSS 后注入也照样赢。
        const RAIL = 'body nav[class*="_frame"]';
        tag.textContent =
          "[data-width-handle]{display:none}" +
          // ⏸️ 暂时停用（见上方说明）："[data-chat-turn]{content-visibility:auto;contain-intrinsic-size:auto 200px}" +
          RAIL + "{opacity:0;pointer-events:none}" +
          // ⑤ 缩略导航外壳（自绘，见 ensureTurnMinimap）：平时半透明不抢视线，指着它才亮起来
          ".dshome-minimap{position:fixed;z-index:6;cursor:pointer;border-radius:4px;opacity:.92;transition:opacity .15s ease}" +
          ".dshome-minimap:hover,.dshome-minimap[data-active]{opacity:1}" +
          ".dshome-minimap-view{position:absolute;inset:0;overflow:hidden;border-radius:4px;contain:paint}" +
          ".dshome-minimap canvas{position:absolute;left:0;top:0;width:100%;will-change:transform}" +
          ".dshome-minimap-thumb{position:absolute;left:0;right:0;border-radius:3px;background:var(--dsw-alias-label-tertiary);opacity:.22;pointer-events:none;transition:opacity .15s ease}" +
          // 视觉抓取环：长会话里框只有 ~10px，看着像被压扁。这圈 18px 的浅色环**只是外观**——
          // 框的几何（高度/位置）一个像素不动（实心条仍是真实视口范围），所以点击/悬停依旧分毫不差。
          ".dshome-minimap-thumb::after{content:'';position:absolute;left:-1px;right:-1px;top:50%;height:18px;transform:translateY(-50%);border-radius:5px;background:var(--dsw-alias-label-tertiary);opacity:.10;border:1px solid var(--dsw-alias-label-tertiary)}" +
          ".dshome-minimap:hover .dshome-minimap-thumb::after,.dshome-minimap[data-active] .dshome-minimap-thumb::after{opacity:.22}" +
          ".dshome-minimap:hover .dshome-minimap-thumb,.dshome-minimap[data-active] .dshome-minimap-thumb{opacity:.38}" +
          ".dshome-minimap-tip{position:absolute;right:calc(100% + 10px);transform:translateY(-50%);width:max-content;max-width:360px;min-width:96px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;opacity:0;transition:opacity .12s ease;white-space:pre-line;overflow-wrap:break-word;overflow:hidden}" +
          ".dshome-minimap-tip[data-show]{opacity:1}";
        document.head.appendChild(tag);
        /**
         * ③b 「宽度重排上锁」：平时**不注入** content-visibility（消息全部真实排版 ⇒ 缩略图/滚动条拿到的
         * 都是真尺寸）；只有**列宽正在变**（开合侧栏 / 拖会话宽度 / 窗口 resize）那一小段时间临时挂上，
         * 让屏幕外的块不参与重排（省掉真机实测的 280~600ms 长任务）；宽度静默 CV_IDLE_MS 后摘掉，
         * 让浏览器补一次真实布局（一次性，不在拖动过程中卡）。
         * 挂锁期间**冻结缩略图重画**（那时的尺寸是占位值，画了会错），摘锁后通知它重画一次归位。
         */
        const CV_RULE = "[data-chat-turn]{content-visibility:auto;contain-intrinsic-size:auto 200px}";
        const CV_IDLE_MS = 180;
        let cvTag = null;
        let cvTimer = 0;
        let cvLockedAt = 0;
        const cvUnlock = () => {
          // 时间守卫：万一这个定时器被提前触发（宿主/环境怪异），也别提前解锁
          if (Date.now() - cvLockedAt < CV_IDLE_MS) {
            try { cvTimer = window.setTimeout(cvUnlock, CV_IDLE_MS - (Date.now() - cvLockedAt)); } catch { /* 环境不支持 */ }
            return;
          }
          if (cvTimer !== 0) { try { window.clearTimeout(cvTimer); } catch { /* 环境不支持 */ } cvTimer = 0; }
          if (cvTag !== null) {
            try { cvTag.remove(); } catch { /* 已经没了 */ }
            cvTag = null;
          }
          window.__dshomeCvLocked = false;
          // 摘锁后总高/块高都会变回真值 ⇒ 让缩略图重画一次归位
          try { window.__dshomeMinimapRedraw?.(); } catch { /* 缩略图没装 */ }
        };
        const cvLock = () => {
          if (cvTag === null) {
            cvTag = document.createElement("style");
            cvTag.setAttribute("data-dshome-cv-temp", "1");
            cvTag.textContent = CV_RULE;
            document.head.appendChild(cvTag);
          }
          window.__dshomeCvLocked = true;
          cvLockedAt = Date.now();
          if (cvTimer !== 0) { try { window.clearTimeout(cvTimer); } catch { /* 同上 */ } }
          cvTimer = window.setTimeout(cvUnlock, CV_IDLE_MS);
        };
        if (typeof ResizeObserver === "function") {
          let watching = null;
          const watchSessionColumn = () => {
            const el = [...document.querySelectorAll('[class*="_scrollBody"]')]
              .find((e) => e.clientHeight > 0 && e.querySelector("[data-chat-turn]") !== null);
            if (el === null || el === watching) return el !== null;
            watching = el;
            try { new ResizeObserver(() => cvLock()).observe(el); } catch { /* 挂不上就退化：不加锁 */ }
            return true;
          };
          if (!watchSessionColumn()) {
            // 会话还没挂上来：短轮询等到它出现（找到就停）
            const wait = window.setInterval(() => { if (watchSessionColumn()) window.clearInterval(wait); }, 300);
          }
        }
      } catch (error) {
        console.warn("dshome-theme: override css failed", error);
      }
    }

    /* ------------------------------------------------------------------ *
     * 轮次缩略导航（VSCode minimap 形态）
     * ------------------------------------------------------------------ */

    /** 缩略条宽度：窄了看不出内容纹理，宽了挤占会话列（VSCode 默认约 100px，会话列给 58px）。 */
    const MINIMAP_WIDTH_PX = 58;
    /**
     * 缩略条高度：**不跟**官方导轨的 420px 上限——长会话几百个块挤在 420px 里每块只剩 1px，必然糊。
     */
    const MINIMAP_MAX_HEIGHT_PX = 760;
    /** 底部 composer（输入框）要留出的高度：缩略条不跟它抢地方。 */
    const MINIMAP_COMPOSER_RESERVE_PX = 152;
    /**
     * 缩略图**不放大**（默认 zoom = 1）：整篇会话压进条高。
     *
     * 【为什么必须不放大 · 主人两次反馈的正解】
     * 框在条内走的是「整篇比例」（`框顶 = 滚动量 × (条高−框高)/(全文−视口)`），
     * 内容走的是「自身坐标」（`内容位置 × 条高/全文`）。放大了 zoom 倍之后这两把尺子
     * **只在中间附近重合**，于是：
     *   ① 「点击后滑块位置和鼠标位置对不上」——点在哪，框不在哪；
     *   ② 算位置时的任何误差都被 zoom 放大成肉眼可见的偏移（zoom=6 时 1000px 的内容误差 = 44px）。
     * zoom = 1 时两条关系**恒等**（`(条高−框高)/(全文−视口) === 条高/全文`）⇒
     * 点哪 ⇒ 框心就到哪（贴着鼠标），且点中的那块正好落在视口中央 —— 两个要求同时成立。
     * 顺带：canvas 高度恒等于条高，滚动期间**只写 transform**（不脏布局），滚动更顺。
     * 想再试放大：控制台 `window.__dshomeMinimapZoom = 4`。
     */
    const MINIMAP_DEFAULT_ZOOM = 1;
    /**
     * 比例尺（**唯一一套，不再分模式**）：
     *   缩略条 = 整篇会话按固定比例尺 k 画出来的长卷；视窗 = 屏幕右侧那个固定高度的可见窗口；
     *   滑块 = 当前屏幕内容（一屏）在缩略条上的位置，高度 = 一屏 × k。
     * 三者自动自洽：
     *   ① k 固定 ⇒ 滑块高固定、视窗里装的内容量固定（会话再长也不变，不会"压扁"）；
     *   ② 滚动时缩略条按 (缩略条长−视窗高)/(缩略条长−滑块高) 平移 ⇒ 会话顶/底时缩略条顶/底正好贴视窗边；
     *   ③ 点击视窗某处 ⇒ 那里画着的内容滚到屏幕中央，滑块随之覆盖它、缩略条随之平移。
     * k 的取值 = 滑块占视窗高度的 MINIMAP_THUMB_RATIO。
     */
    const MINIMAP_THUMB_RATIO = 0.08;
    /**
     * 「第一眼」估算用的系数：**只**用于「浏览器还没排好版」的那一瞬（一次布局都不读 ⇒ 立刻有东西看），
     * 排版一就绪立刻换成真值（真值那一路才是主人要的准，见 draw）。估的那一版会整体缩放到真实总高，
     * 所以它和真值是**同一把尺**，不会出现"两把尺子对不上"。
     */
    const MINIMAP_EST_CHARS_PER_LINE = 45;
    const MINIMAP_EST_LINE_PX = 21;
    const MINIMAP_EST_PAD_PX = 36;
    /** 一次绘制里"读到有效高度"的块占比低于它 ⇒ 判定浏览器还没排好版（走估算，并稍后重试）。 */
    const MINIMAP_READY_RATIO = 0.6;
    /** 排版重试间隔与上限（约 2 秒），过了就用估算兜着，等真值自己送上门。 */
    const MINIMAP_RETRY_MS = 60;
    const MINIMAP_RETRY_MAX = 34;
    /** 调试钩子用的放大上限（要能撑住「滑块固定 8%」：400 屏的会话需要 32 倍）。 */
    const MINIMAP_ZOOM_MAX = 32;
    /** 框的绝对最小高度（px）：精确值小于它时兜底（只对超长会话生效，会带来极小的比例尺偏差）。 */
    const MINIMAP_MIN_THUMB_PX = 2;
    // 【已否决的路线 · 留痕】曾经做过「窗口化」：只画当前位置附近 5 屏、窗口跟着视口 1:1 滑。
    // 为什么删掉：① 窗口跟随时，框在屏幕上**中段根本不动**（只在滚到顶/底被夹住时才动），行为不一致；
    // ② 主人的参照物是 VSCode——那边缩略图是**整篇文档**的压缩、内容固定，动的只有框；
    // ③ 全文模式下滚动只动框、canvas 完全不用重绘，「拖动时正文平滑反向滚动」才成立。
    /** 视口框的高度 = 视口 × 比例尺（三档模式都成立；见 thumbHeightOf）。 */
    /**
     * 非全量重绘时，除了视口里那几块，还固定重读**尾部**这么多块：
     * 流式输出长高的是尾部，读 8 块就够，不必读 200 块。
     */
    const MINIMAP_TAIL_REREAD = 8;
    /** 每隔这么久强制全量核对一次（上面的块也可能被改高/改矮，缓存不能永远信）。 */
    const MINIMAP_FULL_PASS_MS = 2000;
    /** 重绘合并窗口：重画现在很便宜（多数时候只重读几块），给短一点，缩略图跟得更紧。 */
    const MINIMAP_REDRAW_MS = 120;
    /** 兜底轮询周期：正常跟位靠 ResizeObserver（拖会话宽度时逐帧跟上），这个只防「RO 没覆盖到的挪窝」。 */
    const MINIMAP_SYNC_MS = 250;
    /** hover 提示节流：指针移动比重绘快得多。 */
    const MINIMAP_TIP_MS = 60;
    /** 拖动状态的寿命上限：人不会按着拖半分钟，超时就是状态卡了，自动收工。 */
    const MINIMAP_DRAG_TIMEOUT_MS = 30000;

    /**
     * ⑤ 会话缩略导航（VSCode minimap 形态）。
     *
     * 打开界面看到什么：会话右侧一条竖带，里面是**整个会话的缩小雷达图**——每一块（你的话 / 助手的
     * 回复 / 思考 / 工具调用）按它在会话里的**真实高度**压成一条横条，颜色按类型分档；你说的话画在
     * 右边（会话里用户气泡本来就右对齐），所以一眼能认出哪段是你的、哪段是鱼的长回复。上面叠一个
     * 半透明视口滑块框住"你正在看的那一段"，随滚动同步走；点哪滚哪、按住拖 = 连续平滑滚动。
     *
     * 关键实现取舍（每条都有理由，别顺手改）：
     *  - 外壳挂 document.body + position:fixed，**绝不插进 React 的树**：插进去会在 React 更新
     *    children 时被打乱，轻则被删、重则抛 NotFoundError 把会话搞崩。
     *  - 位置跟着官方导轨的 rect 走（导轨只是被 CSS 藏起来，rect 仍然有效）——侧栏开合、窗口缩放、
     *    会话列宽变化全都自动跟随，不用自己复算 composer 那套侧间距。
     *  - 缩略用 canvas 画而不是几百个 div：块多时 DOM 版本会拖慢整棵会话树。
     *  - 未加载的历史（会话是分页加载的）不在 DOM 里，竖带的比例按 `scrollHeight`（含官方估算）算
     *    ⇒ 缩略比例是**近似**，滚上去加载后自动修正。这是真实限制，不是 bug。
     *  - 块表在重绘时缓存成升序数组，hover 提示用二分查，避免每次移动都遍历 + 强制布局。
     *  - 失败一律静默：这一层挂了最多是少个导航，绝不能阻断 UI。
     */
    /** 版本戳：控制台敲 `window.__dshomeMinimapVersion` 就知道当前跑的是哪一版（改完自检用）。 */
    const MINIMAP_VERSION = "v41-noshift";

    function ensureTurnMinimap() {
      if (typeof document === "undefined") return;
      // 可重入清理：HMR 热更会重跑这一段，旧实例必须先撤干净——否则 DOM 里叠着一条旧条，
      // 鼠标在那块区域的归属就乱了（这本身就能造成「鼠标像被控制」的手感）。
      if (typeof window.__dshomeMinimapTeardown === "function") {
        try { window.__dshomeMinimapTeardown(); } catch { /* 清理失败不挡新实例 */ }
        window.__dshomeMinimapTeardown = undefined;
      }
      window.__dshomeMinimapVersion = MINIMAP_VERSION;
      /** 内部钩子：宽度重排摘锁后叫缩略图重画一次（不是给用户调参用的）。 */
      window.__dshomeMinimapRedraw = () => { scheduleDraw(); };

      const RAIL_SELECTOR = 'nav[class*="_frame"]';
      const SCROLLER_SELECTOR = '[class*="_scrollBody"]';
      const BLOCK_SELECTOR = "[data-chat-turn]";

      /* ---------- 外壳 ---------- */
      const box = document.createElement("div");
      box.className = "dshome-minimap";
      box.style.display = "none";
      // 缩略图内容画在一条「放大 zoom 倍」的 canvas 上，装在一个 overflow:hidden 的视窗里——
      // 滚动时只平移 canvas（GPU，零重绘），这就是「内容跟着滑块往反方向流动」且平滑的做法。
      const view = document.createElement("div");
      view.className = "dshome-minimap-view";
      const canvas = document.createElement("canvas");
      view.appendChild(canvas);
      const thumb = document.createElement("div");
      thumb.className = "dshome-minimap-thumb";
      const tip = document.createElement("div");
      tip.className = "dshome-minimap-tip";
      box.append(view, thumb, tip);
      document.body.appendChild(box);

      /* ---------- 状态 ---------- */
      let scroller = null;
      let observed = null;
      let dragging = false;
      let redrawTimer = 0;
      let lastDrawAt = 0;
      let lastTipAt = 0;
      let lastGeometry = "";
      let lastZoom = 0;
      /** 拖动开始时的滚动量程 / 条几何 / 框高 / 鼠标在框内的抓取点：拖动期间只认它们，不读布局。 */
      let dragRange = 0;
      let dragBoxH = 0;
      let dragBoxTop = 0;
      let dragThumbH = 0;
      let dragGrab = 0;
      let syncTimer = 0;
      let dragStartedAt = 0;
      /** 内容总高的**稳定值**：只在「内容真的变了」时重算（见 totalOf）。 */
      let stableTotal = 0;
      let totalDirty = true;
      let rafId = 0;
      /** 上次「总高变了就重画」的时刻（节流用）。 */
      let lastMeasureAt = 0;
      /** 上次绘制时用的总高：滚动中只比这一个数就知道缩略图有没有过期（极便宜）。 */
      let drawnTotal = -1;
      /**
       * 每块的**实测**位置（内容坐标 top/height）+ 它对应的元素。
       * 有了它，绘制只在「真变了」的时候才重读 rect——这是「现在还是要等」的正解：
       * 流式输出时只重读尾部几块，而不是几百块。
       */
      const measureCache = [];
      /** 上次**全量**重读的时刻（超过 MINIMAP_FULL_PASS_MS 强制全量核对一次，防止漏掉上面的改动）。 */
      let lastFullPassAt = 0;
      /**
       * **标准条高**（由视口算，与当前盒子实际高度无关）。
       * 为什么要它：缩略条比视窗短时，视窗要**截断**（不留一大片空白）——盒子变短了，
       * 但比例尺/滑块不能跟着变（主人要「滑块大小固定」），所以所有"条高"都取这个值。
       */
      let bandPx = 0;
      /** 需要"重新测量"的标记：换了会话、或总高变了 ⇒ 必须走完整 draw（只重画不重测会拿旧块表画）。 */
      let switched = false;
      /** 内容变了之后多久复核一次（跟到"块表稳定"为止，不是周期轮询）。 */
    const MINIMAP_RECHECK_MS = 500;
    /** 连续复核多少次都没变化才认为渲染落定（一次没变不算——刚插入时高度还是 0）。 */
    const MINIMAP_RECHECK_QUIET = 3;
    /** 连续复核的次数上限（约 10 秒）：渲染总有个头，跟到稳定或跟到上限就停。 */
    const MINIMAP_RECHECK_MAX = 20;
      let retryTimer = 0;
      let retryCount = 0;
      /**
       * 「复核」：内容变了之后，隔 MINIMAP_RECHECK_MS 再全量核对一次真值；若块表还在变就继续跟，**稳定即停**。
       * 为什么必须有它：块的高度是**一点点长出来的**（markdown / 高亮 / 图片 / 字体），而这个过程中**不改 DOM** ⇒
       * 不会再产生 mutation；只靠"有事件才重画"的话，视野外那些块会永远停在渲染中途的脏值上
       * （主人报的「只有当前屏对、以前的都不对、发新消息才修正」正是这个）。它不是周期轮询：稳定就停。
       */
      let recheckTimer = 0;
      let recheckLeft = 0;
      /** 连续"块表没变"的次数：**一次没变不算稳定**（刚插入时高度还是 0，块表本来就不会变）。 */
      let recheckStill = 0;
      /** 上次绘制出来的块表指纹：复核时用它判断"渲染是否已经稳定"。 */
      let lastBlockSig = "";
      /** 块还没渲染出高度时的**临时**高度：只用于这一帧的视觉连续，**永不进缓存**，真值一到就换掉。 */
      const tempHeightOf = (el) => {
        const len = (el.textContent ?? "").trim().length;
        return MINIMAP_EST_PAD_PX + Math.max(1, Math.ceil(len / MINIMAP_EST_CHARS_PER_LINE)) * MINIMAP_EST_LINE_PX;
      };
      /** 重绘时缓存的块表（内容坐标、按 top 升序），hover 提示靠它二分。 */
      let blocks = [];
      // 内容真的变了（新块 / 流式输出）才把「总高」标脏——滚动引起的变化不算（见 totalOf）
      const observer = typeof MutationObserver === "function" ? new MutationObserver(() => {
        totalDirty = true;
        scheduleDraw();
        scheduleRecheck();          // 内容变了 ⇒ 挂一次复核（块的高度可能还在长，而它长高不改 DOM）
      }) : null;
      /** 尺寸观察：拖会话宽度 / 开合侧栏时滚动容器会连续变形，靠 250ms 轮询会明显「不跟手」。 */
      let observedScroller = null;
      const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => { sync(); }) : null;
      /**
       * 「露头就上」观察：会话 DOM 是 React 挂上来的，导轨/滚动容器可能比插件晚出现。
       * 只靠 250ms 轮询的话，缩略条要等半秒才露面（主人报的「现在还是要等」有它一份）。
       * 挂一个 document 级观察，一等到滚动容器就**立刻** sync，然后把自己摘掉（之后不再有开销）。
       */
      let appearObserver = typeof MutationObserver === "function" ? new MutationObserver(() => {
        if (scroller === null) sync();
      }) : null;
      if (appearObserver !== null) {
        try { appearObserver.observe(document.body, { childList: true, subtree: true }); } catch { /* 挂不上就靠轮询 */ }
      }

      /** canvas 不认 CSS 变量，得先解析成具体色值（每次重绘现读，跟得住主题切换）。 */
      const colorOf = (name, fallback) => {
        const value = getComputedStyle(document.body).getPropertyValue(name).trim();
        return value === "" ? fallback : value;
      };

      /**
       * 把一个块折成「真实的行」，返回每行的宽度比例（0..1）。
       *
       * 【已否决的路线 · 留痕】v17 之前缩略图是**逐行细线**，这就是那条路线留下的工具函数。
       * 为什么弃掉：① 主人验收要「美观」，密集横线看着像条形码；② 它要逐块 `textContent`
       * 序列化（几百个块就是几百次），而现在块高直接取浏览器真值，不需要折行估高了。
       * 保留它只是为了让「曾经的实现」在源码里留个可查的痕迹，代码里没有任何地方调用它。
       */
      const lineWidthsOf = (block) => {
        const widths = [];
        const perLine = 45;
        const pushText = (text) => {
          let rest = text.trim().length;
          while (rest > 0) {
            widths.push(Math.min(rest, perLine) / perLine);
            rest -= perLine;
          }
        };
        for (const child of block.children) pushText(child.textContent ?? "");
        if (widths.length === 0) pushText(block.textContent ?? "");
        if (widths.length === 0) widths.push(0.5);
        return widths;
      };

      /**
       * 内容总高（**稳定版**）。
       *
       * 两条规则，缺一不可：
       *  ① `content-visibility:auto` 让屏幕外的块只按估算高度进 `scrollHeight`，滚动时来回切 ⇒ 必须缓存；
       *  ② 历史是**分页加载**的：往上翻会把 `scrollHeight` 撑大。那个变化**不该**让缩略图重排
       *     （主人报的「滑到未加载的区域时会变」）⇒ **只在贴着会话末尾时**才接受新的总高。
       *     翻历史时不动，滚回底部（或发新消息）时才跟上。
       */
      const totalOf = () => {
        // **不做冻结**：内容一变（MutationObserver 置脏）就重新读。
        // 曾经为了「往上翻历史时缩略图别跟着变」加过「只在贴着末尾才更新」——结果分母长期偏小，
        // 缩略图与实际内容对不上（主人报的「又对不上」）。**准确优先于「不动」**。
        if (scroller === null) return 0;
        if (stableTotal <= 0 || totalDirty) {
          stableTotal = scroller.scrollHeight;
          totalDirty = false;
        }
        return stableTotal;
      };

      /**
       * 放大倍数（= 缩略条的比例尺相对「整篇压进视窗高」的倍数），**由滑块高反解**：
       *   滑块高 = 视口/全高 × 视窗高 × zoom，要求它 = MINIMAP_THUMB_RATIO × 视窗高
       *   ⇒ zoom = MINIMAP_THUMB_RATIO × 全高 / 视口。
       * 关键在**滑块高恒定**：全高变长时 zoom 跟着变大，滑块高始终 = 8% 视窗高
       * （主人要的「不管会话有多高，视口显示的高度固定」）。**不取整**，否则它会随会话长短短一点点。
       * 调试钩子 `window.__dshomeMinimapZoom` 仍可硬设倍数（≥1）。
       */
      const zoomOf = (total) => {
        const forced = window.__dshomeMinimapZoom;
        if (typeof forced === "number" && forced >= 1) return Math.min(MINIMAP_ZOOM_MAX, forced);
        const view = scroller === null ? 0 : scroller.clientHeight;
        const height = bandPx > 0 ? bandPx : box.clientHeight;
        const full = typeof total === "number" && total > 0 ? total : totalOf();
        if (view <= 0 || height <= 0 || full <= 0) return MINIMAP_DEFAULT_ZOOM;
        // ⚠️ 这里**不能**用 max(1, …) 兜底：那会让"内容少的会话"退回"整篇压进条高"，
        //    于是它的滑块按整篇比例算、比长会话（恒定 8% 条高）更大 —— 主人看到的「滑块大小不一致」。
        //    比例尺必须无条件固定：滑块 = 一屏 × 比例尺 = 恒定 8% 条高。内容少的会话，缩略条就只占条的一部分。
        return Math.max(0.01, Math.min(MINIMAP_ZOOM_MAX, (MINIMAP_THUMB_RATIO * full) / view));
      };

      /** 承载消息的滚动容器：四个页签各有一个 scrollBody，只有「有高度 + 里面有消息块」的那个算数。 */
      const findScroller = () => {
        // 面板切换时，**旧会话的容器可能还留在 DOM 里且有高度**（只是被盖住/移出视口）。
        // 所以除了"有高度 + 里面有消息块"，再加一条：**必须与视口相交**（在屏幕上的那个才是当前会话），
        // 否则会一直拿旧会话的容器来画 —— 表现就是「点开别的会话没显示 / 显示的还是上一个会话」。
        let firstOk = null;
        for (const candidate of document.querySelectorAll(SCROLLER_SELECTOR)) {
          if (!(candidate.clientHeight > 0) || candidate.querySelector(BLOCK_SELECTOR) === null) continue;
          const rect = candidate.getBoundingClientRect();
          const onScreen = rect.bottom > 0 && rect.top < (window.innerHeight || 0) && rect.right > 0 && rect.left < (window.innerWidth || 0);
          if (onScreen) return candidate;
          if (firstOk === null) firstOk = candidate;
        }
        return firstOk;      // 一个都不在视口内（例如整体还没排好）就退回第一个，总比没有强
      };

      /* ---------- 画缩略图 ---------- */
      /**
       * 把缓存的块表画到 canvas：只依赖 `band`（窗口），**不读任何布局**——
       * 所以滚动/拖动时可以每帧跑（那时窗口一直在滑，但块的位置没变）。
       */
      const paintCanvas = (total) => {
        const ctx = canvas.getContext("2d");
        const width = box.clientWidth;
        const height = bandPx > 0 ? bandPx : box.clientHeight;
        if (ctx === null || width <= 0 || height <= 0 || total <= 0) return;
        // 内容画在「放大 zoom 倍」的画布上：比视窗高，滚动时才有反向流动的行程
        const content = Math.round(height * zoomOf(total));
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(content * dpr)) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(content * dpr);
        }
        canvas.style.height = `${content}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, content);
        const scale = content / total;
        // **不铺底**：以前这里刷了一层 border-l1，深色主题下那是 #1e2a44（深蓝黑），再叠上半透明
        // 就成了「一层黑遮罩」（主人报的）。VSCode 的 minimap 底色就是编辑器背景，不多盖东西。
        // 需要一点底纹时也只让「块与块之间的空隙」透出会话背景，而不是整条压暗。
        for (const item of blocks) {
          // 从**底部**往上排：底部锚定 = 会话末尾（最新消息），往上翻历史时靠底部的部分不动。
          const y = content - (item.fromEnd + item.height) * scale;
          // **每条消息一个干净的小色块**，块间留 2px 缝：不再画密密麻麻的线
          // （主人这次的验收是「美观」——密集横线看着就是条形码）。
          const h = Math.max(2, item.height * scale - 2);
          // 把「实际画在哪」记回块表：hover 命中要按**看得见的那一块**判，不能拿内容坐标反推
          // （小块的绘制高度有 2px 下限，反推会偏到隔壁那条消息去）。
          item.drawY = y;
          item.drawH = h;
          if (y > content || y + h < 0) continue;
          const w = Math.max(3, item.width);
          const x = item.mine ? width - w : 0;
          ctx.globalAlpha = item.mine ? 0.85 : 0.62;
          ctx.fillStyle = item.fill;
          const r = Math.min(3, h / 2);
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, r);
            ctx.fill();
          } else {
            ctx.fillRect(x, y, w, h);
          }
          ctx.globalAlpha = 1;
        }
      };

      /**
       * 平移缩略条：会话的位置 → 缩略条反向偏移（唯一公式见 canvasOffsetOf）。
       * 用 CSS transform 平移而不是重绘 canvas —— 滚动/拖动时 canvas 零开销（主人要的「无感」就靠这条）。
       */
      const paintShift = () => {
        if (scroller === null || box.clientHeight <= 0) return;
        canvas.style.transform = `translateY(${-Math.round(canvasOffsetOf())}px)`;
      };

      /** 窗口滑了但内容没变时用的重画入口（全文模式下其实用不到，保留给「内容不变但要重画」的场合）。 */
      const repaint = () => {
        if (blocks.length === 0) {
          draw();
          return;
        }
        paintCanvas(totalOf());
      };

      /**
       * 复核：内容变化之后，隔 MINIMAP_RECHECK_MS 再全量核对一次真值；块表还在变就继续跟，**稳定即停**。
       * 这是治「只有当前屏对、以前的都不对、发新消息才修正」的那一处：
       * 块长高的过程不改 DOM（没有 mutation），只靠"有事件才重画"就永远读不到真值。
       */
      const scheduleRecheck = () => {
        recheckLeft = MINIMAP_RECHECK_MAX;
        recheckStill = 0;
        if (recheckTimer !== 0) return;                 // 已经挂着一次，让它跑（不叠加）
        recheckTimer = window.setTimeout(runRecheck, MINIMAP_RECHECK_MS);
      };
      const runRecheck = () => {
        recheckTimer = 0;
        if (scroller === null || window.__dshomeCvLocked === true) return;
        const before = lastBlockSig;
        draw(true);                                     // 全量核对 + 重绘（draw 会更新 lastBlockSig）
        if (lastBlockSig !== before) recheckStill = 0;  // 还在长 ⇒ 重新计数
        else recheckStill += 1;
        // 连续 MINIMAP_RECHECK_QUIET 次都没变，才算渲染落定（稳定即停；否则继续跟，直到上限）
        if (recheckStill < MINIMAP_RECHECK_QUIET && recheckLeft > 1) {
          recheckLeft -= 1;
          recheckTimer = window.setTimeout(runRecheck, MINIMAP_RECHECK_MS);
        }
      };

      const draw = (forceFull = false) => {
        if (scroller === null || box.clientHeight <= 0) return;
        // 宽度的重排上锁期间：块的尺寸是占位值，画了会错 ⇒ 冻结（保留上一版真值图形），摘锁后会自动重画
        if (window.__dshomeCvLocked === true) return;
        const width = box.clientWidth;
        const total = totalOf();
        if (width <= 0 || total <= 0) return;

        // canvas 尺寸、清屏、铺底、绘制**全在 paintCanvas 里**；这里只负责「测量 + 缓存块表」。
        // 别在这儿再碰 ctx——曾经残留过一段旧绘制代码，每帧白调一次 getContext（自测用调用栈抓出来的）。
        const scrollTop = scroller.scrollTop;
        const view = scroller.clientHeight;
        const scrollHeight = scroller.scrollHeight;
        // 三类**拉开**层次：你说的/插话＝品牌蓝，助手回复＝中灰，思考与工具＝浅灰但要看得见。
        const colorMine = colorOf("--dsw-alias-brand-primary", "#4D6BFE");
        const colorReply = colorOf("--dsw-alias-label-tertiary", "#6b7a99");
        const colorOther = colorOf("--dsw-alias-border-l4", "#c9d2e3");
        const all = scroller.querySelectorAll(BLOCK_SELECTOR);
        const count = all.length;
        const next = new Array(count);
        // ★★ 位置只用**浏览器自己的真值**，但**不每次都全量重读**（性能就在这儿）：
        //   · 元素一个没换、总高也没变 ⇒ **一个 rect 都不读**（纯重画）；
        //   · 总高变了（流式输出长高 / 被跳过的块渲染出来）⇒ 只重读**尾部几块 + 视口里那几块**
        //     （这几块是唯一可能变的），几百次读直接省掉；
        //   · 块集合变了（往上加载更早的历史 / React 换元素）或超过 MINIMAP_FULL_PASS_MS 没全量核对
        //     ⇒ 全量读一遍（慢的那一下要留着，否则上面某块变了底下全歪）。
        //   缓存存的是**内容坐标**里的 top/height：滚动不改它们，所以滚动完全不触发重读。
        const boxTop = scroller.getBoundingClientRect().top;
        const base = boxTop - scrollTop;                 // 视口坐标 ⇒ 容器内容坐标
        const now = Date.now();
        const sameSet = measureCache.length === count && measureCache.every((c, i) => c !== undefined && c.el === all[i]);
        const totalChanged = scrollHeight !== drawnTotal;
        const needFull = !sameSet || now - lastFullPassAt > MINIMAP_FULL_PASS_MS;
        if (needFull) lastFullPassAt = now;
        // 复核时强制全量；顺带记下"这一遍是全量"（台账用）
        if (forceFull) lastFullPassAt = now;
        // 非全量、但总高变了（块长高/渲染出来）时要重读的下标：**尾部几块 + 视口上下那几块**。
        // 总高没变 ⇒ 一个都不用重读（块高变化必然引起总高变化；真漏了也有 MINIMAP_FULL_PASS_MS 兜底）。
        let reread = null;
        if (!needFull && totalChanged) {
          reread = new Set();
          for (let i = Math.max(0, count - MINIMAP_TAIL_REREAD); i < count; i += 1) reread.add(i);
          const viewLo = scrollHeight - scrollTop - view * 1.5;
          const viewHi = scrollHeight - scrollTop + view * 0.5;
          for (let i = 0; i < count; i += 1) {
            const c = measureCache[i];
            const near = c === undefined ? 0 : scrollHeight - c.top - c.height;
            if (c === undefined || (near >= viewLo && near <= viewHi)) reread.add(i);
          }
        }
        let reads = 0;
        let valid = 0;                                       // 读到有效高度的块数（判"排版好没好"）
        let pending = 0;                                     // 还没渲染出高度、只好给临时高度的块数
        let sig = 0;                                         // 块表指纹（复核时判断"渲染稳了没"）
        for (let i = 0; i < count; i += 1) {
          const block = all[i];
          const cached = measureCache[i];
          const fresh = cached !== undefined && cached.el === block;
          const mustRead = !fresh || needFull || (reread !== null && reread.has(i));
          let top; let h;
          if (!mustRead) {
            top = cached.top;
            h = cached.height;
            if (h > 1) valid += 1;                       // 缓存里的真值也算"已排好版"（不然纯重画会被误判成没排版）
          } else {
            const rect = block.getBoundingClientRect();
            reads += 1;
            top = rect.top - base;
            if (rect.height > 0) {
              h = rect.height;
              valid += 1;
              measureCache[i] = { el: block, top, height: h };
            } else {
              // 还没渲染出高度：**不当真值、也不进缓存**（真值一到立刻换），
              // 只给个临时高度让这一帧不至于"空白一段"。这就是脏值不再被钉住的地方。
              pending += 1;
              h = tempHeightOf(block);
              measureCache[i] = undefined;
            }
          }
          sig += Math.round(h) * (i + 1) + Math.round(top);
          const kind = block.getAttribute("data-chat-flow-kind") ?? "";
          // 用户消息（含插话 steering）在会话里是右对齐气泡，缩略图照搬：靠右画，一眼分清谁说的
          const mine = kind === "user" || kind === "steering";
          const span = mine ? width * 0.62 : width * 0.9;
          next[i] = {
            fromEnd: Math.max(0, scrollHeight - top - h),  // 距末尾（与滚动条同一把尺）
            height: h,
            turn: block.getAttribute("data-chat-turn") ?? "",
            kind,
            mine,
            fill: mine ? colorMine : kind === "assistant" ? colorReply : colorOther,
            // 宽度按**内容量**：用真实块高当代理（省掉几百次 textContent 序列化）
            width: Math.max(6, span * Math.min(1, 0.35 + h / 1200)),
            drawY: 0,
            drawH: 0,
            el: block,          // 只给悬停用：那一下才读它的文字做摘要（绘制时不读，几百块会拖慢）
          };
        }
        measureCache.length = count;
        blocks = next;
        drawnTotal = scrollHeight;
        // ★ 排版还没好（绝大多数块量出来是 0）：**这一遍不算数** —— 不刷新块表、也不画估算版
        //   （宁可不画，也不给主人看一版错的），并清掉缓存，稍后重试真值。
        if (count > 0 && valid < count * MINIMAP_READY_RATIO) {
          measureCache.length = 0;
          if (retryTimer === 0 && retryCount < MINIMAP_RETRY_MAX) {
            retryCount += 1;
            retryTimer = window.setTimeout(() => { retryTimer = 0; draw(); }, MINIMAP_RETRY_MS);
          }
          return;
        }
        retryCount = 0;
        lastBlockSig = `${count}|${Math.round(scrollHeight)}|${sig}`;
        // 性能台账（控制台可看：`window.__dshomeMinimapPerf`）——主人报「要等/不对」时让鱼有数可查
        const cost = Date.now() - now;
        window.__dshomeMinimapPerf = { 块数: count, 读了: reads, 全量: needFull, 待定: pending, 毫秒: cost };
        if (cost > 8) {
          try { console.log("[dshome-minimap] 绘制偏慢", window.__dshomeMinimapPerf); } catch { /* 控制台不可用就算了 */ }
        }
        paintCanvas(total);
        paintShift();
        // 顺手把框也按刚刚读到的总高摆正：内容一变（往上加载更早的历史）框高/框位就过期了，
        // 而 sync 兜底是 250ms 一跳 —— 中间那段时间框是**错的**。
        paintThumb();
      };

      /**
       * 画布平移量（canvas px）—— 全代码**只此一处**坐标来源：绘制、悬停、点击都用它，
       * 不会再出现"两把尺子"。
       * 公式就是要求 ②：会话顶 ⇒ 0（缩略条顶贴视窗顶）；会话底 ⇒ 缩略条底贴视窗底；
       * 中间按 (缩略条长−视窗高)/(缩略条长−滑块高) 平移。
       */
      const canvasOffsetOf = () => {
        const total = totalOf();
        const H = box.clientHeight;                                  // ★ 视窗高（截断后的**实际**高度，不是标准条高）
        const content = (bandPx > 0 ? bandPx : H) * zoomOf(total);   // 画布总长用标准条高
        if (total <= 0 || content <= 0) return 0;
        // ★ 内容装得下视窗（短会话）⇒ **一点都不平移** —— 都显示全了还动什么（主人原话）
        if (content <= H + 1) return 0;
        const scale = content / total;
        const view = scroller === null ? 0 : scroller.clientHeight;
        const range = total - view;
        const thumbHeight = thumbHeightOf(H, view, total);
        const p = range <= 0 ? 0 : Math.min(1, Math.max(0, (scroller === null ? 0 : scroller.scrollTop) / range));
        return (scroller === null ? 0 : scroller.scrollTop) * scale - p * Math.max(0, H - thumbHeight);
      };

      /**
       * 框高 = 视口在「放大后的内容」里占的高度 = `视口/全文 × (条高 × zoom)`。
       * 这样框**框住的就是缩略图上你正在看的那一段**，两者严丝合缝（点哪到哪、拖哪跟哪）。
       */
      const thumbHeightOf = (height, view, total) => {
        const content = (bandPx > 0 ? bandPx : height) * zoomOf(total);   // 比例尺用**标准条高**
        // ⚠️ **不要四舍五入、也不要有下限**：只有框高是精确值时，
        //    「框的比例尺」`(条高−框高)/(全文−视口)` 才**严格等于**「内容的比例尺」`条高/全文`
        //    （见 MINIMAP_DEFAULT_ZOOM 的推导）。取整/夹一个最小高度会留下几 px 偏差，
        //    再被 `/scale` 放大成几百 px 的内容偏差 ⇒ hover 提示与点击会指到隔壁那条消息
        //    （自测的 hover 探针抓到过：5px 的偏差 = 261px 内容偏差）。
        return Math.max(2, (view / total) * content);
      };

      /** 当前滑块在视窗内的顶边：按整篇进度比例走（与缩略条的平移量是同一套坐标，见 canvasOffsetOf）。 */
      const thumbTopOf = (height, thumbHeight) => {
        const total = totalOf();
        const view = scroller === null ? 0 : scroller.clientHeight;
        const range = total - view;
        const p = range <= 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / range));
        const railH = box.clientHeight > 0 ? box.clientHeight : height;   // 行程用**当前视窗高**（截断后更短）
        return p * Math.max(0, railH - thumbHeight);
      };

      /* ---------- 视口框的绘制 ---------- */
      const paintThumb = () => {
        if (scroller === null || box.clientHeight <= 0) return;
        const total = totalOf();
        const view = scroller.clientHeight;
        const height = bandPx > 0 ? bandPx : box.clientHeight;
        if (total <= 0 || height <= 0) return;
        const thumbHeight = thumbHeightOf(height, view, total);
        thumb.style.height = `${thumbHeight}px`;
        thumb.style.transform = `translateY(${Math.round(thumbTopOf(height, thumbHeight))}px)`;
      };

      /**
       * 重绘调度。
       * - 默认（内容变化）：按 MINIMAP_REDRAW_MS 合并——每次都要重新测量几百个块，不能每帧来。
       * - `fast = true`（滚动 / 拖动）：走 rAF + `repaint()`（只重画不测量），这样才跟手。
       *   ⚠️ 现状：**当前无调用者** —— 滚动/拖动走的是「只挪框 + 平移 canvas」（见 draw 里
       *   `totalChanged` 分支），canvas 一个字都不重绘，比 rAF 重画更省。这条路径保留为
       *   完整备选（`repaint()` 的唯一引用点），**不是活跃分支**；改滚动行为前先看这里。
       */
      const scheduleDraw = (fast = false) => {
        if (fast) {
          if (rafId !== 0) return;
          rafId = window.requestAnimationFrame(() => {
            rafId = 0;
            repaint();
          });
          return;
        }
        if (redrawTimer !== 0) return;
        const wait = Math.max(0, MINIMAP_REDRAW_MS - (Date.now() - lastDrawAt));
        redrawTimer = window.setTimeout(() => {
          redrawTimer = 0;
          lastDrawAt = Date.now();
          draw();
        }, wait);
      };

      /* ---------- 跟住官方导轨的位置 ---------- */
      const sync = () => {
        // 急停开关：控制台敲一行 `window.__dshomeMinimapOff = true` 就能整条撤掉，不用改文件、不用重装
        if (window.__dshomeMinimapOff === true) {
          box.style.display = "none";
          return;
        }
        // 拖动中不跑重活（querySelector / 读 rect / zoomOf 都在读布局）——跟手性优先，摆位等松手再修正
        if (dragging) return;
        const rail = document.querySelector(RAIL_SELECTOR);
        const next = findScroller();
        // ⚠️ 只有"找不到会话内容"才隐藏；**官方导轨缺失不再隐藏**——导轨只是用来对齐右边距的，
        //    某些会话/视图里它压根不存在，原来在这里 return 会让整条缩略条消失（主人报的「其他会话没有缩略条」）。
        if (next === null) {
          box.style.display = "none";
          window.__dshomeMinimapWhy = "隐藏：找不到会话滚动容器（没有消息块或高度为 0）";
          scroller = null;
          return;
        }
        // ★ 会话换了（侧栏点开另一个会话）：所有跟旧会话绑定的缓存必须**当场清掉**，
        //   否则新会话会拿着旧会话的总高/比例尺来画 —— 表现就是「点开更早会话后完全坏掉」。
        //   ⚠️ 并且必须走**完整重绘**（要重新测量新会话的块）——只重画不重测的快速路径会拿旧块表画新会话
        //   （自测复现：切会话后画的还是上一个会话的 200 条、台账块数也不变 ⇒ 新会话「没显示」）。
        if (scroller !== next) {
          stableTotal = 0;
          totalDirty = true;
          drawnTotal = -1;
          measureCache.length = 0;
          lastFullPassAt = 0;
          lastZoom = 0;
          lastGeometry = "";
          lastDrawAt = 0;
          switched = true;
        }
        scroller = next;
        // 换了会话：**当场同步完整重绘一次**（要重新测量新会话的块）。不排定时器——切会话是重活，
        // 而且"等一拍再画"正是「点开别的会话没显示/还显示上一个会话」的来源。
        if (switched) {
          switched = false;
          draw();
        }
        // 保险：拖动状态不可能活过半分钟——活着就是卡了，自动收工（绝不让它牵着鼠标滚）
        if (dragging && Date.now() - dragStartedAt > MINIMAP_DRAG_TIMEOUT_MS) endDrag();
        // 内容不够一屏就没什么可导航的，藏起来省得挡视线
        if (scroller.scrollHeight <= scroller.clientHeight * 1.05) {
          box.style.display = "none";
          paintThumb();
          return;
        }
        // 导轨只影响"右边缘对齐"：拿得到就用它的 rect，拿不到就贴右边缘 8px（兜底，照样显示）
        const railRect = rail === null ? null : rail.getBoundingClientRect();
        const railOk = railRect !== null && railRect.height >= 24 && railRect.width > 0;
        window.__dshomeMinimapWhy = railOk
          ? "显示：对齐官方导轨"
          : (rail === null ? "显示：没有官方导轨 ⇒ 兜底贴右边缘" : "显示：导轨太小 ⇒ 兜底贴右边缘");
        if (observer !== null && observed !== scroller) {
          observer.disconnect();
          observer.observe(scroller, { childList: true, subtree: true });
          observed = scroller;
        }
        // 已经找到会话了，「露头就上」观察可以摘掉（不再有开销）
        if (appearObserver !== null) {
          try { appearObserver.disconnect(); } catch { /* 已经摘了 */ }
          appearObserver = null;
        }
        // 变形立即跟上（拖会话宽度时是逐帧触发，不再是 250ms 一次）
        if (resizeObserver !== null && observedScroller !== scroller) {
          resizeObserver.disconnect();
          resizeObserver.observe(scroller);
          observedScroller = scroller;
        }
        // 显示状态与几何缓存**解耦**：几何没变也必须保证「该显示时是显示的」。
        // （会话切走再切回时导轨会消失又出现、几何一模一样，缓存命中就永远显示不回来了——自测抓到的真 bug）
        if (box.style.display !== "block") box.style.display = "block";
        // 首帧不画「估算版」：块的真实尺寸随时可读（content-visibility 已停用），直接等真值更准
        // 尺寸自己定，**不吃官方导轨那套 420px 上限**——VSCode 的 minimap 是铺满编辑器高度、贴顶到底的。
        // 可用区 = 视口去掉底部 composer（约 152px）与上下留白；条高在可用区里**拉满**（上限 MINIMAP_MAX_HEIGHT_PX）。
        const usableTop = 8;
        const usable = Math.max(240, window.innerHeight - MINIMAP_COMPOSER_RESERVE_PX - usableTop * 2);
        bandPx = Math.round(Math.min(usable, MINIMAP_MAX_HEIGHT_PX));   // **标准条高**（与盒子实际高度解耦）
        // 调试钩子（条宽）改了也要当场生效，所以都进这个比较键
        const zoomNow = zoomOf(totalOf());
        if (zoomNow !== lastZoom) {
          lastZoom = zoomNow;
          scheduleDraw();
        }
        // ★ 截断视窗：缩略条总长 = 标准条高 × 放大倍数。条比视窗短时（内容少的会话），
        //   视窗跟着**变短**（不留一大片空白）；比例尺/滑块仍按标准条高算，所以滑块大小不变。
        const stripH = Math.round(bandPx * zoomNow);
        const boxH = Math.max(24, Math.min(bandPx, stripH));
        const top = Math.round(usableTop + (usable - boxH) / 2);
        // 总高变了（往上加载更早的历史 / 被跳过的块首次渲染出来）⇒ 比例尺过期，得重画。
        // 这条兜底是必要的：块「渲染出来」不一定伴随 DOM 变更事件，光靠 MutationObserver 会漏。
        if (scroller.scrollHeight !== drawnTotal && !dragging) {
          totalDirty = true;          // 总高变了 ⇒ 滑块/平移量也必须用新总高（否则「加载更早」那一瞬还是旧的）
          draw();                     // 块高/块数变了 ⇒ 当场重新测量（只重画不重测会拿旧块表）
        }
        const railRight = railOk ? Math.round(railRect.right) : (window.innerWidth || 0) - 8;
        const geometry = `${top}|${boxH}|${railRight}|${window.innerWidth}|${window.__dshomeMinimapWidth ?? ""}`;
        if (geometry !== lastGeometry) {
          lastGeometry = geometry;
          box.style.top = `${top}px`;
          box.style.height = `${boxH}px`;
          box.style.width = `${window.__dshomeMinimapWidth > 0 ? window.__dshomeMinimapWidth : MINIMAP_WIDTH_PX}px`;
          // 右边缘与官方导轨对齐（导轨只被藏起来，rect 仍然有效）
          box.style.right = `${Math.round(window.innerWidth - railRight)}px`;
          scheduleDraw();
        }
        paintThumb();
        paintShift();
      };

      /* ---------- 交互：点到哪、拖到哪，内容就滚到哪 ---------- */
      /**
       * 拖动滑块：把滑块挪到条内的 local 处，会话按**整篇比例**跟着滚。
       * `dragGrab` = 按下时鼠标落在滑块内的哪个点 ⇒ 按在滑块上就原样抓着拖（不跳），按在滑块外就滑块心对齐鼠标。
       */
      const seekLocal = (local) => {
        if (scroller === null) return;
        const height = dragBoxH > 0 ? dragBoxH : box.getBoundingClientRect().height;
        const total = totalOf();
        const view = scroller.clientHeight;
        const thumbHeight = dragThumbH > 0 ? dragThumbH : thumbHeightOf(height, view, total);
        const maxTop = Math.max(0, height - thumbHeight);
        const top = Math.min(maxTop, Math.max(0, local - dragGrab));
        const range = dragRange > 0 ? dragRange : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = (maxTop > 0 ? top / maxTop : 0) * range;
        paintThumb();
        paintShift();
      };

      /**
       * 点击视窗：把**指针底下画着的那条内容**滚到屏幕中央（要求 ③「会话要移动到该位置」）。
       * 滑块与缩略条会自动跟过去：滑块覆盖那条内容（滑块高 = 一屏 × 比例尺），缩略条按同一套坐标平移。
       */
      const jumpToContent = (local) => {
        if (scroller === null) return;
        const total = totalOf();
        const view = scroller.clientHeight;
        const height = dragBoxH > 0 ? dragBoxH : box.getBoundingClientRect().height;
        const contentH = height * zoomOf(total);
        if (total <= 0 || contentH <= 0) return;
        const scale = contentH / total;
        // 「视窗内 y」⇒「画布 y」⇒ 会话位置：与绘制、悬停同一套坐标（canvasOffsetOf）
        const atPointer = (canvasOffsetOf() + local) / scale;
        const range = Math.max(0, total - view);
        scroller.scrollTop = Math.min(range, Math.max(0, atPointer - view / 2));
        paintThumb();
        paintShift();
      };

      /** 二分找指针落点对应的块：按**实际画出来的矩形**找（blocks 按从上到下排，drawY 递增）。 */
      const blockAt = (canvasY) => {
        let low = 0;
        let high = blocks.length - 1;
        let found = null;
        while (low <= high) {
          const mid = (low + high) >> 1;
          if ((blocks[mid].drawY ?? 0) <= canvasY) {
            found = blocks[mid];
            low = mid + 1;
          } else high = mid - 1;
        }
        return found;
      };

      const showTip = (clientY) => {
        if (scroller === null || blocks.length === 0) return;
        const now = Date.now();
        if (now - lastTipAt < MINIMAP_TIP_MS) return;
        lastTipAt = now;
        const rect = box.getBoundingClientRect();
        if (rect.height <= 0) return;
        // 指针 y ⇒ **画布坐标**（= 那一点上画着什么），再按「实际画出来的矩形」找块。
        // 不走「反推内容坐标再按 fromEnd 查」那条路：小块有 2px 绘制下限，反推会偏到隔壁一条消息去。
        const local = clientY - rect.top;
        const block = blockAt(canvasOffsetOf() + local);
        if (block === null) {
          tip.removeAttribute("data-show");
          return;
        }
        const label = block.kind === "user" || block.kind === "steering" ? "你说"
          : block.kind === "assistant" ? "助手回复"
            : block.kind === "tool" ? "工具调用"
              : block.kind === "thinking" ? "思考"
                : block.kind === "" ? "内容" : block.kind;
        // 第二行：**这条消息的开头文字**（主人说「只写第几轮看不出来是什么」）。
        // 只在悬停这一下读一次 DOM（一个块，几微秒），绘制时不读（那是几百块，会拖慢）。
        const raw = (block.el?.textContent ?? "").replace(/\s+/g, " ").trim();
        const preview = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
        tip.textContent = preview === "" ? `第 ${block.turn} 轮 · ${label}` : `第 ${block.turn} 轮 · ${label}\n${preview}`;
        tip.style.top = `${Math.round(clientY - rect.top)}px`;
        tip.setAttribute("data-show", "1");
      };

      /** 收工：任何路径走到这里都必须把拖动状态清干净——它一旦卡住，表现就是「鼠标在页面上移动、会话自己滚」。 */
      const endDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        dragRange = 0;
        dragBoxH = 0;
        dragBoxTop = 0;
        dragThumbH = 0;
        dragGrab = 0;
        box.removeAttribute("data-active");
        if (event !== undefined) {
          try { box.releasePointerCapture(event.pointerId); } catch { /* 已经释放过 */ }
        }
      };

      box.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || scroller === null) return;
        // 拦默认行为：不拦的话按住拖动会把会话文本选中
        event.preventDefault();
        event.stopPropagation();
        dragging = true;
        dragStartedAt = Date.now();
        // 按下时量一次就够：条高、条顶、滚动量程、框高、以及鼠标落在框内的哪个点
        const rect = box.getBoundingClientRect();
        dragBoxH = rect.height;
        dragBoxTop = rect.top;
        dragRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        dragThumbH = thumbHeightOf(rect.height, scroller.clientHeight, totalOf());
        const local = event.clientY - rect.top;
        const currentTop = thumbTopOf(rect.height, dragThumbH);
        // 长会话里框可能很细，抓取区上下各放宽一点（只是**手感**放宽，框的几何一个像素不动）。
        const grabPad = Math.max(8, dragThumbH * 0.5);
        const onThumb = local >= currentTop - grabPad && local <= currentTop + dragThumbH + grabPad;
        // 按在**滑块上** ⇒ 抓着它拖（相对拖动，位置不跳）；
        // 按在**滑块外** ⇒ 把指针底下那条内容滚到屏幕中央（要求 ③），滑块随后自动覆盖它。
        if (onThumb) {
          dragGrab = local - currentTop;
          seekLocal(local);
        } else {
          jumpToContent(local);
          dragGrab = local - thumbTopOf(rect.height, dragThumbH);   // 接着拖不会再跳一下
        }
        box.setAttribute("data-active", "1");
        try { box.setPointerCapture(event.pointerId); } catch { /* 捕获不到也让拖：下面有 buttons 自检兜底 */ }
      });
      box.addEventListener("pointermove", (event) => {
        if (!dragging) {
          showTip(event.clientY);
          return;
        }
        // 左键其实早松了（pointerup 丢在窗口外/被别的东西吃掉）⇒ 当场收工，绝不继续跟着鼠标滚
        if (event.buttons === 0) {
          endDrag(event);
          return;
        }
        seekLocal(event.clientY - dragBoxTop);
      });
      box.addEventListener("pointerup", endDrag);
      box.addEventListener("pointercancel", endDrag);
      // 三道兜底，专治「拖动状态卡住」：全局松手 / 全局取消 / 指针离开条时左键已松
      document.addEventListener("pointerup", endDrag, true);
      document.addEventListener("pointercancel", endDrag, true);
      box.addEventListener("pointerleave", (event) => {
        tip.removeAttribute("data-show");
        if (dragging && event.buttons === 0) endDrag(event);
      });
      // 滚轮转发：缩略条挂在 body 上、不在滚动容器里，滚轮事件不会自己穿透到会话——
      // 不转发的话，鼠标停在这一条上滚轮会**毫无反应**，手感就是「鼠标被夺走了」。
      box.addEventListener("wheel", (event) => {
        if (scroller === null) return;
        event.preventDefault();
        scroller.scrollTop += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
      }, { passive: false });

      /* ---------- 起搏 ---------- */
      // scroll 不冒泡，用捕获阶段跟（滚动容器会被 React 换掉，逐元素绑定会掉线）
      const onScroll = (event) => {
        if (scroller === null || event.target !== scroller) return;
        // ★ 滚动本身**不改块的位置**（位置是浏览器排的，读一遍就够），所以正常情况下这里
        //   一次布局都不读：只挪框 + 平移内容（都是 transform，不脏布局）。
        //   唯一要担心的是：被 content-visibility 跳过的块**首次渲染后高度会变**，浏览器随之重排，
        //   `scrollHeight` 一变缩略图的比例尺就过期了 ⇒ 只比一个数（极便宜），变了才重画（节流）。
        //   拖动中一律不重画（跟手优先，松手后 sync 会补）。
        if (!dragging && scroller.scrollHeight !== drawnTotal) {
          totalDirty = true;
          lastMeasureAt = Date.now();
          draw();
        }
        paintThumb();
        paintShift();
      };
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", sync);
      // 窗口失焦（alt+tab、切走）时收工：回来时状态必须是干净的
      window.addEventListener("blur", endDrag);
      syncTimer = window.setInterval(sync, MINIMAP_SYNC_MS);
      // 拆解器：给下一次 HMR 重跑用——旧实例必须能彻底撤掉（也方便急停时手动调用）。
      // ⚠️ 每一步独立容错、且**先把条从 DOM 撤掉**：只要有一处抛错就中断的话，
      // box 就留在了页面上叠着（自测抓到过：clearInterval 不存在 ⇒ box.remove 没跑到 ⇒ 叠两条）。
      window.__dshomeMinimapTeardown = () => {
        try { if (typeof box.remove === "function") box.remove(); } catch { /* 已经不在 DOM 里 */ }
        try { window.clearInterval(syncTimer); } catch { /* 环境不支持就算了 */ }
        try { if (rafId !== 0) window.cancelAnimationFrame(rafId); } catch { /* 同上 */ }
        try { if (recheckTimer !== 0) window.clearTimeout(recheckTimer); } catch { /* 同上 */ }
        try { if (retryTimer !== 0) window.clearTimeout(retryTimer); } catch { /* 同上 */ }
        try { window.removeEventListener("resize", sync); } catch { /* 同上 */ }
        try { window.removeEventListener("blur", endDrag); } catch { /* 同上 */ }
        try { document.removeEventListener("scroll", onScroll, true); } catch { /* 同上 */ }
        try { document.removeEventListener("pointerup", endDrag, true); } catch { /* 同上 */ }
        try { document.removeEventListener("pointercancel", endDrag, true); } catch { /* 同上 */ }
        try { if (observer !== null) observer.disconnect(); } catch { /* 同上 */ }
        try { if (appearObserver !== null) appearObserver.disconnect(); } catch { /* 同上 */ }
        try { if (resizeObserver !== null) resizeObserver.disconnect(); } catch { /* 同上 */ }
      };
      sync();
    }

    function apply(ctx) {
      // 0) DSHOME 侧覆盖规则（先于品牌注册；属性选择器特异性高于插件类名，重装/升级不丢）
      ensureOverrides();
      // 0b) 会话缩略导航（VSCode minimap 形态：外壳挂 body、自绘 canvas；见 ensureTurnMinimap）
      ensureTurnMinimap();
      // 1) DSHOME 主题配方（light/dark 成对；dark 复刻离线页深海军蓝视觉）
      try {
        const theme = ctx.get("theme");
        if (theme && typeof theme.overrideTokens === "function") {
          theme.overrideTokens("dshome-theme", {
            // 品牌蓝强调色
            "--dsw-alias-brand-primary": { light: "#4D6BFE", dark: "#6B84FF" },
            "--dsw-alias-state-business-primary": { light: "#4D6BFE", dark: "#6B84FF" },
            "--dsw-alias-button-primary-fill": { light: "#4D6BFE", dark: "#4D6BFE" },
            "--dsw-alias-button-primary-hover": { light: "#3E5BF0", dark: "#5B7BFF" },
            // 背景层级（深海军蓝）
            "--dsw-alias-bg-base": { light: "#f7f9fc", dark: "#0f1420" },
            "--dsw-alias-bg-layer-1": { light: "#ffffff", dark: "#131a29" },
            "--dsw-alias-bg-layer-2": { light: "#ffffff", dark: "#172032" },
            "--dsw-alias-bg-overlay": { light: "#ffffff", dark: "#1a2338" },
            "--dsw-alias-bg-module-platform": { light: "#ffffff", dark: "#131a29" },
            // 侧栏（比主背景再深一档，贴合离线页层次）
            "--dsw-specific-sidebar-fill": { light: "#eef2f9", dark: "#0c111c" },
            // 边框
            "--dsw-alias-border-l1": { light: "#e3e9f3", dark: "#1e2a44" },
            "--dsw-alias-border-l2": { light: "#d3dcea", dark: "#2a3a5c" },
            // 文字（蓝白系）
            "--dsw-alias-label-primary": { light: "#1a2233", dark: "#dbe4f0" },
            "--dsw-alias-label-secondary": { light: "#4a5a78", dark: "#c3d0e4" },
            "--dsw-alias-label-tertiary": { light: "#6b7a99", dark: "#8fa3c0" },
            // 交互底色
            "--dsw-alias-interactive-bg-hover": { light: "rgba(77,107,254,0.08)", dark: "rgba(107,132,255,0.10)" },
          });
        }
      } catch (error) {
        console.warn("dshome-theme: token override failed", error);
      }
      // 2) DSHOME 品牌槽（官方声明式模式：嵌套 inject + 生成器 yield）
      try {
        ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", () => ctx.slots.inject("conversation.hero.brand.mark", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, (props) => react_jsx_runtime.jsx(DshomeMark, { size: props?.size, className: props?.className }));
          yield ctx.slots.register({ name: "sidebar.brand.name" }, () => react_jsx_runtime.jsx(DshomeName, {}));
          yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, (props) => react_jsx_runtime.jsx(DshomeMark, { size: props?.size, className: props?.className }));
        })));
      } catch (error) {
        console.warn("dshome-theme: brand slot registration failed", error);
      }
      // 3) 通用设置 · 「通知」开关组
      //    `settingsScope` 走动态 inject：服务后到位也不会漏（apply 时一次性 ctx.get 可能还没就绪），
      //    而失败/缺失只少这一行、不影响品牌槽与缩略导航（降级纪律同本文件其余环节）。
      try {
        var bindNotifySettings = function (scopeCtx) {
          try {
            notifyScope = scopeCtx.settingsScope.bind({ namespace: "dshome" });
            ctx.slots.inject("settings.general.item", function () {
              return ctx.slots.register({ name: "settings.general.item", id: "dshome-notify-settings", order: 43 }, NotifySettingsRow);
            });
          } catch (error) {
            console.warn("dshome-theme: notify settings row failed", error);
          }
        };
        if (typeof ctx.inject === "function") ctx.inject(["settingsScope"], bindNotifySettings);
        else if (ctx.get("settingsScope")) bindNotifySettings(ctx);
        else console.warn("dshome-theme: settingsScope unavailable — 通知开关未挂载（通知按默认值工作）");
      } catch (error) {
        console.warn("dshome-theme: notify settings bind failed", error);
      }
    }

    module.exports = { name: "dshome-theme", inject, apply };
    // 材料化机制取 factory 的【返回值】为插件本体，必须显式返回 module.exports。
    return module.exports;
  },
});