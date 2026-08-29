// CDP: dispatch Ctrl+K, verify palette overlay + session rows.
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');

console.log('dispatch Ctrl+K:', await ev(`(()=>{try{document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,key:'k',bubbles:true}));return 'sent'}catch(e){return 'ERR '+e.message}})()`));
await new Promise((r) => setTimeout(r, 1500));
console.log('overlay present:', await ev(`!!document.querySelector('.dshome-palette')`));
console.log('overlay displayed:', await ev(`(()=>{const p=document.querySelector('.dshome-palette');return p?getComputedStyle(p).display:null})()`));
console.log('row count:', await ev(`document.querySelector('.dshome-palette') ? document.querySelector('.dshome-palette').children[0].children[1].children.length : -1`));
console.log('first rows:', JSON.stringify(await ev(`(()=>{const l=document.querySelector('.dshome-palette');if(!l)return[];const rows=l.children[0].children[1];return [...rows.children].slice(0,6).map(x=>(x.children[0]?.textContent||'').slice(0,40))})()`)));
console.log('nosessions?', await ev(`(()=>{const t=document.querySelector('.dshome-palette');if(!t)return null;return t.children[0].children[1].textContent.includes('暂无会话')})()`));
// close with Esc for cleanliness
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
ws.close();
process.exit(0);