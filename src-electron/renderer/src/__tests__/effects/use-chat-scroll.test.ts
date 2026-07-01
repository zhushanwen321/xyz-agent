/**
 * useChatScroll 单测 —— stickToBottom 真实检测 + unreadBelow + guard（plan.md U13–U17）。
 *
 * 设计：scrollToBottom(behavior, force=false)。
 * - force=false（默认，程序自动滚动）：受 stickToBottom guard，非贴底时不滚只置 unreadBelow
 * - force=true（用户「回到底部」浮层）：强制滚动
 * onScroll 维护 stickToBottom，回贴底时清零 unreadBelow。
 *
 * 覆盖：
 * - U13/U14：onScroll 贴底阈值（BOTTOM_THRESHOLD=40px）
 * - U15：非贴底 + scrollToBottom('auto') guard 拦截 + unreadBelow=true
 * - U16：onScroll 回贴底清零 unreadBelow + stickToBottom=true
 * - U17：贴底态 scrollToBottom('auto') 执行 el.scrollTo + stickToBottom=true
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/effects/use-chat-scroll.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useChatScroll } from '@/composables/effects/useChatScroll'

/**
 * happy-dom 的 HTMLElement 有 scrollTo，但 scrollHeight/scrollTop 默认 0 且不随布局变。
 * 直接 mock scrollEl 的相关属性模拟滚动位置。
 */
function setScroll(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop })
}

describe('useChatScroll · stickToBottom + unreadBelow + guard', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('U13: onScroll 差 41px（>阈值 40）→ stickToBottom=false', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 159) // 1000-800-159 = 41px
    onScroll()
    expect(stickToBottom.value).toBe(false)
  })

  it('U14: onScroll 差 40px（≤阈值）→ stickToBottom=true', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 160) // 1000-800-160 = 40px
    onScroll()
    expect(stickToBottom.value).toBe(true)
  })

  it('U15: 非贴底 + scrollToBottom("auto") 被 guard 拦截 + unreadBelow=true', async () => {
    const { scrollEl, onScroll, scrollToBottom, unreadBelow } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100) // 差 120px，非贴底
    onScroll()
    expect(unreadBelow.value).toBe(false)
    await scrollToBottom('auto') // 程序自动滚动，受 guard
    expect(el.scrollTo).not.toHaveBeenCalled()
    expect(unreadBelow.value).toBe(true)
  })

  it('U16: unreadBelow=true → onScroll 回贴底清零', () => {
    const { scrollEl, onScroll, unreadBelow, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100)
    onScroll() // 非贴底
    unreadBelow.value = true // 模拟新消息到达置位
    // 用户拉到底
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(unreadBelow.value).toBe(false)
    expect(stickToBottom.value).toBe(true)
  })

  it('U17: 贴底态 scrollToBottom("auto") 执行 el.scrollTo + stickToBottom=true', async () => {
    const { scrollEl, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 差 0，贴底
    await scrollToBottom('auto')
    expect(el.scrollTo).toHaveBeenCalled()
    expect(stickToBottom.value).toBe(true)
  })

  it('U15b: 非贴底 + scrollToBottom("smooth", force=true) 强制滚动 + 清 unreadBelow', async () => {
    const { scrollEl, onScroll, scrollToBottom, unreadBelow, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100)
    onScroll() // 非贴底
    unreadBelow.value = true
    // 用户点「回到底部」：强制滚动
    await scrollToBottom('smooth', true)
    expect(el.scrollTo).toHaveBeenCalled()
    expect(stickToBottom.value).toBe(true)
    expect(unreadBelow.value).toBe(false)
  })
})

/**
 * showJumpButton —— 「用户当前不在底部」语义，独立于 unreadBelow。
 * 与 stickToBottom 互斥不变量：showJumpButton === !stickToBottom。
 * 驱动 MessageStream 的「回到底部」浮层 v-if，修复 W3 bug（点击后上滑按钮不重现）。
 */
describe('useChatScroll · showJumpButton', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('U20: 非贴底（差 120px）onScroll → showJumpButton=true', () => {
    const { scrollEl, onScroll, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100) // 1000-800-100 = 120px
    onScroll()
    expect(showJumpButton.value).toBe(true)
  })

  it('U21: 贴底（差 0px）onScroll → showJumpButton=false', () => {
    const { scrollEl, onScroll, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 1000-800-200 = 0px
    onScroll()
    expect(showJumpButton.value).toBe(false)
  })

  it('U22: 上滑(showJumpButton=true) → setScroll 回贴底 → onScroll → showJumpButton=false', () => {
    const { scrollEl, onScroll, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 上滑：非贴底
    setScroll(el, 1000, 800, 100)
    onScroll()
    expect(showJumpButton.value).toBe(true)
    // 用户手动滚回底部（滚轮回底也清，不只点按钮才清）
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(showJumpButton.value).toBe(false)
  })

  it('U23: showJumpButton=true → scrollToBottom("smooth", true) → scrollTo 调用 + showJumpButton=false + stickToBottom=true', async () => {
    const { scrollEl, onScroll, scrollToBottom, showJumpButton, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100) // 非贴底
    onScroll()
    expect(showJumpButton.value).toBe(true)
    await scrollToBottom('smooth', true)
    expect(el.scrollTo).toHaveBeenCalled()
    expect(showJumpButton.value).toBe(false)
    expect(stickToBottom.value).toBe(true)
  })

  it('U24: 贴底→上滑→点按钮回底→再上滑 → 按钮每次上滑都出现（核心 bug 回归）', () => {
    const { scrollEl, onScroll, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 贴底
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(showJumpButton.value).toBe(false)
    // 上滑
    setScroll(el, 1000, 800, 100)
    onScroll()
    expect(showJumpButton.value).toBe(true)
    // 点按钮回底（这里用 onScroll 模拟滚回底清按钮，等价 W3 修复后行为）
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(showJumpButton.value).toBe(false)
    // 再上滑 → 按钮必须再次出现（原 bug 在此：unreadBelow 不会再被置 true）
    setScroll(el, 1000, 800, 100)
    onScroll()
    expect(showJumpButton.value).toBe(true)
  })

  it('U25: 阈值边界——差 41px→showJumpButton=true，差 40px→showJumpButton=false', () => {
    const { scrollEl, onScroll, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 差 41px（>阈值）
    setScroll(el, 1000, 800, 159) // 1000-800-159 = 41px
    onScroll()
    expect(showJumpButton.value).toBe(true)
    // 差 40px（≤阈值）
    setScroll(el, 1000, 800, 160) // 1000-800-160 = 40px
    onScroll()
    expect(showJumpButton.value).toBe(false)
  })

  it('U25b: showJumpButton=true → scrollToBottom("auto", true)（切 session）→ showJumpButton=false', async () => {
    const { scrollEl, onScroll, scrollToBottom, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100) // 非贴底
    onScroll()
    expect(showJumpButton.value).toBe(true)
    // 切会话强制滚到底
    await scrollToBottom('auto', true)
    expect(showJumpButton.value).toBe(false)
  })
})

/**
 * ResizeObserver 自动跟随滚动（W4）—— 解决流式渲染竞态：
 * - thinking/tool 块增高内容但 content.length 不变 → watcher 不触发，靠 ResizeObserver 兜底
 * - Markdown/shiki 异步渲染，内容增高时贴底态自动 scrollToBottom 跟随
 * observe(target) 接受内容根元素，内容增高回调里 if (stickToBottom) scrollToBottom('auto')。
 */
describe('useChatScroll · ResizeObserver auto-follow', () => {
  /** mock 构造函数，捕获回调 cb + 记录实例方法；返回用于手动驱动回调的辅助器 */
  function mockResizeObserver(): {
    trigger: () => void
    instances: Array<{ observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>
  } {
    const instances: Array<{ observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
    let latestCb: ((entries: unknown[]) => void) | null = null
    // 用 class 形式（原生支持 new）；实例方法用 vi.fn 以便断言
    class MockRO {
      constructor(cb: (entries: unknown[]) => void) {
        latestCb = cb
        const inst = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
        instances.push(inst)
        return inst
      }
    }
    globalThis.ResizeObserver = MockRO as unknown as typeof ResizeObserver
    return {
      trigger: () => {
        if (latestCb) latestCb([])
      },
      instances,
    }
  }

  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('U26: stickToBottom=true，observe 后触发高度变化回调 → scrollToBottom 被调用（内容增高自动跟随）', async () => {
    const ro = mockResizeObserver()
    const { scrollEl, onScroll, observe } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底
    onScroll()
    observe(el)
    // 模拟内容增高触发 ResizeObserver 回调（scrollToBottom 内 await nextTick + rAF）
    ro.trigger()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(el.scrollTo).toHaveBeenCalled()
  })

  it('U27: stickToBottom=false（上滑），触发高度变化回调 → 不滚动（尊重上滑）', async () => {
    const ro = mockResizeObserver()
    const { scrollEl, onScroll, observe } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100) // 非贴底
    onScroll()
    observe(el)
    ro.trigger()
    await nextTick()
    expect(el.scrollTo).not.toHaveBeenCalled()
  })

  it('U28: 回调入队时贴底，回调执行前用户上滑 → 回调读当前 stickToBottom=false → 不拉回', async () => {
    const ro = mockResizeObserver()
    const { scrollEl, onScroll, observe, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底
    onScroll()
    expect(stickToBottom.value).toBe(true)
    observe(el)
    // 回调已入队（待执行）。执行前用户手动上滑：
    setScroll(el, 1000, 800, 100)
    onScroll()
    expect(stickToBottom.value).toBe(false)
    // 回调现在执行 → 读 stickToBottom 当前值=false → 不应滚动
    ro.trigger()
    await nextTick()
    expect(el.scrollTo).not.toHaveBeenCalled()
  })

  it('U29: 贴底态，trace 折叠高度减小触发回调 → scrollToBottom 仍只往底滚（视口对齐底部，不上漂）', async () => {
    const ro = mockResizeObserver()
    const { scrollEl, onScroll, observe } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底
    onScroll()
    observe(el)
    // trace 折叠：scrollHeight 骤减，但回调触发 scrollToBottom 仍 scrollTo({ top: scrollHeight })
    // 这里验证：scrollTo 被调用，且 top 参数 = 当前 scrollHeight（不反向跳到更上方）
    setScroll(el, 700, 800, 200)
    ro.trigger()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(el.scrollTo).toHaveBeenCalledTimes(1)
    expect(el.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 700 }))
  })

  it('U30: 触发 onScopeDispose → observer.disconnect() 被调用，无泄漏', async () => {
    const ro = mockResizeObserver()
    // effectScope 包裹以驱动 onScopeDispose
    const { effectScope } = await import('vue')
    const scope = effectScope()
    let api: ReturnType<typeof useChatScroll> | null = null
    await scope.run(() => {
      api = useChatScroll()
      const el = document.createElement('div')
      api!.scrollEl.value = el
      api!.observe(el)
      return undefined
    })
    expect(ro.instances.length).toBe(1)
    expect(ro.instances[0].disconnect).not.toHaveBeenCalled()
    // 销毁作用域 → onScopeDispose 触发 → disconnect
    scope.stop()
    expect(ro.instances[0].disconnect).toHaveBeenCalledTimes(1)
  })
})
