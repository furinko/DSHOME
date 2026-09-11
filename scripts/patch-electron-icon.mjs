#!/usr/bin/env node
// scripts/patch-electron-icon.mjs - run the PowerShell icon patcher (single entry point
// for dev setup, packaging and manual use).
//
// Why: on Windows the taskbar button icon follows the process executable identity, not
// BrowserWindow's `icon` option. Stock electron.exe carries the Electron logo, so we
// rewrite its RT_ICON / RT_GROUP_ICON resources with the DSHOME icon.ico.
//
// Usage:
//   node scripts/patch-electron-icon.mjs                                  # dev tree default target
//   node scripts/patch-electron-icon.mjs --verify-only                    # assert, do not write
//   node scripts/patch-electron-icon.mjs --target <exe> --icon <ico>
//   node scripts/patch-electron-icon.mjs --verify-only --preview <png>
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ps1 = join(here, 'patch-electron-icon.ps1');

const argv = process.argv.slice(2);
const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) {
      console.error(`[patch-icon] missing value for ${a}`);
      process.exit(2);
    }
    return v;
  };
  if (a === '--verify-only' || a === '-VerifyOnly') psArgs.push('-VerifyOnly');
  else if (a === '--quiet' || a === '-Quiet' || a === '-q') psArgs.push('-Quiet');
  else if (a === '--target' || a === '-Target') psArgs.push('-Target', next());
  else if (a === '--icon' || a === '-Icon') psArgs.push('-Icon', next());
  else if (a === '--preview' || a === '-PreviewPath') psArgs.push('-PreviewPath', next());
  else {
    console.error(`[patch-icon] unknown argument: ${a}`);
    process.exit(2);
  }
}

// PowerShell 7 first when present (pwsh), then Windows PowerShell 5.1.
const candidates = process.env.DSHOME_POWERSHELL ? [process.env.DSHOME_POWERSHELL] : ['pwsh.exe', 'powershell.exe'];
let res = null;
let used = null;
for (const exe of candidates) {
  res = spawnSync(exe, psArgs, { stdio: 'inherit', windowsHide: true });
  if (!res.error) { used = exe; break; }
  if (res.error.code !== 'ENOENT') break;
}
if (!used) {
  console.error(`[patch-icon] cannot start PowerShell (${candidates.join(', ')}): ${res?.error?.message ?? 'unknown error'}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`[patch-icon] patcher failed (${used}, exit ${res.status ?? 'null'})`);
  process.exit(res.status ?? 1);
}
process.exit(0);
