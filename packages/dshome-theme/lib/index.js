// dshome-theme — node half（无 host 行为；roster 由 client 侧提供）。
// 双导出约定：named 与 default 都给出带 apply 的插件对象，
// 兼容 loader 的两种插件导入方式（default-first 或 named-first）。
const plugin = {
  name: 'dshome-theme',
  apply() {
    // 皮肤覆盖全部在浏览器侧（lib/client.js）完成。
  },
};
export const name = plugin.name;
export { plugin as apply };
export default plugin;