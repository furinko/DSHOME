// DSHOME RPC probe — standard client-request envelope over POST /api/<method>.
// Usage: node probe-rpc.mjs <method> [jsonParams]
//   node probe-rpc.mjs session.list {}
//   node probe-rpc.mjs session.create '{"title":"dshome probe"}'
import { readFileSync } from 'node:fs';

const base = process.env.DSHOME_URL ?? 'http://127.0.0.1:3081';
const method = process.argv[2] ?? 'session.list';
const params = (() => {
  try { return JSON.parse(process.argv[3] ?? '{}'); } catch { return {}; }
})();
const asString = process.argv[4] === 'string';
const rpcId = `probe-${Date.now()}`;

const res = await fetch(`${base}/api/${method}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Origin: base,
  },
  body: JSON.stringify(asString
  ? { type: 'client-request', rpcId, method, params: {}, payload: JSON.stringify(params) }
  : { type: 'client-request', rpcId, method, params, payload: params }),
});
const text = await res.text();
console.log(`HTTP ${res.status} (${method})`);
try {
  const data = JSON.parse(text);
  console.log(JSON.stringify(data, null, 2).slice(0, 4000));
} catch {
  console.log(text.slice(0, 2000));
}