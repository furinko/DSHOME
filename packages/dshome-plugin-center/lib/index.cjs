// dshome-plugin-center — node half（host 侧 no-op）。
// 本包是纯浏览器 client 插件；host 侧只需一个可解析的根入口，
// 让 roster 扫描（dsh-client-modules）能定位到包的 dsh.client 声明。

module.exports = {
  name: 'dshome-plugin-center',
  apply() {},
};
