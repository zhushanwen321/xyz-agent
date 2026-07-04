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

/** 监听 runtime 崩溃后重启中事件（supervisor 正在拉起新实例），返回取消函数 */
export function onRuntimeRestarting(cb: (payload: { attempt: number }) => void): () => void {
  return api?.onRuntimeRestarting(cb) ?? (() => {})
}

/** 监听 runtime 重启用尽事件（需用户手动重试），返回取消函数 */
export function onRuntimeFailed(cb: (payload: { attempts: number; message: string }) => void): () => void {
  return api?.onRuntimeFailed(cb) ?? (() => {})
}

/** 请求手动重启 runtime（崩溃重启用尽后用户点重试触发）。无 IPC 时 no-op */
export function restartRuntime(): Promise<void> {
  return api?.restartRuntime() ?? Promise.resolve()
}

/** 监听窗口全屏态变化（mac enter/leave-full-screen，main 已发 IPC），返回取消函数 */
export function onFullscreenChanged(cb: (isFullscreen: boolean) => void): () => void {
  return api?.onFullscreenChanged(({ isFullscreen }) => cb(isFullscreen)) ?? (() => {})
}

/**
 * 选择目录（OS 原生目录选择器，#5 步骤 4a 接入 preload handler）。
 * web/mock 环境无 preload → 返回 canceled，让上层落回 popover（AC-5.3）。
 */
export async function pickDirectory(): Promise<{ canceled: boolean; path: string | null }> {
  if (!api?.pickDirectory) return { canceled: true, path: null }
  return api.pickDirectory()
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

/** 用系统默认浏览器打开外链（main 侧 isValidExternalUrl 校验只放行 http(s)://）。
 *  Electron file:// 下 <a target=_blank> 不会开系统浏览器，须走此 IPC。
 *  无 IPC（web/mock）静默 no-op。 */
export function openExternal(url: string): Promise<void> {
  return api?.openExternal(url) ?? Promise.resolve()
}
