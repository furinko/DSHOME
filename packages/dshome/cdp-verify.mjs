// CDP live verify: reload with cache disabled, read sidebar brand.
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const events = [];
let id = 0;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.consoleAPICalled') events.push({ kind: 'console', type: msg.params.type, args: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
  else if (msg.method === 'Log.entryAdded') events.push({ kind: 'log', level: msg.params.entry.level, text: msg.params.entry.text });
};
await new Promise((res) => (ws.onopen = res));
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.reload');
await new Promise((r) => setTimeout(r, 12000));
console.log('brandTexts:', JSON.stringify(await evaluate(`[...document.querySelectorAll('span')].map(e=>e.textContent).filter(t=>t&&/DSHOME|DSH Local|Local Build|v0\\.1\\.0/.test(t)).slice(0,10)`)));
console.log('badgeStyle:', JSON.stringify(await evaluate(`(()=>{const s=[...document.querySelectorAll('span')].find(e=>e.textContent==='v0.1.0');if(!s)return null;const c=getComputedStyle(s);return{display:c.display,background:c.backgroundColor,borderRadius:c.borderRadius,fontSize:c.fontSize,color:c.color,height:c.height}})()`)));
console.log('palette:', JSON.stringify(await evaluate(`(()=>{const cs=getComputedStyle(document.body);const sidebar=document.querySelector('[class*="hHd-Xa_root"]')||document.querySelector('[class*="sidebar"]');const sc=sidebar?getComputedStyle(sidebar).backgroundColor:null;return{bodyBg:cs.backgroundColor,bodyColor:cs.color,sidebarBg:sc}})()`)));
console.log('fallback present:', await evaluate(`!!document.querySelector('[class*="fallbackBrandName"]')`));
console.log('dshome name element:', await evaluate(`[...document.querySelectorAll('span')].some(e=>e.textContent==='DSHOME')`));
console.log('dshome warns:', JSON.stringify(events.filter((e) => /dshome/.test(e.args)).map((e) => e.args.slice(0, 120))));
ws.close();
process.exit(0);