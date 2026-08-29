// CDP: favorites (pin) flows — pin a session, verify pinned section + persist across reload.
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.reload'); await new Promise((r) => setTimeout(r, 11000));

async function openPalette() {
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,key:'k',bubbles:true}))`);
  await new Promise((r) => setTimeout(r, 1200));
}
async function state() {
  return await ev(`(()=>{const p=document.querySelector('.dshome-palette');if(!p)return {open:false};const txt=p.children[0].children[1].textContent;return {open:true,pinned:txt.includes('收藏会话'),stars:[...p.querySelectorAll('button')].filter(b=>b.textContent==='☆').length,starmany:[...p.querySelectorAll('button')].filter(b=>b.textContent==='★').length,ls:(localStorage.getItem('dshome.pinned.sessions')||'[]')}})()`);
}

await openPalette();
console.log('initial:', JSON.stringify(await state()));

// pin the first unpinned session's star
console.log('click first ☆:', await ev(`(()=>{const b=[...document.querySelectorAll('.dshome-palette button')].find(x=>x.textContent==='☆');if(!b)return 'none';b.click();return 'clicked'})()`));
await new Promise((r) => setTimeout(r, 800));
console.log('after pin:', JSON.stringify(await state()));

// reload -> persistence
await send('Page.reload'); await new Promise((r) => setTimeout(r, 11000));
await openPalette();
console.log('after reload:', JSON.stringify(await state()));

// unpin the ★ (in the pinned section)
console.log('click ★ to unpin:', await ev(`(()=>{const b=[...document.querySelectorAll('.dshome-palette button')].find(x=>x.textContent==='★');if(!b)return 'none';b.click();return 'clicked'})()`));
await new Promise((r) => setTimeout(r, 800));
console.log('after unpin:', JSON.stringify(await state()));
ws.close();
process.exit(0);