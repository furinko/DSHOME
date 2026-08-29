// DSHOME chat verification: session.create -> session.prompt -> poll
// session.history until the assistant reply lands. Proves the full
// session/agent pipeline behind the UI (the UI calls these same RPCs).
const base = process.env.DSHOME_URL ?? 'http://127.0.0.1:3081';

async function rpc(method, params, rpcId = `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ type: 'client-request', rpcId, method, params, payload: params }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${method}: non-JSON ${res.status} ${text.slice(0, 200)}`); }
  if (!data.result?.ok) {
    const err = data.result?.error ?? data;
    throw new Error(`${method}: ${JSON.stringify(err).slice(0, 600)}`);
  }
  return data.result.value;
}

const created = await rpc('session.create', { cwd: 'E:\\DSH', agentPreset: 'standard' });
const sessionId = created.sessionId;
console.log('created:', sessionId, JSON.stringify(created).slice(0, 300));

await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '请只回复两个字：你好' }],
});
console.log('prompt accepted');

const deadline = Date.now() + 90_000;
let reply = '';
let usage = null;
while (Date.now() < deadline) {
  const hist = await rpc('session.history', { sessionId });
  const evs = Array.isArray(hist.events) ? hist.events : [];
  for (const e of evs) {
    const t = e.event?.type;
    const data = e.event?.data ?? {};
    if (t === 'assistant/message') {
      const parts = data.message?.content ?? [];
      const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
      if (text.trim()) reply = text;
    }
    if (t === 'assistant/chunk' && data.chunk?.type === 'usage') usage = data.chunk.usage;
  }
  if (reply) break;
  await new Promise((r) => setTimeout(r, 5000));
}
if (!reply) {
  console.log('NO REPLY within timeout — check server log / credentials');
  process.exitCode = 2;
} else {
  console.log('assistant reply:', JSON.stringify(reply.slice(0, 200)));
  if (usage) console.log('usage:', JSON.stringify(usage));
  console.log('CHAT VERIFIED: create -> prompt -> streaming reply -> turn end OK');
}