// dshome-theme — CJS node-half plugin（loader 挂载目标）。
// 用 CommonJS module.exports 提供插件对象：任何导入方式（default-first
// 或 named-first）都能拿到 { name, apply }，杜绝 ESM 互操作导致的 undefined。
'use strict';

module.exports = {
  name: 'dshome-theme',
  apply() {
    // 皮肤覆盖全部在浏览器侧（lib/client.js）完成。
  },
};