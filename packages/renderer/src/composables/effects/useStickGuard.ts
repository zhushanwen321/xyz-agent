/**
 * useStickGuard —— trace 折叠 transition 期间的 stickToBottom 守卫暂停注入。
 *
 * 背景 [HISTORICAL]：对话完成时（isSessionActive true→false），trace 块 CSS transition
 * 收缩高度，浏览器 clamp scrollTop 大幅减小，useChatScroll.onScroll 的「scrollTop 减小→false」
 * 分支误判为用户上滑 → stickToBottom 翻 false → scrollToBottom 被 guard 拦截 → 界面停中间。
 *
 * 暂停机制：Turn.vue 的 trace `<Transition>` JS hooks 在 before-leave 调 pause、leave-done 调 resume，
 * 期间 onScroll 跳过「scrollTop 减小→false」分支（仍保留「distance≤40→true」贴底恢复）。
 * wheel 上滑（deltaY<0）不受影响——纯用户信号优先级最高，暂停只针对程序性 clamp 误判。
 *
 * provide/inject 模式（复刻 useResizeReport）：MessageStream.vue provide（持有 useChatScroll
 * 导出的 pauseStickGuard/resumeStickGuard），Turn.vue inject 后在 transition hooks 内调用。
 * 优雅降级：非 MessageStream 环境（如纯单测 mount Turn）inject 返回 null → hooks 跳过 pause/resume。
 */
import { inject, provide, type InjectionKey } from 'vue'

/** 暂停/恢复 stickToBottom 守卫的接口（useChatScroll 导出的两个函数） */
export interface StickGuard {
  pause: () => void
  resume: () => void
}

/**
 * provide/inject key（Symbol + InjectionKey 类型安全）。
 * 从独立 .ts 文件导出（非 <script setup> 内 export，SFC 编译器禁止）。
 */
export const STICK_GUARD_KEY: InjectionKey<StickGuard> = Symbol('stick-guard')

/**
 * 父组件（MessageStream）侧：provide stick guard，供子树 Turn 的 trace transition hooks 注入。
 *
 * @param guard useChatScroll 导出的 pauseStickGuard/resumeStickGuard
 * @example
 * ```ts
 * // MessageStream.vue setup
 * const { pauseStickGuard, resumeStickGuard } = useChatScroll()
 * provideStickGuard({ pause: pauseStickGuard, resume: resumeStickGuard })
 * ```
 */
export function provideStickGuard(guard: StickGuard): void {
  provide(STICK_GUARD_KEY, guard)
}

/**
 * 子组件（Turn）侧：inject stick guard，用于 trace transition hooks。
 * 无父组件 provide 时返回 null（优雅降级，hooks 跳过 pause/resume）。
 */
export function useStickGuard(): StickGuard | null {
  return inject(STICK_GUARD_KEY, null)
}

/** trace 块 CSS height 过渡时长（ms）——与 hooks 内 setTimeout 兜底时长一致 */
const TRACE_TRANSITION_MS = 200

/**
 * trace 折叠/展开的 height 过渡 JS hooks（Vue `<Transition :css="false">`）。
 *
 * 为什么用 JS hooks 而非纯 CSS max-height：trace 内容含异步 MarkdownRenderer（shiki/mermaid），
 * 实际高度未知，max-height: 9999px 会让 transition 曲线失真（实际 500px，过渡前 90% 看不出变化）。
 * JS hooks 在 leave 开始时测真实 scrollHeight，逐步过渡到 0。
 *
 * @before-leave：锁当前高度（防瞬塌）+ pauseStickGuard（暂停 onScroll 误判）
 * @leave：force reflow → 设 height:0 + transition → setTimeout(done, MS) 兜底
 *   （不依赖 transitionend 事件——happy-dom 不真实执行 CSS transition，transitionend 永不触发）
 * @enter：对称展开（streaming 开始 / 用户手动 expanded 场景），先 height:0 → reflow → height:真实值
 *
 * @param stickGuard useStickGuard() 返回的 guard（可能 null，非 MessageStream 环境降级）
 */
export function useTraceTransition(stickGuard: StickGuard | null) {
  function onTraceBeforeLeave(el: Element): void {
    const node = el as HTMLElement
    node.style.height = node.scrollHeight + 'px'
    node.style.overflow = 'hidden'
    stickGuard?.pause()
  }

  function onTraceLeave(el: Element, done: () => void): void {
    const node = el as HTMLElement
    // force reflow：让浏览器先承认 beforeLeave 设的 height，再过渡到 0
    void node.offsetHeight
    node.style.transition = `height ${TRACE_TRANSITION_MS}ms ease-out`
    node.style.height = '0'
    // 兜底 done：happy-dom / 测试环境不真实执行 CSS transition，transitionend 永不触发。
    // 用与 transition 时长一致的 setTimeout 保证 done 必被调用（否则 Vue 永不卸载 leave 元素）。
    const timer = window.setTimeout(() => {
      window.clearTimeout(timer)
      stickGuard?.resume()
      done()
    }, TRACE_TRANSITION_MS)
  }

  function onTraceEnter(el: Element, done: () => void): void {
    const node = el as HTMLElement
    // 展开：先从 0 开始，测目标高度，过渡到目标
    node.style.height = '0'
    node.style.overflow = 'hidden'
    void node.offsetHeight
    node.style.transition = `height ${TRACE_TRANSITION_MS}ms ease-out`
    node.style.height = node.scrollHeight + 'px'
    const timer = window.setTimeout(() => {
      window.clearTimeout(timer)
      node.style.height = ''
      node.style.overflow = ''
      node.style.transition = ''
      done()
    }, TRACE_TRANSITION_MS)
  }

  return { onTraceBeforeLeave, onTraceLeave, onTraceEnter }
}
