import { computed } from 'vue'
import type { ChatMessage } from '../stores/chat'

export interface TurnGroup {
  /** Unique key for v-for */
  key: string
  /** Messages belonging to this turn */
  messages: ChatMessage[]
}

/**
 * 将扁平消息列表按 Turn 分组。
 * 分组规则：
 *   - 每个 user 消息开始一个新 Turn
 *   - 后续连续的 assistant / system 消息归入同一个 Turn
 *   - system-only 消息（无前置 user）归入前一个 Turn，或作为独立 Turn
 */
export function useTurnGroups(messages: () => ChatMessage[]) {
  const turnGroups = computed<TurnGroup[]>(() => {
    const msgs = messages()
    if (msgs.length === 0) return []

    const groups: TurnGroup[] = []
    let current: ChatMessage[] = []

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]

      // user 消息开始一个新 Turn
      if (msg.role === 'user') {
        if (current.length > 0) {
          groups.push({ key: current[0].id, messages: current })
        }
        current = [msg]
        continue
      }

      // assistant / system 消息追加到当前 Turn
      current.push(msg)
    }

    // 最后一组
    if (current.length > 0) {
      groups.push({ key: current[0].id, messages: current })
    }

    return groups
  })

  return { turnGroups }
}
