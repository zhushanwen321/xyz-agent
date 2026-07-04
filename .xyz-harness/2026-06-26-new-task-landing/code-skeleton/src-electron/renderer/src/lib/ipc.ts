/**
 * IPC 桥接 —— 封装 preload 注入的 window.electronAPI。
 *
 * web/mock 环境（无 preload）electronAPI 为 undefined，方法优雅降级。
 * 这是 renderer 对 electronAPI 的唯一适配点（spec §4 R1）：端口发现 +
 * 全屏态监听 + 窗口控制（mac/win/linux traffic light 相关）。
 *
 * 依赖方向：无下游（读全局 window.electronAPI，类型经 declare global 自动可用）
 */

/** preload 注入的 electronAPI（web/mock 环境为 undefined） */
const api = window.electronAPI

/** 读取已知 runtime 端口（main 已 spawn）。无 IPC 或未启动返回 undefined */
export function getRuntimePort(): Promise<number | undefined> {
  return api ? api.getRuntimePort() : Promise.resolve(undefined)
}

/** 读取端口偏移（dev +100）。无 IPC 返回 undefined */
export function getRuntimePortOffset(): Promise<number | undefined> {
  return api ? api.getRuntimePortOffset() : Promise.resolve(undefined)
}

/** 监听 runtime 端口推送（runtime 重启后 main 推新端口触发重连），返回取消函数 */
export function onRuntimePort(cb: (port: number) => void): () => void {
  return api?.onRuntimePort(cb) ?? (() => {})
}

/** 监听 runtime 启动失败事件，返回取消函数 */
export function onRuntimeError(cb: (error: { message: string }) => void): () => void {
  return api?.onRuntimeError(cb) ?? (() => {})
}

/** 监听窗口全屏态变化（mac enter/leave-full-screen，main 已发 IPC），返回取消函数 */
export function onFullscreenChanged(cb: (isFullscreen: boolean) => void): () => void {
  return api?.onFullscreenChanged(({ isFullscreen }) => cb(isFullscreen)) ?? (() => {})
}

/** win/linux 自绘 traffic light 点击：最小化窗口（mac 系统圆点不走此处） */
export function windowMinimize(): Promise<void> {
  return api?.windowMinimize() ?? Promise.resolve()
}

/** win/linux 自绘 traffic light 点击：切换最大化（mac 系统圆点不走此处） */
export function windowToggleMaximize(): Promise<void> {
  return api?.windowToggleMaximize() ?? Promise.resolve()
}

/** win/linux 自绘 traffic light 点击：关闭窗口（mac 系统圆点不走此处） */
export function windowClose(): Promise<void> {
  return api?.windowClose() ?? Promise.resolve()
}

/**
 * 打开原生目录选择器（#5 选目录，§4.2）。
 *
 * 真引 preload 暴露的 electronAPI.pickDirectory（Tier 2 SDK 证伪点）：
 * - preload/preload.ts 经 ipcRenderer.invoke('pick-directory') 调 main 进程
 * - main/gateway/privileged-handlers.ts 用 BrowserWindow.getFocusedWindow() + dialog.showOpenDialog(openDirectory)
 * - 返回 {canceled, path}：canceled=true / path=null 表取消或无聚焦窗口（E5）
 *
 * 降级：无 preload（web/mock 环境）api=undefined → 返回 {canceled:true, path:null}（等效「取消」）。
 */
export function pickDirectory(options?: { title?: string }): Promise<{ canceled: boolean; path: string | null }> {
  return api
    ? api.pickDirectory(options)
    : Promise.resolve({ canceled: true, path: null })
}
