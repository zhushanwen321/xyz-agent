/**
 * useVirtuaFollow —— virtua-based message-stream follow 状态机（R2 effects 层）。
 *
 * follow 状态机（重写自 useChatScroll，w1 新旧并存，w4 删旧）。
 *
 * 核心不变量（INVAR-M4-2）：**stickToBottom = false（脱离锚定）只由确定的用户输入信号
 * （onWheel deltaY<0）驱动，onScroll 永远不把 stickToBottom 翻 false，只单向翻真
 * （distance≤40 → true）。** 这与 useChatScroll.ts 的不变量一致，迁移自其语义。
 *
 * 与 useChatScroll 的差异：
 * - 滚动操作由原生 DOM scrollTo 改为 virtua VirtualizerHandle.scrollToIndex
 * - lastIndex 不再从 DOM 子元素算，而从 v.findItemIndex(v.scrollSize) 派生（virta 内部
 *   维护测量缓存，按 offset 反查 nearest item index）
 * - pause/resumeStickGuard 改为计数器（useChatScroll 是布尔），支持嵌套 pause
 *   （W1TC9 修复点：trace 折叠 transition 嵌套调用时不致早 resume）
 *
 * 设计要点（对照 design.md §4.2 + W1C6）：
 * - followIfStuck 用 rAF schedule，rAF 回调内**重读** stickToBottom：避免「调用时贴底
 *   →用户上滑翻 false→rAF 仍按 true 滚→把上滑用户扯回底部」
 * - followToBottom(force=true) 是用户「回到底部」浮层点击：同步强制滚（不走 rAF），
 *   让用户点击的即时反馈最强
 */
import { ref, computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'

/** 距底小于该阈值（px）视为贴底（迁移自 useChatScroll 的 BOTTOM_THRESHOLD） */
const BOTTOM_THRESHOLD = 40

/**
 * virtua-based follow 状态机。
 *
 * @param opts.vlistRef Virtualizer 组件的 handle ref（由消费方通过 template ref 绑定）
 * @param opts.onStickChange stickToBottom 翻转时的副作用回调（消费方可据此收起「回到底部」浮层等）
 */
export function useVirtuaFollow(opts: {
  vlistRef: Ref<VirtualizerHandle | null>
  onStickChange?: (stuck: boolean) => void
}): {
  stickToBottom: Ref<boolean>
  unreadBelow: Ref<boolean>
  showJumpButton: ComputedRef<boolean>
  onScroll: (offset: number) => void
  onWheel: (e: WheelEvent) => void
  followIfStuck: () => void
  followToBottom: (force?: boolean) => void
  pauseStickGuard: () => void
  resumeStickGuard: () => void
} {
  const { vlistRef, onStickChange } = opts

  /** 是否贴底（只由用户输入信号驱动翻 false，见文件头不变量说明）。初始贴底。 */
  const stickToBottom = ref(true)
  /** 非贴底时有新内容到达 → 置 true（标记「下方有未读新内容」）；回贴底清零。 */
  const unreadBelow = ref(false)
  /** 用户当前不在底部 且 有未读新内容 → 显示「回到底部」浮层。 */
  const showJumpButton: ComputedRef<boolean> = computed(
    () => !stickToBottom.value && unreadBelow.value,
  )

  /**
   * stickGuard 暂停计数器（W1TC9 修复点，对照 useChatScroll.ts 的 stickGuardPaused 布尔）。
   * 背景：trace 块 CSS transition 收缩高度时程序性 clamp 会让 distance 瞬变，可能误触发
   * onScroll 的贴底恢复分支。transition 期间 pauseStickGuard()，结束后 resumeStickGuard()。
   * 用计数器支持嵌套（外层 transition 套内层 transition），count>0 即 guard 生效。
   */
  let stickGuardPausedCount = 0
  /** 暂停 onScroll 的贴底判定（程序性高度变化期间调用，可嵌套）。 */
  function pauseStickGuard(): void {
    stickGuardPausedCount++
  }
  /** 恢复 onScroll 的贴底判定（与 pauseStickGuard 配对，计数归零才真正解除 guard）。 */
  function resumeStickGuard(): void {
    stickGuardPausedCount = Math.max(0, stickGuardPausedCount - 1)
  }

  /**
   * wheel 事件回调：滚轮 / 触控板上滑（deltaY < 0）→ 脱离锚定。
   * wheel 是纯用户信号（程序性 scrollToIndex 不触发 wheel），无需任何保护期。
   * 下滑（deltaY > 0）不改变 stickToBottom——回到底部由 onScroll 的 distance 判定处理。
   */
  function onWheel(e: WheelEvent): void {
    if (e.deltaY < 0) {
      stickToBottom.value = false
      onStickChange?.(false)
    }
  }

  /**
   * scroll 事件回调（virtua Virtualizer 的 onScroll(offset) 透传）。
   *
   * 只单向翻真（distance≤40 → stickToBottom=true），永不翻 false（翻 false 由 onWheel 负责）。
   * 三个早返回 guard：
   */
  function onScroll(offset: number): void {
    const v = vlistRef.value
    // 边界1: vlistRef null（首帧未挂载）→ 早返回
    if (!v) return
    // 边界2: scrollSize=0（空数据）→ distance 计算无意义，早返回
    if (v.scrollSize === 0) return
    // 边界3: stickGuardPausedCount>0（程序性高度变化期间）→ 早返回
    if (stickGuardPausedCount > 0) return

    const distance = v.scrollSize - offset - v.viewportSize
    if (distance <= BOTTOM_THRESHOLD) {
      if (!stickToBottom.value) {
        stickToBottom.value = true
        unreadBelow.value = false
        onStickChange?.(true)
      }
    }
  }

  /**
   * 跟随到底部（仅在贴底时生效）。
   *
   * INVAR-M4-2【关键】：stickToBottom guard 在 rAF 执行时重新读取，而非调用时捕获。
   * 否则：调用时贴底→用户上滑翻 false→rAF 仍按调用时的 true 滚→把上滑用户扯回底部。
   *
   * rAF schedule：与 useChatScroll.ts:218-255 的 flushScroll 同款语义。rAF 回调内：
   * - 边界3: rAF 触发时 vlistRef 可能已 dispose（session 切换）→ null check
   * - rAF 内重读 stickToBottom，false 则跳过（INVAR-M4-2）
   */
  function followIfStuck(): void {
    const run = (): void => {
      // INVAR-M4-2: rAF 内重读 stickToBottom，避免调用时贴底→用户上滑→仍被扯回
      if (!stickToBottom.value) return
      const v = vlistRef.value
      // 边界3: rAF 触发时 vlistRef 可能已 dispose（session 切换）→ null check
      if (!v) return
      // lastIndex 从 virtua 测量缓存派生：scrollSize 是总高，findItemIndex 反查末项 index
      const lastIdx = v.findItemIndex(v.scrollSize)
      v.scrollToIndex(lastIdx, { align: 'end' })
    }
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(run)
    } else {
      // 测试 / SSR 环境兜底（无 rAF）：用 microtask 推进，保持「异步重读」语义
      Promise.resolve().then(run)
    }
  }

  /**
   * 滚动到底部。
   * - force=true（用户「回到底部」浮层点击）：无视 stickToBottom，**同步**强制滚到底
   *   并重置贴底态。同步（不走 rAF）让用户点击的即时反馈最强。
   * - force=false（默认）：同 followIfStuck（受 stickToBottom guard，非贴底时不滚）。
   */
  function followToBottom(force = false): void {
    const v = vlistRef.value
    if (!v) return
    if (force) {
      stickToBottom.value = true
      unreadBelow.value = false
      const lastIdx = v.findItemIndex(v.scrollSize)
      v.scrollToIndex(lastIdx, { align: 'end' })
      onStickChange?.(true)
      return
    }
    followIfStuck()
  }

  return {
    stickToBottom,
    unreadBelow,
    showJumpButton,
    onScroll,
    onWheel,
    followIfStuck,
    followToBottom,
    pauseStickGuard,
    resumeStickGuard,
  }
}
