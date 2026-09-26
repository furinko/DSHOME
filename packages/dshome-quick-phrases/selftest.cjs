'use strict';
// dshome-quick-phrases 自测（临时验证脚本，不属于插件运行时；跑法：node packages/dshome-quick-phrases/selftest.cjs）
//
// ① host 半：经插件公开面 apply() 捕获子插件 → 捕获 webServer.register 的三条路由 → 真 HTTP 打三个端点
// ② host 半：loopback fence 的正/反例（用假 req 直调路由 handler，伪造 remoteAddress / host）
// ③ client 半：eval 模块源码 → 捕获 __ModuleLoader__.load 定义 → 跑 factory/apply → 断言懒加载与发送链
//
// 数据落在 os.tmpdir() 下的隔离 DSH_HOME（跑完删除）——**不碰仓库里 mind-private/ 的真实短语文件**。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PKG = __dirname;
const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(['PASS', name]); })
    .catch((error) => { results.push(['FAIL', name + ' :: ' + (error && error.message)]); });
}

// 隔离的 DSH_HOME：repoRoot() 要求其下有 mind/ 目录（照抄 mind 的判据）
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-qp-selftest-'));
fs.mkdirSync(path.join(home, 'mind'), { recursive: true });
process.env.DSH_HOME = home;
const DATA_FILE = path.join(home, 'mind-private', 'plugin-data', 'quick-phrases.json');
const DATA_DIR = path.dirname(DATA_FILE);

const plugin = require(path.join(PKG, 'lib', 'index.cjs'));

// ── 捕获子插件与路由 ─────────────────────────────────────────────────────────
const routes = [];
let subPlugin = null;
let effectInstalled = false;
plugin.apply({ plugin: (p) => { subPlugin = p; } });
subPlugin.apply({
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  effect: () => { effectInstalled = true; },
});

const LIST = '/dshome-quick-phrases/list';
const SAVE = '/dshome-quick-phrases/save';
const DELETE = '/dshome-quick-phrases/delete';
const byPath = (p) => routes.find((r) => r.path === p);

const server = http.createServer((req, res) => {
  const route = byPath(String(req.url || '').split('?')[0]);
  if (route === undefined) { res.writeHead(404); res.end(); return; }
  route.handler(req, res);
});

// 注意：loopback fence（照抄 mind）要求带浏览器同源标记 —— 真浏览器同源请求会带
// `sec-fetch-site: same-origin` 与 Origin；Node 的 fetch 默认两个都不发，所以这里显式补上，
// 否则会被自己的 fence 403 掉（第一次跑就是这么红的一片，属于**测试脚本**的失真，不是插件问题）。
const browserHeaders = (extra) => Object.assign({
  'sec-fetch-site': 'same-origin',
  origin: `http://127.0.0.1:${server.address().port}`,
}, extra || {});
const post = (p, body, headers) => fetch(`http://127.0.0.1:${server.address().port}${p}`, {
  method: 'POST',
  headers: browserHeaders(Object.assign({ 'content-type': 'application/json' }, headers || {})),
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: browserHeaders() });

/** 用假 req 直调路由 handler（伪造 remoteAddress / host 做 loopback 反例）。 */
function rawCall(routePath, request) {
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body: body ? JSON.parse(body) : null }); },
    };
    byPath(routePath).handler(request, res);
  });
}

/**
 * client 半的沙箱：极简 DOM 桩（只提供插件真正用到的 API）+ fetch 计数 + 假会话服务。
 * textContent 写成 setter 并清空 children —— 真 DOM 就是这么干的，否则 render() 的
 * `listEl.textContent = ""` 清不掉旧行，断言会看到幽灵节点。
 */
function makeClientSandbox() {
  const styles = []; // 样式节点台账：`head.appendChild(style)` 会登记进来，供 querySelector 查
  const node = (tag, initialChildren) => {
    const n = {
      tagName: tag, className: '', style: {}, children: initialChildren || [], value: '', disabled: false, _text: '', attrs: {},
      appendChild(child) { n.children.push(child); if (tag === 'head' && child && child.tagName === 'style') styles.push(child); return child; },
      setAttribute(k, v) { n.attrs[k] = String(v); },
      focus() {},
    };
    Object.defineProperty(n, 'textContent', {
      get() { return n._text; },
      set(value) { n._text = String(value); n.children.length = 0; },
    });
    return n;
  };
  const fetchCalls = [];
  const sent = [];
  const listeners = [];
  const fixture = [{ id: 'p1', name: '问候', text: '在吗？' }];
  globalThis.document = {
    createElement: node,
    createElementNS: (_ns, tag) => node(tag),
    head: node('head', styles),
    body: node('body'),
    addEventListener: (type, fn) => { listeners.push({ type, fn }); },
    // 2026-09-26 补：样式注入改成「以 DOM 为真源」后，桩必须能查 —— 只按属性匹配我们自己的标记。
    querySelector: (sel) => {
      const m = /^style\[data-dshome-plugin='([^']+)'\]$/.exec(String(sel));
      if (!m) return null;
      return styles.find((s) => s.attrs && s.attrs['data-dshome-plugin'] === m[1]) || null;
    },
  };
  globalThis.fetch = (url, options) => {
    fetchCalls.push(String(url) + (options && options.method ? ' ' + options.method : ''));
    const isList = String(url) === '/dshome-quick-phrases/list';
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, phrases: isList ? fixture : [] }),
    });
  };
  const captured = {};
  const ctx = {
    slots: {
      inject: (key, cb) => { captured.key = key; cb(); },
      register: (options, component) => { captured.options = options; captured.component = component; return () => {}; },
    },
    sessions: {
      scope: (id) => (id === 'sess-1'
        ? { get: (svc) => (svc === 'conversation' ? { send: (text) => { sent.push(text); return Promise.resolve(); } } : undefined) }
        : undefined),
    },
  };
  /** 面板骨架节点路径：root → panel → [head, searchbar, editor, list, foot]。 */
  const rootNode = () => globalThis.document.body.children[0];
  const panelNode = () => rootNode().children[0];
  return {
    captured,
    ctx,
    fetchCalls,
    sent,
    rootNode,
    isVisible: () => rootNode().style.display === 'flex',
    fireKey: (key) => listeners.forEach((l) => { if (l.type === 'keydown') l.fn({ key }); }),
    subLine: () => panelNode().children[0].children[1].children[1].textContent,
    toast: () => panelNode().children[4].children[0].textContent,
    listRows: () => panelNode().children[3].children.map((row) => ({ main: row.children[0], acts: row.children[1] })),
  };
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ① 包清单 + 导出形态 + 装配面（硬禁忌：导出级 inject 不得含 webServer）
  await check('package.json：name/private/type/main/exports/dsh.client 齐备', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'dshome-quick-phrases');
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.main, 'lib/index.cjs');
    assert.equal(manifest.exports['.'], './lib/index.cjs');
    assert.equal(manifest.exports['./client'], './lib/client.js');
    assert.deepEqual(manifest.dsh.client, { platform: 'web', inject: [] });
  });
  await check('导出面只留 name/apply，无导出级 inject', () => {
    assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'name']);
    assert.equal(plugin.name, 'dshome-quick-phrases');
    assert.equal(typeof plugin.apply, 'function');
  });
  await check('子插件自带 inject=[webServer]（依赖不进导出面）', () => {
    assert.deepEqual(subPlugin.inject, ['webServer']);
    assert.equal(subPlugin.name, 'dshome-quick-phrases-api');
    assert.equal(effectInstalled, true);
  });
  await check('注册三条 exact 路由，路径与契约一致', () => {
    assert.deepEqual(routes.map((r) => r.kind), ['exact', 'exact', 'exact']);
    assert.deepEqual(routes.map((r) => r.path), [LIST, SAVE, DELETE]);
  });

  // ② 数据落点：空机（文件不存在）→ 空列表，不抛
  await check('GET list：文件不存在 = 空列表（不抛错）', async () => {
    assert.equal(fs.existsSync(DATA_FILE), false);
    const res = await get(LIST);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, phrases: [] });
  });
  await check('loopback 反例：外部地址 403 forbidden', async () => {
    const out = await rawCall(LIST, { method: 'GET', headers: { host: '127.0.0.1:3099' }, socket: { remoteAddress: '10.1.2.3' } });
    assert.equal(out.status, 403);
    assert.deepEqual(out.body, { ok: false, error: 'forbidden' });
  });
  await check('loopback 反例：host 非本机 403', async () => {
    const out = await rawCall(LIST, { method: 'GET', headers: { host: 'evil.example:3099' }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(out.status, 403);
  });
  await check('loopback 反例：跨站 origin / sec-fetch-site 403', async () => {
    const a = await rawCall(LIST, { method: 'GET', headers: { host: '127.0.0.1:3099', origin: 'http://evil.example' }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(a.status, 403);
    const b = await rawCall(LIST, { method: 'GET', headers: { host: '127.0.0.1:3099', 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(b.status, 403);
  });
  await check('loopback 正例：::ffff:127.0.0.1 与 ::1+localhost 放行（带浏览器同源标记）', async () => {
    const a = await rawCall(LIST, { method: 'GET', headers: { host: '127.0.0.1:3099', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '::ffff:127.0.0.1' } });
    assert.equal(a.status, 200);
    const b = await rawCall(LIST, { method: 'GET', headers: { host: 'localhost:3099', origin: 'http://localhost:3099' }, socket: { remoteAddress: '::1' } });
    assert.equal(b.status, 200);
  });
  await check('loopback 反例：本机地址但无 Origin 也无 Sec-Fetch-Site（curl 这类裸客户端）403', async () => {
    const out = await rawCall(LIST, { method: 'GET', headers: { host: '127.0.0.1:3099' }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(out.status, 403);
  });

  // ③ 新建 / 更新 / 未知 id / 删除 / 幂等 / 坏文件保护
  let firstId = null;
  await check('POST save：无 id = 新建（host 铸 uuid），落盘形状对', async () => {
    const res = await post(SAVE, { phrase: { name: '问候', text: '在吗？' } });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.phrases.length, 1);
    const row = payload.phrases[0];
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    assert.equal(row.name, '问候');
    assert.equal(row.text, '在吗？');
    assert.ok(Date.parse(row.createdAt) > 0);
    assert.equal(row.createdAt, row.updatedAt);
    firstId = row.id;
    const disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    assert.equal(disk.version, 1);
    assert.deepEqual(disk.phrases, payload.phrases);
  });
  await check('原子写：不留临时文件，目录里只有数据文件', () => {
    assert.deepEqual(fs.readdirSync(DATA_DIR), ['quick-phrases.json']);
  });
  await check('POST save：带已知 id = 更新（不新增、createdAt 保留）', async () => {
    const before = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).phrases[0];
    const res = await post(SAVE, { phrase: { id: firstId, name: '问候', text: '在吗？——改过的正文' } });
    const payload = await res.json();
    assert.equal(payload.phrases.length, 1);
    assert.equal(payload.phrases[0].id, firstId);
    assert.equal(payload.phrases[0].text, '在吗？——改过的正文');
    assert.equal(payload.phrases[0].createdAt, before.createdAt);
    assert.ok(Date.parse(payload.phrases[0].updatedAt) >= Date.parse(before.updatedAt));
  });
  await check('POST save：未知 id = 新建（不采纳客户端 id）', async () => {
    const res = await post(SAVE, { phrase: { id: 'forged-id', name: '第二条', text: '正文二' } });
    const payload = await res.json();
    assert.equal(payload.phrases.length, 2);
    assert.notEqual(payload.phrases[1].id, 'forged-id');
  });
  await check('校验：空 name 400 / 非 JSON 媒体类型 415 / 坏 JSON 400 / GET 打 save 405', async () => {
    const bad = await post(SAVE, { phrase: { name: '   ', text: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'BAD_REQUEST');
    const media = await post(SAVE, { phrase: { name: 'a', text: 'b' } }, { 'content-type': 'text/plain' });
    assert.equal(media.status, 415);
    const broken = await post(SAVE, '{not json');
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).error.code, 'BAD_JSON');
    const wrong = await get(SAVE);
    assert.equal(wrong.status, 405);
  });
  await check('POST delete：删掉一条返回全量列表；重复删幂等 200', async () => {
    const res = await post(DELETE, { id: firstId });
    const payload = await res.json();
    assert.equal(payload.phrases.length, 1);
    const again = await post(DELETE, { id: firstId });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).phrases.length, 1);
    const missing = await post(DELETE, {});
    assert.equal(missing.status, 400);
  });
  await check('坏文件保护：JSON 坏了 → 500 DATA_CORRUPT，且文件不被覆盖', async () => {
    const raw = '{ this is not json';
    fs.writeFileSync(DATA_FILE, raw, 'utf8');
    const res = await post(SAVE, { phrase: { name: 'x', text: 'y' } });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'DATA_CORRUPT');
    assert.equal(fs.readFileSync(DATA_FILE, 'utf8'), raw);
    const list = await get(LIST);
    assert.equal(list.status, 500);
    fs.rmSync(DATA_FILE, { force: true });
  });

  // ④ client 半：eval 源码 → 捕获 module 定义 → factory/apply → 懒加载 + 发送链
  await check('client 半：load id = 包名；factory 出 name/inject/apply', () => {
    const src = fs.readFileSync(path.join(PKG, 'lib', 'client.js'), 'utf8');
    const loadCalls = [];
    const sandboxWindow = { __ModuleLoader__: { load: (def) => loadCalls.push(def) } };
    const fakeRequire = (id) => {
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ $$type: type, props }) };
      throw new Error('unknown module ' + id);
    };
    new Function('window', 'require', src)(sandboxWindow, fakeRequire);
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0].id, 'dshome-quick-phrases');
    const mod = loadCalls[0].factory(fakeRequire);
    assert.equal(mod.name, 'dshome-quick-phrases');
    assert.deepEqual(mod.inject, ['slots', 'sessions', 'conversation']);
    assert.equal(typeof mod.apply, 'function');
    globalThis.__qpMod = mod;
  });
  await check('client 半：注册 input.right / id "phrases"；渲染零请求，点开才 GET list', async () => {
    globalThis.__qpState = makeClientSandbox();
    const { captured, fetchCalls } = globalThis.__qpState;
    globalThis.__qpMod.apply(globalThis.__qpState.ctx);
    assert.equal(captured.key, 'conversation.input.right');
    assert.equal(captured.options.name, 'conversation.input.right');
    assert.equal(captured.options.id, 'phrases');
    assert.equal(captured.options.priority, undefined); // 默认 0；与 dshome-input 的 "queue" 不同槽，无冲突
    assert.equal(typeof captured.options.inject, 'function');
    const injected = captured.options.inject('sess-1');
    const element = captured.component({
      sessionId: 'sess-1',
      useSessions: (sel) => sel({ byId: { 'sess-1': { title: '测试会话', displayTitle: '测试会话' } } }),
      send: injected.send,
    });
    assert.equal(element.$$type, 'button');
    assert.equal(element.props.children.length, 2);
    assert.equal(element.props.children[1].props.children, '短语');
    assert.deepEqual(fetchCalls, []); // 面板没打开前一个请求都不发
    element.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(fetchCalls, ['/dshome-quick-phrases/list']);
    // 面板顶部显示目标会话标题
    assert.match(globalThis.__qpState.subLine(), /发送到：测试会话/);
    await injected.send('在吗？');
    assert.deepEqual(globalThis.__qpState.sent, ['在吗？']); // scope → actx.get('conversation') → send(text)
    const noSession = captured.options.inject(undefined);
    await assert.rejects(() => noSession.send('x'), (error) => error.code === 'NO_SESSION');
    const goneScope = captured.options.inject('sess-404');
    await assert.rejects(() => goneScope.send('x'), (error) => error.code === 'NO_SESSION');
  });
  await check('client 半：点短语行 = 发一条消息（可连发）；改/删按钮与二次确认都在', async () => {
    const { listRows, sent } = globalThis.__qpState;
    const row = listRows()[0];
    assert.equal(row.main.children[0].textContent, '问候'); // name
    assert.equal(row.main.children[1].textContent, '在吗？'); // text 单行预览
    assert.deepEqual(row.acts.children.map((b) => b.textContent), ['改', '删']);
    row.main.onclick(); // 连发两次：第二次不该被闸掉
    row.main.onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ['在吗？', '在吗？', '在吗？']); // 含上面直调注入面那一次
    // 删除前二次确认（不用 window.confirm）：删 → 确认删除/取消 → 取消复原
    row.acts.children[1].onclick();
    let acts = listRows()[0].acts;
    assert.deepEqual(acts.children.map((b) => b.textContent), ['确认删除', '取消']);
    acts.children[1].onclick();
    acts = listRows()[0].acts;
    assert.deepEqual(acts.children.map((b) => b.textContent), ['改', '删']);
  });
  await check('client 半：无会话时点行只提示「当前没有打开的会话」，面板照常可管理', async () => {
    const state = globalThis.__qpState;
    const noSessionSend = state.captured.options.inject(undefined).send;
    const element = state.captured.component({
      sessionId: undefined,
      useSessions: (sel) => sel({ byId: {} }),
      send: noSessionSend,
    });
    element.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(state.subLine(), /未选中会话/);
    state.listRows()[0].main.onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(state.toast(), '当前没有打开的会话');
  });
  await check('client 半：Esc 关面板、点遮罩关面板、点面板内部不关', async () => {
    const state = globalThis.__qpState;
    const element = state.captured.component({
      sessionId: 'sess-1',
      useSessions: (sel) => sel({ byId: { 'sess-1': { title: '测试会话', displayTitle: '测试会话' } } }),
      send: state.captured.options.inject('sess-1').send,
    });
    const clickOpen = () => element.props.onClick({ preventDefault() {}, stopPropagation() {} });
    clickOpen();
    assert.equal(state.isVisible(), true);
    state.rootNode().onclick({ target: state.rootNode().children[0] }); // 点面板内部：不关
    assert.equal(state.isVisible(), true);
    state.fireKey('Escape');
    assert.equal(state.isVisible(), false);
    state.fireKey('Escape'); // 面板已关：Esc 不该有任何副作用
    assert.equal(state.isVisible(), false);
    clickOpen();
    assert.equal(state.isVisible(), true);
    state.rootNode().onclick({ target: state.rootNode() }); // 点遮罩：关
    assert.equal(state.isVisible(), false);
  });

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });

  const failed = results.filter((r) => r[0] === 'FAIL');
  for (const [state, name] of results) console.log(`${state}  ${name}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exitCode = 2;
});
