/**
 * Events 层 —— ServerMessage 订阅分发。
 *
 * 两条独立通道：
 * - session 通道（on/off/dispatch/dispatchSession）：按 sessionId 路由。CLAUDE.md line 98
 *   要求 session 级消息必须含 sessionId。隔离规则不变。
 * - global 通道（onGlobal/onGlobalType/dispatchGlobal）：无 sessionId 的 server-push
 *   （config.providers / model.list / config.skills / config.agents / config.plugins /
 *   config.extensions / config.defaults）。sendInitialState 推 7 条 + 运行时广播。
 *
 * 两通道互不串扰。routeInbound（useConnection）按 payload.sessionId 有无决定走哪条。
 */
import type { ServerMessage } from '@xyz-agent/shared'

type MessageHandler = (msg: ServerMessage) => void

// ── session 通道（按 sessionId 路由）──
const sessionHandlers = new Map<string, Set<MessageHandler>>()

/** 按 sessionId 订阅 ServerMessage，返回取消函数 */
export function on(sessionId: string, handler: MessageHandler): () => void {
  let set = sessionHandlers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionHandlers.set(sessionId, set)
  }
  set.add(handler)
  return () => off(sessionId, handler)
}

/** 取消订阅（按 sessionId + handler） */
export function off(sessionId: string, handler: MessageHandler): void {
  sessionHandlers.get(sessionId)?.delete(handler)
}

/** 旧名兼容：转发到 dispatchSession */
export function dispatch(sessionId: string, msg: ServerMessage): void {
  dispatchSession(sessionId, msg)
}

export function dispatchSession(sessionId: string, msg: ServerMessage): void {
  sessionHandlers.get(sessionId)?.forEach((h) => h(msg))
}

// ── global 通道（无 sessionId 的 server-push）──
const globalAllHandlers = new Set<MessageHandler>()
const globalTypeHandlers = new Map<string, Set<MessageHandler>>()

/** 订阅所有全局 ServerMessage（不区分 type），返回取消函数 */
export function onGlobal(handler: MessageHandler): () => void {
  globalAllHandlers.add(handler)
  return () => {
    globalAllHandlers.delete(handler)
  }
}

/** 订阅指定 type 的全局 ServerMessage，返回取消函数 */
export function onGlobalType(type: string, handler: MessageHandler): () => void {
  let set = globalTypeHandlers.get(type)
  if (!set) {
    set = new Set()
    globalTypeHandlers.set(type, set)
  }
  set.add(handler)
  return () => {
    globalTypeHandlers.get(type)?.delete(handler)
  }
}

export function dispatchGlobal(msg: ServerMessage): void {
  globalAllHandlers.forEach((h) => h(msg))
  globalTypeHandlers.get(msg.type)?.forEach((h) => h(msg))
}
