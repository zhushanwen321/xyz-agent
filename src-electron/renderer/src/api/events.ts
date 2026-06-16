import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

type Handler = (msg: ServerMessage) => void

/**
 * 事件订阅层：ServerMessage 的订阅入口 + session 路由第 2 层（D6b）+ 重连收尾信号（G5）。
 * 不依赖 pending、不碰 store——编排由 index.ts 负责（先 pending 后 events），
 * store 收尾由 features 层（useChat）订阅 onConnectionRestored 实现。
 */
export interface EventApi {
  /**
   * 订阅某类 ServerMessage，返回取消函数。
   * 与 lib/event-bus.on 接口兼容（供 SA6 迁移 useChat 直接替换 `event-bus.on`）。
   */
  on(type: ServerMessageType, handler: Handler): () => void
  /** SA6 的 useChat 订阅：重连后遍历 isGenerating session 收尾。events 只 emit 信号不碰 store。 */
  onConnectionRestored(handler: () => void): () => void
  /** 内部：transport 收到非命令消息的唯一入口——D6b 丢弃检查 + emit。 */
  _dispatch(msg: ServerMessage): void
  /** 内部：SA6 的 useConnection 重连成功时调，触发 connectionRestored 订阅者。 */
  _notifyConnectionRestored(): void
}

export function createEvents(): EventApi {
  const handlers = new Map<ServerMessageType, Set<Handler>>()
  const connectionHandlers = new Set<() => void>()

  const emit = (type: ServerMessageType, msg: ServerMessage): void => {
    // try/catch 每个 handler：一个挂不能影响其他（event-bus 同款语义）
    handlers.get(type)?.forEach((h) => {
      try {
        h(msg)
      // eslint-disable-next-line taste/no-silent-catch -- intentional: one handler must not break all others
      } catch (e) {
        console.error(`[api] handler error for event "${type}":`, e)
      }
    })
  }

  return {
    on(type, handler) {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => {
        set?.delete(handler)
      }
    },

    onConnectionRestored(handler) {
      connectionHandlers.add(handler)
      return () => {
        connectionHandlers.delete(handler)
      }
    },

    _dispatch(msg) {
      const { payload } = msg
      // D6b: session-scoped 消息若 sessionId 缺失（payload 声明了该字段但值为空）→ 丢弃 + warn。
      // payload 根本无 sessionId 字段的消息（config.providers / model.list / pong / file.read:result 等）
      // 不算 session-scoped，正常 emit。
      if (
        payload &&
        'sessionId' in payload &&
        (payload.sessionId === undefined || payload.sessionId === null || payload.sessionId === '')
      ) {
        console.warn('[api] 丢弃无 sessionId 消息:', msg.type)
        return
      }
      emit(msg.type, msg)
    },

    _notifyConnectionRestored() {
      connectionHandlers.forEach((h) => {
        try {
          h()
        // eslint-disable-next-line taste/no-silent-catch -- intentional: one handler must not break all others
        } catch (e) {
          console.error('[api] onConnectionRestored handler error:', e)
        }
      })
    },
  }
}
