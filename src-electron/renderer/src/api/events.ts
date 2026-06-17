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
   *
   * 注意：on 不做 refCount 去重——供全局单例流（useChat 模块级注册一次）使用。
   * 组件多实例场景（split mode 下多个 PanelSessionView 并存）请用 onOwned。
   */
  on(type: ServerMessageType, handler: Handler): () => void
  /**
   * G6 refCount 订阅：同一 (type, ownerKey) 组下，二次注册复用首次的订阅，
   * refCount 归零才真正移除。供组件多实例去重（CLAUDE.md #2）。
   *
   * 用 ownerKey（稳定字符串，如组件名）标识「同一逻辑订阅源」。
   * split mode 下 N 个组件实例各自调 onOwned(type, handler, 'PanelSessionView')：
   * 仅首个真正订阅（set.add），其余 count++ 共享；emit 时 handler 只被调 1 次，
   * 避免「事件处理翻倍」。handler 内再按 props.sessionId 过滤处理各自消息。
   */
  onOwned(type: ServerMessageType, handler: Handler, ownerKey: string): () => void
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
  // G6 refCount：key = `${type}::${ownerKey}`，值记录共享订阅的 handler + 计数。
  // 同 ownerKey 二次 onOwned 不重复 set.add，只 count++。
  // 记录 handler 是为了 refCount 归零时从对应 Set 删除首个订阅留下的那一份。
  const ownedHandlers = new Map<string, { count: number; type: ServerMessageType; handler: Handler }>()

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

  /** refCount 归零才真正从 handlers Set 删除 + 清 ownedHandlers 条目。 */
  const releaseOwned = (key: string): void => {
    const entry = ownedHandlers.get(key)
    if (!entry) return
    entry.count--
    if (entry.count > 0) return
    // 归零：真正移除首个订阅留下的 handler。
    ownedHandlers.delete(key)
    const set = handlers.get(entry.type)
    if (set) {
      set.delete(entry.handler)
      if (set.size === 0) handlers.delete(entry.type)
    }
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

    onOwned(type, handler, ownerKey) {
      const key = `${type}::${ownerKey}`
      const existing = ownedHandlers.get(key)
      if (existing) {
        // 同 (type, ownerKey) 已订阅：count++，返回稳定的 off 闭包（不再 add）。
        // emit 时该 handler 在 Set 中只有 1 份 → 只调 1 次，避免多实例翻倍。
        existing.count++
        return () => releaseOwned(key)
      }
      // 首次：真正订阅。
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      ownedHandlers.set(key, { count: 1, type, handler })
      return () => releaseOwned(key)
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
