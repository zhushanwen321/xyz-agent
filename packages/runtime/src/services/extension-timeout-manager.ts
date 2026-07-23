/**
 * Extension UI request timeout manager.
 * Handles registration, clearing, and session-scoped cleanup of extension timeouts.
 *
 * Extension UI requests block indefinitely waiting for user response.
 * Interactive methods (confirm/select/input/editor/ask-user) no longer set a timer;
 * only session tracking is retained so clearForSession can clean up on session end.
 *
 * [2026-07-16] 新增 pending request 缓存：缓存 pending 的 ask-user 请求内容，
 * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求，
 * 解决「切换 session 后 ask-user 请求丢失」问题。
 *
 * TODO（死代码现状，待重新设计或彻底移除）：registerTimeout 改为同步 `void onTimeout`
 * 不排定时器后，下列字段/方法成了事实上的死代码——
 *   - extensionTimeouts Map：registerTimeout 不再写入，clearTimeout/clearForSession 内的
 *     `extensionTimeouts.get` 恒为 undefined（保留无害但无意义）
 *   - timedOutIds Set / markTimedOut / isTimedOut / clearTimedOut：由 transport/
 *     extension-message-handler.handleExtensionTimeout（经 server.ts 的 dead 回调闭包）
 *     调用，但该闭包随 registerTimeout 改为同步触发后永不再被调用，整条链不触发
 *   - handleExtensionTimeout / ui_timeout 广播分支：同上
 * 故意保留而非删除，原因：(1) TIMEOUT_MS / EXTENSION_UI_TIMEOUT_MS 仍被单测
 * （extension-timeout-manager.test.ts 用 advanceTimersByTime 验证「不触发」）引用；
 * (2) 超时编排链跨 transport/extension-message-handler.ts + server.ts 两个文件，
 * 整链移除需协同改动且超出本 PR scope。待超时机制重新设计或确认废弃后统一清理。
 */

/** 缓存的 pending UI 请求 */
export interface PendingUIRequest {
  requestId: string
  sessionId: string
  method: string
  payload: Record<string, unknown>
  receivedAt: number
}

/**
 * 历史 5min UI 超时常量（300_000ms）。交互式 method 已不再排定时器，
 * 此常量仅保留供单测（extension-timeout-manager.test.ts 用 vi.advanceTimersByTime
 * 推进超大偏移验证回调不触发）使用——不得删除。
 */
const EXTENSION_UI_TIMEOUT_MS = 300_000

export class ExtensionTimeoutManager {
  private extensionTimeouts = new Map<string, NodeJS.Timeout>()
  private extensionSessionRequests = new Map<string, Set<string>>()
  private bridgeRequestIds = new Set<string>()
  /** 已超时的 requestId 集合——防止前端 race window 内迟到的 ui_response 再发一次（双响应） */
  private timedOutIds = new Set<string>()
  /** 缓存 pending 的 UI 请求（per-session），用于 session 重新激活时推送 */
  private pendingRequests = new Map<string, Map<string, PendingUIRequest>>()

  /**
   * 历史 5min UI 超时常量。交互式 method 已不再排定时器，
   * 此属性仅保留供单测使用——不得删除。值见模块级 EXTENSION_UI_TIMEOUT_MS。
   */
  readonly TIMEOUT_MS = EXTENSION_UI_TIMEOUT_MS

  /** Check if a requestId is a bridge request */
  isBridgeRequest(requestId: string): boolean {
    return this.bridgeRequestIds.has(requestId)
  }

  /** Remove a bridge request ID from tracking */
  removeBridgeRequest(requestId: string): void {
    this.bridgeRequestIds.delete(requestId)
  }

  /**
   * Register a timeout for an extension UI request.
   * Returns cleanup info or undefined if no timer needed (notify/bridge methods).
   *
   * [2026-07-16] 取消所有 extension UI 超时：confirm/select/input/editor/ask-user
   * 统一不超时，block 等待用户决策。保留 session 跟踪以便 clearForSession 清理。
   * onTimeout 参数保留为 dead callback（不再被调用），维持调用点签名稳定。
   */
  registerTimeout(
    sessionId: string,
    requestId: string,
    method: string,
    onTimeout: () => void,
  ): void {
    void onTimeout // 不再排定时器，回调保留为签名稳定占位
    if (method === 'notify') return

    if (method.startsWith('bridge:')) {
      this.bridgeRequestIds.add(requestId)
      this.trackSessionRequest(sessionId, requestId)
      return
    }

    // 交互式 method（select/confirm/input/editor/ask-user）：只做 session 跟踪，不排超时定时器
    this.trackSessionRequest(sessionId, requestId)
  }

  /** Clear the timeout timer for a specific requestId */
  clearTimeout(requestId: string): void {
    const timer = this.extensionTimeouts.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.extensionTimeouts.delete(requestId)
    }
    for (const [sid, reqs] of this.extensionSessionRequests) {
      if (reqs.delete(requestId)) {
        if (reqs.size === 0) this.extensionSessionRequests.delete(sid)
        break
      }
    }
  }

  /** 标记 requestId 已超时（handleExtensionTimeout 调用，防止后续迟到的 ui_response 双响应） */
  markTimedOut(requestId: string): void {
    this.timedOutIds.add(requestId)
  }

  /** 检查 requestId 是否已超时（extension.ui_response handler 调用，丢弃迟到响应） */
  isTimedOut(requestId: string): boolean {
    return this.timedOutIds.has(requestId)
  }

  /** 清除已超时标记（丢弃迟到响应后调用，防止集合无限增长） */
  clearTimedOut(requestId: string): void {
    this.timedOutIds.delete(requestId)
  }

  /** Clear all pending timeouts for a session */
  clearForSession(sessionId: string): void {
    // 清除缓存的 pending 请求（必须在 extensionSessionRequests 早退之前执行，
    // 否则只 cachePendingRequest 而未 registerTimeout 的 session 会漏清 pending 缓存）
    this.pendingRequests.delete(sessionId)
    const requestIds = this.extensionSessionRequests.get(sessionId)
    if (!requestIds) return
    for (const reqId of requestIds) {
      const timer = this.extensionTimeouts.get(reqId)
      if (timer) {
        clearTimeout(timer)
        this.extensionTimeouts.delete(reqId)
      }
      this.bridgeRequestIds.delete(reqId)
    }
    this.extensionSessionRequests.delete(sessionId)
  }

  private trackSessionRequest(sessionId: string, requestId: string): void {
    let requestSet = this.extensionSessionRequests.get(sessionId)
    if (!requestSet) {
      requestSet = new Set()
      this.extensionSessionRequests.set(sessionId, requestSet)
    }
    requestSet.add(requestId)
  }

  // ── Pending request 缓存（解决切换 session 后 ask-user 请求丢失问题）──

  /**
   * 缓存 pending 的 UI 请求（ask-user 等阻塞式请求）。
   * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求。
   */
  cachePendingRequest(
    sessionId: string,
    requestId: string,
    method: string,
    payload: Record<string, unknown>,
  ): void {
    let sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache) {
      sessionCache = new Map()
      this.pendingRequests.set(sessionId, sessionCache)
    }
    sessionCache.set(requestId, {
      requestId,
      sessionId,
      method,
      payload,
      receivedAt: Date.now(),
    })
  }

  /**
   * 移除缓存的 pending 请求（用户响应后调用）。
   */
  removePendingRequest(sessionId: string, requestId: string): void {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache) return
    sessionCache.delete(requestId)
    if (sessionCache.size === 0) {
      this.pendingRequests.delete(sessionId)
    }
  }

  /**
   * @deprecated 方案2 改用 getPendingRequests（非破坏快照）。此方法保留至 T6 清理所有调用方后删除。
   *
   * 获取指定 session 的所有 pending 请求（session 重新激活时调用）。
   * 返回后清除缓存（避免重复推送）。
   */
  getAndClearPendingRequests(sessionId: string): PendingUIRequest[] {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests = Array.from(sessionCache.values())
    this.pendingRequests.delete(sessionId)
    // 解包 payload 到顶层：renderer 的 ExtensionUIRequest 期望 title/message/options/askUser
    // 在顶层（与 extension.ui_request 实时推送同构），pendingRequests 缓存时嵌套在 .payload
    return requests.map(r => ({ ...r, ...r.payload }))
  }

  /**
   * 获取指定 session 的所有 pending 请求（非破坏性只读快照）。
   *
   * 用于方案2 的 session 级状态快照模型：pending UI 请求是 session 固有状态，
   * 多次拉取都返回完整列表（与 session.commands 快照语义同构）。
   * 移除时机由 removePendingRequest（respond 后）或 clearForSession（session 销毁）控制，
   * 不由拉取动作控制。
   */
  getPendingRequests(sessionId: string): PendingUIRequest[] {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests = Array.from(sessionCache.values())
    return requests.map(r => ({ ...r, ...r.payload }))
  }
}
