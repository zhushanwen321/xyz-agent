import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

/** 命令在超时窗口内未收到响应。 */
export class ApiTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiTimeoutError'
  }
}

/** 连接断开或 session 清理导致的命令失败。 */
export class ApiDisconnectError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ApiDisconnectError'
  }
}

const COMMAND_TIMEOUT_MS = 30_000

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  sessionId?: string
}

export interface PendingApi {
  /** 塞 id、发送、入表、挂 30s 超时，返回 Promise（payload 类型 T 由调用方断言）。 */
  command<T>(msg: ClientMessage): Promise<T>
  /** 路由核心：匹配到 pending id 的命令响应则结算并返回 true，否则返回 false（交由上层 emit 为事件）。 */
  handleMessage(msg: ServerMessage): boolean
  /** 断连善后（G4）：清空全部 pending。 */
  rejectAll(reason: Error): void
  /** G5 重连按 session 清理：仅清 sessionId 匹配的 pending。 */
  clearBySessionId(sessionId: string): void
  readonly size: number
}

export interface PendingDeps {
  send: (msg: ClientMessage) => void
}

export function createPending(deps: PendingDeps): PendingApi {
  const pending = new Map<string, PendingEntry>()

  const remove = (id: string): void => {
    const entry = pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(id)
  }

  return {
    command<T>(msg: ClientMessage): Promise<T> {
      const id = crypto.randomUUID()
      const payload = msg.payload as Record<string, unknown> | undefined
      const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      const withId: ClientMessage = { ...msg, id } as ClientMessage
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new ApiTimeoutError(`Command "${msg.type}" timed out after ${COMMAND_TIMEOUT_MS}ms`))
          }
        }, COMMAND_TIMEOUT_MS)
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
          sessionId,
        })
        deps.send(withId)
      })
    },

    handleMessage(msg: ServerMessage): boolean {
      const { id } = msg
      if (!id) return false
      const entry = pending.get(id)
      if (!entry) return false
      if (msg.type === 'error') {
        entry.reject(new Error(String(msg.payload?.error ?? 'Unknown error')))
      } else {
        entry.resolve(msg.payload)
      }
      remove(id)
      return true
    },

    rejectAll(reason: Error): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(reason)
      }
      pending.clear()
    },

    clearBySessionId(sessionId: string): void {
      for (const [id, entry] of pending) {
        if (entry.sessionId === sessionId) {
          clearTimeout(entry.timer)
          entry.reject(new ApiDisconnectError(`Session ${sessionId} pending cleared`))
          pending.delete(id)
        }
      }
    },

    get size(): number {
      return pending.size
    },
  }
}
