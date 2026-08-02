// apps/electron/preload/preload.ts
import { contextBridge, ipcRenderer } from 'electron'
import type { LatestReleaseInfo, SegmentsMetadataEntry, UpdateStage, UpdateSettings } from '@xyz-agent/shared'

export interface ElectronAPI {
  /** 监听 runtime 端口事件 */
  onRuntimePort(callback: (port: number) => void): () => void
  /** 监听 runtime 启动失败事件 */
  onRuntimeError(callback: (error: { message: string }) => void): () => void
  /** 监听 runtime 崩溃后重启中事件（supervisor 正在拉起新实例） */
  onRuntimeRestarting(callback: (payload: { attempt: number }) => void): () => void
  /** 监听 runtime 重启用尽事件（需用户手动重试） */
  onRuntimeFailed(callback: (payload: { attempts: number; message: string }) => void): () => void
  /** 请求手动重启 runtime（用户从「runtime 不可用」状态条点重试触发） */
  restartRuntime(): Promise<void>
  /** 监听快捷键事件（替代 @tauri-apps/api/event 的 listen('shortcut')） */
  onShortcut(callback: (type: string) => void): () => void
  /** 获取 runtime 端口 */
  getRuntimePort(): Promise<number>
  /** 获取 runtime 端口偏移（dev 模式 +100） */
  getRuntimePortOffset(): Promise<number>
  // ── 窗口管理 ──────────────────────────────────────────────────
  /** 创建新窗口，可选携带 sessionId 迁移 */
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  /** 获取所有窗口状态列表 */
  getWindows(): Promise<import('@xyz-agent/shared').WindowState[]>
  /** 聚焦指定窗口 */
  focusWindow(windowId: string): Promise<void>
  /** 监听窗口列表变化事件（创建/关闭/更新） */
  onWindowListUpdated(callback: () => void): () => void
  /** 打开目录选择对话框（defaultPath 失效时主进程自动回退到 ~） */
  pickDirectory(options?: { title?: string; defaultPath?: string }): Promise<{
    canceled: boolean
    path: string | null
  }>
  /** 打开文件选择对话框（filters 控制文件类型过滤，defaultPath 失效时主进程自动回退到 ~） */
  pickFile(options?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{
    canceled: boolean
    path: string | null
  }>
  /**
   * 把剪贴板图片（base64）写到 <getDataDir>/attachments/<sessionId>/（持久化），返回 {path, fileName, displayName, id, persisted}。
   * Cmd+V/Ctrl+V 粘贴截图走此 IPC（renderer 读 blob → base64 → 落地文件）。
   * 主进程校验 mimeType image/* 前缀 + 20MB 上限，写失败 throw。
   * sessionId 为空时（landing 态）降级走 OS tmpdir。
   * - fileName：落地磁盘文件名（含 uuid 前缀，segment.fileName 用，extractImages 读文件用）
   * - displayName：用户可读名（badge/alt 显示，无 uuid 前缀）；粘贴截图无原文件名时为 截图-时间戳.ext
   * - persisted：sessionId 非空 true（落 attachments 已持久化）；空 false（落 tmpdir，session 创建后需迁移）
   */
  writeSessionImage(payload: {
    sessionId: string
    base64: string
    mimeType: string
    name: string
  }): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }>
  /**
   * 把 landing 态落在 tmpdir 的图片 move 到 <dataDir>/attachments/<sessionId>/（持久化）。
   * session 创建后调用，解决 landing 粘图 path 仍指 tmpdir 的缺口（OS 会清理 tmpdir 导致丢图）。
   * fromPath 不存在（OS 已清理）或 move 失败会 throw，调用方 catch 后降级。
   */
  migrateSessionImage(payload: {
    fromPath: string
    sessionId: string
    fileName: string
  }): Promise<{ path: string }>
  /**
   * 追加/覆盖一条 segments 元数据到 sidecar（<dataDir>/attachments/<sessionId>/segments.json）。
   * 发送 user message 时调用，把完整 Segment[]（含 image/file 私有元信息）落盘，重开 session 时回填。
   * 同 clientUuid 重发（editAndResend）→ 后者覆盖前者。主进程 atomic 写（tmp + rename）。
   */
  writeSegmentsMetadata(payload: {
    sessionId: string
    entry: SegmentsMetadataEntry
  }): Promise<void>
  /** 在默认浏览器中打开外部链接 */
  openExternal(url: string): Promise<void>
  /** 监听 macOS 全屏状态变化 */
  onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  /** 最小化当前窗口 */
  windowMinimize(): Promise<void>
  /** 最大化/还原切换 */
  windowToggleMaximize(): Promise<void>
  /** 关闭当前窗口 */
  windowClose(): Promise<void>
  // ── Browser drawer（嵌入式浏览器）─────────────────────────────
  /** 创建 WebContentsView 并 attach 到指定窗口（初始隐藏） */
  browserCreate(sessionId: string, windowId: string): Promise<void>
  /** 导航到指定 URL */
  browserNavigate(sessionId: string, url: string): Promise<void>
  /** 隐藏 view（keep-alive，不销毁） */
  browserHide(sessionId: string): Promise<void>
  /** 显示 view（恢复最近 rect） */
  browserShow(sessionId: string): Promise<void>
  /** 切换可见 view 到指定 session（Wave 4：隐藏其他可见 view，显示 target；用于切 session 时 swap） */
  browserFocus(sessionId: string): Promise<void>
  /** 设置 view 位置/尺寸（CSS px = DIP，不乘 dpr；renderer 经 getBoundingClientRect 推送） */
  browserSetRect(sessionId: string, rect: { x: number; y: number; width: number; height: number }): Promise<void>
  /** 销毁 view（removeChildView + webContents.destroy） */
  browserDestroy(sessionId: string): Promise<void>
  /** 后退（Wave 5 历史；sessionId 不存在或无法后退时无操作） */
  browserBack(sessionId: string): Promise<void>
  /** 前进（Wave 5 历史；sessionId 不存在或无法前进时无操作） */
  browserForward(sessionId: string): Promise<void>
  /** 设置缩放因子（1.0=100%；Wave 5） */
  browserSetZoom(sessionId: string, factor: number): Promise<void>
  /** 读取当前缩放因子（Wave 5；sessionId 不存在返回 1.0） */
  browserGetZoom(sessionId: string): Promise<number>
  /** 读取 WebContentsView 内当前选区文本 + URL（二期扩展点，Wave 6 预留） */
  browserGetSelection(sessionId: string): Promise<{ text: string; url: string }>
  /** 监听 browser 状态变化（url/isLoading/error/canGoBack/canGoForward/zoomFactor，主进程 did-navigate 等事件推送），返回取消订阅函数 */
  onBrowserState(callback: (state: {
    sessionId: string
    currentUrl: string
    isLoading: boolean
    error: { errorCode: number; errorDescription: string; validatedURL: string } | null
    canGoBack: boolean
    canGoForward: boolean
    zoomFactor: number
  }) => void): () => void
  // ── 自动升级检测 ──────────────────────────────────────────────
  /**
   * 检测最新可用版本。
   * @param opts.force 强制刷新缓存（默认走 1h 缓存）
   * @returns 有新版返回 LatestReleaseInfo，无新版/失败/未注入返回 null
   */
  checkForUpdate(opts?: { force?: boolean }): Promise<LatestReleaseInfo | null>
  // ── 自动升级执行（w3）──────────────────────────────────────────
  /**
   * 执行完整升级流程（下载 → 校验 → 替换 → 触发重启）。
   * @param release checkForUpdate 返回的最新版本信息
   * @returns triggerRestart=true 表示升级已触发、app 即将退出重启
   */
  performUpdate(release: LatestReleaseInfo): Promise<{ triggerRestart: boolean }>
  /**
   * 拆分升级流程的下载阶段：下载 + 校验 + 写入预下载产物元信息。
   * 下载成功后状态进入 'downloaded'，前端可调 updateInstall 触发安装。
   * @param release checkForUpdate 返回的最新版本信息
   * @returns downloaded=true 表示下载完成
   */
  updateDownload(release: LatestReleaseInfo): Promise<{ downloaded: boolean }>
  /**
   * 拆分升级流程的安装阶段：从预下载产物读取 release + filePath，执行替换 + 触发重启。
   * install 权威源是预下载产物（不信任前端传入的 release，堵装错版本漏洞）。
   * @returns triggerRestart=true 表示升级已触发、app 即将退出重启
   */
  updateInstall(): Promise<{ triggerRestart: boolean }>
  /**
   * 读取预下载产物信息（供前端判断是否已下载完成）。
   * @returns 有效的 { release, filePath }，无预下载产物/损坏返回 null
   */
  getPreloaded(): Promise<{ release: LatestReleaseInfo; filePath: string } | null>
  /** 监听升级进度事件（stage + percent 0-100），返回取消订阅函数 */
  onUpdateProgress(callback: (payload: { stage: UpdateStage; percent: number }) => void): () => void
  /** 监听升级错误事件（stage + message + errorCode），返回取消订阅函数 */
  onUpdateError(callback: (payload: { stage: string; message: string; errorCode?: string }) => void): () => void
  /** 不支持当前平台时，打开备用下载页（release 页面） */
  openUpdateFallbackUrl(url: string): Promise<void>
  // ── 代理配置 ────────────────────────────────────────────────────
  /** 获取当前代理配置 */
  getProxyConfig(): Promise<import('@xyz-agent/shared').IProxyConfig>
  /** 保存代理配置 */
  setProxyConfig(config: import('@xyz-agent/shared').IProxyConfig): Promise<void>
  /** 测试代理连接 */
  testProxy(config: import('@xyz-agent/shared').IProxyConfig): Promise<{ success: boolean; message?: string }>
  // ── 升级提醒持久化标志（功能 1：常驻提醒）──────────────────────────
  /**
   * 读取升级提醒持久化标志（app 启动时调用以恢复「可升级」提醒）。
   * @returns 仍有效的 pending release（有新版待升级），无新版/已升级/失败返回 null
   */
  getPendingUpdate(): Promise<LatestReleaseInfo | null>
  // ── 升级设置（功能 2：预下载开关）──────────────────────────────
  /** 读取升级设置（预下载开关等） */
  getUpdateSettings(): Promise<UpdateSettings>
  /** 保存升级设置 */
  setUpdateSettings(settings: UpdateSettings): Promise<{ success: boolean }>
  // ── 系统提示音（跨平台：mac afplay / linux paplay / win 返 wav base64）──
  /** 列出当前平台可用的系统提示音（existsSync 过滤后的精选清单） */
  listSystemSounds(): Promise<{ platform: string; sounds: Array<{ id: string; name: string }> }>
  /**
   * 播放系统提示音。mac/linux 由 main spawn 命令播放；win 返回 wav base64
   * 由 renderer 用 new Audio() 播（wav 是 Chromium 原生格式）。
   * 失败静默 resolve（提示音失败不阻塞对话流）。
   *
   * @param name 声音 id；不在当前平台精选清单内时，若提供 kind 则回落到平台默认（W3 跨平台失效兜底）
   * @param kind 逻辑分类（成功/失败），用于跨平台失效时回落到对应默认；试听已知声音可不传
   */
  playSystemSound(name: string, kind?: 'success' | 'error'): Promise<{ audioData?: string; mimeType?: string }>
}

contextBridge.exposeInMainWorld('electronAPI', {
  onRuntimePort: (callback: (port: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, port: number) => callback(port)
    ipcRenderer.on('runtime-port', handler)
    return () => ipcRenderer.removeListener('runtime-port', handler)
  },
  onRuntimeError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { message: string }) => callback(error)
    ipcRenderer.on('runtime-error', handler)
    return () => ipcRenderer.removeListener('runtime-error', handler)
  },
  onRuntimeRestarting: (callback: (payload: { attempt: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { attempt: number }) => callback(payload)
    ipcRenderer.on('runtime-restarting', handler)
    return () => ipcRenderer.removeListener('runtime-restarting', handler)
  },
  onRuntimeFailed: (callback: (payload: { attempts: number; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { attempts: number; message: string }) => callback(payload)
    ipcRenderer.on('runtime-failed', handler)
    return () => ipcRenderer.removeListener('runtime-failed', handler)
  },
  restartRuntime: () => ipcRenderer.invoke('runtime-restart'),
  onShortcut: (callback: (type: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string) => callback(type)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  getRuntimePort: () => ipcRenderer.invoke('get-runtime-port'),
  getRuntimePortOffset: () => ipcRenderer.invoke('get-runtime-port-offset'),

  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow: (sessionId?: string) => ipcRenderer.invoke('create-window', { sessionId }),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  focusWindow: (windowId: string) => ipcRenderer.invoke('focus-window', windowId),
  onWindowListUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('window-list-updated', handler)
    return () => ipcRenderer.removeListener('window-list-updated', handler)
  },
  pickDirectory: (options?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('pick-directory', options),
  pickFile: (options?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => ipcRenderer.invoke('pick-file', options),
  writeSessionImage: (payload: { sessionId: string; base64: string; mimeType: string; name: string }) =>
    ipcRenderer.invoke('write-session-image', payload),
  migrateSessionImage: (payload: { fromPath: string; sessionId: string; fileName: string }) =>
    ipcRenderer.invoke('migrate-session-image', payload),
  writeSegmentsMetadata: (payload: { sessionId: string; entry: SegmentsMetadataEntry }) =>
    ipcRenderer.invoke('write-segments-metadata', payload),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  onFullscreenChanged: (callback: (payload: { isFullscreen: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { isFullscreen: boolean }) => callback(payload)
    ipcRenderer.on('fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('fullscreen-changed', handler)
  },
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  // ── Browser drawer（嵌入式浏览器）─────────────────────────────
  browserCreate: (sessionId: string, windowId: string) => ipcRenderer.invoke('browser:create', { sessionId, windowId }),
  browserNavigate: (sessionId: string, url: string) => ipcRenderer.invoke('browser:navigate', { sessionId, url }),
  browserHide: (sessionId: string) => ipcRenderer.invoke('browser:hide', sessionId),
  browserShow: (sessionId: string) => ipcRenderer.invoke('browser:show', sessionId),
  browserFocus: (sessionId: string) => ipcRenderer.invoke('browser:focus', sessionId),
  browserSetRect: (sessionId: string, rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:set-rect', { sessionId, rect }),
  browserDestroy: (sessionId: string) => ipcRenderer.invoke('browser:destroy', sessionId),
  browserBack: (sessionId: string) => ipcRenderer.invoke('browser:back', sessionId),
  browserForward: (sessionId: string) => ipcRenderer.invoke('browser:forward', sessionId),
  browserSetZoom: (sessionId: string, factor: number) => ipcRenderer.invoke('browser:set-zoom', { sessionId, factor }),
  browserGetZoom: (sessionId: string) => ipcRenderer.invoke('browser:get-zoom', sessionId),
  browserGetSelection: (sessionId: string) => ipcRenderer.invoke('browser:get-selection', sessionId),
  onBrowserState: (callback: (state: {
    sessionId: string
    currentUrl: string
    isLoading: boolean
    error: { errorCode: number; errorDescription: string; validatedURL: string } | null
    canGoBack: boolean
    canGoForward: boolean
    zoomFactor: number
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: {
      sessionId: string
      currentUrl: string
      isLoading: boolean
      error: { errorCode: number; errorDescription: string; validatedURL: string } | null
      canGoBack: boolean
      canGoForward: boolean
      zoomFactor: number
    }) => callback(state)
    ipcRenderer.on('browser:state', handler)
    return () => ipcRenderer.removeListener('browser:state', handler)
  },
  // ── 自动升级检测 ──────────────────────────────────────────────
  checkForUpdate: (opts?: { force?: boolean }) =>
    ipcRenderer.invoke('update:check', { force: opts?.force }),
  // ── 自动升级执行（w3）──────────────────────────────────────
  performUpdate: (release: LatestReleaseInfo) =>
    ipcRenderer.invoke('update:perform', { release }),
  // ── 自动升级拆分流程（download → install）──────────────────────
  updateDownload: (release: LatestReleaseInfo) =>
    ipcRenderer.invoke('update:download', { release }),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  getPreloaded: () => ipcRenderer.invoke('update:getPreloaded'),
  onUpdateProgress: (callback: (payload: { stage: UpdateStage; percent: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { stage: UpdateStage; percent: number }) => callback(payload)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  onUpdateError: (callback: (payload: { stage: string; message: string; errorCode?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { stage: string; message: string; errorCode?: string }) => callback(payload)
    ipcRenderer.on('update:error', handler)
    return () => ipcRenderer.removeListener('update:error', handler)
  },
  openUpdateFallbackUrl: (url: string) => ipcRenderer.invoke('open-external', url),
  // ── 代理配置 ────────────────────────────────────────────────────
  getProxyConfig: () => ipcRenderer.invoke('update:getProxyConfig'),
  setProxyConfig: (config) => ipcRenderer.invoke('update:setProxyConfig', config),
  testProxy: (config) => ipcRenderer.invoke('update:testProxy', config),
  // ── 升级提醒持久化标志 + 升级设置 ────────────────────────────────
  getPendingUpdate: () => ipcRenderer.invoke('update:getPending'),
  getUpdateSettings: () => ipcRenderer.invoke('update:getSettings'),
  setUpdateSettings: (settings: UpdateSettings) => ipcRenderer.invoke('update:setSettings', settings),
  // ── 系统提示音 ──────────────────────────────────────────────
  listSystemSounds: () => ipcRenderer.invoke('sound:list'),
  playSystemSound: (name: string, kind?: 'success' | 'error') => ipcRenderer.invoke('sound:play', name, kind),
} satisfies ElectronAPI)
