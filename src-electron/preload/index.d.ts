export interface ElectronAPI {
  onRuntimePort(callback: (port: number) => void): () => void
  onRuntimeError(callback: (error: { message: string }) => void): () => void
  onShortcut(callback: (type: string) => void): () => void
  openSettingsWindow(): void
  getRuntimePort(): Promise<number>
  /** Set the OS window title (used by extension:setTitle from TUI bridge) */
  setTitle(title: string): void
  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  getWindows(): Promise<import('@xyz-agent/shared').WindowState[]>
  focusWindow(windowId: string): Promise<void>
  findSessionWindow(sessionId: string): Promise<{ windowId: string; paneId: string } | null>
  updateWindowState(windowId: string, state: Record<string, unknown>): Promise<void>
  onWindowCreated(callback: (windowId: string) => void): () => void
  onWindowClosed(callback: (windowId: string) => void): () => void
  onWindowListUpdated(callback: () => void): () => void
  pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }>
  openExternal(url: string): Promise<void>
  /** 监听 macOS 全屏状态变化 */
  onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
