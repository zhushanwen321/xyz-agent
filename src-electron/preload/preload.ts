// src-electron/preload/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  /** 监听 sidecar 端口事件（替代 @tauri-apps/api/event 的 listen('sidecar-port')） */
  onSidecarPort(callback: (port: number) => void): () => void
  /** 监听快捷键事件（替代 @tauri-apps/api/event 的 listen('shortcut')） */
  onShortcut(callback: (type: string) => void): () => void
  /** 打开设置窗口 */
  openSettingsWindow(): void
  /** 获取 sidecar 端口 */
  getSidecarPort(): Promise<number>
}

contextBridge.exposeInMainWorld('electronAPI', {
  onSidecarPort: (callback: (port: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, port: number) => callback(port)
    ipcRenderer.on('sidecar-port', handler)
    return () => ipcRenderer.removeListener('sidecar-port', handler)
  },
  onShortcut: (callback: (type: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string) => callback(type)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  openSettingsWindow: () => ipcRenderer.send('open-settings-window'),
  getSidecarPort: () => ipcRenderer.invoke('get-sidecar-port'),
} satisfies ElectronAPI)
