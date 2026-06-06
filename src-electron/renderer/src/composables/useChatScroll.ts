/**
 * useChatScroll — 聊天面板滚动管理 composable
 *
 * 管理：滚动位置缓存（split 恢复）、智能自动滚动、FAB 按钮显示状态。
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const SCROLL_NEAR_BOTTOM_THRESHOLD = 80
const SCROLL_BUTTON_THRESHOLD = 40
const MAX_CACHE_SIZE = 50

/**
 * Module-level LRU scroll position cache, shared across ChatPanel instances.
 * Capped at MAX_CACHE_SIZE entries to prevent unbounded memory growth.
 */
const scrollPositionCache = new Map<string, number>()

function cacheSet(key: string, value: number) {
  // Delete first so re-inserting an existing key moves it to the end (true LRU)
  scrollPositionCache.delete(key)
  if (scrollPositionCache.size >= MAX_CACHE_SIZE) {
    // Delete the oldest entry (first key in insertion order)
    const firstKey = scrollPositionCache.keys().next().value
    if (firstKey !== undefined) scrollPositionCache.delete(firstKey)
  }
  scrollPositionCache.set(key, value)
}

export function useChatScroll(
  chatMsgsRef: () => HTMLElement | null,
  sessionId: () => string | null | undefined,
  messagesLength: () => number,
  streamingContent: () => string | undefined,
  isLoadingHistory: () => boolean,
) {
  const userAtBottom = ref(true)
  const scrollTop = ref(0)
  const scrollHeight = ref(0)
  const clientHeight = ref(0)

  const showScrollBottom = computed(() =>
    scrollTop.value + clientHeight.value < scrollHeight.value - SCROLL_BUTTON_THRESHOLD,
  )

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_THRESHOLD
  }

  function forceScrollToBottom() {
    nextTick(() => {
      const el = chatMsgsRef()
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
        userAtBottom.value = true
      }
    })
  }

  function restoreScrollPosition(sid: string) {
    nextTick(() => {
      const el = chatMsgsRef()
      if (!el) return
      const saved = scrollPositionCache.get(sid)
      if (saved !== undefined) {
        el.scrollTo({ top: saved, behavior: 'instant' })
        userAtBottom.value = isNearBottom(el)
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
        userAtBottom.value = true
      }
    })
  }

  function saveScrollPosition() {
    const el = chatMsgsRef()
    const sid = sessionId()
    if (el && sid) {
      cacheSet(sid, el.scrollTop)
    }
  }

  function onChatScroll() {
    const el = chatMsgsRef()
    if (el) {
      userAtBottom.value = isNearBottom(el)
      scrollTop.value = el.scrollTop
      scrollHeight.value = el.scrollHeight
      clientHeight.value = el.clientHeight
      saveScrollPosition()
    }
  }

  function handleScrollToBottom() {
    const el = chatMsgsRef()
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  function scrollToMessage(messageId: string) {
    const el = chatMsgsRef()?.querySelector(`[data-entry-id="${messageId}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  // Smart auto-scroll: follow new content when at bottom, don't force when user scrolled up
  // Uses 'instant' instead of 'smooth' to prevent scroll lag during fast streaming.
  // The smooth animation cannot keep up with rapid content growth, causing the user
  // to visually fall behind even though userAtBottom remains true.
  watch(
    () => [messagesLength(), streamingContent()],
    () => {
      nextTick(() => {
        if (!userAtBottom.value) return
        const el = chatMsgsRef()
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
      })
    },
  )

  // Session switch or history load complete → force scroll to bottom
  watch(
    () => [sessionId(), isLoadingHistory()],
    ([sid, loading]) => {
      if (sid && !loading) {
        forceScrollToBottom()
      }
    },
  )

  // Restore cached position or scroll to bottom on mount
  onMounted(() => {
    if (messagesLength() > 0) {
      const sid = sessionId()
      if (sid && scrollPositionCache.has(sid)) {
        restoreScrollPosition(sid)
      } else {
        forceScrollToBottom()
      }
    }
  })

  onBeforeUnmount(() => {
    saveScrollPosition()
  })

  return {
    userAtBottom,
    showScrollBottom,
    onChatScroll,
    handleScrollToBottom,
    scrollToMessage,
    forceScrollToBottom,
  }
}
