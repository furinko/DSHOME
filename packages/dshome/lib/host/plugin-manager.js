// dshome/plugin-manager — DSHOME 插件管理 host 插件（block 1：已装插件 列表 + 启/停）。
// 通道：平台 apiproxy 固定方法集不路由自定义 RPC；官方 pluginInventory.list 在 web profile 不存在。
// 因此用设置命名空间 `dshome-pluginmanager` 做 宿主↔客户端 数据/指令总线（通知同款机制）。
// 启/停 = 改写 profile 的 cordis.patch.yml（id 定位 disabled）+ 重启生效。
// 共享逻辑见 ./plugin-store.js（plugin-api 的 /api/dshome/plugins 复用同一份真相）。

// 上游导出经 upstream 层运行时获取（原为静态导入：schemastery 的 z + dsh-settings 的 settingsNamespace）。
// 理由见 upstream.js 头注：静态具名/默认导入是 ESM 链接期错误，官方改名即带崩整棵插件树。
import { settingsNamespace, schemastery as z } from './upstream.js';
import { isProtected, writeToggle, snapshot } from './plugin-store.js';
import { setupPluginApi } from './plugin-api.js';

export const name = 'dshome-plugin-manager';
export const inject = ['loader'];
// 同 notify：settingsNamespace() 原样返回字符串，缺失时退回同值，避免模块求值期抛错。
export const PLUGIN_NS = settingsNamespace ? settingsNamespace('dshome-pluginmanager') : 'dshome-pluginmanager';

// schemastery 缺失 → 不构造 schema：本插件**设置总线**停用，但模块照常加载（不拖垮宿主）。
// 三元短路是必须的——`z.any()` 在实参求值期就先跑，函数体里判空拦不住。
const SettingsSchema = z ? z.object({ entries: z.any(), request: z.any(), result: z.any() }) : null;

export function apply(ctx) {
  try {
    // 控制面 API（/api/dshome/plugins）：仅 web profile 经子插件激活，headless 自动跳过。
    setupPluginApi(ctx);

    ctx.inject(['settings'], (sctx) => {
      if (!SettingsSchema) {
        ctx.logger?.('dshome').warn('dshome-plugin-manager: schemastery 缺失 → 设置总线停用');
        return;
      }
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
          // 受保护语义：仅禁止停用【运行中】的核心插件；已停用的核心允许启用。
          if (isProtected(moduleName) && target?.enabled) {
            try { scope.update({ result: { ok: false, protected: true, restartNeeded: false, message: '核心插件运行中，不可停用' } }); } catch {}
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
