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
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

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

/**
 * 订阅指定 type 的全局 ServerMessage，返回取消函数。
 *
 * 泛型化：传入精确 type（如 'config.providers'）时，handler 内 msg 自动收窄为
 * ServerMessage<'config.providers'>，msg.payload 即 `{ providers: ProviderInfo[] }`，
 * 无需 `as` 断言。存储层仍是宽 MessageHandler（类型擦除），运行时按 type 路由。
 */
export function onGlobalType<T extends ServerMessageType>(
  type: T,
  handler: (msg: ServerMessage<T>) => void,
): () => void {
  // 存储层类型擦除：Set 只存「能处理任意 ServerMessage 的函数」，TS 不允许 (msg: Specific)→void
  // 直接赋给 (msg: Wide)→void，故用 as 做受控擦除。运行时 dispatchGlobal 只会喂同 type 的 msg。
  const erased = handler as MessageHandler
  let set = globalTypeHandlers.get(type)
  if (!set) {
    set = new Set()
    globalTypeHandlers.set(type, set)
  }
  set.add(erased)
  return () => {
    globalTypeHandlers.get(type)?.delete(erased)
  }
}

export function dispatchGlobal(msg: ServerMessage): void {
  globalAllHandlers.forEach((h) => h(msg))
  globalTypeHandlers.get(msg.type)?.forEach((h) => h(msg))
}
