import { computed } from 'vue'
import { useChatStore } from '../stores/chat'

export function useContext(sessionId: string) {
  const store = useChatStore()

  const CONTEXT_WARN_THRESHOLD = 80
  const CONTEXT_DANGER_THRESHOLD = 60

  const session = store.getSessionState(sessionId)
  const barColor = computed(() => {
    const pct = session.contextUsagePercent
    if (pct > CONTEXT_WARN_THRESHOLD) return 'var(--danger)'
    if (pct > CONTEXT_DANGER_THRESHOLD) return 'var(--warning)'
    return 'var(--accent)'
  })

  return { percent: session.contextUsagePercent, barColor }
}
