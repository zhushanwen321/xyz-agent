import { computed } from 'vue'
import { useChatStore } from '../stores/chat'

export function useContext() {
  const store = useChatStore()

  const barColor = computed(() => {
    const pct = store.contextUsagePercent
    if (pct > 80) return 'var(--color-danger)'
    if (pct > 60) return 'var(--color-warning)'
    return 'var(--color-accent)'
  })

  return { percent: store.contextUsagePercent, barColor }
}
