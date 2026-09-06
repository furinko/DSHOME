// DSHOME 自救守护 v3（注入主页面 <head>，早于任何插件 bundle 执行）。
// 演进：
//   v1 自动刷新+跳转 → 误判即劫持页面（死循环、吞报错现场）——废弃。
//   v2 改横幅不劫持，但用「轮询整页 body 文本」检测 → 命中对话/历史消息里的
//      'Failed to load plugins' 字样（会话文本就有）→ 误弹横幅——废弃全文轮询。
// v3 原则：**只认 JS 错误事件，绝不扫页面文本**。
//   聊天内容、历史消息、任何页面文字都不会作为 JS error/unhandledrejection 的
//   message 出现；只有真实加载/注册失败（client-modules throw）才会 → 零误触。
//   命中 → 顶部可关横幅：[去自救台停用插件]（新标签）+ [关闭]；永不跳转/刷新。
(() => {
  'use strict';
  if (window.__dshomeSHGuard) return;
  window.__dshomeSHGuard = 1;
  if (/^\/self-heal/.test(location.pathname)) return;

  // 实锤错误句：client-modules 注册失败抛的 Error / 官方加载失败文案。
  // 这些短语作为【JS 错误消息】出现时基本可信；对话文本不会走到这里。
  var TRIGGERS = ['loaded without registering', 'Failed to load plugins'];

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

  // 唯一通道：JS 加载/执行错误（仅实锤错误句；普通业务错误不打扰）
  window.addEventListener('error', function (e) {
    var m = String((e && e.message) || (e && e.error && e.error.message) || '');
    if (isTrigger(m)) showBanner(snippet(m));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var m = String((r && r.message) || (r && String(r)) || '');
    if (isTrigger(m)) showBanner(snippet(m));
  });
})();
