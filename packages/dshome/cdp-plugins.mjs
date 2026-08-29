// CDP: verify DSHOME「插件管理」settings section renders the plugin list + a toggle works.
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
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 5000));

console.log('trigger:', await ev(`!!document.querySelector('[aria-haspopup="dialog"]')`));
await ev(`document.querySelector('[aria-haspopup="dialog"]')?.click()`);
await new Promise((r) => setTimeout(r, 1500));
console.log('modal:', await ev(`!!document.querySelector('[role="dialog"]')`));

// click the「插件管理」nav item (a button whose text is the section label)
const clicked = await ev(`(()=>{const btns=[...document.querySelectorAll('[role="dialog"] nav button, [role="dialog"] [role="tab"], [role="navigation"] button')];const tr=btns.find(b=>(b.textContent||'').trim()==='插件管理');if(!tr&&document.body.innerText.includes('插件管理')){const c=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='插件管理');c&&c.click();return 'clicked:'+!!c}tr&&tr.click();return 'clicked:'+!!tr})()`);
console.log('clicked plugin nav:', clicked);
await new Promise((r) => setTimeout(r, 1500));

console.log('has 插件管理 heading:', await ev(`document.body.innerText.includes('插件管理')`));
console.log('switch count:', await ev(`document.querySelectorAll('[role="switch"]').length`));
console.log('category group labels:', JSON.stringify(await ev(`(()=>{const out=[];document.body.innerText&&/自制|下载|内置/.test(document.body.innerText)&&['自制','下载','内置'].forEach(c=>{const m=document.body.innerText.match(new RegExp(c+'\\s*\\(\\d+\\)'));if(m)out.push(m[0])});return out})()`)));
console.log('first row moduleName:', await ev(`(()=>{const s=[...document.querySelectorAll('[role="switch"]')];if(!s.length)return null;let el=s[0];let lab='';let p=el.parentElement;while(p&&p!==document.body){const txt=p.innerText||'';if(txt.indexOf('/')>0){lab=txt.split('\\n')[0];break}p=p.parentElement}return {near:(el.parentElement?.innerText||'').slice(0,60)}})()`));

// toggle the FIRST switch (a dshome plugin) OFF → host writes cordis.patch + result
const before = await ev(`(()=>{const s=document.querySelectorAll('[role="switch"]')[0];return s?s.getAttribute('aria-checked'):null})()`);
await ev(`document.querySelectorAll('[role="switch"]')[0]?.click()`);
await new Promise((r) => setTimeout(r, 1500));
console.log('after toggle aria:', await ev(`(()=>{const s=document.querySelectorAll('[role="switch"]')[0];return s?s.getAttribute('aria-checked'):null})()`));
console.log('result text present:', await ev(`(()=>{const m=document.body.innerText.match(/重启生效[^\\n]*|已停用[^\\n]*|已启用[^\\n]*/);return m?m[0]:null})()`));
console.log('before aria:', before);
await ev(`document.querySelector('[role="dialog"]')&&document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
ws.close();
process.exit(0);
