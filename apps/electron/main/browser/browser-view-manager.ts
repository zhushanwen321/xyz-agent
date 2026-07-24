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

/** 暂存的 view 状态（W2 经 IPC 回传 renderer） */
export interface BrowserViewState {
  /** 当前 URL（did-navigate / did-navigate-in-page 更新） */
  currentUrl: string
  /** 是否加载中 */
  isLoading: boolean
  /** 最近一次加载错误（did-fail-load 记录；成功导航后清空） */
  error: { errorCode: number; errorDescription: string; validatedURL: string } | null
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
    }
    this.bindWebContentsEvents(view, state, sessionId)

    this.views.set(sessionId, { view, windowId, lastRect: HIDDEN_RECT, isVisible: false, state, lastUsed: Date.now() })
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
      entry.view.setBounds(rect)
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
   * 绑定 webContents 事件到 state 暂存，并经 onStateChange 回调推送 renderer。
   * 抽出方法便于复用 + 单测可观察 state 变化。
   */
  private bindWebContentsEvents(view: WebContentsView, state: BrowserViewState, sessionId: string): void {
    const wc = view.webContents
    const notify = (): void => {
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
  }
}
