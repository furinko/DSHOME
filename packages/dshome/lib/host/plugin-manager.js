// dshome/plugin-manager — DSHOME 插件管理 host 插件（block 1：已装插件 列表 + 启/停）。
// 通道：平台 apiproxy 固定方法集不路由自定义 RPC；官方 pluginInventory.list 在 web profile 不存在。
// 因此用设置命名空间 `dshome-pluginmanager` 做 宿主↔客户端 数据/指令总线（通知同款机制）。
// 启/停 = 改写 profile 的 cordis.patch.yml（id 定位 disabled）+ 重启生效。
// 共享逻辑见 ./plugin-store.js（plugin-api 的 /api/dshome/plugins 复用同一份真相）。

import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { isProtected, writeToggle, snapshot } from './plugin-store.js';
import { setupPluginApi } from './plugin-api.js';

export const name = 'dshome-plugin-manager';
export const inject = ['loader'];
export const PLUGIN_NS = settingsNamespace('dshome-pluginmanager');

const SettingsSchema = z.object({ entries: z.any(), request: z.any(), result: z.any() });

export function apply(ctx) {
  try {
    // 控制面 API（/api/dshome/plugins）：仅 web profile 经子插件激活，headless 自动跳过。
    setupPluginApi(ctx);

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
