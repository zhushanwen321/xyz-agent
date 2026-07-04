/**
 * UI 请求串行队列（UiRequestQueue）
 *
 * 从 PluginService 抽出的独立状态机（约 80 行）。负责把插件发起的 UI 弹窗请求
 * （confirm / select / input）串行派发给前端，并在前端响应或 60s 超时后 resolve。
 *
 * 行为契约（与原 PluginService 完全一致）：
 * - 同时只允许一个弹窗活跃（activeUiRequest），后续请求进 uiRequestQueue 排队。
 * - 活跃请求收到响应（handleUiResponse）或 60s 超时后，自动派发队列中下一个请求。
 * - confirm 超时默认值 false；其它 method 超时默认值 undefined。
 * - 通过注入的 broadcast 回调把请求推给前端。
 *
 * 依赖：仅依赖一个 broadcast 回调（type + payload），不耦合 broker / broadcastFn 细节。
 */

import { randomSuffix } from '../../utils/ids.js'

/** UI 请求超时（ms） */
const UI_REQUEST_TIMEOUT_MS = 60_000

/** 排队中的请求条目 */
interface QueuedRequest {
  params: Record<string, unknown>
  resolve: (v: unknown) => void
}

/** 等待前端响应的活跃请求 */
interface PendingRequest {
  resolve: (v: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** 广播回调：把 UI 请求推给前端（type 固定为 'plugin:uiRequest'） */
export type UiBroadcastFn = (type: 'plugin:uiRequest', payload: Record<string, unknown>) => void

export class UiRequestQueue {
  /** 当前活跃的 UI 请求 ID（串行排队，同一时刻仅一个） */
  activeUiRequest: string | null = null

  /** 等待中的 UI 请求队列 */
  uiRequestQueue: Array<QueuedRequest> = []

  /** 等待前端响应的 UI 请求 */
  pendingUiRequests = new Map<string, PendingRequest>()

  private readonly broadcast: UiBroadcastFn

  constructor(broadcast: UiBroadcastFn) {
    this.broadcast = broadcast
  }

  /**
   * 处理 UI 弹窗请求（串行排队）。
   * 同时只允许一个弹窗显示在前端，后续请求排队等待。
   * 超时 60s 自动 resolve 为默认值。
   */
  async handleRequest(method: string, params: Record<string, unknown>, pluginId: string): Promise<unknown> {
    const requestId = `${pluginId}_${Date.now()}_${randomSuffix()}`
    return new Promise<unknown>((resolve) => {
      if (this.activeUiRequest !== null) {
        this.uiRequestQueue.push({ params: { ...params, requestId, method, pluginId }, resolve })
        return
      }
      this.activeUiRequest = requestId
      this.dispatch(requestId, method, params, pluginId, resolve)
    })
  }

  /** 处理前端返回的 UI 响应（供 server.ts / plugin-message-handler 调用） */
  handleResponse(requestId: string, result: unknown): void {
    const pending = this.pendingUiRequests.get(requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingUiRequests.delete(requestId)
    pending.resolve(result)
    this.processNext()
  }

  /** 发送 UI 请求到前端，设置超时计时器 */
  private dispatch(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
    pluginId: string,
    resolve: (v: unknown) => void,
  ): void {
    // 超时默认值：confirm 失败语义为 false，其它为 undefined
    const defaultResult = method === 'confirm' ? false : undefined

    const timer = setTimeout(() => {
      this.pendingUiRequests.delete(requestId)
      this.processNext()
      resolve(defaultResult)
    }, UI_REQUEST_TIMEOUT_MS)

    this.pendingUiRequests.set(requestId, { resolve, timer })

    // 广播给前端
    const broadcastPayload = {
      requestId,
      pluginId,
      method,
      ...params,
    }
    this.broadcast('plugin:uiRequest', broadcastPayload)
  }

  /** 处理队列中的下一个 UI 请求 */
  private processNext(): void {
    if (this.uiRequestQueue.length === 0) {
      this.activeUiRequest = null
      return
    }
    const next = this.uiRequestQueue.shift()!
    this.activeUiRequest = next.params.requestId as string
    this.dispatch(
      next.params.requestId as string,
      next.params.method as string,
      next.params,
      next.params.pluginId as string,
      next.resolve,
    )
  }
}
