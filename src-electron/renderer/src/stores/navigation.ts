import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface ChatEntry {
  view: 'chat'
  sessionId: string
}

export interface SettingsEntry {
  view: 'settings'
  activeTab: string
}

export type NavEntry = ChatEntry | SettingsEntry

const MAX_ENTRIES = 50

export const useNavigationStore = defineStore('navigation', () => {
  const entries = ref<NavEntry[]>([])
  const pointer = ref(-1)

  const currentEntry = computed<NavEntry | null>(
    () => (pointer.value >= 0 && pointer.value < entries.value.length)
      ? entries.value[pointer.value]
      : null,
  )

  const currentView = computed<'chat' | 'settings'>(
    () => currentEntry.value?.view ?? 'chat',
  )

  const canGoBack = computed(() => pointer.value > 0)
  const canGoForward = computed(() => pointer.value < entries.value.length - 1)

  function push(entry: NavEntry) {
    // Truncate any forward branch before pushing
    if (pointer.value >= 0 && pointer.value < entries.value.length - 1) {
      entries.value.splice(pointer.value + 1)
    }
    entries.value.push(entry)

    // Evict oldest when exceeding capacity
    if (entries.value.length > MAX_ENTRIES) {
      entries.value.shift()
    }

    pointer.value = entries.value.length - 1
  }

  function back() {
    if (pointer.value > 0) {
      pointer.value -= 1
    }
  }

  /** Clear entire stack, return to default chat view */
  function reset() {
    entries.value = []
    pointer.value = -1
  }

  function forward() {
    if (canGoForward.value) pointer.value += 1
  }

  // Replace entire object so Vue reactivity detects the change
  function updateCurrentTab(activeTab: string) {
    const entry = currentEntry.value
    if (entry?.view === 'settings') {
      entries.value[pointer.value] = { view: 'settings', activeTab }
    }
  }

  function getLastSettingsTab(): string {
    for (let i = entries.value.length - 1; i >= 0; i--) {
      if (entries.value[i].view === 'settings') {
        return (entries.value[i] as { view: 'settings'; activeTab: string }).activeTab
      }
    }
    return 'providers'
  }

  return {
    entries,
    pointer,
    currentEntry,
    currentView,
    canGoBack,
    canGoForward,
    push,
    back,
    forward,
    reset,
    updateCurrentTab,
    getLastSettingsTab,
  }
})
