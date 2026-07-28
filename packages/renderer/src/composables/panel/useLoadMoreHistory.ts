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
import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'
import { useChat } from '@/composables/features/useChat'

export function useLoadMoreHistory(sessionId: () => string): {
  /** 加载中状态（disabled / spinner / 文案切换驱动） */
  loadingMore: Ref<boolean>
  /** 是否还有更多历史可加载（historyTruncated 标志驱动） */
  showLoadMore: ComputedRef<boolean>
  /** 防重入加载调用（loadingMore / showLoadMore 守卫） */
  handleLoadMore: () => Promise<void>
  /** [cw wave w3 / IF8] 顶部插入信号（load-more 期间 true）。
   *  喂给 `<Virtualizer :shift>`：virta 在 shift=true 时按列表**末尾**保位（reverse scroll adjustment），
   *  专用于头部插入（load-more-history）——比手写 scrollAdjustDelta 补偿更准。 */
  isPrepend: Ref<boolean>
  } {
  const { loadMoreHistory, hasMoreHistory: checkHasMore } = useChat()
  /** W4 H4：加载更多历史 loading 状态 */
  const loadingMore = ref(false)
  /** [cw wave w3 / IF8] 顶部插入信号：handleLoadMore 期间 true，驱动 `<Virtualizer :shift>` 保位 */
  const isPrepend = ref(false)
  /** N1: 是否有更多历史可加载（由 hydrate 的 historyTruncated 标志驱动，非默认 true） */
  const showLoadMore = computed(() => checkHasMore(sessionId()))

  async function handleLoadMore(): Promise<void> {
    if (loadingMore.value || !showLoadMore.value) return
    // [cw wave w3 / IF8] 顶部插入信号前置 true：virtua :shift=true 期间，renderItems 变长
    //   会保持滚动位置相对末尾不变（即插入的历史不把视口往下推）。
    isPrepend.value = true
    loadingMore.value = true
    try {
      await loadMoreHistory(sessionId())
      // loadMoreHistory 内部 clearHistoryTruncated 会更新 showLoadMore
      // 等 virtua 处理完 data length change（vue 响应式 → Virtualizer watch data.length），
      // shift=true 在此窗口内生效后才能翻 false，否则后到的高度变化（RO 测量）失去保位。
      await nextTick()
    } finally {
      isPrepend.value = false
      loadingMore.value = false
    }
  }

  return { loadingMore, showLoadMore, handleLoadMore, isPrepend }
}
