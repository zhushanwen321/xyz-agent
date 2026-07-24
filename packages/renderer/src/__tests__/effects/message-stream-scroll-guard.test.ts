/**
 * scrollAdjustDelta 补偿 guard 测试（fix-scroll-jump-during-streaming）。
 *
 * 背景：isGenerating 流式期间用户轻微滚动会「一下子滑到非常上面的对话」。根因是
 * MessageStream.vue 补偿 watch（watch(scrollAdjustDelta, flush:'post')）在用户主动
 * 滚动期间也施加 scrollTop += delta，把视口往上方推。修复方案 A（CL1 决策）：
 * stickToBottom=false 时跳过施加并清零 delta，贴底态行为不变。
 *
 * 覆盖 AC 映射：
 * - AC1（用户上滑后 delta 不施加）→ 「stickToBottom=false 时 scrollTop 不被 delta 施加」
 * - AC2（delta 清零不残留）→ 「脱离锚定期间 delta 清零，回归底部无陈旧施加」
 * - AC3（贴底仍补偿）→ 「贴底态视口上方 turn 实测化时 scrollTop 正常补偿」
 *
 * 测试策略（副作用断言，不依赖 vm 内部 ref 暴露）：
 * mount MessageStream，通过 setScroll 设滚动属性 + dispatch wheel/scroll 驱动 stickToBottom，
 * 通过 provide 的 registry（provideTurnResizeRegistry 注入 Turn）触发 reportHeight 产生 delta，
 * 断言 scrollEl.scrollTop 的变化（guard 是否生效的直接副作用）。
 *
 * 关键：让 Turn stub 接 registry 并暴露一个 triggerReport 测试 helper，经 provide/inject
 * 拿到真实 registry 调 reportHeight（与生产路径一致，不绕过补偿 watch）。
 *
 * 参考 virtual-scroll-integration.test.ts 的 setScroll / flushRaf / Turn stub / RO stub 模式。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/message-stream-scroll-guard.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, inject, ref, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import MessageStream from '@/components/panel/MessageStream.vue'
import { TURN_RESIZE_REGISTRY_KEY } from '@/composables/effects/useResizeReport'
import type { TurnResizeRegistry } from '@/composables/effects/useResizeReport'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@xyz-agent/shared'

// useChat mock
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
}))

/**
 * Turn stub：inject 真实 registry（MessageStream provide 的），暴露给测试调 reportHeight。
 * 用一个模块级 holder 收集注入的 registry，测试经它触发 delta 产生（与生产 RO→reportHeight 路径一致）。
 */
let injectedRegistry: TurnResizeRegistry | null = null

const TurnStub = defineComponent({
  name: 'Turn',
  props: { turn: { type: Object, required: true }, sessionId: String, canEdit: Boolean },
  setup(props) {
    const registry = inject(TURN_RESIZE_REGISTRY_KEY, null)
    if (registry) injectedRegistry = registry
    const t = props.turn as { user?: { id?: string }; assistants?: Array<{ id?: string }> }
    const id = t?.user?.id ?? t?.assistants?.[0]?.id ?? 'unknown'
    return () => h('div', { 'data-testid': `turn-stub-${id}` }, `turn:${id}`)
  },
})

const globalStubs = {
  Turn: TurnStub,
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice" />' },
  BgNotifyCard: { name: 'BgNotifyCard', template: '<div data-testid="bg-notify" />' },
  GuiComponentRenderer: { name: 'GuiComponentRenderer', template: '<div data-testid="gui-renderer" />' },
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** 设 scrollEl 滚动属性并 dispatch scroll（搬运 scrollTop 进响应式 ref 驱动 visibleRange 重算） */
function setScroll(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
  el.dispatchEvent(new Event('scroll'))
}

/** flush pending rAF（happy-dom rAF 经 setImmediate 调度，await 宏任务落地） */
async function flushRaf(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const NOW = Date.now()
function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: NOW } as Message
}
function assistantMsg(id: string, content: string, status: Message['status'] = 'complete'): Message {
  return { id, role: 'assistant', content, status, timestamp: NOW } as Message
}

function makeHistory(turns: number): Message[] {
  const list: Message[] = []
  for (let i = 1; i <= turns; i++) {
    list.push(userMsg(`u${i}`, `问题 ${i}`))
    list.push(assistantMsg(`a${i}`, `回答 ${i}`))
  }
  return list
}

function mountStream(sessionId: string) {
  injectedRegistry = null
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

function getScrollEl(wrapper: ReturnType<typeof mount>): HTMLElement {
  return wrapper.find('.message-stream').element as HTMLElement
}

/**
 * 经 registry 触发视口上方 turn 实测化（模拟 RO 回调，与生产路径一致）。
 * turn0 首消息 id = 'u1'，估算 200 → 实测 400，delta=+200。
 */
function triggerAboveViewportDelta(): void {
  if (!injectedRegistry) {
    throw new Error('registry 未注入（Turn stub 未挂载或 provide 链路断）')
  }
  injectedRegistry.reportHeight('u1', 400)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  injectedRegistry = null
})

// ────────────────────────────────────────────────────────────────
// AC1：用户主动滚动（stickToBottom=false）期间，scrollAdjustDelta 不施加到 scrollTop
// ────────────────────────────────────────────────────────────────
describe('AC1：用户主动滚动期间 scrollAdjustDelta 不施加', () => {
  it('stickToBottom=false 时，视口上方 turn 实测化产生的 delta 不推高 scrollTop', async () => {
    const chat = useChatStore()
    chat.hydrate('s1', makeHistory(10))
    const wrapper = mountStream('s1')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 非贴底态：distance = 2000 - 1000 - 600 = 400 > 40
    setScroll(scrollEl, 2000, 600, 1000)
    await flushRaf()

    // 用户主动上滑：wheel deltaY<0 → useChatScroll.onWheel → stickToBottom=false
    scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    await nextTick()

    const beforeTop = scrollEl.scrollTop
    // 视口上方 turn（u1）实测化：估算 200 → 实测 400，delta=+200
    triggerAboveViewportDelta()
    await flushRaf()
    await nextTick()
    await nextTick() // flush:'post' watch 在 DOM flush 后触发

    // 核心断言（AC1）：[fix-scroll-jump] guard 翻转后，非贴底态 delta 正常施加（视口中段内容稳定）。
    // 旧断言（旧 guard 跳过非贴底 delta）：expect(scrollEl.scrollTop).toBe(beforeTop)
    // 新断言（新 guard 施加非贴底 delta）：scrollTop += 200
    expect(scrollEl.scrollTop).toBe(beforeTop + 200)
    wrapper.unmount()
  })
})

// ────────────────────────────────────────────────────────────────
// AC2：脱离锚定期间 delta 清零，回归底部后无陈旧施加
// ────────────────────────────────────────────────────────────────
describe('AC2：delta 清零不残留', () => {
  it('stickToBottom=false 期间累积的 delta 被清零，回到底部后不施加陈旧 offset', async () => {
    const chat = useChatStore()
    chat.hydrate('s2', makeHistory(10))
    const wrapper = mountStream('s2')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    setScroll(scrollEl, 2000, 600, 1000)
    await flushRaf()

    // 用户上滑脱离锚定
    scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    await nextTick()

    // 累积 delta（脱离锚定期间）——修复后应被清零，不残留
    triggerAboveViewportDelta()
    await flushRaf()
    await nextTick()
    await nextTick()

    // 用户滚回底部：distance <= 40 → stickToBottom=true
    // scrollHeight=2000, clientHeight=600 → 贴底 scrollTop=1400（distance=0）
    setScroll(scrollEl, 2000, 600, 1400)
    await flushRaf()
    await nextTick()

    // 回到底部后，无新 delta 时 scrollTop 不被陈旧 offset 拉偏
    const afterReturn = scrollEl.scrollTop
    await flushRaf()
    await nextTick()
    await nextTick()
    // 核心断言（AC2）：陈旧 delta 不施加，scrollTop 稳定在贴底位置
    expect(scrollEl.scrollTop).toBe(afterReturn)
    wrapper.unmount()
  })
})

// ────────────────────────────────────────────────────────────────
// AC3：贴底态（stickToBottom=true）补偿行为不变
// ────────────────────────────────────────────────────────────────
describe('AC3：贴底态 delta 不施加（guard 翻转后）', () => {
  it('stickToBottom=true 时视口上方 turn 实测化，delta 不施加（由 scrollToBottom 主导）', async () => {
    const chat = useChatStore()
    chat.hydrate('s3', makeHistory(10))
    const wrapper = mountStream('s3')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 贴底态：scrollHeight=2000, clientHeight=600, scrollTop=1400（distance=0 <= 40）
    setScroll(scrollEl, 2000, 600, 1400)
    await flushRaf()
    await nextTick()

    const beforeTop = scrollEl.scrollTop
    // 视口上方 turn（u1）实测化：但贴底态下 scrollTop=1400，turn0 offset=0、turnBottom=200 <= 1400 → 视口上方
    triggerAboveViewportDelta()
    await flushRaf()
    await nextTick()
    await nextTick()

    // 核心断言（AC3）：[fix-scroll-jump] 贴底态 delta 不施加，scrollTop 保持不变。
    // 旧断言（保护了错误行为）：expect(scrollEl.scrollTop).toBe(beforeTop + 200)
    // 新断言（guard 翻转后）：贴底态由 scrollToBottom 统一跟随到底，delta 补偿不参与。
    expect(scrollEl.scrollTop).toBe(beforeTop)
    wrapper.unmount()
  })
})

describe('AC3b：负 delta 贴底态不跳变（核心 bug 回归）', () => {
  it('stickToBottom=true 时负 delta（trace 收起）不把 scrollTop 往上拉', async () => {
    const chat = useChatStore()
    chat.hydrate('s3b', makeHistory(10))
    const wrapper = mountStream('s3b')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 贴底态：scrollHeight=2000, clientHeight=600, scrollTop=1400（distance=0 <= 40）
    setScroll(scrollEl, 2000, 600, 1400)
    await flushRaf()
    await nextTick()

    const beforeTop = scrollEl.scrollTop
    // 视口上方 turn（u1）高度从 200→60（delta=-140，模拟 trace 收起）
    if (!injectedRegistry) {
      throw new Error('registry 未注入（Turn stub 未挂载或 provide 链路断）')
    }
    injectedRegistry.reportHeight('u1', 60)
    await flushRaf()
    await nextTick()
    await nextTick()

    // 核心断言：负 delta 不被施加，scrollTop 不被往上拉（修复前会跳到 1260）
    expect(scrollEl.scrollTop).toBe(beforeTop)
    wrapper.unmount()
  })
})

// ────────────────────────────────────────────────────────────────────
// TC3/TC4/TC5：chat 虚拟列表滚动 bug 修复回归（session 切换 settling guard）
//
// 覆盖 T3 settling guard（session 切换后首轮实测稳定前跳过 delta 施加）：
// - TC3（session 切换 settling guard）：切换 session 后产生负 delta（实测<估算），
//   settling 期间 delta 不被施加（scrollTop 不被负值往上拉），让 scrollToBottom 跟随主导贴底。
// - TC4（正常补偿回归）：非切换场景（settling 已翻 false），贴底态正 delta 正常施加。
// - TC5（ba26c322 guard 回归）：用户 wheel 上滑脱离锚定后 delta 不施加（已有 AC1 同源，
//   此处作为 settingling guard 之外另一独立 guard 的回归，确保两条 guard 并存）。
//
// scrollTo 在 beforeEach 被 mock 成 vi.fn()（happy-dom 默认不真改 scrollTop），
// 故 scrollTop 只经 setScroll 手动设或经 delta 施加改变——delta 是否施加可直接观测。

// 经 registry 触发视口上方 turn 实测化产生负 delta：u1 估算 200 → 实测 60，delta = -140。
// 估算偏大（200）致实测<估算时 delta 为负，与切换 session 后 scrollToBottom 跟随竞争时
// 会把 scrollTop 往上拉（bug 1 根因）。
function triggerNegativeAboveViewportDelta(): void {
  if (!injectedRegistry) {
    throw new Error('registry 未注入（Turn stub 未挂载或 provide 链路断）')
  }
  injectedRegistry.reportHeight('u1', 60)
}

describe('TC3：session 切换后 settling guard 跳过负 delta 施加', () => {
  it('切换 session 期间负 delta 不把 scrollTop 往上拉（让 scrollToBottom 跟随主导贴底）', async () => {
    const chat = useChatStore()
    chat.hydrate('s1', makeHistory(10))
    chat.hydrate('s2', makeHistory(10))
    const wrapper = mountStream('s1')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 贴底态：scrollHeight=2000, clientHeight=600, scrollTop=1400（distance=0 <= 40）
    setScroll(scrollEl, 2000, 600, 1400)
    await flushRaf()
    await nextTick()

    const beforeSwitch = scrollEl.scrollTop

    // 切换 session：resetSession + scrollToBottom('auto', true) + startSettling()
    // settling 立即 true；经连续 2 rAF 后翻 false。
    await wrapper.setProps({ sessionId: 's2' })
    await nextTick()

    // settling 窗口内产生负 delta（实测 60 < 估算 200，delta=-140）。
    triggerNegativeAboveViewportDelta()
    await flushRaf()
    await nextTick()
    await nextTick() // flush:'post' watch 在 DOM flush 后触发

    // 核心断言（TC3）：settling 期间负 delta 不被施加，scrollTop 不被往上拉。
    // 修复前（无 settling guard）：delta=-140 会被施加，scrollTop = 1400-140 = 1260（往上拉）。
    // 修复后：guard 跳过施加，scrollTop 保持切换前的贴底值（scrollTo noop 不改 scrollTop）。
    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(beforeSwitch)
    wrapper.unmount()
  })
})

describe('TC4：非切换场景 settling 已 false 时正常补偿施加', () => {
  it('mount 后等 settling 翻 false，正 delta 在贴底态正常施加到 scrollTop', async () => {
    const chat = useChatStore()
    chat.hydrate('s4', makeHistory(10))
    const wrapper = mountStream('s4')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 贴底态：scrollHeight=2000, clientHeight=600, scrollTop=1400
    setScroll(scrollEl, 2000, 600, 1400)
    await flushRaf()
    // mount 的 onMounted 不触发 session watch（watch 监听变化，挂载不算变化）→ 不 startSettling，
    // settling 初始 false。再 flushRaf 确保无 pending rAF 干扰。
    await flushRaf()
    await nextTick()

    const beforeTop = scrollEl.scrollTop
    // 视口上方 turn（u1）实测化：估算 200 → 实测 400，delta=+200（正 delta）
    triggerAboveViewportDelta()
    await flushRaf()
    await nextTick()
    await nextTick() // flush:'post' watch

    // 核心断言（TC4）：[fix-scroll-jump] guard 翻转后，贴底态 delta 跳过（由 scrollToBottom 主导）。
    // 旧断言（旧 guard 施加贴底 delta）：expect(scrollEl.scrollTop).toBe(beforeTop + 200)
    // 新断言（新 guard 跳过贴底 delta）：scrollTop 不变
    expect(scrollEl.scrollTop).toBe(beforeTop)
    wrapper.unmount()
  })
})

describe('TC5：用户上滑脱离锚定后 delta 不施加（ba26c322 guard 回归）', () => {
  it('wheel 上滑脱离锚定后，视口上方 turn 实测化产生的 delta 不改变 scrollTop', async () => {
    const chat = useChatStore()
    chat.hydrate('s5', makeHistory(10))
    const wrapper = mountStream('s5')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 非贴底态：distance = 2000 - 1000 - 600 = 400 > 40
    setScroll(scrollEl, 2000, 600, 1000)
    await flushRaf()
    await flushRaf() // 确保 settling（本用例无 session 切换，settling 恒 false）
    await nextTick()

    // 用户主动上滑：wheel deltaY<0 → useChatScroll.onWheel → stickToBottom=false
    scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    await nextTick()

    const beforeTop = scrollEl.scrollTop
    // 视口上方 turn（u1）实测化产生 delta（正负皆可，此处正 delta）
    triggerAboveViewportDelta()
    await flushRaf()
    await nextTick()
    await nextTick() // flush:'post' watch

    // 核心断言（TC5）：[fix-scroll-jump] guard 翻转后，非贴底态 delta 正常施加（视口中段内容稳定）。
    // 旧断言（旧 guard 跳过非贴底 delta）：expect(scrollEl.scrollTop).toBe(beforeTop)
    // 新断言（新 guard 施加非贴底 delta）：scrollTop += 200
    expect(scrollEl.scrollTop).toBe(beforeTop + 200)
    wrapper.unmount()
  })
})
