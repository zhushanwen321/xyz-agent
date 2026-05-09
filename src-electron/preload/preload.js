const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onSidecarPort: (callback) => {
    const handler = (_event, port) => callback(port)
    ipcRenderer.on('sidecar-port', handler)
    return () => ipcRenderer.removeListener('sidecar-port', handler)
  },
  onShortcut: (callback) => {
    const handler = (_event, type) => callback(type)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  openSettingsWindow: () => ipcRenderer.send('open-settings-window'),
  getSidecarPort: () => ipcRenderer.invoke('get-sidecar-port'),
})
