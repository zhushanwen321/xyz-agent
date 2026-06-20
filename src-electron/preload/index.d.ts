export interface ElectronAPI {
  onRuntimePort(callback: (port: number) => void): () => void
  onRuntimeError(callback: (error: { message: string }) => void): () => void
  onShortcut(callback: (type: string) => void): () => void
  getRuntimePort(): Promise<number>
  /** 获取 runtime 端口偏移（dev 模式 +100，prod 模式 0） */
  getRuntimePortOffset(): Promise<number>
  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  getWindows(): Promise<import('@xyz-agent/shared').WindowState[]>
  focusWindow(windowId: string): Promise<void>
  findSessionWindow(sessionId: string): Promise<{ windowId: string } | null>
  updateWindowState(windowId: string, state: Record<string, unknown>): Promise<void>
  onWindowCreated(callback: (windowId: string) => void): () => void
  onWindowClosed(callback: (windowId: string) => void): () => void
  onWindowListUpdated(callback: () => void): () => void
  pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }>
  openExternal(url: string): Promise<void>
  /** 监听 macOS 全屏状态变化 */
  onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
