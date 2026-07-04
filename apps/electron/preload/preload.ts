// src-electron/preload/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  /** 监听 runtime 端口事件 */
  onRuntimePort(callback: (port: number) => void): () => void
  /** 监听 runtime 启动失败事件 */
  onRuntimeError(callback: (error: { message: string }) => void): () => void
  /** 监听 runtime 崩溃后重启中事件（supervisor 正在拉起新实例） */
  onRuntimeRestarting(callback: (payload: { attempt: number }) => void): () => void
  /** 监听 runtime 重启用尽事件（需用户手动重试） */
  onRuntimeFailed(callback: (payload: { attempts: number; message: string }) => void): () => void
  /** 请求手动重启 runtime（用户从「runtime 不可用」状态条点重试触发） */
  restartRuntime(): Promise<void>
  /** 监听快捷键事件（替代 @tauri-apps/api/event 的 listen('shortcut')） */
  onShortcut(callback: (type: string) => void): () => void
  /** 获取 runtime 端口 */
  getRuntimePort(): Promise<number>
  /** 获取 runtime 端口偏移（dev 模式 +100） */
  getRuntimePortOffset(): Promise<number>
  // ── 窗口管理 ──────────────────────────────────────────────────
  /** 创建新窗口，可选携带 sessionId 迁移 */
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  /** 获取所有窗口状态列表 */
  getWindows(): Promise<import('@xyz-agent/shared').WindowState[]>
  /** 聚焦指定窗口 */
  focusWindow(windowId: string): Promise<void>
  /** 查找指定 session 所在的窗口，返回 { windowId } 或 null */
  findSessionWindow(sessionId: string): Promise<{ windowId: string } | null>
  /** 监听窗口列表变化事件（创建/关闭/更新） */
  onWindowListUpdated(callback: () => void): () => void
  /** 打开目录选择对话框 */
  pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }>
  /** 在默认浏览器中打开外部链接 */
  openExternal(url: string): Promise<void>
  /** 监听 macOS 全屏状态变化 */
  onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  /** 最小化当前窗口 */
  windowMinimize(): Promise<void>
  /** 最大化/还原切换 */
  windowToggleMaximize(): Promise<void>
  /** 关闭当前窗口 */
  windowClose(): Promise<void>
}

contextBridge.exposeInMainWorld('electronAPI', {
  onRuntimePort: (callback: (port: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, port: number) => callback(port)
    ipcRenderer.on('runtime-port', handler)
    return () => ipcRenderer.removeListener('runtime-port', handler)
  },
  onRuntimeError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { message: string }) => callback(error)
    ipcRenderer.on('runtime-error', handler)
    return () => ipcRenderer.removeListener('runtime-error', handler)
  },
  onRuntimeRestarting: (callback: (payload: { attempt: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { attempt: number }) => callback(payload)
    ipcRenderer.on('runtime-restarting', handler)
    return () => ipcRenderer.removeListener('runtime-restarting', handler)
  },
  onRuntimeFailed: (callback: (payload: { attempts: number; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { attempts: number; message: string }) => callback(payload)
    ipcRenderer.on('runtime-failed', handler)
    return () => ipcRenderer.removeListener('runtime-failed', handler)
  },
  restartRuntime: () => ipcRenderer.invoke('runtime-restart'),
  onShortcut: (callback: (type: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string) => callback(type)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  getRuntimePort: () => ipcRenderer.invoke('get-runtime-port'),
  getRuntimePortOffset: () => ipcRenderer.invoke('get-runtime-port-offset'),

  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow: (sessionId?: string) => ipcRenderer.invoke('create-window', { sessionId }),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  focusWindow: (windowId: string) => ipcRenderer.invoke('focus-window', windowId),
  findSessionWindow: (sessionId: string) => ipcRenderer.invoke('find-session-window', sessionId),
  onWindowListUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('window-list-updated', handler)
    return () => ipcRenderer.removeListener('window-list-updated', handler)
  },
  pickDirectory: (options?: { title?: string }) => ipcRenderer.invoke('pick-directory', options),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  onFullscreenChanged: (callback: (payload: { isFullscreen: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { isFullscreen: boolean }) => callback(payload)
    ipcRenderer.on('fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('fullscreen-changed', handler)
  },
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
} satisfies ElectronAPI)
