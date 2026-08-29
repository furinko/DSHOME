// dshome-palette — browser client module (Ctrl+K command palette).
// Vanilla DOM overlay, no React, no sidebar integration.
window.__ModuleLoader__.load({
  id: 'dshome-palette',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var installed = false;

    // favorites (pinned sessions)
    var PIN_KEY = 'dshome.pinned.sessions';
    var PIN_EVENT = 'dshome:pins-changed';
    function pinned() { try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch (e) { return []; } }
    function savePinned(a) { try { localStorage.setItem(PIN_KEY, JSON.stringify(a)); } catch (e) {} }
    function isPinned(id) { return pinned().indexOf(id) >= 0; }
    function togglePinned(id) {
      var a = pinned(); var i = a.indexOf(id);
      if (i >= 0) a.splice(i, 1); else a.unshift(id);
      savePinned(a);
      try { window.dispatchEvent(new CustomEvent(PIN_EVENT)); } catch (e) {}
      return a.indexOf(id) >= 0;
    }

    function titleOf(it) {
      if (it && it.displayTitle) return it.displayTitle;
      if (it && it.projections && it.projections.values && it.projections.values.title) return it.projections.values.title;
      if (it && it.title) return it.title;
      return it ? it.sessionId : '';
    }
    function openSessionByTitle(title) {
      if (!title) return false;
      try {
        var rows = document.querySelectorAll('[role="treeitem"]');
        for (var i = 0; i < rows.length; i++) {
          var lbl = rows[i].getAttribute('aria-label') || '';
          var txt = rows[i].textContent || '';
          if ((lbl && lbl.indexOf(title) >= 0) || (txt && txt.indexOf(title) >= 0)) { rows[i].click(); return true; }
        }
      } catch (e) {}
      return false;
    }

    function rpc(method, params) {
      return fetch(location.origin + '/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'pal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), method, params, payload: params }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.result && d.result.ok) return d.result.value;
          return Promise.reject(new Error((d && d.result && d.result.error && d.result.error.message) || 'rpc failed'));
        });
    }

    function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

    function buildPalette() {
      var root = el('div', 'dshome-palette');
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;background:rgba(5,8,14,.62);align-items:flex-start;justify-content:center;padding-top:16vh;backdrop-filter:blur(2px)';
      var panel = el('div');
      panel.style.cssText = 'width:min(560px,92vw);background:var(--dsw-alias-bg-layer-1,#131a29);border:1px solid var(--dsw-alias-border-l2,#2a3a5c);border-radius:14px;box-shadow:0 22px 60px rgba(0,0,0,.5);overflow:hidden;color:var(--dsw-alias-label-primary,#dbe4f0)';
      var input = el('input'); input.type = 'text'; input.placeholder = 'DSHOME  命令面板…（Enter 打开会话 / Esc 关闭）';
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:14px 18px;font-size:15px;background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l1,#1e2a44);outline:none;color:inherit';
      var list = el('div'); list.style.cssText = 'max-height:46vh;overflow:auto;padding:8px';
      panel.appendChild(input); panel.appendChild(list); root.appendChild(panel); document.body.appendChild(root);

      function close() { root.style.display = 'none'; }
      function open() { root.style.display = 'flex'; input.value = ''; input.focus(); loadSessions(); }
      function renderRows(rows) { list.textContent = ''; rows.forEach((r) => list.appendChild(r)); }
      function token() { return window && typeof window.dispatchEvent === 'function' ? '' : ''; }
      function row(label, sub, onClick, accent, pinBtn) {
        var r = el('div');
        r.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:9px;cursor:pointer;background:' + (accent ? 'var(--dsw-alias-interactive-bg-hover,rgba(107,132,255,.10))' : 'transparent');
        r.onmouseenter = () => { r.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(107,132,255,.10))'; };
        r.onmouseleave = () => { r.style.background = accent ? 'var(--dsw-alias-interactive-bg-hover,rgba(107,132,255,.10))' : 'transparent'; };
        var main = el('div'); main.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px';
        main.appendChild(el('div', null, label));
        if (sub) { var s = el('div'); s.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#8fa3c0)'; s.textContent = sub; main.appendChild(s); }
        r.appendChild(main);
        if (pinBtn) { pinBtn.style.cssText = 'flex:none;font-size:16px;color:var(--dsw-alias-brand-primary,#6B84FF);background:none;border:none;cursor:pointer;padding:0 2px'; pinBtn.onclick = (e) => { e.stopPropagation(); pinBtn._cb && pinBtn._cb(); }; r.appendChild(pinBtn); }
        r.onclick = onClick;
        return r;
      }
      function phrase(txt) { var n = el('div'); n.style.cssText = 'padding:18px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary,#8fa3c0)'; n.textContent = txt; return n; }
      function header(txt) { var n = el('div'); n.style.padding = '6px 14px'; n.style.fontSize = '11px'; n.style.color = 'var(--dsw-alias-label-tertiary,#8fa3c0)'; n.textContent = txt; return n; }

      function sessionRow(it) {
        var title = titleOf(it);
        var star = el('button'); star.textContent = isPinned(it.sessionId) ? '★' : '☆';
        star._cb = () => { togglePinned(it.sessionId); loadSessions(); };
        return row(title, it.sessionId + '  ·  ' + (it.cwd || '-') + '  ·  ' + (it.agentPreset || ''), () => {
          if (openSessionByTitle(title)) close(); else loadModelsFor(it.sessionId);
        }, isPinned(it.sessionId), star);
      }

      function loadSessions() {
        rpc('session.list', {}).then((v) => {
          var items = (v && v.items) || []; var pinOrder = pinned(); var rows = [];
          var pinSessions = pinOrder.map((id) => items.find((it) => it.sessionId === id)).filter(Boolean);
          if (pinSessions.length) {
            rows.push(header('★ 收藏会话'));
            pinSessions.forEach((it) => {
              var st = el('button'); st.textContent = '★'; st._cb = () => { togglePinned(it.sessionId); loadSessions(); };
              rows.push(row(titleOf(it), it.sessionId, () => { if (openSessionByTitle(titleOf(it))) close(); else loadModelsFor(it.sessionId); }, true, st));
            });
          }
          rows.push(row('＋ 新建会话', 'agentPreset: standard', () => { rpc('session.create', { agentPreset: 'standard' }).then(() => close()).catch((e) => alert('新建会话失败: ' + e.message)); }, !pinSessions.length));
          rows.push(header('—— 会话（点击打开 · ☆ 收藏） ——'));
          items.forEach((it) => rows.push(sessionRow(it)));
          if (items.length === 0) rows.push(phrase('暂无会话'));
          renderRows(rows);
        }).catch(() => renderRows([phrase('加载会话失败')]));
      }
      function loadModelsFor(sessionId) {
        rpc('session.models', { sessionId }).then((v) => {
          var rows = [row('← 返回会话列表', '', () => loadSessions())];
          var groups = (v && v.groups) || [];
          groups.forEach((g) => {
            rows.push(header(g.provider + ' @'));
            ((g.models) || []).forEach((m) => {
              var modelId = m.model || m.id || ''; var name = m.name || modelId;
              var isCur = v.current && v.current.model === modelId && v.current.provider === g.provider;
              rows.push(row((isCur ? '✓ ' : '') + name, modelId, () => { rpc('session.selectModel', { sessionId, provider: g.provider, model: modelId }).then(() => close()).catch((e) => alert('切换模型失败: ' + e.message)); }, isCur));
            });
          });
          if (groups.length === 0) rows.push(phrase('无可用模型'));
          renderRows(rows);
        }).catch(() => renderRows([phrase('加载模型失败')]));
      }

      input.addEventListener('input', () => { var q = input.value.toLowerCase(); Array.from(list.children).forEach((c) => { c.style.display = c.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none'; }); });
      document.addEventListener('keydown', (e) => { if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); e.stopPropagation(); open(); } else if (e.key === 'Escape') { close(); } }, true);
      root.addEventListener('click', (e) => { if (e.target === root) close(); });
    }

    function apply(ctx) {
      if (installed) return;
      installed = true;
      try { buildPalette(); } catch (e) { console.warn('dshome-palette: init failed', e); }
    }

    exports.apply = apply;
    return module.exports;
  },
});