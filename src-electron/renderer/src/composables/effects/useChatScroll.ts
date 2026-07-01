/**
 * useChatScroll —— message-stream auto-scroll 副作用（R2 effects 层）。
 *
 * 职责：
 * - onScroll：读滚动位置维护 stickToBottom（距底 ≤ BOTTOM_THRESHOLD 视为贴底），
 *   回贴底时清零 unreadBelow。
 * - scrollToBottom(behavior, force)：force=false（默认，程序自动滚动）受 stickToBottom
 *   guard——非贴底时不滚、置 unreadBelow=true（新内容在下方不可见）；force=true
 *   （用户「回到底部」浮层）强制滚动并恢复贴底态。
 *
 * 依赖方向：仅 vue ref（effects 不跨 api/stores，纯 DOM 副作用）。
 */
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'

/** 距底小于该阈值（px）视为贴底 */
const BOTTOM_THRESHOLD = 40

export function useChatScroll() {
  /** 滚动容器引用（由 MessageStream 绑定 ref） */
  const scrollEl: Ref<HTMLElement | null> = ref(null)
  /** 是否贴底（onScroll 维护） */
  const stickToBottom = ref(true)
  /** 非贴底时有新内容到达 → 置 true（标记「下方有未读新内容」）；回贴底清零 */
  const unreadBelow = ref(false)
  /** 用户当前不在底部 → true（驱动「回到底部」浮层显隐）。与 stickToBottom 互斥 */
  const showJumpButton = ref(false)

  /** scroll 事件回调：据距底距离判定贴底，回贴底清未读标记 */
  function onScroll(): void {
    const el = scrollEl.value
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const stick = distance <= BOTTOM_THRESHOLD
    stickToBottom.value = stick
    showJumpButton.value = !stick
    if (stick) unreadBelow.value = false
  }

  /**
   * 滚动到底部。
   * - force=false（默认）：受 stickToBottom guard，非贴底时不滚只置 unreadBelow（程序自动跟随用）
   * - force=true：强制滚动并恢复贴底态（用户「回到底部」浮层点击用）
   */
  async function scrollToBottom(behavior: ScrollBehavior = 'smooth', force = false): Promise<void> {
    if (!force && !stickToBottom.value) {
      unreadBelow.value = true
      return
    }
    await nextTick()
    const el = scrollEl.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    stickToBottom.value = true
    unreadBelow.value = false
    showJumpButton.value = false
  }

  return { scrollEl, stickToBottom, unreadBelow, showJumpButton, onScroll, scrollToBottom }
}
