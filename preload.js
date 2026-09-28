const { contextBridge, ipcRenderer } = require('electron');

// Exponer API segura a la UI
contextBridge.exposeInMainWorld('sennaAPI', {
  // Auto-update: escuchar eventos
  onUpdaterStatus: (callback) => {
    ipcRenderer.on('updater-status', (event, data) => callback(data));
  },
  // Auto-update: forzar comprobacion manual
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  // Info de la app
  getVersion: () => ipcRenderer.invoke('get-version'),
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('Senna Electron listo');
});
