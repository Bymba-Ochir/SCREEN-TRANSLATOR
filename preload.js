// preload.js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Overlay → main
  sendSelection: (data) => ipcRenderer.send('selection-done', data),
  cancelOverlay: () => ipcRenderer.send('cancel-overlay'),

  // Popup → main
  closePopup: () => ipcRenderer.send('close-popup'),
  hoverPopup: () => ipcRenderer.send('popup-hover'),
  leavePopup: () => ipcRenderer.send('popup-leave'),

  // Main → popup
  onLoading: (callback) => ipcRenderer.on('show-loading', () => callback()),
  onResult: (callback) => ipcRenderer.on('show-result', (_, data) => callback(data))
})