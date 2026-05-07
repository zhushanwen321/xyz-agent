import { computed } from 'vue'
import { useChatStore } from '../stores/chat'

export function useContext() {
  const store = useChatStore()

  const CONTEXT_WARN_THRESHOLD = 80
  const CONTEXT_DANGER_THRESHOLD = 60

  const barColor = computed(() => {
    const pct = store.contextUsagePercent
    if (pct > CONTEXT_WARN_THRESHOLD) return 'var(--color-danger)'
    if (pct > CONTEXT_DANGER_THRESHOLD) return 'var(--color-warning)'
    return 'var(--color-accent)'
  })

  return { percent: store.contextUsagePercent, barColor }
}
