/**
 * Events 层 —— ServerMessage 订阅分发（sessionId 路由第 2 层）。
 *
 * 依赖方向：transport（接收原始 ServerMessage）→ events（按 sessionId 分发）。
 *
 * 注：从 transport.on 原始消息中提取 sessionId 并调用 dispatch 的串联由 features 层负责
 * （transport 给原始 msg，events.dispatch 需要显式 sessionId，桥接在 features 完成）。
 */
import type { ServerMessage } from '@xyz-agent/shared'

type MessageHandler = (msg: ServerMessage) => void

const handlers = new Map<string, Set<MessageHandler>>()

/** 按 sessionId 订阅 ServerMessage，返回取消函数 */
export function on(sessionId: string, handler: MessageHandler): () => void {
  let set = handlers.get(sessionId)
  if (!set) {
    set = new Set()
    handlers.set(sessionId, set)
  }
  set.add(handler)
  return () => off(sessionId, handler)
}

/** 取消订阅（按 sessionId + handler） */
export function off(sessionId: string, handler: MessageHandler): void {
  handlers.get(sessionId)?.delete(handler)
}

/** 按 sessionId 派发 ServerMessage 给已注册 handler */
export function dispatch(sessionId: string, msg: ServerMessage): void {
  handlers.get(sessionId)?.forEach((h) => h(msg))
}
