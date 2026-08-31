// dshome/plugin-store — 插件清单 / 启停共享逻辑（plugin-manager 与 plugin-api 共用）。
// 单一实现：plugin-manager（设置页总线）与 plugin-api（/api/dshome/plugins）读同一份真相。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 核心 / 必备插件：这些是 DSHOME 本体或应用骨架，禁止停用（停用会破坏 DSHOME）。
const PROTECTED_MODULES = new Set([
  'dshome/core', 'dshome/shell', 'dshome-theme', 'dshome-palette', 'dshome/notify', 'dshome/plugin-manager',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-host-apiproxy', '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-locale',
  'cordis:include',
]);

export function isProtected(moduleName) {
  return moduleName.startsWith('dshome') || moduleName.startsWith('cordis:include') || PROTECTED_MODULES.has(moduleName);
}

export function classify(m) {
  if (m.startsWith('dshome')) return '自制';
  if (m.startsWith('@deepseek-ai/') || m.startsWith('cordis:')) return '内置';
  return '下载';
}

export function profileDir() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'dshome');
}

/**
 * 行级最小修改：只动目标 `- id: X` 行的 disabled，绝不重建文件
 * （重建会丢失同条目的 config/注释——如 llm-deepseek 的 apiKeyEnv）。
 */
export async function writeToggle(id, enabled) {
  const file = path.join(profileDir(), 'cordis.patch.yml');
  const raw = await readFile(file, 'utf8').catch(() => '[]');
  // 载荷里的 entryId 形如 `include:dshome-core`；patch 行的 id 是 `dshome-core`。
  const coreId = String(id).replace(/^include:/, '');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const out = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = /^- id: (\S+)/.exec(line);
    if (idMatch && idMatch[1] === coreId) {
      found = true;
      const next = lines[i + 1] ?? '';
      if (enabled) {
        // 启用：跳过紧跟的 `  disabled: true` 行（若存在）
        if (/^\s+disabled:\s*true\b/.test(next)) i++;
        out.push(line);
      } else {
        // 停用：保留原行；若下一行已是 disabled 则不重复
        out.push(line);
        if (!/^\s+disabled:/.test(next)) out.push('  disabled: true');
      }
      continue;
    }
    out.push(line);
  }
  if (!found) {
    if (enabled) return { ok: true, message: '已启用（重启生效）' };
    const tail = raw.trim();
    const base = (tail === '[]' || tail === '') ? '' : raw.replace(/\s+$/, '') + nl;
    await writeFile(file, `${base}- id: ${coreId}${nl}  disabled: true`, 'utf8');
    return { ok: true, message: '已停用（重启生效）' };
  }
  await writeFile(file, out.join(nl) + nl, 'utf8');
  return { ok: true, message: enabled ? '已启用（重启生效）' : '已停用（重启生效）' };
}

/** Loader 树快照：entryId / moduleName / enabled / category / phase / protected。 */
export function snapshot(ctx) {
  const set = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' };
  const entries = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    entries.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      category: classify(entry.options.name),
      phase: entry.fiber?.state === void 0 ? null : (set[entry.fiber.state] ?? null),
      protected: isProtected(entry.options.name),
    });
  }
  return entries;
}
