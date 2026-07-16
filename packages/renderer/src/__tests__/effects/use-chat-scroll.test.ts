/**
 * useChatScroll 单测 —— 锚定判定机制（用户输入信号驱动）。
 *
 * 核心不变量：**stickToBottom = false 只由确定的用户输入信号驱动，onScroll 永远不翻 false。**
 *
 * - 用户上滑 → false：onWheel（deltaY<0）或 onScroll 检测 scrollTop 明显减小
 * - 回到底部 → true：onScroll 检测 distance ≤ BOTTOM_THRESHOLD
 * - showJumpButton === !stickToBottom（computed 不变量）
 *
 * 覆盖：
 * - U13/U14：onScroll 贴底阈值（BOTTOM_THRESHOLD=40px）→ 回到底部翻 true
 * - U15：非贴底 + scrollToBottom('auto') guard 拦截 + unreadBelow=true
 * - U16：onScroll 回贴底清零 unreadBelow + stickToBottom=true
 * - U17：贴底态 scrollToBottom('auto') 执行 el.scrollTo + stickToBottom=true
 * - U15b：非贴底 + scrollToBottom('smooth', force=true) 强制滚动
 * - U20-U25b：showJumpButton（computed 不变量）
 * - U33：onWheel deltaY<0 → stickToBottom=false（用户上滑主路径）
 * - U34：onWheel deltaY>0（下滚）→ 不改变 stickToBottom
 * - U35：onScroll scrollTop 明显减小 → stickToBottom=false（scrollbar/键盘兜底）
 * - U36：程序性 scrollToBottom 后 onScroll（异步增长 distance>阈值）→ 保持 true（核心回归）
 * - U37：showJumpButton === !stickToBottom 任意翻转后校验（computed 不变量）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/effects/use-chat-scroll.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, effectScope } from 'vue'
import type { Ref } from 'vue'
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

/** 构造 wheel 事件（happy-dom 的 WheelEvent 支持 deltaY） */
function wheelEvent(deltaY: number): WheelEvent {
  return new WheelEvent('wheel', { deltaY })
}

/**
 * 绑定 scrollEl 并等待 watch 回调执行（wheel listener 在 watch(scrollEl) 的
 * pre-flush 回调里注册，需 await nextTick 后才绑上）。生产环境无影响（用户不可能
 * 挂载后 0ms 内滚动），仅测试时序需要。
 */
async function bindScroll(scrollEl: Ref<HTMLElement | null>, el: HTMLElement): Promise<void> {
  scrollEl.value = el
  await nextTick()
}

/**
 * ResizeObserver mock：useChatScroll 用它观察 contentEl 高度变化。
 * happy-dom 不提供 ResizeObserver，必须 stub，否则 watch(contentEl) 启动时报错。
 * mock 的 observe/unobserve/disconnect 为空操作——单测不模拟真实尺寸回调，
 * 高度变化驱动的滚动跟随靠手动调 scrollToBottom 验证（ResizeObserver 只是触发器）。
 */
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

describe('useChatScroll · stickToBottom + unreadBelow + guard', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('U13: onScroll 差 41px（>阈值 40）但 scrollTop 未减小 → stickToBottom 保持 true（onScroll 不翻 false）', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 159) // 1000-800-159 = 41px，scrollTop=159 > lastScrollTop=0（未减小）
    onScroll()
    // 核心不变量：onScroll 永不翻 false。程序性滚动后 scrollTop 增大但 distance>阈值不应误判脱离
    expect(stickToBottom.value).toBe(true)
  })

  it('U14: onScroll 差 40px（≤阈值）→ stickToBottom=true（回到底部）', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 160) // 1000-800-160 = 40px
    onScroll()
    expect(stickToBottom.value).toBe(true)
  })

  it('U15: 非贴底 + scrollToBottom("auto") 被 guard 拦截 + unreadBelow=true', async () => {
    const { scrollEl, scrollToBottom, unreadBelow, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100) // 差 120px
    // 用户先上滑脱离锚定
    el.dispatchEvent(wheelEvent(-100))
    expect(stickToBottom.value).toBe(false)
    expect(unreadBelow.value).toBe(false)
    await scrollToBottom('auto') // 程序自动滚动，受 guard
    expect(el.scrollTo).not.toHaveBeenCalled()
    expect(unreadBelow.value).toBe(true)
  })

  it('U16: unreadBelow=true → onScroll 回贴底清零', async () => {
    const { scrollEl, onScroll, unreadBelow, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100)
    // 用户上滑脱离 + 程序滚动被 guard 拦置 unreadBelow
    el.dispatchEvent(wheelEvent(-100))
    onScroll()
    unreadBelow.value = true // 模拟新消息到达置位
    // 用户拉到底（scrollTop 增大到贴底）
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
    const { scrollEl, scrollToBottom, unreadBelow, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100)
    el.dispatchEvent(wheelEvent(-100)) // 用户上滑脱离
    expect(stickToBottom.value).toBe(false)
    unreadBelow.value = true
    // 用户点「回到底部」：强制滚动
    await scrollToBottom('smooth', true)
    expect(el.scrollTo).toHaveBeenCalled()
    expect(stickToBottom.value).toBe(true)
    expect(unreadBelow.value).toBe(false)
  })
})

/**
 * showJumpButton —— computed(() => !stickToBottom.value)，与 stickToBottom 互斥。
 * 驱动 MessageStream 的「回到底部」浮层 v-if。computed 保证不变量，无需手动同步。
 */
describe('useChatScroll · showJumpButton（computed 不变量）', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('U20: 用户上滑（wheel deltaY<0）→ showJumpButton=true', async () => {
    const { scrollEl, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100)
    expect(showJumpButton.value).toBe(false) // 初始贴底
    el.dispatchEvent(wheelEvent(-100))
    expect(showJumpButton.value).toBe(true)
  })

  it('U21: 贴底（初始）→ showJumpButton=false', () => {
    const { scrollEl, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 差 0，贴底
    expect(showJumpButton.value).toBe(false)
  })

  it('U22: 上滑→onScroll 回贴底→showJumpButton=false', async () => {
    const { scrollEl, onScroll, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100)
    el.dispatchEvent(wheelEvent(-100)) // 上滑脱离
    expect(showJumpButton.value).toBe(true)
    // 用户滚回底部
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(showJumpButton.value).toBe(false)
  })

  it('U23: showJumpButton=true → scrollToBottom("smooth", true) → showJumpButton=false + stickToBottom=true', async () => {
    const { scrollEl, scrollToBottom, showJumpButton, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100) // 非贴底
    el.dispatchEvent(wheelEvent(-100)) // 上滑脱离
    expect(showJumpButton.value).toBe(true)
    await scrollToBottom('smooth', true)
    expect(showJumpButton.value).toBe(false)
    expect(stickToBottom.value).toBe(true)
  })

  it('U24: 贴底→上滑→回底→再上滑 → 按钮每次上滑都出现（computed 重新跟随）', async () => {
    const { scrollEl, onScroll, scrollToBottom, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 200) // 贴底
    expect(showJumpButton.value).toBe(false)
    // 上滑
    el.dispatchEvent(wheelEvent(-100))
    expect(showJumpButton.value).toBe(true)
    // 点按钮回底（force=true 设 stickToBottom=true，computed 自动同步）
    await scrollToBottom('smooth', true)
    expect(showJumpButton.value).toBe(false)
    // 再上滑 → 按钮必须再次出现
    el.dispatchEvent(wheelEvent(-100))
    expect(showJumpButton.value).toBe(true)
  })

  it('U25: 阈值边界——onScroll 差 40px→stickToBottom=true，差 41px（scrollTop 未减）→保持 true', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 差 41px，scrollTop 增大（程序性滚动后），不翻 false
    setScroll(el, 1000, 800, 159)
    onScroll()
    expect(stickToBottom.value).toBe(true)
    // 差 40px（≤阈值）→ 回底翻 true
    setScroll(el, 1000, 800, 160)
    onScroll()
    expect(stickToBottom.value).toBe(true)
  })

  it('U25b: showJumpButton=true → scrollToBottom("auto", true)（切 session）→ showJumpButton=false', async () => {
    const { scrollEl, scrollToBottom, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100) // 非贴底
    el.dispatchEvent(wheelEvent(-100)) // 上滑脱离
    expect(showJumpButton.value).toBe(true)
    // 切会话强制滚到底
    await scrollToBottom('auto', true)
    expect(showJumpButton.value).toBe(false)
  })
})

/**
 * 锚定判定机制 —— wheel + scrollTop 方向 + 程序性滚动不误判。
 *
 * 核心不变量：onScroll 永不把 stickToBottom 翻 false。翻 false 只由：
 * - onWheel deltaY<0（用户滚轮/触控板上滑）
 * - onScroll 检测 scrollTop 明显减小（拖滚动条/键盘，兜底非 wheel 上滑）
 */
describe('useChatScroll · 锚定判定（wheel + scrollTop 方向）', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  // U33:用户滚轮上滑 → stickToBottom=false（主路径）
  it('U33: onWheel deltaY<0（上滑）→ stickToBottom=false', async () => {
    const { scrollEl, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    expect(stickToBottom.value).toBe(true)
    el.dispatchEvent(wheelEvent(-100))
    expect(stickToBottom.value).toBe(false)
  })

  // U34:用户下滚不改变 stickToBottom（回到底部由 onScroll 的 distance 判定）
  it('U34: onWheel deltaY>0（下滚）→ 不改变 stickToBottom', async () => {
    const { scrollEl, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 100)
    // 先上滑脱离
    el.dispatchEvent(wheelEvent(-100))
    expect(stickToBottom.value).toBe(false)
    // 下滚：不应自动恢复贴底（需 onScroll distance 判定）
    el.dispatchEvent(wheelEvent(100))
    expect(stickToBottom.value).toBe(false)
  })

  // U35:onScroll 检测 scrollTop 明显减小 → false（拖滚动条/键盘兜底）
  it('U35: onScroll scrollTop 明显减小（>SCROLL_UP_DELTA=10）→ stickToBottom=false', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 先模拟程序滚到底（scrollTop=200，lastScrollTop 更新为 200）
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(stickToBottom.value).toBe(true)
    // 用户拖滚动条上滑（scrollTop 减小到 100，减小 100px > 10）
    setScroll(el, 1000, 800, 100)
    onScroll()
    expect(stickToBottom.value).toBe(false)
  })

  // U35b:scrollTop 减小但不超过 SCROLL_UP_DELTA → 不误判（防抖动）
  it('U35b: onScroll scrollTop 减小 ≤SCROLL_UP_DELTA（≤10px）→ stickToBottom 不变（防抖动）', () => {
    const { scrollEl, onScroll, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200)
    onScroll()
    // scrollTop 仅减小 5px（< 10）——可能是浏览器抖动或亚像素，不视为用户上滑
    setScroll(el, 1000, 800, 195)
    onScroll()
    expect(stickToBottom.value).toBe(true)
  })

  // U36 [核心回归]：程序性 scrollToBottom 后内容异步增长 → onScroll 读 distance>阈值但 scrollTop 未减 → 保持 true
  // （精确复现本次 bug：streaming 中点「回到底部」后 AI 返回 text，锚定失效）
  it('U36: 程序性 scrollToBottom 后 onScroll（异步增长 distance>阈值）→ stickToBottom 保持 true', async () => {
    const { scrollEl, onScroll, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    // 场景：内容高 1000，视口 800，用户已滚到底（scrollTop=200，贴底）
    setScroll(el, 1000, 800, 200)
    onScroll() // lastScrollTop=200
    expect(stickToBottom.value).toBe(true)
    // 用户点「回到底部」（force=true），scrollToBottom 写 scrollTop=scrollHeight-... = 200
    await scrollToBottom('smooth', true)
    expect(stickToBottom.value).toBe(true)
    // 模拟 streaming 异步增长：scrollHeight 从 1000 涨到 1500，scrollTop 仍是 200（程序写的旧值）
    // 此时 distance = 1500-200-800 = 500 > 阈值，但 scrollTop 未减小（200 == lastScrollTop）
    setScroll(el, 1500, 800, 200)
    onScroll()
    // 核心断言：不能误判脱离（这正是旧实现 bug 的精确复现）
    expect(stickToBottom.value).toBe(true)
    // 随后 ResizeObserver/scrollToBottom('auto') 跟随滚动应继续生效
    await scrollToBottom('auto')
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1500, behavior: 'auto' })
  })

  // U37:computed 不变量——任意翻转后 showJumpButton === !stickToBottom
  it('U37: showJumpButton === !stickToBottom（computed 不变量，多轮翻转校验）', async () => {
    const { scrollEl, onScroll, scrollToBottom, stickToBottom, showJumpButton } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)

    // 初始贴底
    setScroll(el, 1000, 800, 200)
    onScroll()
    expect(showJumpButton.value).toBe(!stickToBottom.value)

    // 上滑脱离
    el.dispatchEvent(wheelEvent(-100))
    expect(showJumpButton.value).toBe(!stickToBottom.value)

    // 强制回底
    await scrollToBottom('smooth', true)
    expect(showJumpButton.value).toBe(!stickToBottom.value)

    // 再次上滑
    el.dispatchEvent(wheelEvent(-100))
    expect(showJumpButton.value).toBe(!stickToBottom.value)
  })
})

/**
 * M4（perf-quick-batch）：scrollToBottom rAF trailing 节流。
 *
 * 现状缺陷：MessageStream 三个触发源（watch currentMessages.length / watch last.content.length
 * / ResizeObserver）都无节流调 scrollToBottom。流式每个 token 触发一次 → 高频 scrollTo。
 * scrollToBottom 内 await nextTick + el.scrollTo，无 rAF/debounce 合并。
 *
 * 修复目标：scrollToBottom 加 rAF trailing throttle。
 * - INVAR-M4-2【关键】: stickToBottom 在 rAF 执行时读取而非调用时捕获（否则把上滑用户扯回底部）
 * - INVAR-M4-3: trailing 保证末次执行
 * - INVAR-M4-5: 卸载 cancelAnimationFrame 防 after-unmount
 *
 * [红灯] 当前 scrollToBottom 无节流，每次调用立即执行 → 高频调用 scrollTo 次数 = 调用次数 → fail。
 */
describe('useChatScroll · M4 rAF trailing 节流', () => {
  let rafCallbacks: FrameRequestCallback[]
  let originalRAF: typeof requestAnimationFrame
  let originalCAF: typeof cancelAnimationFrame

  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
    // 手动控制 rAF：收集回调，不自动执行（测试显式 flush）
    rafCallbacks = []
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const handle = rafCallbacks.length
      rafCallbacks.push(cb)
      return handle // fake handle = 数组索引
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((handle: number) => {
      // 按 handle 索引移除回调（cancel 后 flush 不应执行它）
      if (rafCallbacks[handle] !== undefined) rafCallbacks[handle] = undefined as unknown as FrameRequestCallback
    }) as typeof cancelAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
  })

  /** flush 所有 pending rAF 回调（跳过已被 cancel 的）。 */
  function flushRAF(): void {
    const pending = rafCallbacks.splice(0).filter((cb): cb is FrameRequestCallback => cb !== undefined)
    pending.forEach((cb) => cb(0))
  }

  /**
   * M4-1: 一帧内连续触发 100 次 scrollToBottom，el.scrollTo 实际执行 1 次。
   *
   * [红灯] 当前无节流，100 次调用 → 100 次 scrollTo → fail。
   */
  it('M4-1: 一帧内触发 100 次 scrollToBottom → el.scrollTo 执行 1 次', async () => {
    const { scrollEl, scrollToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底

    // 连续调 100 次（模拟流式高频 token）。节流后调用返回的 Promise 在 flush 后 resolve，
    // 这里不逐个 await（节流场景调方也不该逐个 await），fire-and-forget。
    for (let i = 0; i < 100; i++) {
      void scrollToBottom('auto')
    }
    flushRAF()
    await nextTick() // flushScroll 内 await nextTick 后才 scrollTo

    expect(vi.mocked(el.scrollTo)).toHaveBeenCalledTimes(1)
  })

  /**
   * M4-2: 调用时 stickToBottom=true，rAF 执行前用户上滑翻 false → 不 scrollTo。
   *
   * 这验证 INVAR-M4-2：guard 延迟求值。若节流在调用时捕获 stickToBottom=true，
   * trailing 执行时仍会滚 → 把上滑用户扯回底部。
   */
  it('M4-2: 调用时贴底、rAF 执行前上滑翻 false → 不 scrollTo（延迟求值守卫）', async () => {
    const { scrollEl, scrollToBottom, stickToBottom } = useChatScroll()
    const el = document.createElement('div')
    await bindScroll(scrollEl, el)
    setScroll(el, 1000, 800, 200) // 贴底
    expect(stickToBottom.value).toBe(true)

    // 调 scrollToBottom（此时贴底，guard 放行调度 rAF）——不 flush，不 await（节流）
    void scrollToBottom('auto')
    // 在 rAF 执行前，用户上滑脱离
    el.dispatchEvent(wheelEvent(-100))
    expect(stickToBottom.value).toBe(false)

    // 现在 flush rAF：因为执行时 stickToBottom 已 false，不应 scrollTo
    flushRAF()
    await nextTick()
    expect(vi.mocked(el.scrollTo)).not.toHaveBeenCalled()
  })

  /**
   * M4-3: 末次触发后 trailing 执行（贴底态下最终滚到底）。
   */
  it('M4-3: 贴底态连续触发后 flush rAF → 末次执行 scrollTo（trailing）', async () => {
    const { scrollEl, scrollToBottom } = useChatScroll()
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底

    void scrollToBottom('auto')
    void scrollToBottom('auto')
    flushRAF()
    await nextTick()

    expect(vi.mocked(el.scrollTo)).toHaveBeenCalledTimes(1)
  })

  /**
   * M4-4: 卸载时 pending rAF 被取消（INVAR-M4-5 / AC-M4-4）。
   *
   * 防止组件卸载后 flushScroll 对已卸载 el 调 scrollTo 报错。
   * 在 effectScope 内调度 rAF，dispose scope 后 flushRAF 不应触发 scrollTo。
   */
  it('M4-4: effectScope dispose 后 pending rAF 被取消，flush 不触发 scrollTo', async () => {
    const scope = effectScope()
    let scoped: ReturnType<typeof useChatScroll> | undefined
    scope.run(() => {
      scoped = useChatScroll()
    })
    const { scrollEl, scrollToBottom } = scoped!
    const el = document.createElement('div')
    scrollEl.value = el
    setScroll(el, 1000, 800, 200) // 贴底

    // 调度 rAF（不 flush）
    void scrollToBottom('auto')
    expect(rafCallbacks.length).toBeGreaterThan(0)

    // 卸载：onScopeDispose 应取消 rAF（effectScope.stop 触发 onScopeDispose）
    scope.stop()

    // 手动 flush 残留回调（模拟 rAF 到点）——因已 cancelAnimationFrame，
    // flushScroll 不应执行，scrollTo 未被调用
    flushRAF()
    await nextTick()
    expect(vi.mocked(el.scrollTo)).not.toHaveBeenCalled()
  })
})
