// dshome/core — DSHOME 扩展点服务（Phase 1 骨架）。
//
// 提供 ctx.dshome = { commands, panels } 注册表，供未来所有 DSHOME 插件
// 接入（命令面板、侧栏面板等），对应设计文档 §7.2 / §11 扩展点规范。
//
// 护栏（DSHOME-DESIGN.md §13.5）：服务挂载全部 try/catch，
// 任何失败只记日志、绝不 rethrow，保证不阻断 profile 启动。

/** Stable Cordis plugin name (row: `name: dshome/core`). */
export const name = 'dshome-core';

/** Services this row requires before activation. */
export const inject = [];

/** Service key provided by this plugin. */
const SERVICE_KEY = 'dshome';

function makeRegistry(label) {
  const entries = new Map();
  return {
    register(entry) {
      if (!entry || typeof entry !== 'object') {
        throw new TypeError(`dshome.${label}.register: entry must be an object`);
      }
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new TypeError(`dshome.${label}.register: entry.id must be a non-empty string`);
      }
      if (entries.has(entry.id)) {
        throw new Error(`dshome.${label}: id already registered: ${entry.id}`);
      }
      entries.set(entry.id, entry);
      return entry;
    },
    list() {
      return [...entries.values()];
    },
    get(id) {
      return entries.get(id);
    },
  };
}

/**
 * Attach the dshome service defensively.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context
 */
export function apply(ctx) {
  try {
    ctx.provide(SERVICE_KEY, {
      commands: makeRegistry('commands'),
      panels: makeRegistry('panels'),
    });
    ctx.logger?.('dshome').info('dshome-core ready: commands/panels extension seam is live');
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-core disabled itself: %O', error);
  }
}