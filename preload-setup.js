const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  onProgress: (cb) => ipcRenderer.on('setup-progress', (_, data) => cb(data)),
  launch: () => ipcRenderer.send('setup-launch'),
  quit: () => ipcRenderer.send('setup-quit'),
  retry: () => ipcRenderer.send('setup-retry'),
});
