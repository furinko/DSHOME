// dshome-assistant-identity — node half (no host behavior).
// 照 dshome-palette/lib/index.cjs：{ name, apply() {} }，避免 ISSUE-001（纯对象导出判 invalid plugin）。
'use strict';
module.exports = {
  name: 'dshome-assistant-identity',
  apply() {},
};
