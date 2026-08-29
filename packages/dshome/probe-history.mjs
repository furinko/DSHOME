// Print the tail of a session event stream (diagnostic helper).
const base = process.env.DSHOME_URL ?? 'http://127.0.0.1:3081';
const sessionId = process.argv[2];
if (!sessionId) { console.error('usage: node probe-history.mjs <sessionId>'); process.exit(1); }
const r = await fetch(`${base}/api/session.history`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({
    type: 'client-request', rpcId: 'h-probe', method: 'session.history',
    params: { sessionId }, payload: { sessionId },
  }),
});
const d = await r.json();
if (!d.result?.ok) { console.error('rpc failed', JSON.stringify(d.result?.error).slice(0, 500)); process.exit(1); }
const evs = d.result.value.events ?? [];
console.log('events:', evs.length);
for (const e of evs.slice(-16)) {
  const t = e.event.type;
  const data = e.event.data ?? {};
  const texts = [];
  if (Array.isArray(data.content)) {
    for (const p of data.content) if (p?.type === 'text') texts.push(p.text);
  }
  if (typeof data.text === 'string') texts.push(data.text);
  const sum = texts.join(' ').replace(/\s+/g, ' ').slice(0, 140);
  console.log(`seq ${e.event.seq} ${t} role=${data.role ?? '-'} ${sum}`);
}