/**
 * Extension UI request timeout manager.
 * Handles registration, clearing, and session-scoped cleanup of extension timeouts.
 */

const EXTENSION_UI_REQUEST_TIMEOUT_MS = 300_000 // 5min — UI interactions (select/confirm) need user manual action

export class ExtensionTimeoutManager {
  private extensionTimeouts = new Map<string, NodeJS.Timeout>()
  private extensionSessionRequests = new Map<string, Set<string>>()
  private bridgeRequestIds = new Set<string>()

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
