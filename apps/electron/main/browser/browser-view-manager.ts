/**
 * WebContentsView 生命周期管理器。
 *
 * 对应 Browser Drawer Wave 1：在 SideDrawer 的 browser tab 内用
 * Electron WebContentsView 嵌入第三方网页。本管理器负责每个 sessionId 对应
 * view 的创建 / 导航 / 显隐 / 销毁，以及下载拦截等安全默认。
 *
 * [HISTORICAL] 不变量（必须在实现中守护）：
 *
 * 1. 零信任嵌入：创建 view 时显式 webPreferences
 *    { contextIsolation: true, nodeIntegration: false, sandbox: true }，
 *    无 preload、零注入——被嵌入页不能访问 Node / Electron API。
 *
 * 2. WebContentsView 是 Electron 42 原生 API（`import { WebContentsView } from 'electron'`），
 *    不是已废弃的 BrowserView。
 *
 * 3. 下载拦截（MANDATORY 安全默认）：defaultSession.on('will-download', e => e.preventDefault())。
 *    嵌入页不应触发宿主下载；W5 再补提示 UI，W1 先静默拦截。
 *
 * 4. destroy 顺序：先 removeChildView（从父窗口摘下）再 webContents.close()（防内存泄漏），
 *    且 win.isDestroyed() 校验——窗口已关时跳过 removeChildView 但仍 close webContents。
 *    [HISTORICAL] Electron 42 的 WebContents 无 destroy()，close() 是正确销毁 API
 *    （文档：成功 close 后 webContents 被销毁，emit destroyed 事件）。
 *
 * 5. hide = setBounds({0,0,0,0})（keep-alive 不销毁），show 恢复最近 rect。
 *    W3 接 renderer 推送真实 rect：setRect 更新 lastRect + setBounds，
 *    show/hide 用 isVisible 标志精确切换显隐（hide 态收到 setRect 不会意外重显）。
 *
 * 6. [HISTORICAL] rect 坐标系：setBounds 用 DIP（device-independent pixels），
 *    与 CSS px 1:1，**绝对不乘 devicePixelRatio**。renderer 的
 *    getBoundingClientRect() 返回 CSS px，直接透传即可（详见 setRect）。
 *
 * 7. W1 内部用 Map<sessionId, entry>，无 LRU 上限（W4 再加淘汰策略）。
 *
 * 状态暂存：webContents 事件（did-navigate / did-fail-load / isLoading）W1 先暂存到
 * manager 内部 entry，W2 经 IPC 回传 renderer。
 *
 * 依赖方向：browser-view-manager → electron(WebContentsView) + interfaces(type-only)
 * （will-download 拦截用 view.webContents.session 实例属性，不需 electron 的 session 模块导入）
 */
import { WebContentsView } from 'electron'
import type { Rectangle } from 'electron'
import type { IWindowManager } from '../interfaces.js'

/** 隐藏占位 rect（0,0,0,0） */
const HIDDEN_RECT: Rectangle = { x: 0, y: 0, width: 0, height: 0 }

/** view 池 LRU 上限。超过时淘汰 lastUsed 最旧的（removeChildView + webContents.close）。
 * 3 = 最多同时保留 3 个 session 的 view（keep-alive 复用），第 4 个 session 创建时淘汰最旧。
 * rationale：每个 view 独立 webContents（独立渲染进程），内存开销大；3 是用户实际同时切换的合理上限。 */
const MAX_VIEWS = 3

/** Chromium net 错误码：ABORTED（-3）。重定向过程中旧请求被新导航抢占时触发，非真错误，需过滤。
 * 详见 did-fail-load handler 的 [HISTORICAL] 注释。 */
const ERR_ABORTED = -3

/** autoFit 缩放下限：低于此值文字不可读，宁可部分溢出也不再缩小（spec §4.3 可读性约束） */
const AUTO_FIT_MIN = 0.5
/** autoFit 缩放上限：只缩小不放大（不溢出的页面保持 100%，避免把响应式页面强制放大失真） */
const AUTO_FIT_MAX = 1.0

/** 暂存的 view 状态（W2 经 IPC 回传 renderer） */
export interface BrowserViewState {
  /** 当前 URL（did-navigate / did-navigate-in-page 更新） */
  currentUrl: string
  /** 是否加载中 */
  isLoading: boolean
  /** 最近一次加载错误（did-fail-load 记录；成功导航后清空） */
  error: { errorCode: number; errorDescription: string; validatedURL: string } | null
  /** 是否可后退（did-navigate 等事件后同步 webContents.navigationHistory，供 renderer 更新 back 按钮 disabled 态） */
  canGoBack: boolean
  /** 是否可前进 */
  canGoForward: boolean
  /** 当前缩放因子（setZoomFactor 后同步经 onBrowserState 推 renderer，让 useBrowserZoom 基准一致） */
  zoomFactor: number
}

/** 单个 sessionId 对应的托管条目 */
interface ManagedView {
  view: WebContentsView
  windowId: string
  /** 最近 rect（show 时恢复；W3 由 renderer 经 setRect 推送真实 rect） */
  lastRect: Rectangle
  /** 当前是否可见。create=false，show=true，hide=false。
   *  setRect 始终更新 lastRect，但仅当 isVisible 才 setBounds（防止隐藏中 resize 把 view 意外重显） */
  isVisible: boolean
  /** webContents 状态投影 */
  state: BrowserViewState
  /** 最近访问时间戳（Date.now()）。LRU 排序依据：create/focus 时更新，evictLRU 淘汰最小值。 */
  lastUsed: number
  /** navigate() 后置 true，下次 dom-ready 时触发 autoFit 检测并清除。
   *  仅 navigate（地址栏输入新 URL / agent 推链接）触发；页内链接 / 后退前进不经 navigate，不触发。
   *  原因：用户在已缩放的页面上点页内链接属于「在当前布局内浏览」，不应被重新缩放打断。 */
  pendingAutoFit: boolean
}

/**
 * BrowserViewManager：按 sessionId 管理 WebContentsView 生命周期。
 *
 * 依赖注入 IWindowManager（取 BrowserWindow 引用 attach view），不依赖具体类。
 *
 * @param windows 窗口 Facade（取 BrowserWindow 引用 attach view）
 * @param onStateChange 可选状态推送回调（W2）：webContents 事件触发时回调，main.ts
 *   构造时注入「向主窗口 webContents.send('browser:state')」的实现，renderer（BrowserPane）
 *   据此更新地址栏真实 URL（防钓鱼）+ loading/error 态。无注入时仅内部暂存 state。
 *
 * 使用方法：
 * ```ts
 * const mgr = new BrowserViewManager(windows, (sid, state) => {
 *   win.webContents.send('browser:state', { sessionId: sid, ...state })
 * })
 * mgr.create('sess-1', 'win-1')
 * await mgr.navigate('sess-1', 'https://example.com')
 * mgr.hide('sess-1')
 * mgr.show('sess-1')
 * mgr.destroy('sess-1')
 * ```
 */
export class BrowserViewManager {
  private views = new Map<string, ManagedView>()

  constructor(
    private readonly windows: IWindowManager,
    private readonly onStateChange?: (sessionId: string, state: BrowserViewState) => void,
  ) {}

  /**
   * 创建 view 并 attach 到指定窗口。
   *
   * 初始 setBounds({0,0,0,0}) 隐藏（renderer show 前不可见），isVisible=false。
   * 若 sessionId 已存在则幂等复用（不重复创建）。
   */
  create(sessionId: string, windowId: string): void {
    // 幂等：已存在直接复用，避免重复 attach 造成 view 泄漏。
    // 复用即重新访问，更新 lastUsed 提升 LRU 优先级（防最近用的 session 被淘汰）。
    const existing = this.views.get(sessionId)
    if (existing) {
      existing.lastUsed = Date.now()
      return
    }

    // 新建前 LRU 淘汰：池满（>=MAX_VIEWS）时淘汰 lastUsed 最旧的 entry。
    if (this.views.size >= MAX_VIEWS) {
      this.evictLRU()
    }

    const win = this.windows.get(windowId)
    if (!win) {
      console.error(`[browser-view] create: window not found windowId=${windowId} sessionId=${sessionId}`)
      return
    }

    // 零信任嵌入：contextIsolation + sandbox + 无 nodeIntegration + 无 preload
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 初始隐藏（drawer 显示前不可见）
    view.setBounds(HIDDEN_RECT)

    // attach 到目标窗口
    if (!win.isDestroyed()) {
      win.contentView.addChildView(view)
    }

    // 下载拦截（MANDATORY）：嵌入页禁止触发宿主下载
    view.webContents.session.on('will-download', (event) => {
      event.preventDefault()
    })

    // 状态暂存（W2 经 IPC 回传 renderer）
    const state: BrowserViewState = {
      currentUrl: '',
      isLoading: false,
      error: null,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1.0,
    }
    this.bindWebContentsEvents(view, state, sessionId)

    this.views.set(sessionId, {
      view,
      windowId,
      lastRect: HIDDEN_RECT,
      isVisible: false,
      state,
      lastUsed: Date.now(),
      pendingAutoFit: false,
    })
  }

  /**
   * 导航到指定 URL。
   * @throws sessionId 不存在或 loadURL 失败时抛出
   */
  async navigate(sessionId: string, url: string): Promise<void> {
    const entry = this.views.get(sessionId)
    if (!entry) {
      throw new Error(`[browser-view] navigate: session not found sessionId=${sessionId}`)
    }
    // loadURL 前置 pendingAutoFit，确保随后的 dom-ready 能读到（loadURL → dom-ready 是同 tick 后异步触发）。
    // 仅 navigate 触发 autoFit：用户在地址栏输入新 URL / agent 推链接 → 缩放；页内链接 / 后退前进不经过此方法。
    entry.pendingAutoFit = true
    // loadURL 自身 reject 时（DNS 失败 / 非法 URL 等）抛出，调用方经 IPC 接住
    await entry.view.webContents.loadURL(url)
  }

  /**
   * 设置 view 的位置和尺寸（renderer 推送）。
   *
   * [HISTORICAL] rect 坐标系：bounds 单位是 DIP，与 CSS px 1:1，**不乘 devicePixelRatio**。
   * renderer 的 getBoundingClientRect() 返回 CSS px，直接透传（retina dpr=2 误乘会定位屏外+尺寸翻倍）。
   *
   * 行为：始终更新 lastRect（hide 态也记，show 时恢复最新）；
   * 仅当 isVisible 时 setBounds（隐藏中收到 resize 不会把 view 意外重显——防御性）。
   * 幂等：sessionId 不存在时无操作。
   */
  setRect(sessionId: string, rect: Rectangle): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    entry.lastRect = rect
    if (entry.isVisible) {
      const prev = entry.view.getBounds()
      entry.view.setBounds(rect)
      if (prev.x !== rect.x || prev.y !== rect.y || prev.width !== rect.width || prev.height !== rect.height) {
        const win = this.windows.get(entry.windowId)
        if (win && !win.isDestroyed()) {
          win.contentView.addChildView(entry.view)
        }
      }
    }
  }

  /**
   * 隐藏 view（setBounds {0,0,0,0}，keep-alive 不销毁）。
   * 记录当前 getBounds 到 lastRect（show 时恢复）。isVisible 置 false。
   * 幂等：sessionId 不存在时无操作。
   */
  hide(sessionId: string): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    // 记录当前可见 rect（若已隐藏，getBounds 返回 HIDDEN_RECT，无副作用）
    entry.lastRect = entry.view.getBounds()
    entry.isVisible = false
    entry.view.setBounds(HIDDEN_RECT)
  }

  /**
   * 显示 view（恢复最近 rect）。isVisible 置 true。
   * show 前若 setRect 推过真实 rect，lastRect 即真实值；否则为 HIDDEN_RECT。
   * 幂等：sessionId 不存在时无操作。
   */
  show(sessionId: string): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    entry.isVisible = true
    entry.view.setBounds(entry.lastRect)
  }

  /**
   * 销毁 view：先 removeChildView 再 webContents.destroy。
   * 幂等：sessionId 不存在时无操作。
   */
  destroy(sessionId: string): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    const { view, windowId } = entry
    const win = this.windows.get(windowId)
    // 窗口未销毁才摘下 view；窗口已关则跳过（view 会随窗口一起释放）
    if (win && !win.isDestroyed()) {
      win.contentView.removeChildView(view)
    }
    // webContents.close() 释放 webContents（防内存泄漏）。
    // [HISTORICAL] Electron 42 的 WebContents 无 destroy()，close() 是正确的销毁 API
    // （文档：成功 close 后 webContents 被销毁，emit destroyed 事件）。
    if (!view.webContents.isDestroyed()) {
      view.webContents.close()
    }
    this.views.delete(sessionId)
  }

  /**
   * LRU 淘汰：找 lastUsed 最小的 entry，调 destroy() 释放。
   * 仅在 create 超上限时调；destroy 自身不会循环调 evictLRU（destroy 是显式释放，不走 LRU）。
   * 策略：Map 保持插入顺序，遍历找最小 lastUsed 的 key（不用额外链表，3 个 entry 遍历开销可忽略）。
   */
  private evictLRU(): void {
    if (this.views.size < MAX_VIEWS) return
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [sid, entry] of this.views) {
      if (entry.lastUsed < oldestTs) {
        oldestTs = entry.lastUsed
        oldestKey = sid
      }
    }
    if (oldestKey) {
      console.log(`[browser-view] LRU evict: ${oldestKey} (pool size ${this.views.size})`)
      this.destroy(oldestKey)
    }
  }

  /**
   * 切换可见 view 到指定 session（Wave 4 per-session 隔离）。
   *
   * 行为：遍历所有 entry，隐藏当前 isVisible=true 的 entry（除 target 外），显示 target。
   * - 若 target 存在：更新 lastUsed（LRU 提升优先级），isVisible=true，setBounds(lastRect)
   * - 其他 isVisible=true 的 entry：hide（setBounds HIDDEN_RECT + isVisible=false，keep-alive）
   * - 若 target 不存在（view 池里没有，如 LRU 被淘汰或从未创建）：仅隐藏所有可见 view，
   *   renderer 侧 BrowserPane 会经 create + show 重建
   *
   * 幂等：target 已是唯一可见 view 时无操作（仅更新 lastUsed）。
   * 场景：renderer watch(focusedSessionId) → browser:focus(newSid)。切 session 时屏幕只显示新 sid 的 view。
   */
  focus(sessionId: string): void {
    const target = this.views.get(sessionId)
    // 隐藏所有当前可见的 entry（除 target 外）
    for (const [sid, entry] of this.views) {
      if (sid === sessionId) continue
      if (entry.isVisible) {
        entry.isVisible = false
        entry.view.setBounds(HIDDEN_RECT)
      }
    }
    // 显示 target（若存在）
    if (target) {
      target.lastUsed = Date.now()
      target.isVisible = true
      target.view.setBounds(target.lastRect)
    }
    // target 不存在时不报错——renderer 侧 BrowserPane onMounted 会 create + show 重建
  }

  /**
   * 读取某 session 的状态投影（W2 IPC 回传 renderer 用）。
   * 不存在返回 null。
   */
  getState(sessionId: string): BrowserViewState | null {
    const entry = this.views.get(sessionId)
    return entry ? entry.state : null
  }

  /**
   * 是否可后退。sessionId 不存在返回 false。
   *
   * [HISTORICAL] Electron 42 的 webContents.canGoBack() 已废弃，
   * 用 webContents.navigationHistory.canGoBack()。
   */
  canGoBack(sessionId: string): boolean {
    const entry = this.views.get(sessionId)
    return entry ? entry.view.webContents.navigationHistory.canGoBack() : false
  }

  /**
   * 是否可前进。sessionId 不存在返回 false。
   *
   * [HISTORICAL] Electron 42 的 webContents.canGoForward() 已废弃，
   * 用 webContents.navigationHistory.canGoForward()。
   */
  canGoForward(sessionId: string): boolean {
    const entry = this.views.get(sessionId)
    return entry ? entry.view.webContents.navigationHistory.canGoForward() : false
  }

  /**
   * 后退。sessionId 不存在或无法后退时无操作。
   *
   * [HISTORICAL] Electron 42 的 webContents.goBack() 已废弃，
   * 用 webContents.navigationHistory.goBack()。isDestroyed 守卫防 webContents 已销毁时报错。
   */
  goBack(sessionId: string): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    const wc = entry.view.webContents
    if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack()
    }
  }

  /**
   * 前进。sessionId 不存在或无法前进时无操作。
   *
   * [HISTORICAL] Electron 42 的 webContents.goForward() 已废弃，
   * 用 webContents.navigationHistory.goForward()。isDestroyed 守卫防 webContents 已销毁时报错。
   */
  goForward(sessionId: string): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    const wc = entry.view.webContents
    if (!wc.isDestroyed() && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward()
    }
  }

  /**
   * 设置缩放因子（1.0=100%，1.25=125%，0.75=75%）。
   * sessionId 不存在或 webContents 已销毁时无操作。
   *
   * 同步 state.zoomFactor + notify renderer（经 onBrowserState 通道）：用户手动 Cmd+/Cmd- 调用时
   * renderer 本地已更新无需回推，但 autoFit 在主进程触发时 renderer 无感知，需 notify 让基准一致。
   * notify 幂等，renderer 收到后调 setZoomFromRemote 更新本地 ref（不调 IPC 避免循环）。
   *
   * [HISTORICAL] setZoomFactor 单位是因子（1.0=100%），不是百分比；负值会被 Chromium 忽略。
   */
  setZoomFactor(sessionId: string, factor: number): void {
    const entry = this.views.get(sessionId)
    if (!entry) return
    const wc = entry.view.webContents
    if (!wc.isDestroyed()) {
      wc.setZoomFactor(factor)
      entry.state.zoomFactor = factor
      this.onStateChange?.(sessionId, entry.state)
    }
  }

  /**
   * 读取当前缩放因子。sessionId 不存在或 webContents 已销毁返回 1.0（默认）。
   */
  getZoomFactor(sessionId: string): number {
    const entry = this.views.get(sessionId)
    if (!entry) return 1.0
    const wc = entry.view.webContents
    return wc.isDestroyed() ? 1.0 : wc.getZoomFactor()
  }

  /**
   * 读取 WebContentsView 内的当前文本选区 + 页面 URL（二期扩展点，Wave 6 预留）。
   *
   * 用 webContents.executeJavaScript 执行 window.getSelection().toString()。
   * 返回 { text, url }：text 为选中文本（无选中返回空串），url 为当前页面 URL。
   * sessionId 不存在或 webContents 已销毁返回 { text: '', url: '' }。
   *
   * 安全：executeJavaScript 在零信任页执行，只读 window.getSelection()（无副作用），
   * 不注入任何脚本文件、不暴露 Node API（contextIsolation + sandbox 保护）。
   *
   * 二期用法：前端 composer「引用网页选区」功能调此 IPC 拿到选区文本，作为 badge 注入消息。
   */
  async getSelection(sessionId: string): Promise<{ text: string; url: string }> {
    const entry = this.views.get(sessionId)
    if (!entry) return { text: '', url: '' }
    const wc = entry.view.webContents
    if (wc.isDestroyed()) return { text: '', url: '' }
    const url = entry.state.currentUrl
    return wc
      .executeJavaScript('window.getSelection().toString()')
      .then((text: unknown) => ({ text: typeof text === 'string' ? text : '', url }))
      .catch(() => {
        /* executeJavaScript 可能因导航中断/CSP 失败，返回空选区（非关键路径） */
        return { text: '', url }
      })
  }

  /**
   * 绑定 webContents 事件到 state 暂存，并经 onStateChange 回调推送 renderer。
   * 抽出方法便于复用 + 单测可观察 state 变化。
   */
  private bindWebContentsEvents(view: WebContentsView, state: BrowserViewState, sessionId: string): void {
    const wc = view.webContents
    const notify = (): void => {
      // 同步导航历史状态（back/forward 按钮 disabled 态）。
      // [HISTORICAL] Electron 42 的 webContents.canGoBack() / goBack() 等已废弃，
      // 必须用 webContents.navigationHistory.canGoBack() / goBack()。
      state.canGoBack = wc.navigationHistory.canGoBack()
      state.canGoForward = wc.navigationHistory.canGoForward()
      this.onStateChange?.(sessionId, state)
    }
    wc.on('did-start-loading', () => {
      state.isLoading = true
      notify()
    })
    wc.on('did-stop-loading', () => {
      state.isLoading = false
      notify()
    })
    wc.on('did-navigate', (_e, url: string) => {
      state.currentUrl = url
      state.error = null
      notify()
    })
    wc.on('did-navigate-in-page', (_e, url: string) => {
      state.currentUrl = url
      state.error = null
      notify()
    })
    wc.on('did-fail-load', (_e, errorCode: number, errorDescription: string, validatedURL: string) => {
      // [HISTORICAL] ERR_ABORTED(-3)：重定向过程中的正常取消（被新导航抢占），非真错误，过滤。
      // 不过滤会让重定向中闪现的 ABORTED 把 BrowserPane 切到错误态。
      if (errorCode === ERR_ABORTED) return
      state.error = { errorCode, errorDescription, validatedURL }
      notify()
    })
    // dom-ready：注入 viewport meta + autoFit 自动缩放（链式，保证 viewport reflow 完成后再读 scrollWidth）。
    //
    // viewport meta 注入：无 viewport meta 的桌面网页默认按 980px layout viewport 渲染，在窄 panel 里溢出 + 不滚动。
    // 注入 width=device-width 让 CSS viewport = view 物理宽度，网页自适应 + 内部滚动正常。仅页面无自带 meta 时注入。
    //
    // autoFit（仅 navigate 触发，pendingAutoFit 标志控制）：检测 scrollWidth > innerWidth（横向溢出）→ 自动缩放到刚好容纳。
    // 解决"固定宽度页面在窄 panel 里溢出"问题（如百度搜索框 width:535px 在 400px panel 里）。下限 0.5（可读性），只缩小不放大。
    // 必须在 viewport 注入 .then 后执行：layout viewport 改变会让 scrollWidth 重算，提前读会得到错误值。
    // 仅 navigate（地址栏输入/agent 推链接）触发；页内链接/后退前进不经 navigate，pendingAutoFit 保持 false，不触发（避免打断用户浏览）。
    // 安全：executeJavaScript 在零信任页执行，只读 scrollWidth/innerWidth（无副作用），contextIsolation + sandbox 保护。
    wc.on('dom-ready', () => {
      wc.executeJavaScript(
        `(() => {
          if (document.querySelector('meta[name="viewport"]')) return;
          const m = document.createElement('meta');
          m.name = 'viewport';
          m.content = 'width=device-width, initial-scale=1';
          document.head.appendChild(m);
        })()`,
      )
        .then(() => {
          // viewport 注入完成（layout viewport 已更新），此时读 scrollWidth 准确。
          // 仅 navigate 触发的首次加载执行 autoFit（pendingAutoFit 标志）。
          const entry = this.views.get(sessionId)
          if (!entry?.pendingAutoFit) return undefined
          entry.pendingAutoFit = false
          // 读 [scrollWidth, innerWidth]：scrollWidth = 内容实际宽度，innerWidth = view 物理宽度（layout viewport）
          return wc.executeJavaScript('[document.documentElement.scrollWidth, window.innerWidth]')
        })
        .then((dims: unknown) => {
          if (!Array.isArray(dims)) return // 上一步 return undefined（无 pendingAutoFit）或 executeJavaScript 返回非数组
          const [scrollW, viewW] = dims as [number, number]
          if (typeof scrollW !== 'number' || typeof viewW !== 'number') return
          if (viewW === 0 || scrollW <= viewW) return // viewW=0（隐藏中）或无溢出 → 不缩放
          // fitFactor = viewport / content，钳制到 [AUTO_FIT_MIN, AUTO_FIT_MAX]（只缩小不放大，下限保可读性）
          const fit = Math.max(AUTO_FIT_MIN, Math.min(AUTO_FIT_MAX, viewW / scrollW))
          this.setZoomFactor(sessionId, fit) // 内部更新 state.zoomFactor + notify renderer
        })
        .catch(() => {
          /* viewport 注入或 autoFit 可能因 CSP/导航中断失败，非关键路径（网页仍按默认渲染，用户可手动 Cmd+-） */
        })
    })
  }
}
