/**
 * useChatScroll —— message-stream auto-scroll 副作用（R2 effects 层）。
 *
 * 核心不变量：**stickToBottom = false（脱离锚定）只由确定的用户输入信号驱动，
 * onScroll 永远不把 stickToBottom 翻 false。**
 *
 * 设计理由 [HISTORICAL]：曾用 onScroll 的瞬时 distance（scrollHeight - scrollTop
 * - clientHeight）判定是否贴底。streaming 高频内容增长下，程序性 el.scrollTo 写入的
 * 旧 scrollTop 与异步派发 scroll 事件时的新 scrollHeight 错位，distance > 阈值被误判
 * 为「用户上滑脱离」，stickToBottom 翻 false，后续 streaming 跟随全被 guard 拦截。
 * 根因是 scroll 事件天然混合程序性（scrollToBottom 引发）与用户两种来源，靠事后猜测
 * 来源不可靠。改为用确定信号驱动：
 *
 * - 用户上滑 → false：wheel 事件（deltaY < 0，纯用户信号，程序性滚动不触发）；
 *   兜底 onScroll 检测 scrollTop 明显减小（拖滚动条 / 键盘 PageUp）
 * - 回到底部 → true：onScroll 检测 distance ≤ 阈值（用户滚回底 或 程序性滚到底，
 *   方向无歧义）
 * - 程序性 scrollToBottom 引发的 scroll 事件：scrollTop 只增不减，不满足兜底分支
 *   的「scrollTop 减小」条件，不会误判脱离
 *
 * 职责：
 * - onWheel / onScroll：维护 stickToBottom（见上方驱动规则）
 * - scrollToBottom(behavior, force)：force=false 受 stickToBottom guard（非贴底时不滚
 *   只置 unreadBelow）；force=true 强制滚动并恢复贴底态（用户「回到底部」浮层）
 * - contentEl + ResizeObserver：观察内容高度变化，贴底态下内容增高（Markdown 异步
 *   渲染 / streaming 追加）自动跟随滚到底，解耦滚动层与渲染层时序
 */
import { computed, getCurrentScope, nextTick, onScopeDispose, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/** 距底小于该阈值（px）视为贴底 */
const BOTTOM_THRESHOLD = 40
/** scrollTop 减小超过该值（px）视为主动上滑（拖滚动条 / 键盘兜底，wheel 不走此分支） */
const SCROLL_UP_DELTA = 10

export function useChatScroll() {
  /** 滚动容器引用（由 MessageStream 绑定 ref，overflow-y-auto 容器本身） */
  const scrollEl: Ref<HTMLElement | null> = ref(null)
  /**
   * 承载消息内容的子元素引用（scrollEl 内的 wrapper）。
   * ResizeObserver 观察它的高度变化——观察 scrollEl 本身无效（overflow 容器 border-box 固定）。
   */
  const contentEl: Ref<HTMLElement | null> = ref(null)
  /** 是否贴底（只由用户输入信号驱动翻 false，见文件头不变量说明） */
  const stickToBottom = ref(true)
  /** 非贴底时有新内容到达 → 置 true（标记「下方有未读新内容」）；回贴底清零 */
  const unreadBelow = ref(false)
  /** 用户当前不在底部 → true（驱动「回到底部」浮层显隐）。与 stickToBottom 互斥 */
  const showJumpButton: ComputedRef<boolean> = computed(() => !stickToBottom.value)
  /**
   * 上一次 onScroll 时的 scrollTop，用于检测方向（兜底非 wheel 上滑）。
   * 程序性 scrollToBottom 只增不减 scrollTop，故「scrollTop 明显减小」必为用户操作。
   */
  let lastScrollTop = 0

  /**
   * wheel 事件回调：滚轮 / 触控板上滑（deltaY < 0）→ 脱离锚定。
   * wheel 是纯用户信号（程序性 scrollTo 不触发 wheel），无需任何保护期。
   * 下滑（deltaY > 0）不改变 stickToBottom——回到底部由 onScroll 的 distance 判定处理。
   */
  function onWheel(e: WheelEvent): void {
    if (e.deltaY < 0) stickToBottom.value = false
  }

  /** scrollEl 绑定后注册 wheel listener（passive，不阻止默认滚动） */
  watch(
    scrollEl,
    (el, _old, onCleanup) => {
      if (el) {
        el.addEventListener('wheel', onWheel, { passive: true })
        onCleanup(() => el.removeEventListener('wheel', onWheel))
      }
    },
    { immediate: true },
  )

  /**
   * ResizeObserver：观察 contentEl 高度变化，贴底态下内容增高即跟随滚到底。
   *
   * 触发场景：Markdown 异步渲染（shiki WASM 加载 / fileSearch RPC 回来重渲染 / mermaid 布局）
   * 导致 scrollHeight 多次跳变；单次 nextTick 不足以稳定，靠 ResizeObserver 兜底。
   * 同时覆盖 streaming 追加——内容增高即滚，不依赖消费方 watch 的触发频率。
   *
   * 受 stickToBottom guard（scrollToBottom 内部判定）：用户上滑脱离锚定时不强制拉回。
   */
  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    watch(
      contentEl,
      (el, _old, onCleanup) => {
        if (el) {
          resizeObserver = new ResizeObserver(() => {
            void scrollToBottom('auto')
          })
          resizeObserver.observe(el)
          onCleanup(() => {
            resizeObserver?.disconnect()
            resizeObserver = null
          })
        }
      },
      { immediate: true },
    )
    // effectScope 卸载兜底（组件卸载时 watch 的 onCleanup 会清理，此处防止
    // composable 在非组件 scope 调用后泄漏）。无 active scope（如纯单测）时跳过。
    if (getCurrentScope()) {
      onScopeDispose(() => {
        resizeObserver?.disconnect()
        resizeObserver = null
      })
    }
  }

  /**
   * scroll 事件回调。
   *
   * 只在两个方向更新 stickToBottom，永不翻 false（翻 false 由 onWheel / 本函数的
   * scrollTop 减小分支负责）：
   * - distance ≤ BOTTOM_THRESHOLD → true（到低了，无歧义）
   * - scrollTop 明显减小（拖滚动条 / 键盘）→ false（程序性滚动只增不减，不会误触发）
   * - 其他（scrollTop 增大但未到底，如程序性 scrollTo 后内容增长）→ 不变
   */
  function onScroll(): void {
    const el = scrollEl.value
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance <= BOTTOM_THRESHOLD) {
      stickToBottom.value = true
      unreadBelow.value = false
    } else if (el.scrollTop < lastScrollTop - SCROLL_UP_DELTA) {
      stickToBottom.value = false
    }
    lastScrollTop = el.scrollTop
  }

  /**
   * 滚动到底部。
   * - force=false（默认）：受 stickToBottom guard，非贴底时不滚只置 unreadBelow（程序自动跟随用）
   * - force=true：强制滚动并恢复贴底态（用户「回到底部」浮层点击用）
   *
   * 无需任何 scroll 事件保护期——onScroll 永不因程序性滚动翻 false（见文件头说明），
   * smooth 动画中途的 scroll 事件（scrollTop 增大）同样不会误判。
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
  }

  return { scrollEl, contentEl, stickToBottom, unreadBelow, showJumpButton, onScroll, scrollToBottom }
}
