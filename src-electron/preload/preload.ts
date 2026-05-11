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
  // ── 窗口管理 ──────────────────────────────────────────────────
  /** 创建新窗口，可选携带 sessionId 迁移 */
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  /** 获取所有窗口状态列表 */
  getWindows(): Promise<Array<{ windowId: string; focusedPaneId: string; sessionIds: string[] }>>
  /** 聚焦指定窗口 */
  focusWindow(windowId: string): Promise<void>
  /** 更新指定窗口状态 */
  updateWindowState(windowId: string, state: Record<string, unknown>): Promise<void>
  /** 监听窗口创建事件，返回取消监听函数 */
  onWindowCreated(callback: (windowId: string) => void): () => void
  /** 监听窗口关闭事件，返回取消监听函数 */
  onWindowClosed(callback: (windowId: string) => void): () => void
  /** 监听窗口列表变化事件（创建/关闭/更新） */
  onWindowListUpdated(callback: () => void): () => void
  /** 打开目录选择对话框 */
  pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }>
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

  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow: (sessionId?: string) => ipcRenderer.invoke('create-window', { sessionId }),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  focusWindow: (windowId: string) => ipcRenderer.invoke('focus-window', windowId),
  updateWindowState: (windowId: string, state: Record<string, unknown>) => ipcRenderer.invoke('update-window-state', windowId, state),
  onWindowCreated: (callback: (windowId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, windowId: string) => callback(windowId)
    ipcRenderer.on('window-created', handler)
    return () => ipcRenderer.removeListener('window-created', handler)
  },
  onWindowClosed: (callback: (windowId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, windowId: string) => callback(windowId)
    ipcRenderer.on('window-closed', handler)
    return () => ipcRenderer.removeListener('window-closed', handler)
  },
  onWindowListUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('window-list-updated', handler)
    return () => ipcRenderer.removeListener('window-list-updated', handler)
  },
  pickDirectory: (options?: { title?: string }) => ipcRenderer.invoke('pick-directory', options),
} satisfies ElectronAPI)
