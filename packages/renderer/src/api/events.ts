/**
 * Events 层 —— ServerMessage 订阅分发。
 *
 * 三条独立通道：
 * - session 通道（on/off/dispatch/dispatchSession）：按 sessionId 路由。CLAUDE.md line 98
 *   要求 session 级消息必须含 sessionId。隔离规则不变。
 * - global 通道（onGlobal/onGlobalType/dispatchGlobal）：无 sessionId 的 server-push
 *   （config.providers / model.list / config.skills / config.agents / config.plugins /
 *   config.extensions / config.defaults）。sendInitialState 推 7 条 + 运行时广播。
 * - crossSession 通道（onCrossSession/dispatchCrossSession）：带 sessionId 但需同时分发到
 *   全局单例消费者的消息（ADR-0060）。合法消费者仅 ExtensionHost（+ 未来远程化协同态），
 *   per-session 消费用 on(sid, handler)，不要用本通道。
 *
 * 三通道互不串扰。routeInbound（useConnection）按 payload.sessionId 有无 + type 白名单
 * 决定走哪条（有 sid → session 通道；有 sid 且 type ∈ CROSS_SESSION_TYPES → 额外 crossSession；
 * 无 sid → global 通道）。
 */
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

type MessageHandler = (msg: ServerMessage) => void

/**
 * 安全遍历 handler 集合（M4：单 handler 抛错不中断同通道剩余订阅者）。
 *
 * sidebar 有 6+ 组件实例化 useSidebar，一个坏 handler 会让整条 session.list 广播中断。
 * 每个 handler 调用包 try-catch，抛错时 console.error 记录后继续遍历。
 */
function safeForEach(set: Set<MessageHandler>, msg: ServerMessage): void {
  for (const h of set) {
    try {
      h(msg)
    // eslint-disable-next-line taste/no-silent-catch -- 事件分发器隔离：单 handler 抛错不中断同通道其余订阅者（M4），console.error 记录后继续遍历
    } catch (e) {
      console.error('[events] handler threw, continuing dispatch:', e)
    }
  }
}

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
  const set = sessionHandlers.get(sessionId)
  if (set) safeForEach(set, msg)
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
  safeForEach(globalAllHandlers, msg)
  const typeSet = globalTypeHandlers.get(msg.type)
  if (typeSet) safeForEach(typeSet, msg)
}

// ── crossSession 通道（带 sid 消息的全局消费者订阅，ADR-0060）──
// 语义：允许全局单例消费者（ExtensionHost）接收带 sessionId 的消息——routeInbound 用
// payload.sessionId 路由，有 sid 的下行（extension:widget/notify 等）走 dispatchSession 不
// 触发 onGlobal，全局消费者经本通道才能收到。**这不是广播**：合法消费者仅 ExtensionHost
// （+ 未来远程化协同态 busy/idle/presence），per-session 消费用 on(sid, handler)。
const crossSessionHandlers = new Set<MessageHandler>()

/** 订阅 crossSession 通道（全局消费者接收带 sid 消息），返回取消函数。ADR-0060。 */
export function onCrossSession(handler: MessageHandler): () => void {
  crossSessionHandlers.add(handler)
  return () => {
    crossSessionHandlers.delete(handler)
  }
}

/** 分发消息到 crossSession 通道（route-inbound FALLBACK 有 sid 分支调用）。ADR-0060。 */
export function dispatchCrossSession(msg: ServerMessage): void {
  if (crossSessionHandlers.size > 0) safeForEach(crossSessionHandlers, msg)
}
