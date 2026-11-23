/**
 * Electron Preload 桥接（contextIsolation: true）：
 * 仅向 Webview 暴露受限的桌面壳能力（原生系统通知与外链打开），绝不暴露 Node API。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('harnessDeckDesktop', {
  notify: (title: string, body: string) => {
    ipcRenderer.send('hd:notify', { title, body });
  },
  openExternal: (url: string) => ipcRenderer.invoke('hd:open-external', url),
});
