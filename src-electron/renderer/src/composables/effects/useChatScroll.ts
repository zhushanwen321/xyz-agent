/**
 * useChatScroll —— message-stream auto-scroll 副作用（R2 effects 层）。
 *
 * 职责：
 * - onScroll：读滚动位置维护 stickToBottom（距底 ≤ BOTTOM_THRESHOLD 视为贴底），
 *   回贴底时清零 unreadBelow。程序性滚动（scrollToBottom 发起）期间不翻转 stickToBottom，
 *   避免 smooth 动画中途位置误判为「用户上滑」而脱离锚定。
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
/** smooth 滚动动画最长等待（ms），超时即认为动画结束，恢复 onScroll 正常判定 */
const SMOOTH_SCROLL_GUARD_MS = 600

export function useChatScroll() {
  /** 滚动容器引用（由 MessageStream 绑定 ref） */
  const scrollEl: Ref<HTMLElement | null> = ref(null)
  /** 是否贴底（onScroll 维护） */
  const stickToBottom = ref(true)
  /** 非贴底时有新内容到达 → 置 true（标记「下方有未读新内容」）；回贴底清零 */
  const unreadBelow = ref(false)
  /** 用户当前不在底部 → true（驱动「回到底部」浮层显隐）。与 stickToBottom 互斥 */
  const showJumpButton = ref(false)
  /**
   * 程序性滚动进行中标志（scrollToBottom 发起）。
   * onScroll 检测到此标志为 true 时不翻转 stickToBottom——避免 smooth 动画中途位置
   * （distance > 阈值）被误判为「用户上滑脱离锚定」。动画结束后（scrollend 或超时）清除。
   * [HISTORICAL] 事故：用户点「回到底部」→ smooth 动画进行中 onScroll 把 stickToBottom
   * 翻 false → streaming 的 scrollToBottom('auto') 被 guard 拦截 → streaming 不再跟随。
   */
  let programmaticScrolling = false
  /** smooth 动画超时兜底句柄（防 scrollend 不触发导致标志永不清除） */
  let smoothGuardTimer: ReturnType<typeof setTimeout> | null = null

  /** 清除程序性滚动标志 + 超时句柄（scrollend / 超时 / force 重入时调用） */
  function clearProgrammaticGuard(): void {
    programmaticScrolling = false
    if (smoothGuardTimer) {
      clearTimeout(smoothGuardTimer)
      smoothGuardTimer = null
    }
  }

  /**
   * scroll 事件回调：据距底距离判定贴底，回贴底清未读标记。
   * 程序性滚动期间（smooth 动画）跳过 stickToBottom 翻转——动画中途位置不代表用户意图。
   */
  function onScroll(): void {
    const el = scrollEl.value
    if (!el) return
    // 程序性滚动中：不翻转锚定态（smooth 动画中途会触发 scroll 事件，位置非终态）
    if (programmaticScrolling) return
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
   * smooth 滚动期间置 programmaticScrolling=true 拦截 onScroll 的锚定翻转，避免动画中途
   * 位置误判为「用户上滑脱离」（[HISTORICAL] 事故：streaming 中点「回到底部」后 smooth 动画
   * 把 stickToBottom 翻 false，后续 scrollToBottom('auto') 全被 guard 拦截，streaming 不跟随）。
   * 'auto' 瞬间滚动无需保护——scrollTo 同步到底，onScroll 读到贴底态只会强化 stickToBottom=true。
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
    // 仅 smooth 需要 onScroll 保护期（动画中途位置非终态）
    if (behavior === 'smooth') {
      programmaticScrolling = true
      if (smoothGuardTimer) clearTimeout(smoothGuardTimer)
      smoothGuardTimer = setTimeout(clearProgrammaticGuard, SMOOTH_SCROLL_GUARD_MS)
      const onEnd = (): void => {
        clearProgrammaticGuard()
        el.removeEventListener('scrollend', onEnd)
      }
      el.addEventListener('scrollend', onEnd, { once: true })
    }
  }

  return { scrollEl, stickToBottom, unreadBelow, showJumpButton, onScroll, scrollToBottom }
}
