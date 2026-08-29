// Headless materialization test for the dshome-theme client factory:
// mimics window.__ModuleLoader__.load + stubs react/jsx-runtime, asserts
// factory(require) RETURNS a plugin with an apply function (the contract
// official client modules rely on).
import { readFileSync } from 'node:fs';

const src = readFileSync('E:/DSH/packages/dshome-theme/lib/client.js', 'utf8');
let captured = null;

const sandbox = src; // 已是完整语句：window.__ModuleLoader__.load({...});
// evaluate with a window global that captures the registration
const window = {
  __ModuleLoader__: {
    load(registration) {
      captured = registration;
    },
  },
};
globalThis.window = window;
(0, eval)(sandbox);

if (!captured) {
  console.error('FAIL: no registration captured');
  process.exit(1);
}
console.log('registered id:', captured.id);

const stubRequire = (spec) => {
  if (spec === 'react/jsx-runtime') return { jsx: (...a) => ({ __jsx: a }) };
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: () => null };
  throw new Error(`unexpected require: ${spec}`);
};

const exports = captured.factory(stubRequire);
console.log('factory return type:', typeof exports);
console.log('has apply:', typeof exports?.apply === 'function');
console.log('inject:', JSON.stringify(exports?.inject));
console.log('name:', exports?.name);
if (typeof exports !== 'object' || exports === null || typeof exports.apply !== 'function') {
  console.error('FAIL: factory did not return a plugin');
  process.exit(1);
}
if (!Array.isArray(exports.inject) || !exports.inject.includes('slots')) {
  console.error('FAIL: plugin must inject the "slots" service');
  process.exit(1);
}
console.log('PASS: dshome-theme client factory materializes to a valid plugin');