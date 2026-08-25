/**
 * SubagentTab 组件测试（E-4，subagent-realtime-channel §6.1/§6.3 退役步骤 1）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者：entry 帧消费走 chatStore.applySubagentEntries（routeInbound 链，不经组件）——
 *   组件只负责快照拉取 + 恒订阅 stream_delta
 * - 使用者（黑盒 DOM）：帧先于 drawer 打开到达 → 打开 drawer「打开即完整」（快照替换后
 *   MessageStream 渲染完整对话流，消息文本 DOM 可见）；entry 帧继续到达（帧路由链）→
 *   DOM 增量出现新消息
 * - 观察者：非 running record 也恒订阅（R3 消解：订阅时机与 record 状态机解耦）
 *
 * virtua mock / 壳 deps mock 与 MessageStream-subagent-force-working.test.ts 同款
 * （该文件头有完整论证：happy-dom 无布局，Virtualizer stub 全量渲染 scoped slot）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/subagent-tab.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import { openSubagent, bindDrawerSessionId, _resetDrawerForTest } from '@xyz-agent/core/domain/drawer'
import SubagentTab from '@/components/panel/SubagentTab.vue'
import type { Message, SubagentRecord } from '@xyz-agent/shared'
import * as events from '@/api/events'

vi.mock('virtua/vue', async () => {
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
      },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vitest.fn(),
          getItemOffset: vitest.fn(() => 0),
          getItemSize: vitest.fn(() => 200),
          findItemIndex: vitest.fn(() => 0),
          scrollTo: vitest.fn(),
          scrollBy: vitest.fn(),
        }
      },
      render(ctx) {
        return h(
          'div',
          { class: 'mock-virtualizer' },
          (ctx.data as unknown[]).map((item, index) => ctx.$slots.default?.({ item, index }) ?? []),
        )
      },
    }),
  }
})

// 壳 deps mock（对齐 MessageStream-subagent-force-working.test.ts：聚焦数据链不需真 deps）
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
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

// sessionApi mock：fetchAndInject 内部调 getSubagentHistory（快照腿）
vi.mock('@/api/domains/session', () => ({
  getSubagentHistory: vi.fn(),
  getSubagents: vi.fn().mockResolvedValue([]),
  subagentAction: vi.fn(),
  getAgentCallHistory: vi.fn(),
}))
// subagent store 经 @/api 门面导入 session；vitest 环境 VITE_MOCK=true 时门面把 session
// 解析到 src/api/mock（非 domains/session，mockApi.getSubagentHistory 在测试里永不 resolve，
// fetchAndInject 卡死 → 恒订阅不执行）。需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()（同 stores/subagent.test.ts 手法）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  return { ...actual, session }
})
// events mock：断言恒订阅（subscribeStream 双键注册）
vi.mock('@/api/events', () => ({
  on: vi.fn(() => vi.fn()),
  off: vi.fn(),
  dispatch: vi.fn(),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  onGlobal: vi.fn(() => vi.fn()),
  onGlobalType: vi.fn(() => vi.fn()),
  onCrossSession: vi.fn(() => vi.fn()),
  dispatchCrossSession: vi.fn(),
}))

import * as sessionApi from '@/api/domains/session'

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Turn stub：透出对话流内容（黑盒断言面——MessageStream 渲染树末端的消息文本）。
 * template 表达式受限于 stub 形态，用 computed 归一 user/assistant 文本。
 */
const globalStubs = {
  Turn: defineComponent({
    name: 'Turn',
    props: { turn: { type: Object, required: true } },
    setup(props) {
      const text = () => {
        const t = props.turn as { user?: { content: unknown }; assistants?: Array<{ content: unknown }> }
        const asText = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c))
        return [
          asText(t.user?.content),
          ...(t.assistants ?? []).map((a) => asText(a.content)),
        ].join('|')
      }
      return () => h('div', { 'data-testid': 'turn-stub' }, text())
    },
  }),
  SystemNotice: { name: 'SystemNotice', template: '<div />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

const MAIN_SID = 's-tab-main'
const SUB_ID = 'sub-tab-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, SUB_ID)

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: SUB_ID,
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: 'do something',
    status: 'running',
    ...overrides,
  }
}

function mountTab() {
  const wrapper = mount(SubagentTab, {
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
  return wrapper
}

/** 等待 fetchAndInject（async watch immediate → RPC microtask → setMessages）落地到渲染 */
async function settle(wrapper: Awaited<ReturnType<typeof mountTab>>) {
  await flushPromises()
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
}

describe('SubagentTab E-4 接入（entry 帧 + 恒订阅）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    _resetDrawerForTest()
    // drawer control 是 per-session 分区（sidRef 绑定驱动）：绑定固定 sid 才能让 openSubagent
    // 的写入与 SubagentTab 的 useDrawerControl 读到同一分区（renderer 由 useSideDrawer 顶层
    // 绑 focusedSessionId，测试直连 core 域同款手法——PanelContainer.test.ts 先例）
    bindDrawerSessionId(ref(MAIN_SID))
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    // records 预置（subagentMeta 标题栏读分区；不依赖 session.subagents 推送）
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord()])
  })

  it('帧先于打开 → 打开即完整：entry 帧写分区 + 快照替换后 DOM 渲染完整对话流', async () => {
    // ① 帧先于 drawer 打开到达（routeInbound 兜底链 → chatStore.applySubagentEntries）
    const chat = useChatStore()
    chat.applySubagentEntries(VIRTUAL_ID, [
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '分析这个仓库' }], timestamp: 1000 },
      },
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '第一段产出' }], timestamp: 2000 },
      },
    ])
    expect(chat.getMessages(VIRTUAL_ID)).toHaveLength(2)

    // ② drawer 打开：fetchAndInject 快照（文件直读全量）替换分区
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([
      { id: 'uuid-u1', role: 'user', content: '分析这个仓库', status: 'complete', timestamp: 1000 },
      { id: 'uuid-a1', role: 'assistant', content: '第一段产出', status: 'complete', timestamp: 2000 },
    ] as Message[])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })

    const wrapper = mountTab()
    await settle(wrapper)

    // 黑盒 DOM：打开即完整（快照内容全量可见）
    const turns = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect(turns[0]?.text()).toContain('分析这个仓库')
    expect(turns[0]?.text()).toContain('第一段产出')

    // ③ 新 entry 帧继续到达（帧路由链）→ DOM 增量出现新消息（同 turn 追加 assistant：
    // message-turns 的 D11 分组 = user 起点到下一 user 之前，第二条 assistant 并入同 turn）
    chat.applySubagentEntries(VIRTUAL_ID, [
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '第二段产出' }], timestamp: 4000 },
      },
    ])
    await settle(wrapper)
    const turnsAfter = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turnsAfter.length).toBe(1)
    expect(turnsAfter[0]?.text()).toContain('第一段产出')
    expect(turnsAfter[0]?.text()).toContain('第二段产出')

    wrapper.unmount()
  })

  it('恒订阅（R3 消解）：非 running record 打开也注册 stream_delta 双键订阅', async () => {
    // 非 running（done）record：旧逻辑 isRunning=false 不订阅；E-4 恒订阅
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ status: 'done' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })

    const wrapper = mountTab()
    await settle(wrapper)

    // 快照腿确实走了 mock（而非 VITE_MOCK 的 mockApi 挂起实现），恒订阅才有执行机会
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledWith(MAIN_SID, SUB_ID)
    // 双键订阅（主 sid + 虚拟分区 id，tee 帧 payload.sessionId 归属差异适配）
    expect(events.on).toHaveBeenCalledWith(MAIN_SID, expect.any(Function))
    expect(events.on).toHaveBeenCalledWith(VIRTUAL_ID, expect.any(Function))
    wrapper.unmount()
  })

  it('空态：未选中 subagent 时渲染空态占位（首屏冒烟）', () => {
    const wrapper = mountTab()
    expect(wrapper.find('[data-testid="drawer-subagent-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-subagent-tab"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
