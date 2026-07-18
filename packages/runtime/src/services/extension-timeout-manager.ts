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
    // 清除缓存的 pending 请求
    this.pendingRequests.delete(sessionId)
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
   * 获取指定 session 的所有 pending 请求（不清除缓存，用于查询）。
   */
  getPendingRequests(sessionId: string): PendingUIRequest[] {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests = Array.from(sessionCache.values())
    return requests.map(r => ({ ...r, ...r.payload }))
  }
}
