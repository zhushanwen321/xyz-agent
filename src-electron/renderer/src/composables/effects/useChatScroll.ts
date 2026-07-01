/**
 * useChatScroll —— message-stream auto-scroll 副作用（R2 effects 层）。
 *
 * 职责：
 * - onScroll：读滚动位置维护 stickToBottom（距底 ≤ BOTTOM_THRESHOLD 视为贴底），
 *   回贴底时清零 unreadBelow。
 * - scrollToBottom(behavior, force)：force=false（默认，程序自动滚动）受 stickToBottom
 *   guard——非贴底时不滚、置 unreadBelow=true（新内容在下方不可见）；force=true
 *   （用户「回到底部」浮层）强制滚动并恢复贴底态。
 * - observe(target)：用 ResizeObserver 监听内容根高度变化（W4）。贴底时内容增高
 *   自动 scrollToBottom('auto') 跟随，解决 Markdown/shiki 异步渲染 + thinking/tool 块
 *   增高但 content.length 不变的竞态（watcher 兜不住的场景）。作用域销毁时自动 disconnect。
 *
 * 依赖方向：仅 vue ref（effects 不跨 api/stores，纯 DOM 副作用）。
 */
import { nextTick, onScopeDispose, ref } from 'vue'
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

  /** ResizeObserver 实例（监听内容根高度变化，贴底时自动跟随滚动） */
  let resizeObserver: ResizeObserver | null = null

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
   *
   * nextTick 后再 await 一帧（requestAnimationFrame），覆盖一次同步布局——缓解 Markdown/shiki
   * 异步渲染竞态（nextTick 读到的 scrollHeight 可能仍是渲染前的高度）。
   */
  async function scrollToBottom(behavior: ScrollBehavior = 'smooth', force = false): Promise<void> {
    if (!force && !stickToBottom.value) {
      unreadBelow.value = true
      return
    }
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const el = scrollEl.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    stickToBottom.value = true
    unreadBelow.value = false
    showJumpButton.value = false
  }

  /**
   * 监听内容根高度变化（W4）。
   * 内容增高（如 thinking/tool 块出现、Markdown 异步渲染完成）时，若贴底则 scrollToBottom('auto') 跟随。
   * 回调里读 stickToBottom 的当前值（非入队时值）——用户可能在回调执行前手动上滑，此时不应拉回。
   * 作用域销毁时自动 disconnect（onScopeDispose），无需组件手动清理。
   */
  function observe(target: HTMLElement): void {
    // 若已有旧 observer，先清理（切换 observe 目标）
    resizeObserver?.disconnect()
    resizeObserver = new ResizeObserver(() => {
      if (stickToBottom.value) scrollToBottom('auto')
    })
    resizeObserver.observe(target)
  }

  // 作用域销毁时自动清理 ResizeObserver，防泄漏
  onScopeDispose(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return { scrollEl, stickToBottom, unreadBelow, showJumpButton, onScroll, scrollToBottom, observe }
}
