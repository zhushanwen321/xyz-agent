/**
 * useLoadMoreHistory —— 加载更多历史的 loading 状态 + handler（从 MessageStream.vue 拆出）。
 *
 * 职责（单一变化轴「load-more 交互态」，原 misplaced 在容器组件 MessageStream.vue 内）：
 * - loadingMore：加载中 ref（驱动按钮 disabled + spinner + 文案切换）。
 * - showLoadMore：是否还有更多历史可加载（由 hydrate 的 historyTruncated 标志驱动，非默认 true）。
 * - handleLoadMore：防重入的加载调用（loadingMore/showLoadMore 守卫），完成后 clearHistoryTruncated 更新 showLoadMore。
 *
 * 不含：load-more 按钮的 DOM 渲染 + 高度断言（容器 useConstantHeightAssert 负责）。
 *
 * @param sessionId 当前 session id getter
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useChat } from '@/composables/features/useChat'

export function useLoadMoreHistory(sessionId: () => string): {
  /** 加载中状态（disabled / spinner / 文案切换驱动） */
  loadingMore: Ref<boolean>
  /** 是否还有更多历史可加载（historyTruncated 标志驱动） */
  showLoadMore: ComputedRef<boolean>
  /** 防重入加载调用（loadingMore / showLoadMore 守卫） */
  handleLoadMore: () => Promise<void>
  } {
  const { loadMoreHistory, hasMoreHistory: checkHasMore } = useChat()
  /** W4 H4：加载更多历史 loading 状态 */
  const loadingMore = ref(false)
  /** N1: 是否有更多历史可加载（由 hydrate 的 historyTruncated 标志驱动，非默认 true） */
  const showLoadMore = computed(() => checkHasMore(sessionId()))

  async function handleLoadMore(): Promise<void> {
    if (loadingMore.value || !showLoadMore.value) return
    loadingMore.value = true
    try {
      await loadMoreHistory(sessionId())
      // loadMoreHistory 内部 clearHistoryTruncated 会更新 showLoadMore
    } finally {
      loadingMore.value = false
    }
  }

  return { loadingMore, showLoadMore, handleLoadMore }
}
