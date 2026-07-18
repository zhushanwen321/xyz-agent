/**
 * toolcall status 翻转 UI 回归测试。
 *
 * 验证：tool.status running→completed 后，DOM 上 .animate-working-pulse 消失 + Check 图标出现。
 * 覆盖三层链路：
 * - 方案 a：mount Block，改 props.tool.status（叶子组件单元回归）
 * - 方案 b：mount Turn，改 turn.assistants[0].toolCalls[0].status（单 turn 链路回归）
 * - 方案 c：mount MessageStream（真 store + 真虚拟滚动层），applyMessageEvent 走 tool_call_end 路径
 * - 方案 d：虚拟滚动响应式——heights/scrollTop 变化触发 visibleRange 重算（Wave1 liveComputed→真 computed 修复回归）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/tool-status-flip.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, effectScope, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Block from '@/components/panel/message-stream/Block.vue'
import Turn from '@/components/panel/message-stream/Turn.vue'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useChatStore } from '@/stores/chat'
import { useVirtualTurnList } from '@/composables/effects/useVirtualTurnList'
import type { ToolCall, Message, ServerMessage } from '@xyz-agent/shared'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'

const NOW = Date.now()

// ── MessageStream（方案 c）需要的全局 mock ──────────────────────────
// useChat 仅用 loadMoreHistory / hasMoreHistory，no-op 即可
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ loadMoreHistory: vi.fn(), hasMoreHistory: () => false }),
}))

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolName: 'read',
    input: { path: '/tmp/a.txt' },
    status: 'running',
    startTime: NOW,
    ...over,
  }
}

/**
 * 构造一条含单个 toolCall 的 assistant message。
 * toolCalls 与 contentBlocks（toolCall 引用）都填充，走 expandAssistantBlocks 的
 * 真实时序分支（非降级）。toolCall 对象会被 expandAssistantBlocks 通过
 * msg.toolCalls.find(...) 取出——返回的是同一引用，所以外部改它的 status 会反映到 UI。
 */
function makeAssistantWithTool(tool: ToolCall): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    status: 'complete',
    timestamp: NOW,
    toolCalls: [tool],
    contentBlocks: [{ type: 'toolCall', refId: 'tc1' }],
  }
}

function makeTurn(assistant: Message, isWorking = false): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'q', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isWorking,
    hasFoldable: true,
  }
}

beforeEach(() => {
  // Turn.vue 依赖多个 pinia store（chat/fileTree/subagent...）。Block.vue 只依赖 i18n。
  setActivePinia(createPinia())
})

/* ─────────────────────── 方案 c：mount MessageStream（真 store + 真虚拟滚动层）───────────────────────
 * mount 完整 MessageStream，用真实 chat store + applyMessageEvent 走真 tool_call_end 路径。
 * 用 Turn **透视 stub**（不隔离，直接渲染内部 tool 状态文本），断言 tool_call_end 后
 * 渲染的 toolCall.status 是否从 running 翻转成 completed。
 *
 * 这是验证「虚拟滚动层（visibleItems/visibleRange）是否截断响应式更新」的最小真链路。
 * ------------------------------------------------------------------------- */

// happy-dom 不提供 ResizeObserver
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Turn 透视 stub：把传入 turn 的 toolCall 状态渲染成文本，供断言。
 * 不调任何 store（隔离重依赖），仅做纯渲染。
 */
const TurnXRay = defineComponent({
  name: 'Turn',
  props: { turn: { type: Object, required: true }, sessionId: String, canEdit: Boolean },
  setup(props) {
    return () => {
      const turn = props.turn as MessageTurn
      const tc = turn.assistants[0]?.toolCalls?.[0]
      const status = tc ? tc.status : 'no-tool'
      return h(
        'div',
        {
          'data-testid': 'turn-xray',
          'data-tool-status': status,
          'data-assistant-id': turn.assistants[0]?.id ?? '',
        },
        `toolStatus:${status}`,
      )
    }
  },
})

const streamGlobalStubs = {
  Turn: TurnXRay,
  SystemNotice: { name: 'SystemNotice', template: '<div />' },
  BgNotifyCard: { name: 'BgNotifyCard', template: '<div />' },
  GuiComponentRenderer: { name: 'GuiComponentRenderer', template: '<div />' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: streamGlobalStubs },
    attachTo: document.body,
  })
}

describe('方案 c: mount MessageStream（真 store + 真虚拟滚动层）— tool_call_end 翻转', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('c-full: hydrate(user) → message_start → tool_call_start → tool_call_end，断言 Turn 收到 status 翻转', async () => {
    const chat = useChatStore()
    const sid = 'sess-c'
    // hydrate 一条 user 消息（避免 message_start 找不到前置）
    chat.hydrate(sid, [
      { id: 'u1', role: 'user', content: 'read file', status: 'complete', timestamp: NOW },
    ])

    const wrapper = mountStream(sid)
    await nextTick()

    // 触发 message_start：插入 streaming assistant
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage<'message.message_start'>)
    await nextTick()

    // 触发 tool_call_start：插入 running tool
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'read', input: { path: '/x' } },
    } as ServerMessage<'message.tool_call_start'>)
    await nextTick()

    // 断言 running：Turn 透视 stub 应显示 toolStatus:running
    const running = wrapper.find('[data-testid="turn-xray"]')
    expect(running.exists()).toBe(true)
    expect(running.attributes('data-tool-status')).toBe('running')

    // 触发 tool_call_end：翻转成 completed
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: { sessionId: sid, toolCallId: 'tc1', output: 'file content', status: 'completed' },
    } as ServerMessage<'message.tool_call_end'>)
    await nextTick()

    // 断言翻转：Turn 透视 stub 应显示 toolStatus:completed
    const completed = wrapper.find('[data-testid="turn-xray"]')
    expect(completed.attributes('data-tool-status')).toBe('completed')

    wrapper.unmount()
  })

  it('c-multi: 多 turn，running tool 在非末位 turn —— 验证虚拟窗口非末项 turn 翻转', async () => {
    // 构造 5 个 turn，第 1 个 turn 含 running tool，其余 4 个完成。
    // 末项钉扎（SR3）保证 last turn 恒在窗口，但第 1 个 turn 是否在窗口取决于高度。
    // 关键：如果虚拟滚动窗口在 tool_call_end 后没有重新渲染第 1 个 turn（已卸载/重新挂载），
    // 状态翻转可能丢失。这里默认高度都按估算，scrollTop=0，第 1 个 turn 必在窗口内。
    const chat = useChatStore()
    const sid = 'sess-c-multi'
    const history: Message[] = []
    for (let i = 1; i <= 4; i++) {
      history.push({ id: `u${i}`, role: 'user', content: `q${i}`, status: 'complete', timestamp: NOW })
      history.push({ id: `a${i}`, role: 'assistant', content: `answer${i}`, status: 'complete', timestamp: NOW })
    }
    // 第 5 个 turn：user + assistant(streaming)
    history.push({ id: 'u5', role: 'user', content: 'q5', status: 'complete', timestamp: NOW })
    chat.hydrate(sid, history)

    const wrapper = mountStream(sid)
    await nextTick()

    // message_start 给第 5 turn 插 streaming assistant（末位 turn，必在窗口）
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a5' },
    } as ServerMessage<'message.message_start'>)
    await nextTick()

    // 直接测「已 hydrate 的完成 turn 上 toolCalls 状态翻转」。
    // 用 setMessages 覆盖第 1 turn 含 running tool，再翻转。
    const base = chat.messages.get(sid) ?? []
    const tool: ToolCall = { id: 'tc-multi', toolName: 'read', input: {}, status: 'running', startTime: NOW }
    const updated: Message[] = base.map((m) =>
      m.id === 'a1'
        ? { ...m, toolCalls: [tool], contentBlocks: [{ type: 'toolCall', refId: 'tc-multi' }] }
        : m,
    )
    chat.setMessages(sid, updated)
    await nextTick()

    // 找到 turn1（data-assistant-id=a1），断言 running
    const turn1 = wrapper
      .findAll('[data-testid="turn-xray"]')
      .find((w) => w.attributes('data-assistant-id') === 'a1')
    expect(turn1?.attributes('data-tool-status')).toBe('running')

    // 翻转 tool status via setMessages（不可变替换，模拟 tool_call_end 的 store 路径）
    const toolDone: ToolCall = { ...tool, status: 'completed', output: 'done' }
    const updated2: Message[] = (chat.messages.get(sid) ?? []).map((m) =>
      m.id === 'a1' ? { ...m, toolCalls: [toolDone] } : m,
    )
    chat.setMessages(sid, updated2)
    await nextTick()

    const turn1After = wrapper
      .findAll('[data-testid="turn-xray"]')
      .find((w) => w.attributes('data-assistant-id') === 'a1')
    expect(turn1After?.attributes('data-tool-status')).toBe('completed')
    wrapper.unmount()
  })

  it('c-full-cycle: message.start→tool_start→tool_end→message.complete(full working→done) 真实生命周期', async () => {
    // 模拟完整真实流程：working turn 在 tool_call_end 后再收 message.complete → finalizeSession。
    // 验证：message.complete 后 tool 仍 completed（不被 finalize 覆盖回 running/end_not_received）。
    const chat = useChatStore()
    const sid = 'sess-cycle'
    chat.hydrate(sid, [
      { id: 'u1', role: 'user', content: 'q', status: 'complete', timestamp: NOW },
    ])
    const wrapper = mountStream(sid)
    await nextTick()

    // message_start（streaming assistant）→ turn isWorking=true
    chat.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } } as ServerMessage<'message.message_start'>)
    await nextTick()

    // tool_call_start
    chat.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'read', input: {} } } as ServerMessage<'message.tool_call_start'>)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')).toBe('running')

    // tool_call_end（completed）
    chat.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, toolCallId: 'tc1', output: 'done', status: 'completed' } } as ServerMessage<'message.tool_call_end'>)
    await nextTick()

    // message.complete（normal stop）→ finalizeSession reason='normal'
    chat.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'stop', content: 'final answer' } } as ServerMessage<'message.complete'>)
    await nextTick()
    const finalStatus = wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')

    // 关键断言：tool_call_end 已 completed，finalize reason=normal 不改 completed toolCalls
    expect(finalStatus).toBe('completed')
    wrapper.unmount()
  })
})

/* ─────────────────────── 方案 a：mount Block，改 props.tool.status ─────────────────────── */
describe('方案 a: mount Block 组件 — 翻转 props.tool.status', () => {
  it('running→completed：脉冲点消失，Check 图标出现', async () => {
    const tool = makeTool({ status: 'running' })
    const wrapper = mount(Block, {
      props: { type: 'tool', tool, sessionId: 's1' },
    })

    // running 态：脉冲点存在
    expect(wrapper.findAll('.animate-working-pulse').length).toBeGreaterThan(0)
    expect(wrapper.find('svg.lucide-check').exists()).toBe(false)

    // 翻转 status → completed（且有 output，满足 Block.vue:100 `!isFailed && !isUnfinished && result`）
    // 注意：result = props.tool.output，需要 output 才会显示 Check（否则走 noResult 分支）
    await wrapper.setProps({ tool: { ...tool, status: 'completed', output: 'file content' } })

    // 断言：脉冲消失，Check 出现
    expect(wrapper.findAll('.animate-working-pulse')).toHaveLength(0)
    expect(wrapper.find('svg.lucide-check').exists()).toBe(true)
  })
})

/* ─────────────────────── 方案 b：mount Turn，改 turn prop 内 tool ─────────────────────── */
describe('方案 b: mount Turn 组件 — 翻转 turn.assistants[0].toolCalls[0].status', () => {
  it('running→completed：Turn 内 Block 脉冲消失，Check 出现', async () => {
    const tool = makeTool({ status: 'running' })
    const assistant = makeAssistantWithTool(tool)
    const turn = makeTurn(assistant, /* isWorking */ false)

    const wrapper = mount(Turn, {
      props: { turn, sessionId: 's1' },
      global: { stubs: { ChangeSetCard: true, ForkConfirmModal: true, MarkdownRenderer: true } },
    })

    // 需展开 trace 才能看到 Block（showTrace = isWorking || expanded；这里 isWorking=false）
    // 点击 turn-meta 按钮展开
    await wrapper.find('button.turn-meta').trigger('click')
    await nextTick()

    // running 态断言：脉冲点存在
    expect(wrapper.findAll('.animate-working-pulse').length).toBeGreaterThan(0)

    // 翻转 status：构造新的 turn prop（不可变更新，模拟 store commitMessages 路径）
    const tool2: ToolCall = { ...tool, status: 'completed', output: 'file content' }
    const assistant2: Message = { ...assistant, toolCalls: [tool2] }
    const turn2: MessageTurn = { ...turn, assistants: [assistant2] }
    await wrapper.setProps({ turn: turn2 })
    await nextTick()

    // 断言：脉冲消失，Check 出现
    expect(wrapper.findAll('.animate-working-pulse')).toHaveLength(0)
    // 至少有一个 Check 图标（assistant 区复制按钮也有 Check，但 tool 块的 Check 在 trace 内）
    expect(wrapper.findAll('svg.lucide-check').length).toBeGreaterThan(0)
  })
})

/* ─────────────────────── 方案 c（叶子）：直接验证 traceBlocks 响应式 ───────────────────────
 * 不 mount MessageStream（虚拟滚动层响应式在 use-virtual-turn-list.test.ts 与下方方案 d
 * 已覆盖），而是聚焦验证「Turn 把 toolCall 引用的 status 变化（不可变替换）传给 Block」是否响应式。
 * ------------------------------------------------------------------------- */
describe('方案 c（叶子）: traceBlocks 响应式验证（不可变替换翻转）', () => {
  it('c1: 不可变替换 turn prop（模拟 store commit）— 应翻转', async () => {
    const tool = makeTool({ status: 'running' })
    const assistant = makeAssistantWithTool(tool)
    const turn = makeTurn(assistant, false)

    const wrapper = mount(Turn, {
      props: { turn, sessionId: 's1' },
      global: { stubs: { ChangeSetCard: true, ForkConfirmModal: true, MarkdownRenderer: true } },
    })
    await wrapper.find('button.turn-meta').trigger('click')
    await nextTick()
    expect(wrapper.findAll('.animate-working-pulse').length).toBeGreaterThan(0)

    // 不可变替换（与方案 b 同）
    const tool2: ToolCall = { ...tool, status: 'completed', output: 'done' }
    const a2: Message = { ...assistant, toolCalls: [tool2] }
    await wrapper.setProps({ turn: { ...turn, assistants: [a2] } })
    await nextTick()

    expect(wrapper.findAll('.animate-working-pulse')).toHaveLength(0)
  })
})

/* ─────────────────────── 方案 d：虚拟滚动响应式——Wave1 liveComputed→真 computed 修复回归 ───────────────────────
 * 复刻 MessageStream.vue 的真实装配：renderItems 是真 computed（包 ref 数据源），
 * useVirtualTurnList 的 items getter 读 renderItems.value。visibleItems 是真 computed，
 * 内部读 visibleRange.value（Wave1 后为真 computed）+ renderItems.value（真 computed）。
 *
 * Wave1 修复后行为：heights 变化（reportHeight）经 triggerRef(heights) 失效 layout/visibleRange；
 * scrollTop 变化经 onScrollUpdate() 写入响应式 ref 失效 visibleRange。两者都应触发 visibleItems 重算。
 * ------------------------------------------------------------------------- */

function turnItemR(index: number, key: string): RenderItem {
  return {
    kind: 'turn',
    turn: {
      index,
      user: { id: `u-${key}`, role: 'user', content: 'q', status: 'complete', timestamp: NOW } as never,
      assistants: [],
      isWorking: false,
      hasFoldable: false,
    },
  }
}

describe('方案 d: 虚拟滚动响应式——heights/scrollTop 变化触发 visibleRange 重算', () => {
  it('d1: reportHeight 后 heights 变 → visibleRange 重算（非过时）', () => {
    const scope = effectScope()
    let assertCount = 0
    scope.run(() => {
      const data = ref<RenderItem[]>([turnItemR(1, 'k1'), turnItemR(2, 'k2'), turnItemR(3, 'k3')])
      const renderItems = computed(() => data.value)
      const scrollEl = document.createElement('div')
      Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 0 })
      Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, writable: true, value: 200 })
      Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, writable: true, value: 9999 })

      const vl = useVirtualTurnList({
        items: () => renderItems.value,
        scrollEl: () => scrollEl,
        estimatedHeight: () => 200,
        buffer: () => 0,
      })
      // 初始化 scrollTop/viewportHeight 响应式 ref（Wave1：visibleRange 是真 computed，
      // 依赖响应式 scrollTop/viewportHeight；不调 onScrollUpdate 则用 ref 初始值 0）
      vl.onScrollUpdate()

      // visibleItems 复刻 MessageStream.vue 真实派生
      const visibleItems = computed(() => {
        const { startIndex, endIndex } = vl.visibleRange.value
        const items = renderItems.value
        const arr: number[] = []
        for (let i = startIndex; i <= endIndex && i < items.length; i++) arr.push(i)
        return arr
      })

      // 初始：3 turn 各 200，视口 200，buffer 0 → 窗口必含至少 1 项
      const initialCount = visibleItems.value.length
      expect(initialCount).toBeGreaterThan(0)
      assertCount++

      // reportHeight 让 k1 变成 50px（变小，但末项钉扎保证全 3 项仍渲染）
      vl.reportHeight('u-k1', 50)
      // visibleItems 是真 computed；heights 变化经 triggerRef 失效 layout→visibleRange→visibleItems。
      // 真 computed 在 .value 访问时同步求值，无需 await nextTick。
      const countAfterHeight = visibleItems.value.length
      expect(countAfterHeight).toBeGreaterThan(0)
      assertCount++

      // 滚动：改 DOM scrollTop + 调 onScrollUpdate（Wave1：把 DOM scrollTop 写入响应式 ref）
      scrollEl.scrollTop = 400
      vl.onScrollUpdate()
      // k1=50, k2=200, k3=200 → offsets=[0,50,250], total=450
      // scrollTop=400 在 turn2 内（offset 250-450）；buffer 0 → 窗口 [2,2]
      const rangeAfterScroll = vl.visibleRange.value
      expect(rangeAfterScroll.startIndex).toBe(2)
      expect(rangeAfterScroll.endIndex).toBe(2)
      assertCount++
    })
    scope.stop()
    // 防回归：三个断言都被执行（非短路跳过）
    expect(assertCount).toBe(3)
  })
})
