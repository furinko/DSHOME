// DSHOME 自救守护 v4（注入主页面 <head>，早于任何插件 bundle 执行）。
// 演进：
//   v1 自动刷新+跳转 → 误判即劫持页面（死循环、吞报错现场）——废弃。
//   v2 改横幅不劫持，但用「轮询整页 body 文本」检测 → 命中对话/历史消息里的
//      'Failed to load plugins' 字样（会话文本就有）→ 误弹横幅——废弃全文轮询。
//   v3 只认 JS 错误事件（error/unhandledrejection 的 message），零误触；
//      但官方若把注册失败【渲染成页面文本】（如 "did not activate / pending"）
//      而不抛 JS error，则不弹 → 漏报。
// v4 = v3 通道保留（精准）+ 新增【渲染式失败页】通道：
//      只在【非对话流容器】出现实锤失败短语才弹横幅——两个排除类：
//      ① [data-chat-flow]（对话/历史，用户聊到这些词）；
//      ② DSHOME 自有知识/文档面板（.dshome-mind-*，渲染 .md 正文，如 project.md
//         就字面含 "Failed to load plugins" 的描述性句子）→ 都算"内容展示"，
//         不是 boot 失败状态，永不误触。
//      命中 → 顶部可关横幅：[去自救台停用插件]（新标签）+ [关闭]；永不跳转/刷新/劫持。
(() => {
  'use strict';
  if (window.__dshomeSHGuard) return;
  window.__dshomeSHGuard = 1;
  if (/^\/self-heal/.test(location.pathname)) return;

  // 实锤错误句：client-modules 注册失败抛的 Error / 官方加载失败文案（JS 错误通道）。
  var TRIGGERS = ['loaded without registering', 'Failed to load plugins'];
  // 渲染式失败短语：官方把 boot/pending 失败渲染成 UI 文本时用的实锤句（DOM 通道）。
  var DOM_TRIGGERS = ['Failed to load plugins', 'did not activate', 'waiting for service', 'does not appear to be registered'];

  function isTrigger(m) {
    for (var i = 0; i < TRIGGERS.length; i++) {
      if (m.indexOf(TRIGGERS[i]) !== -1) return true;
    }
    return false;
  }
  function snippet(m) {
    m = String(m || '').replace(/\s+/g, ' ').trim();
    if (m.length > 200) m = m.slice(0, 200) + '…';
    return m;
  }
  function showBanner(text) {
    if (document.getElementById('dsh-sh-banner')) return;
    var div = document.createElement('div');
    div.id = 'dsh-sh-banner';
    div.setAttribute('role', 'alert');
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;'
      + 'background:#fff8e1;border-bottom:1px solid #f0d47c;color:#3a2f00;'
      + 'font:13px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;'
      + 'padding:9px 14px;display:flex;gap:12px;align-items:center;'
      + 'box-shadow:0 2px 6px rgba(0,0,0,.15);flex-wrap:wrap';
    var msg = document.createElement('span');
    msg.style.cssText = 'flex:1;min-width:200px;word-break:break-all';
    msg.textContent = '⚠️ 检测到插件加载异常：' + text;
    var heal = document.createElement('button');
    heal.textContent = '去自救台停用插件';
    heal.style.cssText = 'font:inherit;cursor:pointer;padding:4px 12px;border-radius:6px;'
      + 'border:1px solid #b07d1e;background:#fff;color:#7a5600';
    heal.onclick = function () {
      try { window.open('/self-heal', '_blank'); } catch (e) { /* ignore */ }
    };
    var close = document.createElement('button');
    close.textContent = '关闭';
    close.style.cssText = 'font:inherit;cursor:pointer;padding:4px 10px;border-radius:6px;'
      + 'border:1px solid #ccc;background:#fff;color:#555';
    close.onclick = function () { div.remove(); };
    div.appendChild(msg);
    div.appendChild(heal);
    div.appendChild(close);
    var mount = function () {
      if (document.body) document.body.appendChild(div);
      else setTimeout(mount, 200);
    };
    mount();
  }

  // 通道 1：JS 加载/执行错误（仅实锤错误句；普通业务错误不打扰）。
  window.addEventListener('error', function (e) {
    var m = String((e && e.message) || (e && e.error && e.error.message) || '');
    if (isTrigger(m)) showBanner(snippet(m));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var m = String((r && r.message) || (r && String(r)) || '');
    if (isTrigger(m)) showBanner(snippet(m));
  });

  // 通道 2：渲染式失败页 —— 官方把失败渲染成 UI 文本（非 JS error）时兜底。
  // 只在【非内容展示容器】命中才触发；对话流/DSHOME 知识面板内的同名文本一律跳过。
  var domScanIssued = false;
  // 是否为"内容展示"容器（用户看到的内容，不是 boot 失败状态）：
  //  ① data-chat-flow —— 官方聊天流（对话/历史，聊到这些词很正常）；
  //  ② class 含 dshome-mind —— DSHOME 心智/知识面板（渲染 .md 正文，如 project.md
  //     字面含 "Failed to load plugins" 这类描述旧事故的句子）。
  function isContentSurface(el) {
    var p = el;
    while (p) {
      if (p.getAttribute && p.getAttribute('data-chat-flow') !== null) return true;
      if (typeof p.className === 'string' && p.className.indexOf('dshome-mind') !== -1) return true;
      p = p.parentElement;
    }
    return false;
  }
  function renderHealCheck() {
    if (domScanIssued) return;
    var found = null;
    var guard = 0;
    try {
      var walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
      var node;
      while ((node = walker.nextNode()) && guard < 200000) {
        guard += 1;
        var t = node.nodeValue || '';
        var hit = null;
        for (var i = 0; i < DOM_TRIGGERS.length; i++) {
          if (t.indexOf(DOM_TRIGGERS[i]) !== -1) { hit = t; break; }
        }
        if (hit === null) continue;
        var parent = node.parentElement;
        if (parent === null || !isContentSurface(parent)) { found = hit; break; }
      }
    } catch (e) { return; }
    if (found) {
      domScanIssued = true;
      showBanner(snippet(found));
      if (shObserver !== null) shObserver.disconnect();
    }
  }
  var shObserver = null;
  var pendTimer = null;
  function scheduleScan() {
    if (pendTimer !== null) return;
    pendTimer = window.setTimeout(function () { pendTimer = null; renderHealCheck(); }, 250);
  }
  function startObserving() {
    if (shObserver !== null || typeof MutationObserver === 'undefined') return;
    try {
      shObserver = new MutationObserver(scheduleScan);
      shObserver.observe(document.body, { childList: true, subtree: true });
      renderHealCheck();
    } catch (e) { /* ignore */ }
  }
  if (document.body) startObserving();
  else document.addEventListener('DOMContentLoaded', startObserving);
})();
