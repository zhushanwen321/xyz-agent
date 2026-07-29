/**
 * Extension UI request manager.
 * Handles registration, clearing, and session-scoped cleanup of extension UI requests.
 *
 * Extension UI requests block indefinitely waiting for user response.
 * Interactive methods (confirm/select/input/editor/ask-user) no longer set a timer;
 * only session tracking is retained so clearForSession can clean up on session end.
 *
 * [2026-07-16] 新增 pending request 缓存：缓存 pending 的 ask-user 请求内容，
 * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求，
 * 解决「切换 session 后 ask-user 请求丢失」问题。
 *
 * [2026-07-28] 清理死代码：registerTimeout 改为同步 `void onTimeout` 不排定时器后，
 * extensionTimeouts Map / timedOutIds Set / markTimedOut / isTimedOut / clearTimedOut /
 * handleExtensionTimeout 链路（extension-message-handler + server.ts 回调闭包）均为死代码，
 * 已统一移除。clearForSession 简化为只清 pendingRequests + session 请求跟踪表。
 * onTimeout 参数保留为签名稳定占位（调用方 server.ts 不改），但永不被调用。
 */

/**
 * 缓存的 pending UI 请求（内部原始结构，未解包）。
 * 存于 pendingRequests Map，cachePendingRequest 写入、removePendingRequest/clearForSession 清理。
 */
export interface PendingUIRequest {
  requestId: string
  sessionId: string
  method: string
  payload: Record<string, unknown>
  receivedAt: number
}

/**
 * getPendingRequests 返回值类型：原始字段 + payload 解包到顶层（`{ ...r, ...r.payload }`）。
 * payload 字段不固定（ask/confirm/select 各自不同），故解包部分用索引签名收纳——
 * 消费方（renderer 经类型守卫收窄为 ExtensionUIRequest）按 method 取具体字段。
 */
export type PendingUIRequestResolved = PendingUIRequest & Record<string, unknown>

export class ExtensionTimeoutManager {
  private extensionSessionRequests = new Map<string, Set<string>>()
  private bridgeRequestIds = new Set<string>()
  /** 缓存 pending 的 UI 请求（per-session），用于 session 重新激活时推送 */
  private pendingRequests = new Map<string, Map<string, PendingUIRequest>>()

  /** Check if a requestId is a bridge request */
  isBridgeRequest(requestId: string): boolean {
    return this.bridgeRequestIds.has(requestId)
  }

  /** Remove a bridge request ID from tracking */
  removeBridgeRequest(requestId: string): void {
    this.bridgeRequestIds.delete(requestId)
  }

  /**
   * Register a session-scoped tracking entry for an extension UI request.
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

  /**
   * Clear the session-scoped tracking entry for a specific requestId.
   * 历史上还清过 setTimeout 定时器，但定时器已不再创建（registerTimeout 不排 timer），
   * 故此处只清 session 请求跟踪表 + bridge 标记。
   */
  clearTimeout(requestId: string): void {
    for (const [sid, reqs] of this.extensionSessionRequests) {
      if (reqs.delete(requestId)) {
        if (reqs.size === 0) this.extensionSessionRequests.delete(sid)
        break
      }
    }
  }

  /** Clear all pending requests + session tracking for a session */
  clearForSession(sessionId: string): void {
    // 清除缓存的 pending 请求（必须在 extensionSessionRequests 早退之前执行，
    // 否则只 cachePendingRequest 而未 registerTimeout 的 session 会漏清 pending 缓存）
    this.pendingRequests.delete(sessionId)
    const requestIds = this.extensionSessionRequests.get(sessionId)
    if (!requestIds) return
    for (const reqId of requestIds) {
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
   * 获取指定 session 的所有 pending 请求（非破坏性只读快照）。
   *
   * 用于方案2 的 session 级状态快照模型：pending UI 请求是 session 固有状态，
   * 多次拉取都返回完整列表（与 session.commands 快照语义同构）。
   * 移除时机由 removePendingRequest（respond 后）或 clearForSession（session 销毁）控制，
   * 不由拉取动作控制。
   */
  getPendingRequests(sessionId: string): PendingUIRequestResolved[] {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests = Array.from(sessionCache.values())
    return requests.map(r => ({ ...r, ...r.payload }))
  }

  /**
   * 聚合所有 session 的 pending UI 请求（跨 session 全局快照，非破坏只读）。
   *
   * 用于 sendInitialState 第 14 段（P3 D3）：新连接 auth 后随 initial state 点对点推送，
   * 让冷启动/长断线/页面 reload 的客户端恢复审批挂起状态（短断线由 P2 ring buffer 回放覆盖）。
   *
   * 遍历 pendingRequests Map 各子 Map 收集条目，返回原始 PendingUIRequest 结构（requestId/
   * sessionId/method/payload/receivedAt，不解包——跨 session 聚合后前端按 sessionId 分流填入
   * 对应 store 分区，解包形态 PendingUIRequestResolved 会拍平 payload 与现有 onUIRequest 的
   * ExtensionUIRequest 形状不一致）。
   *
   * 异常容忍（ES1）：单条 try/catch 跳过结构异常条目（如并发 race 塞入 undefined），不中断聚合。
   * 返回顺序依赖 Map 插入序（ES2015+ 规范保证），同一状态多次调用结果序一致。
   */
  getAllPendingRequests(): PendingUIRequest[] {
    const all: PendingUIRequest[] = []
    for (const sessionCache of this.pendingRequests.values()) {
      for (const req of sessionCache.values()) {
        try {
          // 防御：并发 race 可能使 req 为 undefined 或缺字段。异常条目跳过不中断聚合。
          if (!req || typeof req.requestId !== 'string') continue
          all.push(req)
        // eslint-disable-next-line taste/no-silent-catch -- 聚合是 best-effort 快照，单条异常不能丢弃其余条目
        } catch {
          continue
        }
      }
    }
    return all
  }
}
