// dshome-theme — browser client module.
//
// 1) 服务级注入 ["slots"]：保证 apply 时 ctx.slots 就绪（官方品牌同款契约）；
// 2) 通过 theme 服务 overrideTokens 注入 DSHOME 品牌蓝强调色（light/dark 成对）；
// 3) 按官方模式注册 DSHOME 品牌槽（sidebar.brand.mark/name、conversation.hero.brand.mark），
//    替换官方/回退品牌显示。
// 容错：任一环节失败只静默降级，绝不阻断 UI。

window.__ModuleLoader__.load({
  id: "dshome-theme",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 当前 DSHOME 版本（发布版本号：与 packages/dshome package.json version、updates.json、DSHOME.iss MyAppVersion 一致；发版时勿忘同步——曾漏更停留在 v0.1.0）。 */
    const DSHOME_VERSION = "v0.3.0";

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

    /** DSHOME 侧 CSS 覆盖（稳定属性选择器，升级/重装免疫）：input-traffic 插队 dock 限宽。 */
    function ensureOverrides() {
      try {
        if (typeof document === "undefined" || !document.head) return;
        if (document.querySelector("style[data-dshome-overrides]")) return;
        const tag = document.createElement("style");
        tag.setAttribute("data-dshome-overrides", "1");
        tag.textContent =
          "div[data-steer-dock]{width:100%;max-width:780px;margin-inline:auto}";
        document.head.appendChild(tag);
      } catch (error) {
        console.warn("dshome-theme: override css failed", error);
      }
    }

    function apply(ctx) {
      // 0) DSHOME 侧覆盖规则（先于品牌注册；属性选择器特异性高于插件类名，重装/升级不丢）
      ensureOverrides();
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
    }

    module.exports = { name: "dshome-theme", inject, apply };
    // 材料化机制取 factory 的【返回值】为插件本体，必须显式返回 module.exports。
    return module.exports;
  },
});