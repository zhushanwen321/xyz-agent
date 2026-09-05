/**
 * PendingBubble 组件测试（session-occupancy u4b / D4 入队即显 pending 气泡）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - P1 组件黑盒·未提交态：气泡渲染（半透明 opacity-55 + Clock icon + hover 标注
 *   「压缩结束后发送」）+ × 可点（emit remove）
 * - P2 组件黑盒·已提交态：× 禁用 + tooltip「已提交，等待投递」（D4 撤销边界——
 *   已进 pi 队列的条目无法从 pi 侧撤回）
 * - P3 MessageStream 集成·入队即显 + 确认转态：enqueue → 对话流尾部出现 pending 气泡
 *   （flush 提交后气泡仍在——滞留语义）→ message_end(user) 确认帧（core ① →
 *   confirmDelivery）→ pending 气泡消失 + 正常 user 气泡入流（转态，live ≡ reload）
 * - P4 MessageStream 集成·撤销：未提交条目 × 点击 → 气泡消失，其余条目不受影响
 *
 * i18n：vitest 全局 setup（vitest-i18n-setup.ts）mock useI18n → t() 返回 zh-CN 文案。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/PendingBubble.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const apiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: apiMock.send, steer: apiMock.steer, streamSubscribe: apiMock.streamSubscribe },
  session: {},
}))
// MessageStream 挂载的重依赖 composable（对齐 MessageStream.wire.test.ts 的隔离策略）
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn(), loadMoreHistory: vi.fn(), hasMoreHistory: () => false }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))
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

import PendingBubble from '../PendingBubble.vue'
import MessageStream from '../../MessageStream.vue'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'
import { useChatStore } from '@/stores/chat'

let scope: EffectScope

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  scope = effectScope()
  scope.run(() => {
    useCompactQueue()
  })
  useCompactQueue()._clearAllForTest()
})

describe('PendingBubble 组件两态（P1-P2）', () => {
  it('P1: 未提交态——半透明气泡 + Clock icon + hover 标注 + × 可点（emit remove）', async () => {
    const entry: QueuedMessage = { id: 'pm-1', text: '排队消息 A' }
    const wrapper = mount(PendingBubble, { props: { entry } })
    await nextTick()

    // 气泡锚点 + 半透明（opacity-55）+ Clock icon（lucide svg）
    const bubble = wrapper.find('[data-testid="pending-bubble-pm-1"]')
    expect(bubble.exists()).toBe(true)
    const body = wrapper.find('[data-testid="pending-bubble-body"]')
    expect(body.classes()).toContain('opacity-55')
    expect(body.find('svg').exists()).toBe(true)
    // hover 标注（i18n zh-CN：压缩结束后发送）
    expect(body.attributes('title')).toBe('压缩结束后发送')
    expect(body.text()).toContain('排队消息 A')

    // × 可点（未提交不 disabled）→ emit remove(id)
    const cancel = wrapper.find('[data-testid="pending-bubble-cancel-pm-1"]')
    expect(cancel.attributes('disabled')).toBeUndefined()
    await cancel.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['pm-1']])
  })

  it('P2: 已提交态——× 禁用 + tooltip「已提交，等待投递」（撤销边界，D4）', async () => {
    const entry: QueuedMessage = { id: 'pm-2', text: '已提交消息', mode: 'send' }
    const wrapper = mount(PendingBubble, { props: { entry } })
    await nextTick()

    // × disabled（disabled button 不派发 mouse 事件，tooltip 挂外层 anchor span）
    const cancel = wrapper.find('[data-testid="pending-bubble-cancel-pm-2"]')
    expect(cancel.attributes('disabled')).toBeDefined()
    const anchor = wrapper.find('[data-testid="pending-bubble-cancel-anchor"]')
    expect(anchor.attributes('title')).toBe('已提交，等待投递')
  })
})

describe('PendingBubble × MessageStream 集成（P3-P4）', () => {
  /** mount MessageStream（真实 chat store + 真实 useCompactQueue 分区驱动） */
  async function mountStream(sessionId: string) {
    const wrapper = mount(MessageStream, {
      props: { sessionId },
      attachTo: document.body,
      global: { plugins: [createPinia()] },
    })
    await nextTick()
    await nextTick()
    return wrapper
  }

  it('P3: 入队即显 pending 气泡；flush 提交后气泡保持；确认帧驱动出队转正常态', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const wrapper = await mountStream('sess-p3')

    // 入队 → 对话流尾部立即出现 pending 气泡（半透明 + 标注）
    const m1 = queue.enqueue('sess-p3', '排队中')
    await nextTick()
    expect(wrapper.find(`[data-testid="pending-bubble-${m1.id}"]`).exists()).toBe(true)

    // flush 提交（submitQueuedEntry send 通道）——确认帧未到，气泡保持（滞留语义：
    // 提交 ≠ 投递，不误转态）
    await queue.flush('sess-p3')
    await nextTick()
    expect(queue.peek('sess-p3')[0]!.mode).toBe('send')
    expect(wrapper.find(`[data-testid="pending-bubble-${m1.id}"]`).exists()).toBe(true)

    // message_end(user) 确认帧（core ① 命中 → confirmDelivery 出队 + 转态 appendUser）
    chat.applyMessageEvent('sess-p3', { type: 'message.message_end', payload: { sessionId: 'sess-p3', entry: {
      type: 'message', id: `e-${crypto.randomUUID()}`, parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '排队中' }], timestamp: Date.now() },
    } } })
    await nextTick()

    // pending 气泡消失 + 正常 user 气泡入流（转态闭环）
    expect(wrapper.find(`[data-testid="pending-bubble-${m1.id}"]`).exists()).toBe(false)
    expect(chat.getMessages('sess-p3').some((m) => m.role === 'user')).toBe(true)
    wrapper.unmount()
  })

  it('P4: 未提交条目 × 撤销生效（气泡消失），其余队列消息不受影响', async () => {
    const queue = useCompactQueue()
    const wrapper = await mountStream('sess-p4')
    const m1 = queue.enqueue('sess-p4', '要撤销的')
    const m2 = queue.enqueue('sess-p4', '保留的')
    await nextTick()
    // 气泡数以列表容器子节点计（前缀选择器会误中 body/cancel-anchor 的 testid）
    expect(wrapper.findAll('[data-testid="pending-bubble-list"] > *')).toHaveLength(2)

    // 点 m1 的 × → remove 出队；m2 气泡保留
    await wrapper.find(`[data-testid="pending-bubble-cancel-${m1.id}"]`).trigger('click')
    await nextTick()
    expect(queue.peek('sess-p4').map((m) => m.text)).toEqual(['保留的'])
    expect(wrapper.find(`[data-testid="pending-bubble-${m1.id}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="pending-bubble-${m2.id}"]`).exists()).toBe(true)
    wrapper.unmount()
  })
})
