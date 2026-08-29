// dshome-theme — node half（CJS 默认导出插件对象）。
// 用 CommonJS module.exports：import 后 default 恒为插件对象，
// 任何导入约定都不会得到 undefined（规避 ESM named-only 互操作歧义）。
'use strict';

module.exports = {
  name: 'dshome-theme',
  apply() {
    // 皮肤覆盖全部在浏览器侧（lib/client.js）完成。
  },
};