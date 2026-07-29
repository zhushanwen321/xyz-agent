/**
 * Worker 侧 JSON-RPC 2.0 客户端
 *
 * Worker 通过 parentPort 发送 RpcRequest 到主线程，
 * 主线程的 PluginHost 接收后转发给 PluginRpcServer.dispatch()，
 * 响应通过 HostToWorkerMessage.rpc.response 回传，由本 client 处理。
 *
 * P7 长期方案 A：Worker 持有「当前执行上下文 clientId」（plugin-bootstrap 在
 * plugin.tool.execute 入口设置）。request() 自动把它注入到每个 RPC 请求 params，
 * 主线程 handler 据此 per-client resolve，绕开 ALS 跨独立 I/O tick 断裂。
 */

import type { RpcResponse, RpcNotification, RpcRequest } from './plugin-types.js'
import { PluginRpcErrorCodes, CLIENT_ID_PARAM_KEY } from './plugin-types.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'
import { errorWithCode } from '../../utils/errors.js'
import { getOrCreate } from '../../utils/collections.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Worker 通信端口的抽象（MessagePort / parentPort 均可适配） */
export interface ClientPort {
  postMessage(message: unknown): void
}

export class PluginRpcClient {
  private nextId = 1
  // D15/D25: 请求/回复登记表收编为 PendingTracker（超时 reject 带 .code）。
  private pending = new PendingTracker<number, unknown>()
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private port: ClientPort | null = null
  /**
   * 当前执行上下文的 clientId（P7 长期方案 A）。
   *
   * plugin-bootstrap 在 plugin.tool.execute 入口设为 invoke params 带来的 clientId，
   * 工具执行结束复位为 undefined。request() 自动注入到 RPC params，主线程 handler
   * 据此 per-client resolve。undefined（hook/定时器/生命周期触发的 plugin 操作）→
   * 不注入，主线程走 ALS / 全局 fallback。
   *
   * 注意：Worker Thread 内 plugin 同步调用（非 await 跨 tick）在此值有效期内发起的
   * RPC 都会带上 clientId。currentClientId 是模块级单值——安全性依赖：
   * plugin.tool.execute 的唯一来源是 pi 的 bridge_request 事件，单个 pi 进程在单个
   * session 的工具执行循环中串行调用（一个工具完成才下一个）。因此同一 Worker 上
   * 同一 plugin 的 tool.execute 不会真正并发，模块级单值在此正常路径安全（无需 ALS）。
   *
   * 理论残留风险（不改逻辑，仅诚实标注）：trusted Worker 可承载多插件
   *（MAX_PLUGINS_PER_TRUSTED_WORKER=10），plugin-bootstrap 的 parentPort
   * message 处理是 fire-and-forget（无队列/single-flight）。若不同 session 的 pi 共享
   * 同一 trusted Worker 且同插件并发触发 tool execute，极罕见的跨 session 并发可能
   * 串台（prevClientId save/restore 仅对嵌套安全，对真并发不安全）。正常单 session
   * 路径概率极低故不处理；如需严格保证可加 single-flight 队列。
   */
  private currentClientId: string | undefined

  /** 绑定通信端口（Worker 中通常为 parentPort） */
  attach(port: ClientPort): void {
    this.port = port
  }

  /**
   * 设置当前执行上下文 clientId（P7 长期方案 A）。
   * plugin-bootstrap 在 plugin.tool.execute 入口调用，工具执行结束调 setCurrentClientId(undefined) 复位。
   */
  setCurrentClientId(clientId: string | undefined): void {
    this.currentClientId = clientId
  }

  /** 读取当前执行上下文 clientId（测试用）。 */
  getCurrentClientId(): string | undefined {
    return this.currentClientId
  }

  /**
   * 发送 RPC 请求并等待响应。
   *
   * P7 长期方案 A：若 currentClientId 已设置（处于 plugin.tool.execute 执行期内），
   * 自动注入到 params[CLIENT_ID_PARAM_KEY]，主线程 handler 据此 per-client resolve。
   * 调用方传入的 params 不应包含该键（保留键名，会被覆盖）。
   *
   * 消息格式为 WorkerToHostMessage 的 rpc 变体：
   * `{ type: 'rpc', jsonrpc: '2.0', id, method, params }`
   */
  request(method: string, params: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.port) {
      return Promise.reject(new Error('RPC client not attached'))
    }

    const id = this.nextId++
    const timeoutError = Object.assign(
      new Error(`RPC timeout: ${method}`),
      { code: PluginRpcErrorCodes.RPC_TIMEOUT },
    )

    // 先登记 pending（含超时 timer），再 postMessage。
    const promise = this.pending.register(id, timeoutMs, timeoutError)

    // P7 长期方案 A：注入当前执行上下文 clientId（若有）。
    const effectiveParams: Record<string, unknown> = this.currentClientId !== undefined
      ? { ...params, [CLIENT_ID_PARAM_KEY]: this.currentClientId }
      : params

    // WorkerToHostMessage: { type: 'rpc' } & RpcRequest
    const message: RpcRequest & { type: 'rpc' } = {
      type: 'rpc',
      jsonrpc: '2.0',
      id,
      method,
      params: effectiveParams,
    }
    this.port.postMessage(message)

    return promise
  }

  /** 发送通知（无 id，不期望响应） */
  notify(method: string, params: Record<string, unknown>): void {
    if (!this.port) return
    // WorkerToHostMessage: { type: 'rpc' } & RpcNotification
    const message: RpcNotification & { type: 'rpc' } = {
      type: 'rpc',
      jsonrpc: '2.0',
      method,
      params,
    }
    this.port.postMessage(message)
  }

  /**
   * 注册通知处理器，返回取消注册的函数。
   * 主线程通过 HostToWorkerMessage.rpc.notification 发送通知。
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = getOrCreate(this.notificationHandlers, method, () => new Set())
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) this.notificationHandlers.delete(method)
    }
  }

  /** 处理来自主线程的 RPC 响应（PluginHost 从 HostToWorkerMessage 中提取后调用） */
  handleResponse(response: RpcResponse): void {
    if ('error' in response) {
      // reply-error：code 来自响应，由调用方构造 error 后交给 tracker 拒绝。
      // reply-error：code 来自响应，由调用方构造 error 后交给 tracker 拒绝。
      this.pending.reject(response.id, errorWithCode(response.error.message, response.error.code))
    } else {
      this.pending.resolve(response.id, response.result)
    }
  }

  /** 处理来自主线程的 RPC 通知 */
  handleNotification(notification: RpcNotification): void {
    const handlers = this.notificationHandlers.get(notification.method)
    if (handlers) {
      for (const handler of handlers) {
        handler(notification.params)
      }
    }
  }

  dispose(): void {
    this.pending.rejectAll(new Error('RPC client disposed'))
    this.notificationHandlers.clear()
    this.port = null
  }
}
