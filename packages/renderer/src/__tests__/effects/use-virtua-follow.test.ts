/**
 * useVirtuaFollow 单测（cw wave w1 / W1CO2 mock 工厂 + W1TC1-W1TC9）。
 *
 * 覆盖 follow 状态机：
 * - onWheel 上滑 → stickToBottom=false
 * - onScroll distance≤40 → stickToBottom=true（只单向翻真）
 * - pause/resumeStickGuard 计数器（TC9 修复点）
 * - followIfStuck 受 stickToBottom guard（含 INVAR-M4-2 rAF 内重读）
 * - followToBottom(force) 强制贴底
 * - showJumpButton 派生 = !stickToBottom && unreadBelow
 *
 * mock 策略：不 mount 真实 virtua 组件（happy-dom 下 Virtualizer 行为不可控），
 * 用 createMockVlist 造一个满足 VirtualizerHandle 接口、可断言调用的 mock 对象，
 * 注入 vlistRef。followIfStuck / followToBottom 通过 v.findItemIndex(v.scrollSize)
 * 派生 lastIndex——mock 提供固定 scrollSize/findItemIndex 让结果可预测。
 *
 * fake timers：W1TC7 用 vi.useFakeTimers 控制 rAF（实现用 requestAnimationFrame）。
 * 其余用例不需要 rAF 控制（followIfStuck 调用后立即 advance/flush 或不依赖 rAF 时序），
 * 但为统一仍用 fake timers 并在断言前 flush。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, type Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'
import { useVirtuaFollow } from '@/composables/effects/useVirtuaFollow'
// createMockVlist 共享工厂（w2 提取至此，避免与 rail-virtua 测试重复定义）
import { createMockVlist } from './_virtua-mock-helper'

describe('useVirtuaFollow (cw wave w1 W1TC1-W1TC9)', () => {
  let vlistRef: Ref<VirtualizerHandle | null>
  let mock: ReturnType<typeof createMockVlist>
  let onStickChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mock = createMockVlist()
    vlistRef = ref(null)
    onStickChange = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('W1TC1 onWheel deltaY<0 翻 stickToBottom=false', () => {
    vlistRef.value = mock
    const { stickToBottom, onWheel } = useVirtuaFollow({ vlistRef, onStickChange })
    // 初始贴底
    expect(stickToBottom.value).toBe(true)

    onWheel({ deltaY: -100 } as WheelEvent)

    expect(stickToBottom.value).toBe(false)
    expect(onStickChange).toHaveBeenCalledWith(false)
  })

  it('W1TC2 onScroll distance≤40 翻 stickToBottom=true', () => {
    // mock scrollSize=1000/viewportSize=500；初始 stickToBottom=false
    mock = createMockVlist({ scrollSize: 1000, viewportSize: 500 })
    vlistRef.value = mock
    const { stickToBottom, onScroll } = useVirtuaFollow({ vlistRef, onStickChange })
    stickToBottom.value = false

    // onScroll(480) → distance = 1000-480-500 = 20 ≤ 40
    onScroll(480)

    expect(stickToBottom.value).toBe(true)
    expect(onStickChange).toHaveBeenCalledWith(true)
  })

  it('W1TC3 onScroll distance>40 不改 stickToBottom（保持 false）', () => {
    mock = createMockVlist({ scrollSize: 1000, viewportSize: 500 })
    vlistRef.value = mock
    const { stickToBottom, onScroll } = useVirtuaFollow({ vlistRef, onStickChange })
    stickToBottom.value = false

    // onScroll(100) → distance = 1000-100-500 = 400 > 40
    onScroll(100)

    expect(stickToBottom.value).toBe(false)
    expect(onStickChange).not.toHaveBeenCalled()
  })

  it('W1TC4 pause/resumeStickGuard 计数器：count>0 时 onScroll 不改 stickToBottom', () => {
    mock = createMockVlist({ scrollSize: 1000, viewportSize: 500 })
    vlistRef.value = mock
    const { stickToBottom, onScroll, pauseStickGuard, resumeStickGuard } = useVirtuaFollow({
      vlistRef,
      onStickChange,
    })
    stickToBottom.value = false

    // pause 两次 → count===2
    pauseStickGuard()
    pauseStickGuard()
    // distance≤40，但 count>0 guard，不应翻 true
    onScroll(480)
    expect(stickToBottom.value).toBe(false)

    // resume 一次 → count===1，仍 guard
    resumeStickGuard()
    onScroll(480)
    expect(stickToBottom.value).toBe(false)

    // resume 一次 → count===0，guard 解除，onScroll 翻 true
    resumeStickGuard()
    onScroll(480)
    expect(stickToBottom.value).toBe(true)
  })

  it('W1TC5 followIfStuck stickToBottom=true 调 scrollToIndex(lastIndex, {align:"end"})', async () => {
    // 提供可预测的 findItemIndex：scrollSize=1000 → 返回 last index 4
    const findItemIndex = vi.fn(() => 4)
    mock = createMockVlist({ scrollSize: 1000, findItemIndex })
    vlistRef.value = mock
    const { stickToBottom, followIfStuck } = useVirtuaFollow({ vlistRef, onStickChange })
    expect(stickToBottom.value).toBe(true)

    followIfStuck()
    // 实现用 rAF schedule，flush 后才执行
    await vi.advanceTimersByTimeAsync(16)

    expect(findItemIndex).toHaveBeenCalledWith(1000)
    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' })
  })

  it('W1TC6 followIfStuck stickToBottom=false 不调 scrollToIndex，但置 unreadBelow=true（U15 语义）', async () => {
    vlistRef.value = mock
    const { stickToBottom, unreadBelow, followIfStuck } = useVirtuaFollow({ vlistRef, onStickChange })
    stickToBottom.value = false
    expect(unreadBelow.value).toBe(false)

    followIfStuck()
    await vi.advanceTimersByTimeAsync(16)

    expect(mock.scrollToIndex).not.toHaveBeenCalled()
    // U15 即时语义（迁移自 useChatScroll.ts:243）：非贴底时新内容到达 → 标记 unreadBelow
    // 让 showJumpButton 浮层（= !stickToBottom && unreadBelow）出现，用户可点「回到底部」
    expect(unreadBelow.value).toBe(true)
  })

  it('W1TC7 followIfStuck rAF 内重读 stickToBottom（INVAR-M4-2）：调用后立即上滑→rAF 不滚', async () => {
    const findItemIndex = vi.fn(() => 4)
    mock = createMockVlist({ scrollSize: 1000, findItemIndex })
    vlistRef.value = mock
    const { stickToBottom, onWheel, followIfStuck } = useVirtuaFollow({
      vlistRef,
      onStickChange,
    })
    // 初始贴底
    expect(stickToBottom.value).toBe(true)

    // 调 followIfStuck（schedule rAF，rAF 回调内重读 stickToBottom）
    followIfStuck()
    // rAF 尚未触发，立即 onWheel 翻 false
    onWheel({ deltaY: -100 } as WheelEvent)
    expect(stickToBottom.value).toBe(false)

    // 触发 rAF：rAF 内重读到 false → 跳过 scrollToIndex
    await vi.advanceTimersByTimeAsync(16)

    expect(mock.scrollToIndex).not.toHaveBeenCalled()
  })

  it('W1TC8 followToBottom(force=true) 无视 stickToBottom，强制滚到底并翻回 true', () => {
    const findItemIndex = vi.fn(() => 4)
    mock = createMockVlist({ scrollSize: 1000, findItemIndex })
    vlistRef.value = mock
    const { stickToBottom, followToBottom } = useVirtuaFollow({ vlistRef, onStickChange })
    stickToBottom.value = false

    followToBottom(true)

    expect(stickToBottom.value).toBe(true)
    expect(findItemIndex).toHaveBeenCalledWith(1000)
    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' })
    expect(onStickChange).toHaveBeenCalledWith(true)
  })

  describe('W1TC9 showJumpButton 派生 = !stickToBottom && unreadBelow', () => {
    it('① stickToBottom=true / unreadBelow=true → false（贴底时不显示回到底部）', () => {
      vlistRef.value = mock
      const { stickToBottom, unreadBelow, showJumpButton } = useVirtuaFollow({
        vlistRef,
        onStickChange,
      })
      stickToBottom.value = true
      unreadBelow.value = true
      expect(showJumpButton.value).toBe(false)
    })

    it('② stickToBottom=false / unreadBelow=false → false（未贴底但无未读新内容）', () => {
      vlistRef.value = mock
      const { stickToBottom, unreadBelow, showJumpButton } = useVirtuaFollow({
        vlistRef,
        onStickChange,
      })
      stickToBottom.value = false
      unreadBelow.value = false
      expect(showJumpButton.value).toBe(false)
    })

    it('③ stickToBottom=false / unreadBelow=true → true（未贴底且有未读新内容）', () => {
      vlistRef.value = mock
      const { stickToBottom, unreadBelow, showJumpButton } = useVirtuaFollow({
        vlistRef,
        onStickChange,
      })
      stickToBottom.value = false
      unreadBelow.value = true
      expect(showJumpButton.value).toBe(true)
    })

    it('④ 默认（stickToBottom=true / unreadBelow=false）→ false', () => {
      vlistRef.value = mock
      const { showJumpButton } = useVirtuaFollow({ vlistRef, onStickChange })
      expect(showJumpButton.value).toBe(false)
    })
  })
})
