/**
 * Worker 侧 JSON-RPC 2.0 客户端
 *
 * Worker 通过 parentPort 发送 RpcRequest 到主线程，
 * 主线程的 PluginHost 接收后转发给 PluginRpcServer.dispatch()，
 * 响应通过 HostToWorkerMessage.rpc.response 回传，由本 client 处理。
 */

import type { RpcResponse, RpcNotification, RpcRequest } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Worker 通信端口的抽象（MessagePort / parentPort 均可适配） */
export interface ClientPort {
  postMessage(message: unknown): void
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class PluginRpcClient {
  private nextId = 1
  private pending = new Map<number, PendingEntry>()
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private port: ClientPort | null = null

  /** 绑定通信端口（Worker 中通常为 parentPort） */
  attach(port: ClientPort): void {
    this.port = port
  }

  /**
   * 发送 RPC 请求并等待响应。
   *
   * 消息格式为 WorkerToHostMessage 的 rpc 变体：
   * `{ type: 'rpc', jsonrpc: '2.0', id, method, params }`
   */
  request(method: string, params: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('RPC client not attached'))
        return
      }

      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`RPC timeout: ${method}`), { code: PluginRpcErrorCodes.RPC_TIMEOUT }))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      // WorkerToHostMessage: { type: 'rpc' } & RpcRequest
      const message: RpcRequest & { type: 'rpc' } = {
        type: 'rpc',
        jsonrpc: '2.0',
        id,
        method,
        params,
      }
      this.port.postMessage(message)
    })
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
    let handlers = this.notificationHandlers.get(method)
    if (!handlers) {
      handlers = new Set()
      this.notificationHandlers.set(method, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) this.notificationHandlers.delete(method)
    }
  }

  /** 处理来自主线程的 RPC 响应（PluginHost 从 HostToWorkerMessage 中提取后调用） */
  handleResponse(response: RpcResponse): void {
    const entry = this.pending.get(response.id)
    if (!entry) return

    clearTimeout(entry.timer)
    this.pending.delete(response.id)

    if ('error' in response) {
      entry.reject(Object.assign(new Error(response.error.message), { code: response.error.code }))
    } else {
      entry.resolve(response.result)
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
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('RPC client disposed'))
    }
    this.pending.clear()
    this.notificationHandlers.clear()
    this.port = null
  }
}
