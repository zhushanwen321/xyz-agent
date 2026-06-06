import { computed } from 'vue'
import { groupIntoTurns } from '../lib/message-layout'
import type { ChatMessage } from '../stores/chat'

export interface TurnGroup {
  /** Unique key for v-for */
  key: string
  /** Messages belonging to this turn */
  messages: ChatMessage[]
}

/**
 * Reactive wrapper: flat messages → turn groups.
 * Delegates to lib/message-layout.ts groupIntoTurns().
 */
export function useTurnGroups(messages: () => ChatMessage[]) {
  const turnGroups = computed(() => groupIntoTurns(messages()))

  return { turnGroups }
}
