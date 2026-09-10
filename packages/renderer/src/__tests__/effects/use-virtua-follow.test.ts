/**
 * useVirtuaFollow 单测（cw wave w1 / W1CO2 mock 工厂 + W1TC1-W1TC9）。
 *
 * 覆盖 follow 状态机：
 * - onWheel 上滑 → stickToBottom=false
 * - onScroll distance≤40 → stickToBottom=true（只单向翻真）
 * - followIfStuck 受 stickToBottom guard（含 INVAR-M4-2 rAF 内重读）
 * - followToBottom(force) 强制贴底
 * - showJumpButton 派生 = !stickToBottom && unreadBelow
 *
 * mock 策略：不 mount 真实 virtua 组件（happy-dom 下 Virtualizer 行为不可控），
 * 用 createMockVlist 造一个满足 VirtualizerHandle 接口、可断言调用的 mock 对象，
 * 注入 vlistRef。滚动目标由 itemCount() - 1 直取（D1，chat-pin-bottom-fix）——
 * 测试注入固定 itemCount 让结果可预测，并断言 findItemIndex 反查（R3 禁用模式）
 * 不再被调用。
 *
 * fake timers：W1TC7 用 vi.useFakeTimers 控制 rAF（实现用 requestAnimationFrame）。
 * 其余用例不需要 rAF 控制（followIfStuck 调用后立即 advance/flush 或不依赖 rAF 时序），
 * 但为统一仍用 fake timers 并在断言前 flush。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, type Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'
import { useVirtuaFollow } from '@/composables/panel/useVirtuaFollow'
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

  it('W1TC5 followIfStuck stickToBottom=true 调 scrollToIndex(itemCount-1, {align:"end"})（D1 索引直取）', async () => {
    // D1：末项索引 = itemCount() - 1 直取（mock 5 项 → last index 4）；findItemIndex 反查（R3
    // 禁用模式）不得被调用
    const findItemIndex = vi.fn(() => 4)
    mock = createMockVlist({ scrollSize: 1000, findItemIndex })
    vlistRef.value = mock
    const { stickToBottom, followIfStuck } = useVirtuaFollow({
      vlistRef,
      itemCount: () => 5,
      onStickChange,
    })
    expect(stickToBottom.value).toBe(true)

    followIfStuck()
    // 实现用 rAF schedule，flush 后才执行
    await vi.advanceTimersByTimeAsync(16)

    expect(findItemIndex).not.toHaveBeenCalled()
    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })
  })

  it('W1TC5b endOffset 注入 → scrollToIndex 携带正偏移（D2 尾部块高度补偿）', async () => {
    mock = createMockVlist({ scrollSize: 1000 })
    vlistRef.value = mock
    const { followIfStuck } = useVirtuaFollow({
      vlistRef,
      itemCount: () => 5,
      endOffset: () => 28,
      onStickChange,
    })

    followIfStuck()
    await vi.advanceTimersByTimeAsync(16)

    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 28 })
  })

  it('W1TC5c itemCount=0（空列表）→ 不滚（无末项可滚）', async () => {
    mock = createMockVlist({ scrollSize: 0 })
    vlistRef.value = mock
    const { followIfStuck } = useVirtuaFollow({
      vlistRef,
      itemCount: () => 0,
      onStickChange,
    })

    followIfStuck()
    await vi.advanceTimersByTimeAsync(16)

    expect(mock.scrollToIndex).not.toHaveBeenCalled()
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

  it('W1TC8 followToBottom(force=true) 无视 stickToBottom，强制滚到底并翻回 true（D1 索引直取）', () => {
    const findItemIndex = vi.fn(() => 4)
    mock = createMockVlist({ scrollSize: 1000, findItemIndex })
    vlistRef.value = mock
    const { stickToBottom, followToBottom } = useVirtuaFollow({
      vlistRef,
      itemCount: () => 5,
      onStickChange,
    })
    stickToBottom.value = false

    followToBottom(true)

    expect(stickToBottom.value).toBe(true)
    expect(findItemIndex).not.toHaveBeenCalled()
    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })
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

  describe('vlistBottom 定位基线（D6，收拢自 MessageStream.vue）', () => {
    it('① 末项索引直取：getItemOffset(itemCount-1)+getItemSize(itemCount-1)，不调 findItemIndex（R3）', () => {
      const findItemIndex = vi.fn(() => 4)
      mock = createMockVlist({
        scrollSize: 1000,
        findItemIndex,
        getItemOffset: vi.fn((i: number) => 100 * i),
        getItemSize: vi.fn(() => 200),
      })
      vlistRef.value = mock
      const { vlistBottom } = useVirtuaFollow({ vlistRef, itemCount: () => 5, onStickChange })

      expect(vlistBottom.value).toBe(600) // 100*4 + 200
      expect(mock.getItemOffset).toHaveBeenCalledWith(4)
      expect(findItemIndex).not.toHaveBeenCalled()
    })

    it('② 边界：vlistRef 未挂载 / scrollSize=0 / itemCount≤0 → 0', () => {
      // vlistRef null（beforeEach 初始 null，首帧未挂载）
      const a = useVirtuaFollow({ vlistRef, itemCount: () => 5, onStickChange })
      expect(a.vlistBottom.value).toBe(0)

      // 空数据 scrollSize=0
      mock = createMockVlist({ scrollSize: 0 })
      vlistRef.value = mock
      const b = useVirtuaFollow({ vlistRef, itemCount: () => 5, onStickChange })
      expect(b.vlistBottom.value).toBe(0)

      // 空列表 itemCount=0
      vlistRef.value = createMockVlist({ scrollSize: 1000 })
      const c = useVirtuaFollow({ vlistRef, itemCount: () => 0, onStickChange })
      expect(c.vlistBottom.value).toBe(0)
    })
  })
})
