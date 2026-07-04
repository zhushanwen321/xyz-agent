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
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/effects/use-chat-scroll.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
 * programmaticScrolling guard —— smooth 滚动动画期间 onScroll 不翻转 stickToBottom。
 *
 * [HISTORICAL] 事故：用户点「回到底部」→ scrollToBottom('smooth', true) 启动动画 →
 * 动画中途每帧触发 onScroll，读到非终态位置（distance > 阈值）→ stickToBottom 被翻 false →
 * 后续 streaming 的 scrollToBottom('auto')（force=false）全被 guard 拦截 → streaming 不跟随。
 * 修复：smooth 期间置 programmaticScrolling=true，onScroll 检测到此标志直接 return，
 * scrollend / 超时清除。
 */
describe('useChatScroll · programmaticScrolling guard（smooth 动画锚定保护）', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  // U26:核心回归 —— smooth 滚动后，动画中途 onScroll（非贴底位置）不翻转 stickToBottom
  it('U26: scrollToBottom("smooth", true) 后 onScroll 读到中途位置（差 200px）→ stickToBottom 保持 true', async () => {
    const { scrollEl, onScroll, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 起始非贴底（用户点了「回到底部」按钮）
    setScroll(el, 1000, 800, 100)
    await scrollToBottom('smooth', true)
    expect(stickToBottom.value).toBe(true)
    // smooth 动画第 N 帧到达中途位置（差 200px，非终态）
    setScroll(el, 1000, 800, 0) // 1000-800-0 = 200px，仍非贴底
    onScroll()
    // 关键断言：保护期内 stickToBottom 不被翻转（否则 streaming scrollToBottom 被 guard 拦）
    expect(stickToBottom.value).toBe(true)
  })

  // U27:scrollend 触发后保护期结束，onScroll 恢复正常判定
  it('U27: smooth 滚动后派发 scrollend → onScroll 恢复正常（用户上滑能翻 false）', async () => {
    const { scrollEl, onScroll, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100)
    await scrollToBottom('smooth', true)
    // 模拟 scrollend（浏览器动画结束派发）
    el.dispatchEvent(new Event('scrollend'))
    // 保护期结束后，用户上滑到非贴底 → onScroll 正常翻 false
    setScroll(el, 1000, 800, 0) // 差 200px
    onScroll()
    expect(stickToBottom.value).toBe(false)
  })

  // U28:'auto' 瞬间滚动不进入保护期（onScroll 正常判定，强化贴底）
  it('U28: scrollToBottom("auto") 不触发保护期——后续 onScroll 正常判定', async () => {
    const { scrollEl, onScroll, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底
    await scrollToBottom('auto')
    // auto 不进保护期：若随后用户上滑，onScroll 应立即翻 false（无保护期延迟）
    setScroll(el, 1000, 800, 100) // 差 100px
    onScroll()
    expect(stickToBottom.value).toBe(false)
  })

  // U29:超时兜底清除保护期（scrollend 不触发的浏览器/场景）
  it('U29: smooth 后 scrollend 未触发 → 超时后保护期清除，onScroll 恢复正常', async () => {
    vi.useFakeTimers()
    const { scrollEl, onScroll, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100)
    await scrollToBottom('smooth', true)
    // 保护期内 onScroll 不翻转
    setScroll(el, 1000, 800, 0)
    onScroll()
    expect(stickToBottom.value).toBe(true)
    // 超时兜底触发（SMOOTH_SCROLL_GUARD_MS=600ms）
    vi.advanceTimersByTime(700)
    // 超时后 onScroll 恢复正常判定
    setScroll(el, 1000, 800, 0) // 差 200px
    onScroll()
    expect(stickToBottom.value).toBe(false)
    vi.useRealTimers()
  })

  // U30:streaming 连续 scrollToBottom('auto') 在 smooth 保护期内不被 guard 拦截
  // （这是事故的精确复现：smooth 后 streaming 跟随失效）
  it('U30: smooth 保护期内 scrollToBottom("auto")（streaming 跟随）不被 guard 拦截', async () => {
    const { scrollEl, onScroll, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 100)
    // 用户点「回到底部」→ smooth 动画启动
    await scrollToBottom('smooth', true)
    // 动画中途触发 onScroll（旧实现会翻 false）
    setScroll(el, 1000, 800, 50) // 差 150px
    onScroll()
    // streaming 内容追加 → scrollToBottom('auto')（force=false）必须通过 guard
    setScroll(el, 1100, 800, 50) // 新内容让 scrollHeight 增长
    await scrollToBottom('auto')
    // 关键：auto 滚动执行了（未被 guard 拦），stickToBottom 保持 true
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: 'auto' })
    expect(stickToBottom.value).toBe(true)
  })
})
