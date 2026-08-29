// CDP inspection of the DSHOME window: read sidebar brand DOM + console logs.
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
  else if (msg.method === 'Runtime.consoleAPICalled') {
    events.push({ kind: 'console', type: msg.params.type, args: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
  } else if (msg.method === 'Log.entryAdded') {
    events.push({ kind: 'log', level: msg.params.entry.level, text: msg.params.entry.text });
  }
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
await send('Log.enable');
await send('Page.enable');

console.log('== BEFORE RELOAD ==');
console.log('brandTexts:', JSON.stringify(await evaluate(`[...document.querySelectorAll('span')].map(e=>e.textContent).filter(t=>t&&/DSHOME|DSH Local|Local Build/.test(t)).slice(0,10)`)));
console.log('fallback present:', await evaluate(`!!document.querySelector('[class*="fallbackBrandName"]')`));
console.log('markHTML:', (await evaluate(`document.querySelector('[class*="brandMark"]')?.innerHTML?.slice(0,120)`)));

console.log('== RELOADING ==');
await send('Page.reload');
await new Promise((r) => setTimeout(r, 12000));

console.log('== AFTER RELOAD ==');
console.log('brandTexts:', JSON.stringify(await evaluate(`[...document.querySelectorAll('span')].map(e=>e.textContent).filter(t=>t&&/DSHOME|DSH Local|Local Build/.test(t)).slice(0,10)`)));
console.log('fallback present:', await evaluate(`!!document.querySelector('[class*="fallbackBrandName"]')`));
console.log('markHTML:', (await evaluate(`document.querySelector('[class*="brandMark"]')?.innerHTML?.slice(0,120)`)));
console.log('== CONSOLE/LOG EVENTS (dshome related) ==');
for (const e of events) if (/dshome|theme|slot|error|warn/i.test(e.text)) console.log(JSON.stringify(e));
console.log('== ALL console types ==');
console.log(JSON.stringify(events.filter((e) => e.kind === 'console').map((e) => e.type + ': ' + e.args.slice(0, 80))).slice(0, 2000));
ws.close();
process.exit(0);