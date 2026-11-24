const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('L', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, ...args),
  on: (ch, cb) => ipcRenderer.on(ch, (_e, d) => cb(d))
});
