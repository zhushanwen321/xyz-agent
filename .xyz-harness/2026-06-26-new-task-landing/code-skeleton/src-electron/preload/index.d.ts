/**
 * preload electronAPI 类型声明（骨架桩）。
 *
 * 真实声明在 src-electron/preload/index.d.ts（含窗口管理/port 发现等完整 API，未改动）。
 * 骨架仅暴露 NewTaskFlow 链路用到的 pickDirectory（lib/ipc.ts 真引此 seam，Tier 2 IPC 证伪点）。
 * 其余 window 控制方法已在 lib/ipc.ts 镜像中保留（均经 `api?.method()` 降级，类型由本声明提供）。
 */
export interface ElectronAPI {
  getRuntimePort(): Promise<number>
  getRuntimePortOffset(): Promise<number>
  onRuntimePort(callback: (port: number) => void): () => void
  onRuntimeError(callback: (error: { message: string }) => void): () => void
  onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void
  /** 打开原生目录选择器（#5 选目录，main/gateway/privileged-handlers.ts 实现） */
  pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }>
  openExternal(url: string): Promise<void>
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
