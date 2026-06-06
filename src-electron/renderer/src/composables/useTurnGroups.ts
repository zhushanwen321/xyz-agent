import { computed } from 'vue'
import { groupIntoTurns } from '../lib/message-layout'
import type { ChatMessage } from '../stores/chat'

/**
 * Reactive wrapper: flat messages → turn groups.
 * Delegates to lib/message-layout.ts groupIntoTurns().
 */
export function useTurnGroups(messages: () => ChatMessage[]) {
  const turnGroups = computed(() => groupIntoTurns(messages()))

  return { turnGroups }
}
