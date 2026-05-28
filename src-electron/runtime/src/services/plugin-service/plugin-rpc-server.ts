/**
 * 主线程侧 JSON-RPC 2.0 服务端
 *
 * 接收来自 Worker 的 RPC 请求，分发到注册的 handler，
 * 并支持向特定 Worker 发送通知或广播通知。
 */

import type { RpcRequest, RpcResponse, RpcNotification } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'

export type RpcMethodHandler = (params: Record<string, unknown>) => Promise<unknown>

/** 权限检查函数签名 — 返回 true 表示放行，false 表示拒绝 */
export type PermissionCheckFn = (pluginId: string, method: string) => boolean

/** Worker 通信端口的抽象（MessagePort / parentPort 均可适配） */
export interface WorkerPort {
  postMessage(message: unknown): void
}

/** Pending outgoing invoke entry */
interface PendingInvoke {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class PluginRpcServer {
  private methods = new Map<string, RpcMethodHandler>()
  private workers = new Map<string, WorkerPort>()
  private permissionCheck: PermissionCheckFn | null = null
  private nextRequestId = 1
  private pendingInvokes = new Map<number, PendingInvoke>()

  /** 设置权限检查钩子，dispatch 前调用 */
  setPermissionChecker(checker: PermissionCheckFn): void {
    this.permissionCheck = checker
  }

  registerMethod(method: string, handler: RpcMethodHandler): void {
    this.methods.set(method, handler)
  }

  unregisterMethod(method: string): void {
    this.methods.delete(method)
  }

  registerWorker(workerId: string, port: WorkerPort): void {
    this.workers.set(workerId, port)
  }

  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId)
  }

  /** 向指定 Worker 发送通知（无 id，不期望响应） */
  notify(workerId: string, method: string, params: Record<string, unknown>): void {
    const worker = this.workers.get(workerId)
    if (!worker) return
    const notification: RpcNotification = { jsonrpc: '2.0', method, params }
    worker.postMessage({ type: 'rpc', notification })
  }

  /** 向所有已注册 Worker 广播通知 */
  broadcast(method: string, params: Record<string, unknown>): void {
    for (const worker of this.workers.values()) {
      const notification: RpcNotification = { jsonrpc: '2.0', method, params }
      worker.postMessage({ type: 'rpc', notification })
    }
  }

  /**
   * 发起 RPC 请求到指定 Worker，等待响应。
   *
   * 用于主线程主动调用 Worker 的方法（如 plugin.tool.execute）。
   * 创建 pending entry，发送请求到 Worker port，等待 handleResponse 匹配。
   *
   * @param workerId - 目标 Worker ID
   * @param method - RPC 方法名
   * @param params - 请求参数
   * @param timeoutMs - 超时时间（毫秒）
   */
  invoke(workerId: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const worker = this.workers.get(workerId)
    if (!worker) {
      return Promise.reject(new Error(`Worker not found: ${workerId}`))
    }

    const id = this.nextRequestId++

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(id)
        reject(new Error('RPC timeout'))
      }, timeoutMs)

      this.pendingInvokes.set(id, { resolve, reject, timer })

      const request: RpcRequest = { jsonrpc: '2.0', id, method, params }
      worker.postMessage({ type: 'rpc', request })
    })
  }

  /**
   * 处理来自 Worker 的 RPC 响应（对应 invoke 发出的请求）。
   *
   * 当 PluginHost 收到 type: 'rpc' 消息且包含 id + (result | error) 时调用。
   * 如果 id 匹配 pendingInvokes，resolve/reject 对应的 Promise。
   * 如果不匹配（属于 Worker 主动发起的请求），返回 false。
   */
  handleResponse(response: import('./plugin-types.js').RpcResponse): boolean {
    const pending = this.pendingInvokes.get(response.id)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pendingInvokes.delete(response.id)

    if ('error' in response) {
      pending.reject(new Error(response.error.message))
    } else {
      pending.resolve(response.result)
    }
    return true
  }

  /**
   * 处理来自 Worker 的 RPC 请求，调用对应 handler 并回复结果。
   *
   * 调用方（PluginHost）从 WorkerToHostMessage 中提取 RpcRequest 后传入。
   */
  async dispatch(workerId: string, message: RpcRequest): Promise<void> {
    const worker = this.workers.get(workerId)
    if (!worker) return

    const handler = this.methods.get(message.method)
    if (!handler) {
      worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, PluginRpcErrorCodes.METHOD_NOT_FOUND, `Method not found: ${message.method}`) })
      return
    }

    // 权限检查
    if (this.permissionCheck) {
      const pluginId = (message.params?.pluginId as string) || 'unknown'
      if (!this.permissionCheck(pluginId, message.method)) {
        worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, PluginRpcErrorCodes.PERMISSION_DENIED, `PERMISSION_DENIED: ${message.method}`) })
        return
      }
    }

    try {
      const result = await handler(message.params)
      worker.postMessage({ type: 'rpc', response: this.makeSuccessResponse(message.id, result) })
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: number })?.code ?? PluginRpcErrorCodes.INTERNAL_ERROR
      worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, code, errorMessage) })
    }
  }

  dispose(): void {
    // Reject all pending invokes
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer)
      pending.reject(new Error('RPC server disposed'))
    }
    this.pendingInvokes.clear()
    this.methods.clear()
    this.workers.clear()
  }

  private makeSuccessResponse(id: number, result: unknown): RpcResponse {
    return { jsonrpc: '2.0', id, result }
  }

  private makeErrorResponse(id: number, code: number, message: string, data?: unknown): RpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } }
  }
}
