/**
 * Events 层 —— ServerMessage 订阅分发（sessionId 路由第 2 层）。
 *
 * 依赖方向：transport（接收原始 ServerMessage）→ events（按 sessionId 分发）。
 * 骨架阶段：签名完整，体 throw。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/** 按 sessionId 订阅 ServerMessage，返回取消函数 */
export function on(sessionId: string, handler: (msg: ServerMessage) => void): () => void {
  throw new Error(`not implemented: on(${sessionId}, ${typeof handler})`)
}

/** 取消订阅（按 sessionId + handler） */
export function off(sessionId: string, handler: (msg: ServerMessage) => void): void {
  throw new Error(`not implemented: off(${sessionId}, ${typeof handler})`)
}

/** 按 sessionId 派发 ServerMessage 给已注册 handler */
export function dispatch(sessionId: string, msg: ServerMessage): void {
  throw new Error(`not implemented: dispatch(${sessionId}, ${msg.type})`)
}
