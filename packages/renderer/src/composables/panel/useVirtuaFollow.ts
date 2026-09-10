/**
 * useVirtuaFollow —— virtua-based message-stream follow 状态机（R2 effects 层）。
 *
 * 设计起源：follow 状态机迁移自早期 useChatScroll（手写 DOM scrollTop 方案），现已是
 * 单一 virtua 路径实现（旧手写方案于 cw wave w4 删除）。
 *
 * 核心不变量（INVAR-M4-2）：**stickToBottom = false（脱离锚定）只由确定的用户输入信号
 * （onWheel deltaY<0）驱动，onScroll 永远不把 stickToBottom 翻 false，只单向翻真
 * （distance≤40 → true）。** 该不变量迁移自早期 useChatScroll 的语义。
 *
 * virtua 路径实现要点：
 * - 滚动操作用 virtua VirtualizerHandle.scrollToIndex（替代早期原生 DOM scrollTo）
 * - 末项索引 = itemCount() - 1 **直取**（D1，chat-pin-bottom-fix）——禁止 findItemIndex(scrollSize)
 *   反查。[R3 事故背景] virtua 的 findItemIndex 入参按绝对滚动坐标解释（内部再减 startMargin，
 *   实装 0.50.0：`$findItemIndex: e => d(R, e - m)`，m = startSpacerSize），而 handle.scrollSize
 *   不含 startMargin——load-more 显示时（startMargin=44）高度 <44px 的末项（SystemNotice /
 *   SkillNoticeInline 通知行约 24px）被反查到**倒数第二项**，滚后距底为负值 ≤ 阈值 →
 *   stickToBottom 恒 true → 不浮「回到底部」按钮 → 自我锁死的错钉。索引直取与
 *   startMargin/scrollSize 坐标语义彻底解耦，末项定位与末项像素高度无关
 * - scrollToIndex(末项, { align: 'end', offset: endOffset() })——endOffset = Virtualizer 之后、
 *   仍在滚动容器文档流内的尾部块实测总高（消费方注入；virtua offset 语义 = 目标 scrollTop 正偏移，
 *   实装 0.50.0 公式 `offset + startSpacerSize + itemOffset + itemSize - viewportSize`）。
 *   未注入时 = 0（落点等价旧版 align-end 语义）。守卫：scripts/check-scroll-follow.mjs（C-state-11）
 *
 * 设计要点（对照 design.md §4.2 + W1C6）：
 * - followIfStuck 用 rAF schedule，rAF 回调内**重读** stickToBottom：避免「调用时贴底
 *   →用户上滑翻 false→rAF 仍按 true 滚→把上滑用户扯回底部」
 * - followToBottom(force=true) 是用户「回到底部」浮层点击：同步强制滚（不走 rAF），
 *   让用户点击的即时反馈最强
 */
import { ref, computed, onScopeDispose } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'

/** 距底小于该阈值（px）视为贴底（迁移自 useChatScroll 的 BOTTOM_THRESHOLD） */
const BOTTOM_THRESHOLD = 40

/**
 * virtua-based follow 状态机。
 *
 * @param opts.vlistRef Virtualizer 组件的 handle ref（由消费方通过 template ref 绑定）
 * @param opts.itemCount D1 末项索引直取的数据条数源（消费方注入 `() => streamItems.value.length`，
 *   与 <Virtualizer :data> 同一数组基准）。[过渡缺省] 未注入时取 Number.MAX_SAFE_INTEGER，交由
 *   virtua scrollToIndex 内部 clamp 到 [0, itemsLength-1]（实装 0.50.0 首行
 *   `t = r(t, 0, $getItemsLength() - 1)`），语义等价末项直取
 * @param opts.endOffset 滚动目标的正偏移 = Virtualizer 之后尾部块实测总高（消费方注入）。
 *   [过渡缺省] 未注入时 = 0（无尾部高度补偿，落点 = 旧版 align-end 语义）
 * @param opts.onStickChange stickToBottom 翻转时的副作用回调（消费方可据此收起「回到底部」浮层等）
 */
export function useVirtuaFollow(opts: {
  vlistRef: Ref<VirtualizerHandle | null>
  itemCount?: () => number
  endOffset?: () => number
  onStickChange?: (stuck: boolean) => void
}): {
  stickToBottom: Ref<boolean>
  unreadBelow: Ref<boolean>
  showJumpButton: ComputedRef<boolean>
  /** D6 末项底部绝对 px（瞬时块定位基线），itemCount 直取末项索引（坐标语义同 scrollToRealBottom） */
  vlistBottom: ComputedRef<number>
  onScroll: (offset: number) => void
  onWheel: (e: WheelEvent) => void
  followIfStuck: () => void
  followToBottom: (force?: boolean) => void
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
   * D6 末项底部绝对 px（virta getItemOffset 已含 startMargin）：末项索引 = itemCount() - 1
   * 直取，坐标语义与 scrollToRealBottom 同源（禁止 findItemIndex(scrollSize) 反查，R3 见头注释）。
   * 消费方：瞬时块（compacting/fork notice）absolute 定位的 top 基线。
   * 边界：vlistRef null（首帧未挂载）/ scrollSize=0（空数据）/ itemCount ≤ 0 → 0。
   * [缺省差异] itemCount 未注入时按 0（无末项 → 无基线）而非 scrollToRealBottom 的
   * MAX_SAFE_INTEGER——定位基线不能依赖 virtua 内部 clamp（clamp 的是索引不是「存在末项」）。
   */
  const vlistBottom: ComputedRef<number> = computed(() => {
    const v = vlistRef.value
    if (!v || v.scrollSize === 0) return 0
    const count = opts.itemCount?.() ?? 0
    if (count <= 0) return 0
    return v.getItemOffset(count - 1) + v.getItemSize(count - 1)
  })

  /**
   * stickGuard 暂停计数器已随 trace <Transition> 删除退役（原 pause/resumeStickGuard
   * 通路无消费方）。guarded 回归结构上不可能：本状态机 onScroll 只单向翻真
   * （distance≤40 → stickToBottom=true），翻 false 只由 onWheel（纯用户信号）驱动。
   */

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
   * 两个早返回 guard：
   */
  function onScroll(offset: number): void {
    const v = vlistRef.value
    // 边界1: vlistRef null（首帧未挂载）→ 早返回
    if (!v) return
    // 边界2: scrollSize=0（空数据）→ distance 计算无意义，早返回
    if (v.scrollSize === 0) return

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
   * follow 原语的唯一滚动实现（D1 + D2）：末项索引直取 + offset = endOffset()。
   * 本文件所有「滚到底」的唯一出口（C-state-11：scrollToIndex 白名单唯一落点）。
   * 边界4：itemCount() ≤ 0（空列表）→ 无末项可滚，跳过。
   */
  function scrollToRealBottom(v: VirtualizerHandle): void {
    const count = opts.itemCount?.() ?? Number.MAX_SAFE_INTEGER
    if (count <= 0) return
    v.scrollToIndex(count - 1, { align: 'end', offset: opts.endOffset?.() ?? 0 })
  }

  /**
   * 待执行的 rAF 句柄（null = 无 pending）。连续 followIfStuck 会先 cancel 旧 rAF 再调度新 rAF，
   * 避免叠加多个 pending 回调；scope dispose 时（session 切换/组件卸载）取消 pending rAF 防泄漏。
   */
  let pendingRafId: number | null = null

  /**
   * 跟随到底部（仅在贴底时生效）。
   *
   * INVAR-M4-2【关键】：stickToBottom guard 在 rAF 执行时重新读取，而非调用时捕获。
   * 否则：调用时贴底→用户上滑翻 false→rAF 仍按调用时的 true 滚→把上滑用户扯回底部。
   *
   * rAF schedule：与 useChatScroll.ts:218-255 的 flushScroll 同款语义。rAF 回调内：
   * - 边界3: rAF 触发时 vlistRef 可能已 dispose（session 切换）→ null check
   * - rAF 内重读 stickToBottom，false 则跳过（INVAR-M4-2）
   *
   * 句柄生命周期：调度时保存 pendingRafId，回调进入即清 null；连续调用先 cancel 旧句柄。
   * onScopeDispose 兜底取消 pending rAF（composable 在 setup 同步调用，scope 必然活跃）。
   */
  function followIfStuck(): void {
    const run = (): void => {
      pendingRafId = null
      // INVAR-M4-2: rAF 内重读 stickToBottom，避免调用时贴底→用户上滑→仍被扯回
      if (!stickToBottom.value) {
        // U15 即时语义（迁移自 useChatScroll.ts:243）：非贴底时新内容到达 → 标记 unreadBelow，
        // 让 showJumpButton 浮层（= !stickToBottom && unreadBelow）出现，用户可点「回到底部」。
        unreadBelow.value = true
        return
      }
      const v = vlistRef.value
      // 边界3: rAF 触发时 vlistRef 可能已 dispose（session 切换）→ null check
      if (!v) return
      scrollToRealBottom(v)
    }
    if (typeof requestAnimationFrame !== 'undefined') {
      // 连续 followIfStuck：先 cancel 旧 rAF，避免多个 pending 回调叠加
      if (pendingRafId !== null) cancelAnimationFrame(pendingRafId)
      pendingRafId = requestAnimationFrame(run)
    } else {
      // 测试 / SSR 环境兜底（无 rAF）：用 microtask 推进，保持「异步重读」语义。
      // microtask 无法取消，接受其执行（run 内 null check / stickToBottom 重读保证安全）。
      Promise.resolve().then(run)
    }
  }

  // scope dispose（session 切换/组件卸载）兜底取消 pending rAF，防泄漏。
  // composable 在 setup 同步调用 → scope 必然活跃（测试无 scope 时 onScopeDispose 为 no-op，不抛错）。
  onScopeDispose(() => {
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
  })

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
      scrollToRealBottom(v)
      onStickChange?.(true)
      return
    }
    followIfStuck()
  }

  return {
    stickToBottom,
    unreadBelow,
    showJumpButton,
    vlistBottom,
    onScroll,
    onWheel,
    followIfStuck,
    followToBottom,
  }
}
