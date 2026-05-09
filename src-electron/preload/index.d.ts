export interface ElectronAPI {
  onSidecarPort(callback: (port: number) => void): () => void
  onShortcut(callback: (type: string) => void): () => void
  openSettingsWindow(): void
  getSidecarPort(): Promise<number>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
