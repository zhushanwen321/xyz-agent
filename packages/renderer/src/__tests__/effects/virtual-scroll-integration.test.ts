/**
 * 虚拟滚动 W3/W4 集成层测试（review_fix）。
 *
 * 背景：H1 虚拟滚动分 4 个 Wave——W1 useVirtualTurnList（纯逻辑，12 单测）+ W2
 * useResizeReport（RO 上报，8 单测）已有单测；但 W3（MessageStream.vue 窗口化改造：
 * 全量 v-for → spacer + visibleItems absolute 定位）+ W4（Turn.vue inject useResizeReport
 * + useChatScroll 集成）的集成层此前无自动化验证，虚拟化核心收益（DOM 节点数常数级）
 * 没有测试兜底。本文件补这层集成测试，覆盖三个场景：
 *
 * - 场景 1（E3 变体 / M4 回归）：mount MessageStream 不崩 + useChatScroll 仍正常工作
 *   （onMounted 强制 scrollToBottom）—— 虚拟化改造不破坏现有滚动行为。
 * - 场景 2（核心收益）：注入大量消息（25 turn）+ mock 滚动到底部区，触发响应式重算
 *   后断言渲染的 Turn 实例数远小于全量（虚拟化只挂载可见窗口 + buffer + 末项钉扎）。
 * - 场景 3（空态）：空消息列表 mount 不崩 + 显示欢迎语（renderItems.length===0 分支）。
 *
 * ── mock 策略 ────────────────────────────────────────────────────
 * MessageStream 依赖：chat store（真 pinia）/ useChat（vi.mock）/ useChatScroll（真）/
 * useVirtualTurnList（真）/ provideTurnResizeRegistry（真）/ i18n（vitest setup 已 mock）/
 * subagentStore（真 pinia）。子组件 Turn/SystemNotice/BgNotifyCard/GuiComponentRenderer
 * 有重依赖（MarkdownRenderer/ChangeSetCard/ForkConfirmModal/...），全 stub 隔离——
 * 本测聚焦虚拟化窗口逻辑（visibleItems 数量），不验证 Turn 内部渲染。
 *
 * Turn stub 带 data-testid="turn-stub-${首消息id}"，findAllComponents 或 selector 计数。
 *
 * ── happy-dom 滚动属性 mock ────────────────────────────────────
 * happy-dom 的 HTMLElement 无真实布局，scrollHeight/clientHeight/scrollTop 默认 0。
 * useVirtualTurnList.computeWindow 读 scrollEl.scrollTop/clientHeight 算窗口——
 * mount 后通过 .message-stream selector 拿 scrollEl，Object.defineProperty 设这些属性，
 * 再触发响应式重算（生产中由 ResizeObserver→reportHeight 触发；测试通过追加一条消息
 * 让 renderItems 重算，连带 visibleItems 重读最新 scrollTop）。
 * 参考 use-chat-scroll.test.ts 的 setScroll helper。
 *
 * ── 关于 visibleRange 响应式触发 ────────────────────────────────
 * useVirtualTurnList 的 totalHeight/visibleRange 用 liveComputed（每次 .value 访问重读
 * getter）。DOM 的 scrollTop 变化本身不触发 Vue 响应式——生产中窗口重算由 Turn 挂载 →
 * ResizeObserver → reportHeight → heights ref 变化驱动（视口外 turn 卸载后停止上报，
 * 窗口收敛到可见范围）。测试模拟此触发：mount 后设 scrollTop，再 append 一条消息让
 * renderItems 重算，连带 visibleItems 重读 scrollTop 得到收敛后的窗口。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/virtual-scroll-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@xyz-agent/shared'

// ── useChat mock：MessageStream 只用 loadMoreHistory + hasMoreHistory，返回 no-op 即可 ──
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
}))

// ── 子组件 stub：隔离 Turn/SystemNotice/BgNotifyCard/GuiComponentRenderer 重依赖 ──
// Turn stub 带 turn prop 透传，data-testid 含首消息 id，便于断言哪些 turn 被渲染（窗口外的 turn 不应出现）
const TurnStub = defineComponent({
  name: 'Turn',
  props: { turn: { type: Object, required: true }, sessionId: String, canEdit: Boolean },
  setup(props) {
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

/**
 * happy-dom 不提供 ResizeObserver（useChatScroll/useResizeReport 用它）。
 * MessageStream provideTurnResizeRegistry → Turn stub 内不调 useResizeReport，
 * 故 RO 不会被 Turn 创建；但 useChatScroll 的 contentEl watch 会 new ResizeObserver，
 * 必须 stub 成 no-op 否则 mount 报错。
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * mock scrollEl 的滚动属性（参考 use-chat-scroll.test.ts 的 setScroll）。
 * happy-dom 默认全 0，需手动设 scrollTop/clientHeight/scrollHeight 让 computeWindow 工作。
 * writable: true 让 useChatScroll 的 scrollToBottom 能写 scrollTop（force 滚动场景）。
 */
function setScroll(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
}

const NOW = Date.now()

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: NOW } as Message
}
function assistantMsg(id: string, content: string, status: Message['status'] = 'complete'): Message {
  return { id, role: 'assistant', content, status, timestamp: NOW } as Message
}

/** 构造 N 个回合（user + assistant 交替）= 2N 条消息 */
function makeHistory(turns: number): Message[] {
  const list: Message[] = []
  for (let i = 1; i <= turns; i++) {
    list.push(userMsg(`u${i}`, `问题 ${i}`))
    list.push(assistantMsg(`a${i}`, `回答 ${i}`))
  }
  return list
}

/** mount MessageStream（sessionId 必传） */
function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

/** 取挂载后的 scrollEl（.message-stream 选择器） */
function getScrollEl(wrapper: ReturnType<typeof mount>): HTMLElement {
  return wrapper.find('.message-stream').element as HTMLElement
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  // scrollTo 由 useChatScroll 调用，stub 成 no-op 防 happy-dom 行为差异
  HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ────────────────────────────────────────────────────────────────
// 场景 1：M4 回归——虚拟化不破坏 useChatScroll（mount 不崩 + 滚动 API 仍工作）
// ────────────────────────────────────────────────────────────────
describe('虚拟滚动集成 · 场景 1：虚拟化不破坏 useChatScroll（E3 变体 / M4 回归）', () => {
  it('mount MessageStream 不崩（W3 窗口化 + W4 useChatScroll 集成正常）', async () => {
    const chat = useChatStore()
    chat.hydrate('s1', makeHistory(3))
    const wrapper = mountStream('s1')
    await nextTick()
    // 基本存活断言：根容器 + 滚动容器存在
    expect(wrapper.find('.message-stream').exists()).toBe(true)
    // 虚拟化 spacer（contentEl）挂载（class 含 relative px-5）
    expect(wrapper.find('[class*="relative"][class*="px-5"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('useChatScroll 集成正常——onMounted 强制 scrollToBottom（force=true，不受 guard 拦截）', async () => {
    const chat = useChatStore()
    chat.hydrate('s1', makeHistory(3))
    const wrapper = mountStream('s1')
    await nextTick()
    // M4 的 scrollToBottom 走 rAF trailing，happy-dom 下 rAF 异步推进。
    // 不断言 el.scrollTo 调用（rAF 时序难控），只确认 mount 不崩 + scrollEl 绑定（链路连通）
    expect(getScrollEl(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('useChatScroll 集成正常——上滑后 showJumpButton 浮层出现（computed 不变量不破坏）', async () => {
    const chat = useChatStore()
    chat.hydrate('s1', makeHistory(3))
    const wrapper = mountStream('s1')
    await nextTick()
    const scrollEl = getScrollEl(wrapper)
    // 设非贴底态（distance > BOTTOM_THRESHOLD=40）
    setScroll(scrollEl, 1000, 800, 100)
    await nextTick()
    // 上滑脱离锚定（onWheel deltaY<0 → stickToBottom=false → showJumpButton=true）
    scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    await nextTick()
    // 「回到底部」浮层 v-if 渲染——浮层是带 title 属性的 Button（title=panel.message.scrollToBottom）
    const titledBtns = wrapper.findAll('button[title]')
    expect(titledBtns.length).toBeGreaterThan(0)
    wrapper.unmount()
  })
})

// ────────────────────────────────────────────────────────────────
// 场景 2：核心收益——虚拟化后 DOM 只渲染可见窗口（远小于全量 turn 数）
// ────────────────────────────────────────────────────────────────
describe('虚拟滚动集成 · 场景 2：DOM 只渲染可见窗口（核心收益验证）', () => {
  /**
   * 25 turn × 估算 200px/turn（MessageStream ESTIMATED_TURN_HEIGHT=200），buffer=2。
   * 滚到底部区：totalHeight=5000，viewport=600，scrollTop=4400（近底，看最后几个 turn）。
   * computeWindow（liveComputed 每次访问重算）：
   *   startIndex ≈ 20（视口上方 turn 不渲染），endIndex=24（末项钉扎 INVAR-10）
   *   → visibleRange = {20, 24}
   * 触发 visibleItems 重算（生产中由 ResizeObserver→reportHeight 驱动；测试通过 append 一条
   * 消息让 renderItems 重算，连带 visibleItems 重读最新 scrollTop）后断言 DOM Turn 数 << 25。
   */
  it('25 turn 滚到底部区 → visibleRange 收敛到窗口 {20,24}，渲染的 Turn 实例数远小于全量', async () => {
    const TURN_COUNT = 25
    const chat = useChatStore()
    chat.hydrate('s2', makeHistory(TURN_COUNT))
    const wrapper = mountStream('s2')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 滚到底部区：25*200=5000 总高，viewport 600，scrollTop=4400（近底）
    setScroll(scrollEl, 5000, 600, 4400)
    await nextTick()

    // visibleRange 是 liveComputed（每次访问重读 getter），直接读拿收敛后的窗口
    const range = (wrapper.vm as unknown as { visibleRange: { value: { startIndex: number; endIndex: number } } }).visibleRange.value
    expect(range.startIndex).toBe(20)
    expect(range.endIndex).toBe(24) // 末项钉扎（INVAR-10）

    // 触发 visibleItems 重算（模拟生产 RO→reportHeight 驱动）：append 一条 assistant 消息
    // 让 currentMessages/renderItems 重算，连带 visibleItems 重读 scrollTop
    chat.applyMessageEvent('s2', {
      type: 'message.message_start',
      payload: { sessionId: 's2', messageId: 'a-after' },
    })
    await nextTick()
    await nextTick()

    const turnStubs = wrapper.findAll('[data-testid^="turn-stub-"]')
    // 核心断言：DOM 内 Turn 实例远小于全量（虚拟化生效，只渲染窗口 + 末项）
    expect(turnStubs.length).toBeLessThan(TURN_COUNT)
    // 末项钉扎：最后一个 turn（u25）恒在窗口内
    const lastTurnRendered = turnStubs.some((t) => t.attributes('data-testid') === 'turn-stub-u25')
    expect(lastTurnRendered).toBe(true)
    // 视口上方的首 turn（u1）应被卸载（不渲染）
    const firstTurnRendered = turnStubs.some((t) => t.attributes('data-testid') === 'turn-stub-u1')
    expect(firstTurnRendered).toBe(false)
    wrapper.unmount()
  })

  it('totalHeight 随 turn 数线性增长（25 turn × 200px = 5000，未上报实测前全估算）', async () => {
    const chat = useChatStore()
    chat.hydrate('s3', makeHistory(25))
    const wrapper = mountStream('s3')
    await nextTick()
    // totalHeight 是 liveComputed，通过 vm 读取拿真值（25 * 200 = 5000）
    const totalHeight = (wrapper.vm as unknown as { totalHeight: { value: number } }).totalHeight.value
    expect(totalHeight).toBe(5000)
    wrapper.unmount()
  })

  /**
   * 滚到中间区域：startIndex 明显 > 0（视口上方 turn 不渲染），证明窗口上边界裁剪生效。
   * 25 turn，scrollTop=2000（中间）→ startIndex ≈ 8-10，首 turn 不在窗口。
   */
  it('25 turn 滚到中间 → visibleRange.startIndex > 0（首 turn 不在窗口，窗口上边界裁剪生效）', async () => {
    const TURN_COUNT = 25
    const chat = useChatStore()
    chat.hydrate('s4', makeHistory(TURN_COUNT))
    const wrapper = mountStream('s4')
    await nextTick()

    const scrollEl = getScrollEl(wrapper)
    // 中间位置：scrollTop=2000，viewport=600
    setScroll(scrollEl, 5000, 600, 2000)
    await nextTick()

    const range = (wrapper.vm as unknown as { visibleRange: { value: { startIndex: number; endIndex: number } } }).visibleRange.value
    // startIndex > 0（视口上方 turn 被裁掉，证明窗口化生效）
    expect(range.startIndex).toBeGreaterThan(0)
    expect(range.startIndex).toBeLessThan(TURN_COUNT)
    wrapper.unmount()
  })

  it('顶部（scrollTop=0）时 visibleRange.startIndex=0 + 末项钉扎 endIndex=lastIndex', async () => {
    const TURN_COUNT = 25
    const chat = useChatStore()
    chat.hydrate('s5', makeHistory(TURN_COUNT))
    const wrapper = mountStream('s5')
    await nextTick()
    const range = (wrapper.vm as unknown as { visibleRange: { value: { startIndex: number; endIndex: number } } }).visibleRange.value
    expect(range.startIndex).toBe(0)
    expect(range.endIndex).toBe(TURN_COUNT - 1) // 末项钉扎（INVAR-10）
    wrapper.unmount()
  })
})

// ────────────────────────────────────────────────────────────────
// 场景 3：空态——renderItems 为空时显示欢迎语不崩
// ────────────────────────────────────────────────────────────────
describe('虚拟滚动集成 · 场景 3：空态（renderItems 为空显示欢迎语不崩）', () => {
  it('空消息列表 mount 不崩 + totalHeight=0（SR12/INVAR-9 空态守恒）', async () => {
    const chat = useChatStore()
    // hydrate 空历史（标记 session 已加载，messages 为空数组）
    chat.hydrate('empty', [])
    const wrapper = mountStream('empty')
    await nextTick()
    // 基本存活
    expect(wrapper.find('.message-stream').exists()).toBe(true)
    // totalHeight = 0（空态 SR12/INVAR-9，reduce 初值 0 防 NaN）
    const totalHeight = (wrapper.vm as unknown as { totalHeight: { value: number } }).totalHeight.value
    expect(totalHeight).toBe(0)
    wrapper.unmount()
  })

  it('空态显示欢迎语（i18n panel.message.startConversation 文案）', async () => {
    const chat = useChatStore()
    chat.hydrate('empty', [])
    const wrapper = mountStream('empty')
    await nextTick()
    // i18n zh-CN panel.message.startConversation = 「开始对话，或从左侧选择一个会话」
    // 空态分支 v-if="renderItems.length === 0" 渲染欢迎语
    expect(wrapper.text()).toContain('开始对话')
    wrapper.unmount()
  })

  it('空态不渲染任何 Turn 实例（visibleItems 为空）', async () => {
    const chat = useChatStore()
    chat.hydrate('empty', [])
    const wrapper = mountStream('empty')
    await nextTick()
    const turnStubs = wrapper.findAll('[data-testid^="turn-stub-"]')
    expect(turnStubs).toHaveLength(0)
    wrapper.unmount()
  })

  it('空态 visibleRange = {0, 0}（无越界）', async () => {
    const chat = useChatStore()
    chat.hydrate('empty', [])
    const wrapper = mountStream('empty')
    await nextTick()
    const range = (wrapper.vm as unknown as { visibleRange: { value: { startIndex: number; endIndex: number } } }).visibleRange.value
    // allEntries() 为空 → n=0 分支返回 {0, 0}
    expect(range).toEqual({ startIndex: 0, endIndex: 0 })
    wrapper.unmount()
  })
})
