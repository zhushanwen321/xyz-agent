/**
 * Extension UI request timeout manager.
 * Handles registration, clearing, and session-scoped cleanup of extension timeouts.
 */

const EXTENSION_UI_REQUEST_TIMEOUT_MS = 300_000 // 5min — UI interactions (select/confirm) need user manual action

export class ExtensionTimeoutManager {
  private extensionTimeouts = new Map<string, NodeJS.Timeout>()
  private extensionSessionRequests = new Map<string, Set<string>>()
  private bridgeRequestIds = new Set<string>()
  /** 已超时的 requestId 集合——防止前端 race window 内迟到的 ui_response 再发一次（双响应） */
  private timedOutIds = new Set<string>()

  readonly TIMEOUT_MS = EXTENSION_UI_REQUEST_TIMEOUT_MS

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
   */
  registerTimeout(
    sessionId: string,
    requestId: string,
    method: string,
    onTimeout: () => void,
  ): void {
    if (method === 'notify') return

    if (method.startsWith('bridge:')) {
      this.bridgeRequestIds.add(requestId)
      this.trackSessionRequest(sessionId, requestId)
      return
    }

    this.clearTimeout(requestId)

    const timer = setTimeout(() => {
      this.extensionTimeouts.delete(requestId)
      this.removeSessionRequest(sessionId, requestId)
      onTimeout()
    }, EXTENSION_UI_REQUEST_TIMEOUT_MS)

    this.extensionTimeouts.set(requestId, timer)
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
  }

  private trackSessionRequest(sessionId: string, requestId: string): void {
    let requestSet = this.extensionSessionRequests.get(sessionId)
    if (!requestSet) {
      requestSet = new Set()
      this.extensionSessionRequests.set(sessionId, requestSet)
    }
    requestSet.add(requestId)
  }

  private removeSessionRequest(sessionId: string, requestId: string): void {
    const requestSet = this.extensionSessionRequests.get(sessionId)
    if (requestSet) {
      requestSet.delete(requestId)
      if (requestSet.size === 0) this.extensionSessionRequests.delete(sessionId)
    }
  }
}
