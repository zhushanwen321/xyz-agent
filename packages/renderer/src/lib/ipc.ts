/**
 * IPC 桥接 —— 封装 preload 注入的 window.electronAPI。
 *
 * web/mock 环境（无 preload）electronAPI 为 undefined，方法优雅降级。
 * 这是 renderer 对 electronAPI 的唯一适配点（spec §4 R1）：端口发现 +
 * 全屏态监听 + 窗口控制（mac/win/linux traffic light 相关）+ 自动升级。
 *
 * 依赖方向：无下游（读全局 window.electronAPI，类型经 declare global 自动可用）
 */
import type { LatestReleaseInfo, UpdateStage, UpdateSettings, UpdateErrorPayload, ProxyTestResult } from '@xyz-agent/shared'

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

/**
 * 读取当前 runtime 的 WS auth token（S1-W1）：连接 open 后作首条 auth 消息发送。
 * runtime 重启后值刷新（supervisor 每次 spawn 重新生成），重连路径须重新调用。
 * 无 IPC（web/mock）返回 undefined——调用方（use-connection / transport）以不带
 * token 连接（mock 平台无需 auth）。
 */
export function getRuntimeToken(): Promise<string | null | undefined> {
  return api?.getRuntimeToken ? api.getRuntimeToken() : Promise.resolve(undefined)
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

/**
 * 选择文件（OS 原生文件选择器，+菜单「附件 / 图片」入口用）。
 * web/mock 环境无 preload → 返回 canceled，让上层（onAddSelect）静默 return。
 *
 * @param options.defaultPath 候选初始目录（主进程 existsSync 守卫，失效回退 ~）
 * @param options.filters    文件类型过滤（如 [{name:'Images', extensions:['png','jpg',...]}]）
 */
export async function pickFile(
  options?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  },
): Promise<{ canceled: boolean; path: string | null }> {
  if (!api?.pickFile) return { canceled: true, path: null }
  return api.pickFile(options)
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

/** 在文件管理器中显示文件（main shell.showItemInFolder；trace MALFORMED 行「打开所在目录」
 *  恢复指引）。main 侧校验绝对路径后才放行。无 IPC（web/mock）静默 no-op。 */
export function revealInFolder(filePath: string): Promise<unknown> {
  return api?.revealInFolder?.(filePath) ?? Promise.resolve()
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
    /** 当前缩放因子（autoFit 后主进程回推，BrowserPane 转发给 useBrowserZoom.setZoomFromRemote） */
    zoomFactor: number
  }) => void,
): () => void {
  // onBrowserState 在 preload 暴露（Wave 2 加）；类型经 declare global ElectronAPI 对齐。
  // 用可选链兜底旧 preload 未暴露的场景（mock/测试环境）。
  return (api as { onBrowserState?: (cb: typeof callback) => () => void })?.onBrowserState?.(callback) ?? (() => {})
}

// ── 自动升级（w4 update-frontend）───────────────────────────────────────
// Wave 2/3：renderer → main 五个 IPC 封装（check/perform/progress/error/fallback）。
// checkForUpdate 返回 LatestReleaseInfo | null（无新版/失败/未注入返回 null）。
// performUpdate 触发完整流程（下载→校验→替换→重启），triggerRestart=true 表示即将重启。
// onUpdateProgress/onUpdateError 订阅主进程推送，返回取消订阅函数。
// 无 IPC（web/mock）静默 no-op / 返回空 unsubscribe / null / {triggerRestart:false}。

/**
 * 检测最新可用版本。
 * @param opts.force 强制刷新缓存（默认走 1h 缓存）
 * @returns 有新版返回 LatestReleaseInfo，无新版/失败/未注入返回 null
 */
export function checkForUpdate(opts?: { force?: boolean }): Promise<LatestReleaseInfo | null> {
  return api?.checkForUpdate(opts) ?? Promise.resolve(null)
}

/**
 * 执行完整升级流程（下载 → 校验 → 替换 → 触发重启）。
 * @param release checkForUpdate 返回的最新版本信息
 * @returns triggerRestart=true 表示升级已触发、app 即将退出重启
 */
export function performUpdate(release: LatestReleaseInfo): Promise<{ triggerRestart: boolean }> {
  return api?.performUpdate(release) ?? Promise.resolve({ triggerRestart: false })
}

/**
 * 触发下载阶段（下载 → 校验，止于 downloaded 态，不替换/重启）。
 * @param release checkForUpdate 返回的最新版本信息
 * @returns downloaded=true 表示产物已下载并校验通过，等待 performInstall 触发替换重启
 */
export function updateDownload(release: LatestReleaseInfo): Promise<{ downloaded: boolean }> {
  return api?.updateDownload(release) ?? Promise.resolve({ downloaded: false })
}

/**
 * 触发安装阶段（替换 + 重启）。依赖已下载产物（updateDownload 成功后调用）。
 * @returns triggerRestart=true 表示替换完成、app 即将退出重启
 */
export function updateInstall(): Promise<{ triggerRestart: boolean }> {
  return api?.updateInstall() ?? Promise.resolve({ triggerRestart: false })
}

/**
 * 读取 main 侧预下载产物（app 启动时恢复 downloaded 态用）。
 * @returns 有有效预下载产物返回 { release, filePath }，无则 null
 */
export function getPreloaded(): Promise<{ release: LatestReleaseInfo; filePath: string } | null> {
  return api?.getPreloaded() ?? Promise.resolve(null)
}

/** 监听升级进度事件（stage + percent 0-100），返回取消订阅函数。无 IPC 返回 no-op */
export function onUpdateProgress(cb: (p: { stage: UpdateStage; percent: number }) => void): () => void {
  return api?.onUpdateProgress(cb) ?? (() => {})
}

/** 监听升级错误事件（stage + message + errorCode + suggestion），返回取消订阅函数。无 IPC 返回 no-op */
export function onUpdateError(cb: (e: UpdateErrorPayload) => void): () => void {
  return api?.onUpdateError(cb) ?? (() => {})
}

/** 读取启动结果（升级成功/失败/回滚通知）。首次调用返回结果，后续返回 null。无 IPC 返回 null */
export function getLaunchResult(): Promise<{ status: string; version: string } | null> {
  return api?.getLaunchResult() ?? Promise.resolve(null)
}

/** 不支持当前平台时，打开备用下载页（release 页面）。无 IPC 时 no-op */
export function openUpdateFallbackUrl(url: string): Promise<void> {
  return api?.openUpdateFallbackUrl(url) ?? Promise.resolve()
}

// ── 代理配置 ────────────────────────────────────────────────────────

/**
 * 读取数据目录（~ 缩写展示路径，如 ~/.xyz-agent-dev）。
 * Settings 强制目录展示动态化用。无 IPC（web/mock）返回 undefined，调用方需 fallback。
 */
export function getDataDir(): Promise<string | undefined> {
  return api ? api.getDataDir() : Promise.resolve(undefined)
}

/**
 * 薄包装 preload chooseDirectory（其复用 pick-directory handler），取 path 字段（canceled→null），
 * 对齐 ui 层 ChooseDirectoryFn 契约。web/mock 环境无 preload → 返回 null，LoadPaths 守 null 静默 return。
 */
export async function chooseDirectory(): Promise<string | null> {
  if (!api?.chooseDirectory) return null
  return api.chooseDirectory()
}

/** 获取当前代理配置。无 IPC 时返回默认配置 */
export function getProxyConfig(): Promise<import('@xyz-agent/shared').IProxyConfig> {
  return api?.getProxyConfig() ?? Promise.resolve({ mode: 'system' })
}

/** 保存代理配置。无 IPC 时 no-op */
export function setProxyConfig(config: import('@xyz-agent/shared').IProxyConfig): Promise<void> {
  return api?.setProxyConfig(config) ?? Promise.resolve()
}

/** 测试代理连接。无 IPC 时返回成功（跳过测试） */
export function testProxy(config: import('@xyz-agent/shared').IProxyConfig): Promise<ProxyTestResult> {
  return api?.testProxy(config) ?? Promise.resolve({ success: true, message: 'No IPC available' })
}

// ── 升级提醒持久化标志 + 升级设置（功能 1 常驻提醒 + 功能 2 预下载开关）─────────
// getPendingUpdate：app 启动时调，读持久化标志恢复「可升级」提醒（离线也能常驻）。
// getUpdateSettings/setUpdateSettings：读/写升级设置（预下载开关），设置页用。
// 无 IPC（web/mock）时 getPendingUpdate 返回 null，getUpdateSettings 返回默认值，setUpdateSettings no-op。

/** 读取升级提醒持久化标志。无 IPC 时返回 null（无持久化提醒可恢复） */
export function getPendingUpdate(): Promise<LatestReleaseInfo | null> {
  return api?.getPendingUpdate() ?? Promise.resolve(null)
}

/** 读取升级设置。无 IPC 时返回默认值（预下载关闭） */
export function getUpdateSettings(): Promise<UpdateSettings> {
  return api?.getUpdateSettings() ?? Promise.resolve({ preDownload: false })
}

/** 保存升级设置。无 IPC 时 no-op 返回 success */
export function setUpdateSettings(settings: Partial<UpdateSettings>): Promise<{ success: boolean }> {
  return api?.setUpdateSettings(settings) ?? Promise.resolve({ success: true })
}

// ── 系统提示音（跨平台：mac afplay / linux paplay / win 返 wav base64）─────────
// main 侧 sound-handlers.ts 处理平台分发。win 返 wav base64 由 renderer 用 new Audio() 播。
// 无 IPC（web/mock）时 listSystemSounds 返回空清单，playSystemSound 静默 no-op。

/** 当前平台可用系统提示音（main existsSync 过滤后的精选清单）。无 IPC 返回空 sounds。 */
export async function listSystemSounds(): Promise<{
  platform: string
  sounds: Array<{ id: string; name: string }>
}> {
  return api?.listSystemSounds?.() ?? { platform: '', sounds: [] }
}

/**
 * 按名字播放系统提示音。mac/linux 由 main spawn 播；win 返 wav base64 由调用方播。
 * name 为空或未知时：若提供 kind，main 回落到平台默认（W3）；否则静默 resolve。
 * 失败静默（提示音失败不阻塞对话流）。
 *
 * @param name 声音 id
 * @param kind 逻辑分类（成功/失败），跨平台失效时回落到对应平台默认；试听可不传
 */
export async function playSystemSound(
  name: string,
  kind?: 'success' | 'error',
): Promise<{ audioData?: string; mimeType?: string }> {
  return api?.playSystemSound?.(name, kind) ?? {}
}
