/**
 * mobile-renderer IPC 适配层 —— 全 no-op（spec P4 D8）。
 *
 * 移动端无 Electron 主进程：所有方法返回 Promise.resolve(undefined) / 默认值，
 * 回调订阅类返回 no-op () => {}。不注册 window.electronAPI（保持 undefined），
 * 业务层（useConnection 等 copy 自 renderer）的优雅降级天然生效。
 *
 * 方法签名与 renderer lib/ipc.ts 1:1 对齐，确保 copy 过来的 composable 调用 ipc.ts 时
 * 类型通过（IF1 契约）。
 *
 * 依赖方向：无下游（读全局 window.electronAPI——移动端恒 undefined，但保留读取以维持
 * 与 renderer 同形的降级语义；实际所有方法直接 no-op，不依赖 electronAPI 值）。
 */

/** no-op 取消订阅函数（回调订阅类方法统一返回） */
function noopUnsubscribe(): void {
  /* mobile-renderer 无 IPC，订阅类方法恒 no-op */
}

// ── runtime 端口发现（移动端无本地 runtime，恒 undefined）──────────────

/** 读取已知 runtime 端口。移动端无本地 runtime → 恒 undefined */
export function getRuntimePort(): Promise<undefined> {
  return Promise.resolve(undefined)
}

/** 读取端口偏移。移动端无本地 runtime → 恒 undefined */
export function getRuntimePortOffset(): Promise<undefined> {
  return Promise.resolve(undefined)
}

/** 监听 runtime 端口推送。移动端无 IPC → 恒 no-op 取消函数 */
export function onRuntimePort(_cb: (port: number) => void): () => void {
  return noopUnsubscribe
}

/** 监听主进程快捷键事件。移动端无键盘/IPC → 恒 no-op 取消函数 */
export function onShortcut(_cb: (type: string) => void): () => void {
  return noopUnsubscribe
}

/** 监听 runtime 启动失败事件。移动端无本地 runtime → 恒 no-op 取消函数 */
export function onRuntimeError(_cb: (error: { message: string }) => void): () => void {
  return noopUnsubscribe
}

/** 监听 runtime 崩溃后重启中事件。移动端无本地 runtime → 恒 no-op 取消函数 */
export function onRuntimeRestarting(_cb: (payload: { attempt: number }) => void): () => void {
  return noopUnsubscribe
}

/** 监听 runtime 重启用尽事件。移动端无本地 runtime → 恒 no-op 取消函数 */
export function onRuntimeFailed(_cb: (payload: { attempts: number; message: string }) => void): () => void {
  return noopUnsubscribe
}

/** 请求手动重启 runtime。移动端无本地 runtime → 恒 no-op */
export function restartRuntime(): Promise<void> {
  return Promise.resolve()
}

/** 监听窗口全屏态变化。移动端无窗口概念 → 恒 no-op 取消函数 */
export function onFullscreenChanged(_cb: (isFullscreen: boolean) => void): () => void {
  return noopUnsubscribe
}

/**
 * 选择目录（OS 原生目录选择器）。
 * 移动端无 OS 目录选择器 IPC → 恒 canceled，上层落回手动路径输入（spec D4）。
 */
export function pickDirectory(
  _options?: { title?: string; defaultPath?: string },
): Promise<{ canceled: boolean; path: null }> {
  return Promise.resolve({ canceled: true, path: null })
}

// ── 窗口控制（移动端无窗口 chrome，全 no-op）──────────────────────────

/** 最小化窗口。移动端无窗口 → no-op */
export function windowMinimize(): Promise<void> {
  return Promise.resolve()
}

/** 切换最大化。移动端无窗口 → no-op */
export function windowToggleMaximize(): Promise<void> {
  return Promise.resolve()
}

/** 关闭窗口。移动端无窗口 → no-op */
export function windowClose(): Promise<void> {
  return Promise.resolve()
}

/**
 * 用系统默认浏览器打开外链。
 * 移动端无 IPC，但浏览器环境可直接 window.open——为保持与 renderer ipc.ts 签名一致，
 * 此处 no-op（移动端外链打开由组件层用 <a target=_blank> 或 window.open 处理，不走 ipc）。
 */
export function openExternal(_url: string): Promise<void> {
  return Promise.resolve()
}

// ── Browser drawer（嵌入式浏览器，WebContentsView 生命周期）─────────────
// 移动端无 Electron WebContentsView，BrowserPane drawer 在 P4 砍掉（spec D7）。
// 全 no-op 仅为保持 ipc.ts 签名完整（copy 过来的代码若有引用不致类型断链）。

/** 创建 WebContentsView。移动端无 → no-op */
export function browserCreate(_sessionId: string, _windowId: string): Promise<void> {
  return Promise.resolve()
}

/** 导航到指定 URL。移动端无 → no-op */
export function browserNavigate(_sessionId: string, _url: string): Promise<void> {
  return Promise.resolve()
}

/** 隐藏 view。移动端无 → no-op */
export function browserHide(_sessionId: string): Promise<void> {
  return Promise.resolve()
}

/** 显示 view。移动端无 → no-op */
export function browserShow(_sessionId: string): Promise<void> {
  return Promise.resolve()
}

/** 切换可见 view。移动端无 → no-op */
export function browserFocus(_sessionId: string): Promise<void> {
  return Promise.resolve()
}

/** 后退。移动端无 → no-op */
export function browserBack(_sessionId: string): Promise<void> {
  return Promise.resolve()
}

/** 前进。移动端无 → no-op */
export function browserForward(_sessionId: string): Promise<void> {
  return Promise.resolve()
}

/** 设置缩放因子。移动端无 → no-op */
export function browserSetZoom(_sessionId: string, _factor: number): Promise<void> {
  return Promise.resolve()
}

/** 读取当前缩放因子。移动端无 → 恒 1.0 */
export function browserGetZoom(_sessionId: string): Promise<number> {
  return Promise.resolve(1.0)
}

/** 读取嵌入页当前选区 + URL。移动端无 → 恒空选区 */
export function browserGetSelection(_sessionId: string): Promise<{ text: string; url: string }> {
  return Promise.resolve({ text: '', url: '' })
}

/** 推送 view 的位置/尺寸。移动端无 → no-op */
export function browserSetRect(
  _sessionId: string,
  _rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  return Promise.resolve()
}

/** 销毁 view。移动端无 → no-op */
export function browserDestroy(_sessionId: string): Promise<void> {
  return Promise.resolve()
}

/**
 * 监听主进程推送的 browser 状态变化。
 * 移动端无 IPC → 恒 no-op 取消函数。
 */
export function onBrowserState(
  _callback: (state: {
    sessionId: string
    currentUrl: string
    isLoading: boolean
    error: { errorCode: number; errorDescription: string; validatedURL: string } | null
    canGoBack: boolean
    canGoForward: boolean
    zoomFactor: number
  }) => void,
): () => void {
  return noopUnsubscribe
}
