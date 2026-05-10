export interface ElectronAPI {
  onSidecarPort(callback: (port: number) => void): () => void
  onShortcut(callback: (type: string) => void): () => void
  openSettingsWindow(): void
  getSidecarPort(): Promise<number>
  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  getWindows(): Promise<import('@xyz-agent/shared').WindowState[]>
  focusWindow(windowId: string): Promise<void>
  updateWindowState(windowId: string, state: Record<string, unknown>): Promise<void>
  onWindowCreated(callback: (windowId: string) => void): () => void
  onWindowClosed(callback: (windowId: string) => void): () => void
  onWindowListUpdated(callback: () => void): () => void
  pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
