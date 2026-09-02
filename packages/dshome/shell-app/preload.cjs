// DSHOME shell preload — 只给页面暴露「触发后端探活/拉起」能力（离线页「重新连接」按钮用）。
// 页面侧：window.__dshomeShell__.retryBackend() → Promise<{ok, up, started?, reason?}>
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dshomeShell__', {
  retryBackend: () => ipcRenderer.invoke('shell:retry-backend'),
});
