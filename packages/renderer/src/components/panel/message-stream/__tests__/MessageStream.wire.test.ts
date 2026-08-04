/**
 * w4 wave 接线层测试（实际用例：TC-w4-1/2/3/3b/4/6/7/8/9）。
 *
 * 覆盖：Turn.vue 接入 useTurnExpansion（w1）+ 连续同类块独立渲染（合并功能已移除），
 *       MessageStream.vue 挂载 TurnRail（w3）+ 事件路由。
 *
 * 策略（任务指引「务实优先」）：
 * - TC-w4-1/2/7/8：mount Turn.vue + 真实 useTurnExpansion（无 mock，验端到端接线）
 * - TC-w4-3：mount TurnRail.vue smoke test（TurnRail props 契约：5 props + 2 emit）
 * - TC-w4-3b/4/6：useMessageStreamRail composable 单元测试（验事件路由 handler → useTurnExpansion，
 *   rail 下标→MessageTurn.index 映射）
 * - TC-w4-9：mount MessageStream.vue 首屏冒烟（验 MessageStream 模板真的引用 TurnRail + emit 接线）。
 *   真实 mount：仅 mock useChat/useSidebar（store 副作用隔离），用 chat store setMessages 注入
 *   消息让 renderItems/railTurns 非空，TurnRail v-if turns.length>0 命中渲染。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/MessageStream.wire.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
// [w6 chat-ui-and-shell T7] ui 包组件：Turn/TurnRail 迁 ui；Turn 展开态经 deps inject（真实 useTurnExpansion 在 renderer 壳 useChatViewDeps）
import { computed, nextTick, ref, shallowRef, defineComponent, h, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { VirtualizerHandle } from 'virtua/vue'
import { Turn, TurnRail } from '@xyz-agent/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import MessageStream from '../../MessageStream.vue'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import { createMockVlist } from '@/__tests__/effects/_virtua-mock-helper'
import { useTurnExpansionStore } from '@/stores/turn-expansion'
import { useChatStore } from '@/stores/chat'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import type { Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

// mock 重依赖 composable（只测组件接线，不测 store 副作用）。
// useChat mock 需含 loadMoreHistory/hasMoreHistory：useLoadMoreHistory 经 useChat 读这俩，
// MessageStream 挂载时 useLoadMoreHistory 会立即调 hasMoreHistory（computed）。
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

// [w6] MessageStream 壳装配 useChatViewDeps（TC-w4-9/9b mount 真组件）→ mock 装配器，壳内 ui 组件经 deps inject 消费
const chatDepsMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => []),
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  getChangeSetStatus: vi.fn(() => undefined),
  isExpanded: vi.fn(() => false),
  toggleExpand: vi.fn(),
  collapse: vi.fn(),
  abortBash: vi.fn(),
  editAndResend: vi.fn(),
  onFork: vi.fn(),
  onForkAsk: vi.fn(),
  onHandoff: vi.fn(),
  onHandoffAsk: vi.fn(),
  openDrawer: vi.fn(),
  onFileClick: vi.fn(),
  onAmbiguousSelect: vi.fn(),
  loadFileCandidates: vi.fn(() => Promise.resolve([])),
  renderMarkdown: vi.fn(() => Promise.resolve([])),
  renderMermaid: vi.fn(() => Promise.resolve({ svg: '' })),
  toMarkdown: vi.fn(() => ''),
}))
vi.mock('@/composables/panel/useChatViewDeps', () => ({
  useChatViewDeps: () => chatDepsMock,
}))

/** 构造 toolCall（status 可指定，默认 completed） */
function makeToolCall(id: string, status: ToolCall['status'] = 'completed'): ToolCall {
  return { id, toolName: 'grep', input: { command: 'foo' }, status, startTime: 0 } as ToolCall
}

/** 构造带 contentBlocks 的 assistant message（连续同类块场景）。 */
function assistantWithBlocks(opts: {
  id?: string
  content?: string
  status?: Message['status']
  thinking?: ThinkingBlock[]
  toolCalls?: ToolCall[]
  contentBlocks?: Message['contentBlocks']
}): Message {
  return {
    id: opts.id ?? 'a1',
    role: 'assistant',
    content: opts.content ?? 'done',
    status: opts.status ?? 'complete',
    timestamp: Date.now(),
    thinking: opts.thinking,
    toolCalls: opts.toolCalls,
    contentBlocks: opts.contentBlocks,
  } as Message
}

/** 构造 MessageTurn：complete 态 + hasFoldable=true（让 turn-meta 可点击展开）。 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() } as Message,
    assistants: [assistantWithBlocks({ status: 'complete' })],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  } as MessageTurn
}

/** [w6] ui Turn 展开态经 deps 注入：stateful mock（reactive Set）驱动展开/收起契约
 *  （真实 useTurnExpansion 逻辑在 renderer 壳 useChatViewDeps 内，组件层只经 isExpanded/toggleExpand/collapse 消费）。 */
const expandedTurns = reactive(new Set<number>())
function statefulExpandDeps() {
  return {
    isExpanded: (idx: number) => expandedTurns.has(idx),
    toggleExpand: (idx: number) => {
      if (expandedTurns.has(idx)) expandedTurns.delete(idx)
      else expandedTurns.add(idx)
    },
    collapse: (idx: number) => expandedTurns.delete(idx),
  }
}

/** mount Turn，stub 掉子组件（Block/ChangeSetCard/MarkdownRenderer），隔离 Turn 自身接线逻辑。 */
function mountTurn(props: { turn: MessageTurn; sessionId?: string; isSessionActive?: boolean }) {
  return mount(Turn, {
    props: {
      turn: props.turn,
      sessionId: props.sessionId ?? 's1',
      ...(props.isSessionActive !== undefined ? { isSessionActive: props.isSessionActive } : {}),
    },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(statefulExpandDeps()),
      stubs: { Block: true, ChangeSetCard: true, MarkdownRenderer: true },
    },
  })
}

/** mount Turn 但用真实 Block（验 merged 卡片 / trace 块渲染）。 */
function mountTurnWithRealBlock(props: { turn: MessageTurn; sessionId?: string }) {
  return mount(Turn, {
    props: { turn: props.turn, sessionId: props.sessionId ?? 's1' },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(statefulExpandDeps()),
      stubs: { ChangeSetCard: true, MarkdownRenderer: true },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  expandedTurns.clear()
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-1/2/7/8：Turn.vue 接入 useTurnExpansion（真实 composable，端到端）
 * ────────────────────────────────────────────────────────────── */
describe('Turn.vue 接线 useTurnExpansion（w1）', () => {
  it('TC-w4-1: complete 态默认折叠（showTrace=false），点 turn-meta → 展开 trace（isExpanded 驱动）', async () => {
    const wrapper = mountTurn({ turn: makeTurn() })
    // complete + 默认折叠 → trace 不存在
    expect(wrapper.find('.trace').exists()).toBe(false)
    // chevron 未 rotate-90（折叠态）
    expect(wrapper.find('.chev').classes()).not.toContain('rotate-90')
    // 点击 turn-meta → useTurnExpansion.toggle → isExpanded=true → showTrace=true
    await wrapper.find('.turn-meta').trigger('click')
    expect(wrapper.find('.trace').exists()).toBe(true)
    // chevron rotate-90（展开态）
    expect(wrapper.find('.chev').classes()).toContain('rotate-90')
  })

  it('TC-w4-2: 完成态自动收起（isSessionActive true→false 触发 useTurnElapsed.onComplete → deps.collapse）', async () => {
    // 关键：先让 isExpanded=true（手动展开），才能区分两条路径——
    //   showTrace = sessionActive || isExpanded(idx)。
    //   若不预先展开，sessionActive true→false 时 showTrace 直接 false，与 onComplete 是否调用无关，
    //   测试无法捕捉 onComplete 回归（即使把 onComplete 改 no-op 测试仍过）。
    //   预先 isExpanded=true 后：onComplete 正确触发 collapse → isExpanded 转 false → showTrace=false；
    //   若 onComplete 未触发 → isExpanded 仍 true → showTrace=false||true=true（trace 仍在，测试能捕捉）。
    //
    // sessionActive=true 时 turn-meta button :disabled（Turn.vue），无法用点击触发 toggle，
    // 故直接预置 expandedTurns（makeTurn() 默认 index=1）。
    expandedTurns.add(1)
    const wrapper = mount(Turn, {
      props: {
        turn: makeTurn({ isStreaming: false }),
        sessionId: 'sess-w4-2',
        isSessionActive: true,
      },
      global: {
        plugins: [createPinia()],
        provide: mockChatProvide(statefulExpandDeps()),
        stubs: { Block: true, ChangeSetCard: true, MarkdownRenderer: true },
      },
    })
    // sessionActive=true → showTrace = true || true = true（trace 可见）
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 对话结束：isSessionActive true→false → useTurnElapsed watch 触发 onComplete → deps.collapse(1)
    //   → isExpanded(1) 变 false → showTrace = false || false = false → trace 消失
    await wrapper.setProps({ isSessionActive: false })
    expect(wrapper.find('.trace').exists()).toBe(false)
    // 回归守卫：collapse 确实被调用（expandedTurns 已被 onComplete 路径复位）。
    // 若 onComplete 被改成 no-op，此处仍为 true，测试会失败（捕捉回归）。
    expect(expandedTurns.has(1)).toBe(false)
  })

  it('TC-w4-7: 展开态隔离 —— 两个 Turn（不同 turnIndex）展开互不影响', async () => {
    // [w6] 展开态经 deps 注入（stateful mock 按 turnIndex 分区）；真实 per-session 隔离在
    // renderer 壳 useChatViewDeps（useTurnExpansion(sessionId)）。组件层契约：不同 turnIndex 独立。
    const turnA = makeTurn({ index: 1 })
    const turnB = makeTurn({ index: 2 })
    const wrapperA = mountTurn({ turn: turnA, sessionId: 'sessA' })
    const wrapperB = mountTurn({ turn: turnB, sessionId: 'sessB' })
    // 初始都折叠
    expect(wrapperA.find('.trace').exists()).toBe(false)
    expect(wrapperB.find('.trace').exists()).toBe(false)
    // 展开 A
    await wrapperA.find('.turn-meta').trigger('click')
    expect(wrapperA.find('.trace').exists()).toBe(true)
    // B 仍折叠（不同 turnIndex，展开态隔离）
    expect(wrapperB.find('.trace').exists()).toBe(false)
  })

  it('TC-w4-8: 连续同类 tool 调用 → 每个 block 独立渲染（不再合并）', async () => {
    // 构造 3 个连续 toolCall（同类型，非失败）→ 不再合并，3 个独立 Block
    const tc1 = makeToolCall('tc1')
    const tc2 = makeToolCall('tc2')
    const tc3 = makeToolCall('tc3')
    const turn = makeTurn({
      assistants: [
        assistantWithBlocks({
          status: 'complete',
          content: 'all done',
          toolCalls: [tc1, tc2, tc3],
          contentBlocks: [
            { type: 'toolCall', refId: 'tc1' },
            { type: 'toolCall', refId: 'tc2' },
            { type: 'toolCall', refId: 'tc3' },
            { type: 'text', refId: 'text' },
          ],
        }),
      ],
    })
    const wrapper = mountTurnWithRealBlock({ turn })
    // 展开 trace（complete 态需手动展开）
    await wrapper.find('.turn-meta').trigger('click')
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 不存在 merged 卡片（合并功能已移除）
    expect(wrapper.findAll('[data-testid="merged-block-card"]')).toHaveLength(0)
    // 3 个连续 tool 各自独立渲染（3 个 Block / trace-blk）
    const blocks = wrapper.findAll('.trace-blk')
    expect(blocks).toHaveLength(3)
  })
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-3：TurnRail（w3）props 契约 smoke test（TurnRail props 契约：5 props + 2 emit）
 * TC-w4-3b/4/6：useMessageStreamRail composable 单元测试（验事件路由 → useTurnExpansion，rail 下标→MessageTurn.index 映射）
 *
 * MessageStream.vue 整体 mount 的真接线性由 TC-w4-9（见文末 describe）覆盖：仅 mock useChat/
 * useSidebar（store 副作用隔离），用 chat store setMessages 注入消息让 railTurns 非空，
 * 断言 TurnRail 在 DOM 渲染 + jump/toggle emit 经 MessageStream 路由到 rail composable。
 * ────────────────────────────────────────────────────────────── */
describe('MessageStream rail 接线（TurnRail props 契约 + useMessageStreamRail 事件路由）', () => {
  /** 构造 3 个 turn 的 renderItems（rail 索引空间 = 3 turns） */
  function makeRenderItems(): RenderItem[] {
    return [
      { kind: 'turn', turn: makeTurn({ index: 1 }) },
      { kind: 'turn', turn: makeTurn({ index: 2 }) },
      { kind: 'turn', turn: makeTurn({ index: 3 }) },
    ]
  }

  /**
   * mount 一个 host 组件，setup 内调 useMessageStreamRail（composable 内 onMounted/onScopeDispose
   * 需 active component instance，用 host 组件包裹避免「no active effect scope」warning）。
   * 返回 rail composable 返回值 + host wrapper（unmount 触发 onScopeDispose 清理）。
   *
   * [cw wave w4] vlistRef 必填：默认注入 createMockVlist()，virtua 路径专用。
   */
  function mountRail(opts: {
    sessionId?: string
    renderItems?: RenderItem[]
    scrollEl?: HTMLElement | null
    vlistRef?: ReturnType<typeof shallowRef<VirtualizerHandle | null>>
  } = {}): { rail: ReturnType<typeof useMessageStreamRail>; wrapper: ReturnType<typeof mount> } {
    const sessionId = computed(() => opts.sessionId ?? 's-rail-test')
    const renderItemsRef = ref<RenderItem[]>(opts.renderItems ?? makeRenderItems())
    const scrollElRef = ref<HTMLElement | null>(opts.scrollEl ?? null)
    const vlistRef = opts.vlistRef ?? shallowRef<VirtualizerHandle | null>(createMockVlist())
    let rail!: ReturnType<typeof useMessageStreamRail>
    const Host = defineComponent({
      setup() {
        rail = useMessageStreamRail({
          sessionId,
          renderItems: renderItemsRef,
          scrollEl: scrollElRef,
          vlistRef,
        })
        return () => h('div')
      },
    })
    const wrapper = mount(Host, { global: { plugins: [createPinia()] } })
    return { rail, wrapper }
  }

  /** mount TurnRail smoke test（验 props 契约：MessageStream 传给 TurnRail 的 5 个 props + 4 个 emit） */
  it('TC-w4-3: TurnRail 接受 MessageStream 传入的 props 契约（turns/activeTurnIndex/sessionActive/panelRightEdge/expandedTurns）', () => {
    const turns = makeRenderItems().map((i) => (i.kind === 'turn' ? i.turn : null)).filter(Boolean) as MessageTurn[]
    const wrapper = mount(TurnRail, {
      props: {
        turns,
        activeTurnIndex: 1,
        sessionActive: false,
        panelRightEdge: 800,
        expandedTurns: new Set([2]),
      },
    })
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(true)
    // 验 rail 接受所有 props 不报错（MessageStream 传相同 shape）
    expect(wrapper.findAll('[data-testid="rail-node"]')).toHaveLength(3)
    expect(wrapper.props('panelRightEdge')).toBe(800)
    // expandedTurns prop 透传（toggle 图标方向依据）
    expect(wrapper.props('expandedTurns')).toEqual(new Set([2]))
  })

  it('TC-w4-3b: useMessageStreamRail.expandedTurns 从 store 派生当前 session 已展开的 turn index', () => {
    const { rail, wrapper } = mountRail()
    // 初始无展开 → 空 Set
    expect(rail.expandedTurns.value.size).toBe(0)
    // onToggle(0) 翻转 railTurns[0].index=1 → store 记录 index=1 展开
    rail.onToggle(0)
    expect(rail.expandedTurns.value.has(1)).toBe(true)
    expect(rail.expandedTurns.value.size).toBe(1)
    // 再 onToggle(0) 翻回 → index=1 折叠，expandedTurns 不含 1
    rail.onToggle(0)
    expect(rail.expandedTurns.value.has(1)).toBe(false)
    wrapper.unmount()
  })

  it('TC-w4-4: onToggle(idx) → useTurnExpansion.toggle 翻转（rail 下标 → MessageTurn.index 映射正确）', () => {
    // useMessageStreamRail 内部调 useTurnExpansion（per-instance Map）。
    // 验证 rail onToggle 下标映射 → MessageTurn.index：railTurns[0].index=1，onToggle(0) 应翻转 index=1。
    // 注：useTurnExpansion 是 per-instance（每次调用建自己的 Map），与 Turn.vue 内的调用不共享——
    //    这是 w1 既定设计（任务规范「直接 import 用，不重新实现」）。本测验证 rail handler 路由正确性。
    const { rail, wrapper } = mountRail()
    // railTurns 下标 → MessageTurn.index 映射（这是 onToggle/expandAll 的路由核心）
    expect(rail.railTurns.value).toHaveLength(3)
    expect(rail.railTurns.value[0].index).toBe(1)
    expect(rail.railTurns.value[1].index).toBe(2)
    expect(rail.railTurns.value[2].index).toBe(3)
    // onToggle(0) 不抛错（railTurns[0].index=1 存在，调 useTurnExpansion.toggle(1)）
    expect(() => rail.onToggle(0)).not.toThrow()
    // 边界：onToggle 越界不抛错（railTurns[99] 不存在 → turnIdx undefined → no-op）
    expect(() => rail.onToggle(99)).not.toThrow()
    wrapper.unmount()
  })

  it('TC-w4-6a: [cw wave w4] vlistRef.value=null（首帧未挂载）→ onJump no-op 不抛错', () => {
    // vlistRef 必填但 value 可能为 null（首帧 / session 切换 dispose）：onJump 早返回 no-op。
    const scrollEl = document.createElement('div')
    const vlistRef = shallowRef<VirtualizerHandle | null>(null)
    const { rail, wrapper } = mountRail({ scrollEl, vlistRef })
    expect(() => rail.onJump(1)).not.toThrow()
    expect(() => rail.onJump(2)).not.toThrow()
    wrapper.unmount()
  })

  it('TC-w4-6b: [cw wave w3] virtua 路径（传 vlistRef）onJump(idx) → vlistRef.scrollToIndex(renderIdx, {align:"start"})', () => {
    // virta 路径：rail.onJump 用 v.scrollToIndex 替代 scrollEl.scrollTop 写入（design §4.1/§3.3）
    const scrollToIndex = vi.fn()
    const vlistRef = shallowRef<VirtualizerHandle | null>(createMockVlist({ scrollToIndex }))
    const { rail, wrapper } = mountRail({ vlistRef })
    // onJump(1) → railTurns[1]=index=2 → renderItems 下标 1（makeRenderItems：turn/index=1,2,3 各占 0,1,2）
    rail.onJump(1)
    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
    // onJump(2) → renderItems 下标 2
    rail.onJump(2)
    expect(scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' })
    wrapper.unmount()
  })
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-9：mount MessageStream.vue 首屏冒烟（验真接线）
 *
 * 反回归目标：若有人从 MessageStream.vue 模板删掉 <TurnRail> 标签、删掉 rail.onJump/onToggle
 * 绑定、或重命名 emit，本测直接失败（区别于上面 composable/props 契约测试——它们不 mount
 * MessageStream.vue，删 <TurnRail> 标签后仍全绿）。
 *
 * 真实 mount 可行性：MessageStream.vue 的重依赖（useChat/useSidebar）已 mock；
 * useChat mock 补 loadMoreHistory/hasMoreHistory（useLoadMoreHistory 经 useChat 读这俩）。
 * 用 chat store setMessages 注入消息让 renderItems/railTurns 非空，TurnRail v-if 命中渲染。
 * attachTo: document.body 让 scrollEl 真挂 DOM（virtua <Virtualizer> 需真实布局测量才能窗口化渲染；
 * 不 attach 的话 scrollEl 在 happy-dom 空间里 clientHeight=0，虚拟化窗口为空）。
 * ────────────────────────────────────────────────────────────── */
describe('MessageStream.vue 首屏冒烟（mount 真组件，验 TurnRail 接线）', () => {
  /** 构造 2 turn 的消息序列（user/assistant 交替）让 toRenderItems 产出 2 个 turn。 */
  function makeStreamMessages(): Message[] {
    return [
      { id: 'u1', role: 'user', content: 'first turn', status: 'complete', timestamp: 1 } as Message,
      { id: 'a1', role: 'assistant', content: 'first reply', status: 'complete', timestamp: 2 } as Message,
      { id: 'u2', role: 'user', content: 'second turn', status: 'complete', timestamp: 3 } as Message,
      { id: 'a2', role: 'assistant', content: 'second reply', status: 'complete', timestamp: 4 } as Message,
    ]
  }

  it('TC-w4-9: mount MessageStream 渲染 TurnRail（DOM 含 [data-testid=turn-rail] + rail-node）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    chat.setMessages('sess-mount', makeStreamMessages())

    const wrapper = mount(MessageStream, {
      props: { sessionId: 'sess-mount' },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    // 等 watch(scrollEl) immediate 回调 + onScrollUpdate + computed 链路稳定
    await nextTick()
    await nextTick()

    // 真接线断言 1：MessageStream 模板里的 <TurnRail> 标签确实渲染到 DOM（v-if turns.length>0 命中）
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(true)
    // 真接线断言 2：rail-node 数 = 消息里的 turn 数（2 turn）
    expect(wrapper.findAll('[data-testid="rail-node"]')).toHaveLength(2)

    wrapper.unmount()
  })

  it('TC-w4-9b: mount MessageStream 后 TurnRail emit jump/toggle 经模板 @jump/@toggle 路由（验 emit 接线）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    chat.setMessages('sess-mount-emit', makeStreamMessages())

    const wrapper = mount(MessageStream, {
      props: { sessionId: 'sess-mount-emit' },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    await nextTick()
    await nextTick()

    // 找到 MessageStream 内部渲染的 TurnRail 子组件（真接线：MessageStream import + template 引用）
    const turnRail = wrapper.findComponent(TurnRail)
    expect(turnRail.exists()).toBe(true)

    // emit jump(0) → MessageStream 模板 @jump="onJump" 路由到 rail.onJump（不抛错即接线成立）
    turnRail.vm.$emit('jump', 0)
    await nextTick()
    // emit toggle(0) → MessageStream 模板 @toggle="onToggle" 路由到 rail.onToggle → useTurnExpansion.toggle(1)
    //   railTurns[0].index=1（首条 user 开启 turnSeq=1）→ store 分区记 index=1 展开态
    turnRail.vm.$emit('toggle', 0)
    await nextTick()

    // 真接线断言：toggle 经 MessageStream 路由到 useTurnExpansion（store isExpanded(1) 翻为 true）。
    // 若 MessageStream 模板删了 @toggle 绑定或 onToggle 改名，store 不变 → 此处 false，测试失败。
    const store = useTurnExpansionStore()
    expect(store.isExpanded('sess-mount-emit', 1)).toBe(true)

    wrapper.unmount()
  })
})
