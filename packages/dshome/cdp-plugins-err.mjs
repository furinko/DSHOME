const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pend = new Map(); let id = 0;
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable');
await ev(`document.querySelector('[aria-haspopup="dialog"]')?.click()`);
await new Promise((r) => setTimeout(r, 1000));
await ev(`(()=>{const c=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='插件管理');c&&c.click();return !!c})()`);
await new Promise((r) => setTimeout(r, 1000));
console.log('h2 插件管理 (in section body):', await ev(`(()=>{const h=[...document.querySelectorAll('h2')].find(x=>x.textContent==='插件管理');return !!h})()`));
console.log('--- console/exception logs ---');
logs.forEach((l) => console.log(l));
console.log('--- end ---');
ws.close(); process.exit(0);
