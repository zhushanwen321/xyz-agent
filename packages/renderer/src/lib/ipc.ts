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

/**
 * 监听主进程快捷键事件（before-input-event 拦截后转发）。
 * type 含 'standard' / 'focus'（globalShortcut）/'close'（before-input-event Cmd/Ctrl+W）。
 * 返回取消订阅函数。无 IPC（web/mock）返回 no-op。
 */
export function onShortcut(cb: (type: string) => void): () => void {
  return api?.onShortcut(cb) ?? (() => {})
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
 *
 * @param options.defaultPath 候选初始目录（通常是 currentCwd）；主进程 existsSync 守卫，
 *                            存在则用，否则自动回退到 ~（homedir）。不传则用 homedir。
 */
export async function pickDirectory(
  options?: { title?: string; defaultPath?: string },
): Promise<{ canceled: boolean; path: string | null }> {
  if (!api?.pickDirectory) return { canceled: true, path: null }
  return api.pickDirectory(options)
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

// ── Browser drawer（嵌入式浏览器，WebContentsView 生命周期）─────────────
// Wave 2：renderer → main 五个 IPC 封装（create/navigate/hide/show/destroy）。
// onBrowserState 订阅主进程推送的加载状态（url/isLoading/error），供 BrowserPane 更新地址栏 + 态切换。
// 无 IPC（web/mock）静默 no-op / 返回空 unsubscribe。

/** 创建 WebContentsView 并 attach 到指定窗口（初始隐藏）。无 IPC 时 no-op。 */
export function browserCreate(sessionId: string, windowId: string): Promise<void> {
  return api?.browserCreate(sessionId, windowId) ?? Promise.resolve()
}

/** 导航到指定 URL（loadURL 失败时 reject）。无 IPC 时 no-op。 */
export function browserNavigate(sessionId: string, url: string): Promise<void> {
  return api?.browserNavigate(sessionId, url) ?? Promise.resolve()
}

/** 隐藏 view（keep-alive，不销毁）。无 IPC 时 no-op。 */
export function browserHide(sessionId: string): Promise<void> {
  return api?.browserHide(sessionId) ?? Promise.resolve()
}

/** 显示 view（恢复最近 rect）。无 IPC 时 no-op。 */
export function browserShow(sessionId: string): Promise<void> {
  return api?.browserShow(sessionId) ?? Promise.resolve()
}

/** 切换可见 view 到指定 session（Wave 4 per-session 隔离）。
 * 隐藏当前可见的其他 session view，显示 target session view。切 session 时由 useBrowserFocusSync 调用。
 * 无 IPC（web/mock）静默 no-op。 */
export function browserFocus(sessionId: string): Promise<void> {
  return api?.browserFocus(sessionId) ?? Promise.resolve()
}

/** 后退（webContents.navigationHistory.goBack）。无 IPC 时 no-op。Wave 5 历史导航。 */
export function browserBack(sessionId: string): Promise<void> {
  return api?.browserBack(sessionId) ?? Promise.resolve()
}

/** 前进（webContents.navigationHistory.goForward）。无 IPC 时 no-op。Wave 5 历史导航。 */
export function browserForward(sessionId: string): Promise<void> {
  return api?.browserForward(sessionId) ?? Promise.resolve()
}

/** 设置缩放因子（1.0=100%）。无 IPC 时 no-op。Wave 5 缩放。 */
export function browserSetZoom(sessionId: string, factor: number): Promise<void> {
  return api?.browserSetZoom(sessionId, factor) ?? Promise.resolve()
}

/** 读取当前缩放因子。无 IPC 时返回 1.0。Wave 5 缩放。 */
export function browserGetZoom(sessionId: string): Promise<number> {
  return api?.browserGetZoom(sessionId) ?? Promise.resolve(1.0)
}

/** 读取嵌入页当前选区 + URL（二期扩展点预留）。无 IPC 时返回空选区。 */
export function browserGetSelection(sessionId: string): Promise<{ text: string; url: string }> {
  return api?.browserGetSelection(sessionId) ?? Promise.resolve({ text: '', url: '' })
}

/**
 * 推送 view 的位置/尺寸（rect 同步 Wave 3）。
 *
 * [HISTORICAL] rect 坐标系：主进程 setBounds 用 DIP，与 CSS px 1:1，**不乘 devicePixelRatio**。
 * 调用方传 getBoundingClientRect() 的值（CSS px）即可（retina dpr=2 误乘会定位屏外+尺寸翻倍）。
 * 无 IPC（web/mock）静默 no-op。
 */
export function browserSetRect(
  sessionId: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  return api?.browserSetRect(sessionId, rect) ?? Promise.resolve()
}

/** 销毁 view（removeChildView + webContents.close）。无 IPC 时 no-op。 */
export function browserDestroy(sessionId: string): Promise<void> {
  return api?.browserDestroy(sessionId) ?? Promise.resolve()
}

/**
 * 监听主进程推送的 browser 状态变化（url/isLoading/error）。
 * 主进程 did-navigate / did-fail-load / did-start-loading 等事件触发时推送，
 * BrowserPane 据此更新地址栏真实 URL（防钓鱼）+ loading/error 态。
 * 返回取消订阅函数。无 IPC 时返回 no-op。
 */
export function onBrowserState(
  callback: (state: {
    sessionId: string
    currentUrl: string
    isLoading: boolean
    error: { errorCode: number; errorDescription: string; validatedURL: string } | null
    canGoBack: boolean
    canGoForward: boolean
  }) => void,
): () => void {
  // onBrowserState 在 preload 暴露（Wave 2 加）；类型经 declare global ElectronAPI 对齐。
  // 用可选链兜底旧 preload 未暴露的场景（mock/测试环境）。
  return (api as { onBrowserState?: (cb: typeof callback) => () => void })?.onBrowserState?.(callback) ?? (() => {})
}
