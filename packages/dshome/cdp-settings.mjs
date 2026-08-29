const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable');
console.log('haspopup buttons:', JSON.stringify(await ev(`(()=>{const b=[...document.querySelectorAll('[aria-haspopup="dialog"]')].map(x=>(x.textContent||'').trim()||'<icon>');return b})()`)));
// open the SETTINGS modal: the trigger is the sidebar-foot one; try by aria-label/text '设置' or nav-bearing
await ev(`(()=>{const b=[...document.querySelectorAll('[aria-haspopup="dialog"]')].find(x=>(x.textContent||'').includes('设置'));b&&b.click();return !!b})()`);
await new Promise((r) => setTimeout(r, 1500));
console.log('after settings open, nav:', JSON.stringify(await ev(`(()=>{const d=document.querySelector('[role="dialog"]');if(!d)return [];const b=[...d.querySelectorAll('nav button, [role="navigation"] button')].map(x=>(x.textContent||'').trim()).filter(Boolean);return b})()`)));
console.log('has 插件管理 in dialog text:', await ev(`document.querySelector('[role="dialog"]')?.innerText.includes('插件管理')`));
ws.close(); process.exit(0);
