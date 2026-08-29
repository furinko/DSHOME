const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable');
const btns = await ev(`[...document.querySelectorAll('[aria-haspopup="dialog"]')].length`);
// click each until a dialog with 插件管理 nav appears; report which
for (let i = 0; i < btns; i++) {
  await ev(`[...document.querySelectorAll('[aria-haspopup="dialog"]')][${i}]?.click()`);
  await new Promise((r) => setTimeout(r, 1200));
  const has = await ev(`document.querySelector('[role="dialog"]')?.innerText.includes('插件管理')`);
  const nav = await ev(`(()=>{const d=document.querySelector('[role="dialog"]');if(!d)return[];return [...d.querySelectorAll('button')].map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,12)})()`);
  console.log('btn', i, 'has 插件管理=', has, 'nav=', JSON.stringify(nav));
  if (has) { const t = await ev(`(()=>{const c=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='插件管理');c&&c.click();return !!c})()`); await new Promise((r) => setTimeout(r, 800)); console.log('  clicked 插件管理=', t, 'switches=', await ev(`document.querySelectorAll('[role="switch"]').length`)); }
  await ev(`document.querySelector('[role="dialog"]')&&document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await new Promise((r) => setTimeout(r, 400));
}
ws.close(); process.exit(0);
