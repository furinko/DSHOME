// CDP: verify the DSHOME notification settings row (设置→通知) renders and persists.
// Steps: disable cache → reload 3081 → open Settings modal → find the two `[role=switch]`
// toggles → report initial state → toggle the master switch → confirm host `dshome.enabled`.
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

// reopen the page to freshly-serve the client modules
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 5000));

// 1) open the Settings modal (the settings trigger has aria-haspopup=dialog)
console.log('trigger found:', await ev(`!!document.querySelector('[aria-haspopup="dialog"]')`));
await ev(`document.querySelector('[aria-haspopup="dialog"]')?.click()`);
await new Promise((r) => setTimeout(r, 1500));

// 2) dump the switch toggles inside the opened settings content
function dumpSwitches(label) { return label; }
console.log('modal open:', await ev(`!!document.querySelector('[role="dialog"]')`));
console.log('notify row text present:', await ev(`document.body.innerText.includes('通知')`));
console.log('switch count:', await ev(`document.querySelectorAll('[role="switch"]').length`));
console.log('switches:', JSON.stringify(await ev(`(()=>{const r=[];document.querySelectorAll('[role="switch"]').forEach((b,i)=>r.push({i, checked:b.getAttribute('aria-checked'), text:b.textContent, near:(b.parentElement?.innerText||'').slice(0,60)}));return r})()`)));

// 3) toggle the FIRST switch (master "通知") OFF
await ev(`document.querySelectorAll('[role="switch"]')[0]?.click()`);
await new Promise((r) => setTimeout(r, 1500));
console.log('after toggle switches:', JSON.stringify(await ev(`(()=>{const r=[];document.querySelectorAll('[role="switch"]').forEach((b,i)=>r.push({i, checked:b.getAttribute('aria-checked')}));return r})()`)));

// 4) confirm the host persisted `dshome.enabled` (RPC from within the page)
console.log('host dshome.enabled:', await ev(`(async()=>{const res=await fetch('/api/settings.describe',{method:'POST',headers:{'content-type':'application/json',Origin:location.origin},body:JSON.stringify({type:'client-request',rpcId:'cdp-notify',method:'settings.describe',params:{},payload:{}})});const d=await res.json();const n=(d.result?.value||{}).namespaces?.find(x=>x.ns==='dshome');return JSON.stringify(n?.value)})()`));

// 5) toggle it back ON, then close modal
await ev(`document.querySelectorAll('[role="switch"]')[0]?.click()`);
await new Promise((r) => setTimeout(r, 1200));
console.log('final switches:', JSON.stringify(await ev(`(()=>{const r=[];document.querySelectorAll('[role="switch"]').forEach((b,i)=>r.push({i, checked:b.getAttribute('aria-checked')}));return r})()`)));
await ev(`document.querySelector('[role="dialog"]')&&document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
ws.close();
process.exit(0);
