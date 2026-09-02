/**
 * MessageStream 虚拟 session forceWorking 接线测试（review round2 R1-遗留-1）。
 *
 * 验证完整接线：虚拟 session id → subagentStore.isStreamingSubagent（窄口径，
 * running 且无轮终 result）→ toRenderItemsIncremental 的 forceWorking → 末位
 * turn.isStreaming → Turn prop。轮终 running-resumable（running + result）不再把
 * 虚拟 session 末位 turn 卡 streaming；真 running（无 result）仍显示 streaming。
 *
 * 与 turn-working.test.ts 的 R1-遗留-1 组分工：彼组断言 store 两口径派生值
 * （isStreamingSubagent / isRunning）与 useSessionActive 链；本组 mount 真实
 * MessageStream 锚定组件接线——forceWorking 若回退宽松 isRunning（修复前形态），
 * 轮终用例红（isStreaming 误 true）。
 *
 * virtua mock / 壳 deps mock 与 MessageStream-kind.test.ts 同款（该文件头有
 * 完整论证：happy-dom 无布局，Virtualizer stub 全量渲染 scoped slot）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-subagent-force-working.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import MessageStream from '@/components/panel/MessageStream.vue'
import type { Message, SubagentRecord } from '@xyz-agent/shared'

vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
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

// 壳 deps mock（对齐 MessageStream-kind.test.ts：测试聚焦 forceWorking 接线不需真 deps）
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
vi.mock('@/composables/features/sidebar/useSidebarNew', () => ({
  useSidebarNew: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Turn stub：透出末位 turn.isStreaming（forceWorking 的接线终点，Turn prop 形态） */
const globalStubs = {
  Turn: {
    name: 'Turn',
    props: { turn: { type: Object, required: true } },
    template: '<div data-testid="turn-stub" :data-streaming="String(turn.isStreaming)" />',
  },
  SystemNotice: { name: 'SystemNotice', template: '<div />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

const MAIN_SID = 's-fw-main'
const SUB_ID = 'sub-fw-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, SUB_ID)

function makeMsg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    ...over,
  } as Message
}

/** 虚拟分区消息：历史拉取形态（user + assistant 均 complete——JSONL 读出 status 恒 complete） */
function virtualHistory(): Message[] {
  return [
    makeMsg({ id: 'u1', role: 'user', content: '任务' }),
    makeMsg({ id: 'a1', role: 'assistant', content: '本轮产出正文' }),
  ]
}

function makeSubagentRecord(overrides: Partial<SubagentRecord>): SubagentRecord {
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

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

async function mountAndReadStreaming(): Promise<string> {
  const wrapper = mountStream(VIRTUAL_ID)
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
  const turnStub = wrapper.find('[data-testid="turn-stub"]')
  expect(turnStub.exists()).toBe(true)
  const streaming = turnStub.attributes('data-streaming')
  wrapper.unmount()
  return streaming ?? ''
}

describe('MessageStream 虚拟 session forceWorking 接线（R1-遗留-1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    // 虚拟分区注入历史（fetchAndInject 形态：均 complete，streaming 态完全由 forceWorking 驱动）
    useChatStore().hydrate(VIRTUAL_ID, virtualHistory())
  })

  it('轮终 record（running + result，running-resumable）→ 末位 turn.isStreaming=false（不卡 streaming）', async () => {
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running', result: '本轮产出正文' })])
    expect(await mountAndReadStreaming()).toBe('false')
  })

  it('真 running record（无 result）→ 末位 turn.isStreaming=true（仍显示 working）', async () => {
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])
    expect(await mountAndReadStreaming()).toBe('true')
  })

  it('主 session id（非虚拟）不受 subagent record 影响 → 末位 turn.isStreaming=false', async () => {
    // 主 session 分区注入同一形态消息；record 存在真 running 也不该经 forceWorking 传导
    useChatStore().hydrate(MAIN_SID, virtualHistory())
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])

    const wrapper = mountStream(MAIN_SID)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // 主 session 的 streaming 判定走 assistant.status（complete）→ false（working 指示归
    // session 级 derivedStatus，不在 MessageStream forceWorking 域）
    const turnStub = wrapper.find('[data-testid="turn-stub"]')
    expect(turnStub.exists()).toBe(true)
    expect(turnStub.attributes('data-streaming')).toBe('false')
    wrapper.unmount()
  })
})
