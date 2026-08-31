// dshome/plugin-manager — DSHOME 插件管理 host 插件（block 1：已装插件 列表 + 启/停）。
// 通道：平台 apiproxy 固定方法集不路由自定义 RPC；官方 pluginInventory.list 在 web profile 不存在。
// 因此用设置命名空间 `dshome-pluginmanager` 做 宿主↔客户端 数据/指令总线（通知同款机制）。
// 启/停 = 改写 profile 的 cordis.patch.yml（id 定位 disabled）+ 重启生效。

import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'dshome-plugin-manager';
export const inject = ['loader'];
export const PLUGIN_NS = settingsNamespace('dshome-pluginmanager');

// 核心/必备插件：这些是 DSHOME 本体或应用骨架，禁止停用（停用会破坏 DSHOME）。
const PROTECTED_MODULES = new Set([
  'dshome/core', 'dshome/shell', 'dshome-theme', 'dshome-palette', 'dshome/notify', 'dshome/plugin-manager',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-host-apiproxy', '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-locale',
  'cordis:include',
]);
function isProtected(moduleName) {
  return moduleName.startsWith('dshome') || moduleName.startsWith('cordis:include') || PROTECTED_MODULES.has(moduleName);
}

const SettingsSchema = z.object({ entries: z.any(), request: z.any(), result: z.any() });

function classify(m) { if (m.startsWith('dshome')) return '自制'; if (m.startsWith('@deepseek-ai/') || m.startsWith('cordis:')) return '内置'; return '下载'; }
function profileDir() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'dshome');
}
async function writeToggle(id, enabled) {
  const file = path.join(profileDir(), 'cordis.patch.yml');
  const raw = await readFile(file, 'utf8').catch(() => '[]');
  // 载荷里的 entryId 形如 `include:dshome-core`；patch 行的 id 是 `dshome-core`。
  const coreId = String(id).replace(/^include:/, '');
  // 行级最小修改：只动目标 `- id: X` 行的 disabled，绝不重建文件
  // （重建会丢失同条目的 config/注释——如 llm-deepseek 的 apiKeyEnv）。
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
function snapshot(ctx) {
  const set = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' };
  const entries = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    entries.push({ entryId: entry.id, moduleName: entry.options.name, enabled: !entry.disabled, category: classify(entry.options.name), phase: entry.fiber?.state === void 0 ? null : (set[entry.fiber.state] ?? null), protected: isProtected(entry.options.name) });
  }
  return entries;
}
export function apply(ctx) {
  try {
    ctx.inject(['settings'], (sctx) => {
      sctx.effect(() => {
        const scope = sctx.settings.register(PLUGIN_NS, SettingsSchema, { applies: 'live' });
        let lastRequest = '';
        const push = () => { try { scope.update({ entries: snapshot(ctx) }); } catch {} };
        const onCommand = (next) => {
          const req = next.request;
          if (!req || typeof req !== 'object') return;
          const key = JSON.stringify(req);
          if (key === lastRequest) return;
          lastRequest = key;
          if (req.op !== 'toggle' || typeof req.id !== 'string') return;
          const target = (next.entries || []).find((e) => e.entryId === req.id);
          const moduleName = target?.moduleName || '';
          if (isProtected(moduleName)) {
            try { scope.update({ result: { ok: false, protected: true, restartNeeded: false, message: '核心插件，不可停用' } }); } catch {}
            return;
          }
          writeToggle(req.id, !!req.enabled).then((res) => {
            try { scope.update({ result: { ...res, restartNeeded: !!res.ok } }); } catch {}
          });
        };
        push();
        const off = ctx.on('loader/entries-updated', push);
        const stop = scope.watch(onCommand);
        return () => { off(); stop(); };
      }, 'dshome-plugin-manager: settings bus');
    });
  } catch (error) { ctx.logger?.('dshome').warn('dshome-plugin-manager disabled: %O', error); }
  ctx.logger?.('dshome').info('dshome-plugin-manager ready: list + toggle (restart-needed)');
}