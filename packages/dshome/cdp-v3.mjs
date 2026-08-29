// CDP v3: palette titles, favorites, sidebar favorites panel.
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.reload'); await new Promise((r) => setTimeout(r, 11000));

// sidebar favorites panel present BEFORE any pin?
console.log('sidebar ★收藏 header present:', await ev(`!!([...document.querySelectorAll('div')].find(d=>d.textContent==='★ 收藏'))`));
// open palette
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,key:'k',bubbles:true}))`);
await new Promise((r) => setTimeout(r, 1200));
// first session row label (title vs session-id)
console.log('first rows:', JSON.stringify(await ev(`(()=>{const p=document.querySelector('.dshome-palette');if(!p)return [];const c=p.children[0].children[1];return [...c.children].slice(0,7).map(x=>(x.children[0]?.textContent||'').slice(0,45))})()`)));
// pin first session star
console.log('click ☆:', await ev(`(()=>{const b=[...document.querySelectorAll('.dshome-palette button')].find(x=>x.textContent==='☆');if(!b)return 'none';b.click();return 'ok'})()`));
await new Promise((r) => setTimeout(r, 1000));
console.log('after pin → ★收藏区:', await ev(`(()=>{const p=document.querySelector('.dshome-palette');return p? p.children[0].children[1].textContent.includes('★ 收藏会话'):null})()`));
console.log('ls:', await ev(`localStorage.getItem('dshome.pinned.sessions')`));
// close palette, check sidebar panel now shows ★ 收藏
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await new Promise((r) => setTimeout(r, 600));
console.log('sidebar ★收藏 header now:', await ev(`!!([...document.querySelectorAll('div')].find(d=>d.textContent==='★ 收藏'))`));
console.log('sidebar fav item count:', await ev(`[...document.querySelectorAll('[role="button"]')].filter(b=>(b.textContent||'').indexOf('★ ')===0).length`));
// reload -> persistence + sidebar panel persists
await send('Page.reload'); await new Promise((r) => setTimeout(r, 11000));
console.log('after reload sidebar ★收藏:', await ev(`!!([...document.querySelectorAll('div')].find(d=>d.textContent==='★ 收藏'))`));
ws.close(); process.exit(0);