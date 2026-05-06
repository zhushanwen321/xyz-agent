import { ref, shallowRef, readonly } from 'vue'

export function useRafBatch<T>() {
  const buffer = shallowRef<T[]>([])
  const latest = shallowRef<T | null>(null)
  const pending = ref(false)
  let rafId: number | null = null

  function add(item: T) {
    buffer.value = [...buffer.value, item]
    if (!pending.value) {
      pending.value = true
      rafId = requestAnimationFrame(flush)
    }
  }

  function flush() {
    const items = buffer.value
    buffer.value = []
    pending.value = false
    rafId = null
    // Process the last item (most recent delta)
    if (items.length > 0) {
      latest.value = items[items.length - 1]
    }
  }

  function reset() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    buffer.value = []
    latest.value = null
    pending.value = false
  }

  return {
    add,
    flush,
    reset,
    latest: readonly(latest),
    pending: readonly(pending),
  }
}
