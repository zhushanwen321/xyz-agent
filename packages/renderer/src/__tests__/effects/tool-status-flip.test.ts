/**
 * 动态验证：虚拟滚动改动后 toolcall status 翻转 UI 不更新的根因定位。
 *
 * 策略 a → b → c，逐层 mount 真组件链，翻转 tool.status running→completed，
 * 断言 .animate-working-pulse 消失 + Check 图标出现。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/tool-status-flip.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Block from '@/components/panel/message-stream/Block.vue'
import Turn from '@/components/panel/message-stream/Turn.vue'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useChatStore } from '@/stores/chat'
import type { ToolCall, Message, ServerMessage } from '@xyz-agent/shared'
import type { MessageTurn } from '@/composables/logic/messageTurns'

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
 * 这是验证「虚拟滚动层（visibleItems/visibleRange liveComputed）是否截断响应式更新」的最小真链路。
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
          'data-assistant-ref': turn.assistants[0] ? 'new' : 'none',
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
    console.log('[c-full] running attr:', running.attributes('data-tool-status'))
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
    console.log('[c-full] completed attr:', completed.attributes('data-tool-status'))
    expect(completed.attributes('data-tool-status')).toBe('completed')

    wrapper.unmount()
  })

  it('c-assistant-ref: tool_call_end 后 turn.assistants[0] 引用是否更新（验证渲染层 prop 是否变）', async () => {
    // 此测试验证虚拟滚动层是否把新的 turn 对象传给 Turn。
    // 如果 liveComputed 缓存了旧 turn，data-assistant-id 可能不变但 data-assistant-ref 仍 new，
    // 关键看 data-tool-status 是否翻转。c-full 已覆盖；这里追加日志辅助定位。
    const chat = useChatStore()
    const sid = 'sess-c2'
    chat.hydrate(sid, [
      { id: 'u1', role: 'user', content: 'q', status: 'complete', timestamp: NOW },
    ])
    const wrapper = mountStream(sid)
    await nextTick()

    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage<'message.message_start'>)
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'read', input: {} },
    } as ServerMessage<'message.tool_call_start'>)
    await nextTick()
    console.log('[c-ref] before end:', wrapper.find('[data-testid="turn-xray"]').attributes())

    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: { sessionId: sid, toolCallId: 'tc1', output: 'done', status: 'completed' },
    } as ServerMessage<'message.tool_call_end'>)
    await nextTick()
    console.log('[c-ref] after end:', wrapper.find('[data-testid="turn-xray"]').attributes())

    expect(wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')).toBe('completed')
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

    const turns = wrapper.findAll('[data-testid="turn-xray"]')
    console.log('[c-multi] rendered turn count after start:', turns.length)

    // 现在第 1 turn 也注入 running tool：需要它是 streaming。但 finalize 后第 1 turn 不是 streaming。
    // 改测：直接测「已 hydrate 的完成 turn 上 toolCalls 状态翻转」。
    // 用 setMessages 覆盖第 1 turn 含 running tool，再翻转。
    const base = chat.messages.get(sid) ?? []
    const firstAssistant = base.find((m) => m.id === 'a1')!
    const tool: ToolCall = { id: 'tc-multi', toolName: 'read', input: {}, status: 'running', startTime: NOW }
    const updated: Message[] = base.map((m) =>
      m.id === 'a1'
        ? { ...m, toolCalls: [tool], contentBlocks: [{ type: 'toolCall', refId: 'tc-multi' }] }
        : m,
    )
    chat.setMessages(sid, updated)
    await nextTick()

    const turns2 = wrapper.findAll('[data-testid="turn-xray"]')
    console.log('[c-multi] rendered turn count after setMessages(running tool on a1):', turns2.length)
    // 找到 turn1（data-assistant-id=a1）
    const turn1 = turns2.find((w) => w.attributes('data-assistant-id') === 'a1')
    console.log('[c-multi] turn1 status (running):', turn1?.attributes('data-tool-status'))

    // 翻转 tool status via setMessages（不可变替换，模拟 tool_call_end 的 store 路径）
    const toolDone: ToolCall = { ...tool, status: 'completed', output: 'done' }
    const updated2: Message[] = (chat.messages.get(sid) ?? []).map((m) =>
      m.id === 'a1' ? { ...m, toolCalls: [toolDone] } : m,
    )
    chat.setMessages(sid, updated2)
    await nextTick()

    const turns3 = wrapper.findAll('[data-testid="turn-xray"]')
    const turn1After = turns3.find((w) => w.attributes('data-assistant-id') === 'a1')
    console.log('[c-multi] turn1 status (completed):', turn1After?.attributes('data-tool-status'))

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
    console.log('[cycle] after start, isWorking via xray:', wrapper.find('[data-testid="turn-xray"]').html())

    // tool_call_start
    chat.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'read', input: {} } } as ServerMessage<'message.tool_call_start'>)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')).toBe('running')

    // tool_call_end（completed）
    chat.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, toolCallId: 'tc1', output: 'done', status: 'completed' } } as ServerMessage<'message.tool_call_end'>)
    await nextTick()
    console.log('[cycle] after tool_call_end:', wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status'))

    // message.complete（normal stop）→ finalizeSession reason='normal'
    chat.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'stop', content: 'final answer' } } as ServerMessage<'message.complete'>)
    await nextTick()
    const finalStatus = wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')
    console.log('[cycle] after message.complete:', finalStatus)

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

    // running 态断言
    const pulseBefore = wrapper.findAll('.animate-working-pulse')
    console.log('[b] pulseBefore count:', pulseBefore.length)
    console.log('[b] html snippet (running):', wrapper.html().slice(0, 500))

    // 翻转 status：构造新的 turn prop（不可变更新，模拟 store commitMessages 路径）
    const tool2: ToolCall = { ...tool, status: 'completed', output: 'file content' }
    const assistant2: Message = { ...assistant, toolCalls: [tool2] }
    const turn2: MessageTurn = { ...turn, assistants: [assistant2] }
    await wrapper.setProps({ turn: turn2 })
    await nextTick()

    const pulseAfter = wrapper.findAll('.animate-working-pulse')
    const checkAfter = wrapper.findAll('svg.lucide-check')
    console.log('[b] pulseAfter count:', pulseAfter.length, '| checkAfter count:', checkAfter.length)

    expect(pulseAfter).toHaveLength(0)
    // 至少有一个 Check 图标（assistant 区复制按钮也有 Check，但 tool 块的 Check 在 trace 内）
    expect(checkAfter.length).toBeGreaterThan(0)
  })
})

/* ─────────────────────── 方案 c：直接验证 traceBlocks 响应式 ───────────────────────
 * c 不 mount MessageStream（虚拟滚动层 liveComputed 问题在 use-virtual-turn-list.test.ts
 * 已有覆盖），而是聚焦验证「Turn 把同一 toolCall 引用的 status 变化传给 Block」是否响应式。
 * 用同一引用（mutable tool.status = 'completed'）+ 不可变替换两种方式都测，区分断裂点。
 * ------------------------------------------------------------------------- */
describe('方案 c: traceBlocks 响应式验证（mutable 同引用 vs 不可变替换）', () => {
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

    console.log('[c1] pulse after immutable replace:', wrapper.findAll('.animate-working-pulse').length)
    expect(wrapper.findAll('.animate-working-pulse')).toHaveLength(0)
  })

  it('c2: mutable 同引用改 tool.status（深度 mutate）— 是否翻转？', async () => {
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

    // 深度 mutate 同一引用（非响应式，普通对象）—— prop 引用未变，setProps 也不触发
    // 这是验证「如果 store 内部是 mutate 而非替换」的情况
    ;(tool as ToolCall).status = 'completed'
    ;(tool as ToolCall).output = 'done'
    await nextTick()

    console.log('[c2] pulse after mutable mutate (no setProps):', wrapper.findAll('.animate-working-pulse').length)
    // 普通（非 reactive）对象 mutate 不会触发 Vue 更新——这里记录现象
  })
})

/* ─────────────────────── 方案 d：liveComputed 响应式追踪缺陷（根因定位）───────────────────────
 * 复刻 MessageStream.vue 的真实装配：renderItems 是真 computed（包 ref 数据源），
 * useVirtualTurnList 的 items getter 读 renderItems.value。visibleItems 是真 computed，
 * 内部读 visibleRange.value（liveComputed，**不追踪**）+ renderItems.value（真 computed，追踪）。
 *
 * 缺陷假设：当 heights 变化（reportHeight，ResizeObserver 驱动）但 renderItems 引用未变时，
 * visibleItems（真 computed）不会重算（其唯一被追踪依赖 renderItems 未变）→ 窗口/offsets 过时，
 * visibleRange.value 读到的是旧的 startIndex/endIndex → 滚动后该渲染的 turn 没渲染 / 该卸载的留着。
 * ------------------------------------------------------------------------- */
import { computed, ref, effectScope } from 'vue'
import { useVirtualTurnList } from '@/composables/effects/useVirtualTurnList'
import type { RenderItem } from '@/composables/logic/messageTurns'

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

describe('方案 d: liveComputed 响应式追踪缺陷（heights 变但 renderItems 未变时 visibleItems 不重算）', () => {
  it('d: reportHeight 后 heights 变，但 renderItems 不变 → visibleItems 不重算 → 窗口过时', async () => {
    // 模拟 MessageStream：renderItems 包一个 ref，items getter 读它
    const scope = effectScope()
    let visibleItemsCount = -1
    let visibleRangeSnapshot = { startIndex: -1, endIndex: -1 }
    await new Promise<void>((resolve) => {
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
        // visibleItems 复刻 MessageStream.vue:197
        const visibleItems = computed(() => {
          const { startIndex, endIndex } = vl.visibleRange.value
          const items = renderItems.value
          const arr: number[] = []
          for (let i = startIndex; i <= endIndex && i < items.length; i++) arr.push(i)
          return arr
        })

        // 初始：估算高度 200，视口 200，buffer 0 → 窗口应含 [0,1] 左右
        visibleItemsCount = visibleItems.value.length
        visibleRangeSnapshot = { ...vl.visibleRange.value }
        console.log('[d] initial visibleRange:', visibleRangeSnapshot, '| visibleItems count:', visibleItemsCount)

        // 步骤 A：reportHeight 让 k1 变成 50px（高度变小），但 renderItems 不变
        vl.reportHeight('u-k1', 50)
        // 不 await nextTick（同 scope 内同步读）
        const countAfterHeight = visibleItems.value.length
        const rangeAfterHeight = { ...vl.visibleRange.value }
        console.log('[d] after reportHeight(k1=50) — visibleRange:', rangeAfterHeight, '| visibleItems count:', countAfterHeight)
        // visibleRange（liveComputed）每次访问重算，应反映新 heights
        // 但 visibleItems（真 computed）只在被追踪依赖（renderItems）变时才重算

        // 步骤 B：改 scrollTop（模拟滚动）—— scrollTop 不是响应式，visibleItems 仍不会因它重算
        scrollEl.scrollTop = 400
        const rangeAfterScroll = { ...vl.visibleRange.value } // liveComputed 重读，反映新 scrollTop
        const countAfterScroll = visibleItems.value.length // 真 computed 缓存（renderItems 没变）
        console.log('[d] after scrollTop=400 — visibleRange(liveComputed):', rangeAfterScroll, '| visibleItems count(真computed, cached):', countAfterScroll)

        resolve()
      })
    })
    scope.stop()

    // 关键结论（日志可见）：
    // - visibleRange 是 liveComputed，每次 .value 访问都重算（反映最新 heights/scrollTop）
    // - 但 visibleItems 是真 computed，只在 renderItems 变时重算——heights/scrollTop 变化它感知不到
    // → 如果只有 heights/scrollTop 变（无 renderItems 变），visibleItems 返回旧数组 → 过时渲染
    expect(visibleItemsCount).toBeGreaterThan(0)
  })
})
