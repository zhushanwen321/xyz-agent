/**
 * PendingBubble 组件测试（session-occupancy u4b / D4 入队即显 pending 气泡）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - P1 组件黑盒·未提交态：气泡渲染（半透明 opacity-55 + Clock icon + hover 标注
 *   「占用结束后发送」）+ × 可点（emit remove）
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
    // [defer segments 化] 纯文本条目 segments = text 单段（enqueue 包的等价形态），无 chip 徽标
    const entry: QueuedMessage = { id: 'pm-1', text: '排队消息 A', segments: [{ type: 'text', text: '排队消息 A' }] }
    const wrapper = mount(PendingBubble, { props: { entry } })
    await nextTick()

    // 气泡锚点 + 半透明（opacity-55）+ Clock icon（lucide svg）
    const bubble = wrapper.find('[data-testid="pending-bubble-pm-1"]')
    expect(bubble.exists()).toBe(true)
    const body = wrapper.find('[data-testid="pending-bubble-body"]')
    expect(body.classes()).toContain('opacity-55')
    expect(body.find('svg').exists()).toBe(true)
    // hover 标注（i18n zh-CN：占用结束后发送——R3-doc1 泛化为占用维度中性措辞）
    expect(body.attributes('title')).toBe('占用结束后发送')
    expect(body.text()).toContain('排队消息 A')

    // × 可点（未提交不 disabled）→ emit remove(id)
    const cancel = wrapper.find('[data-testid="pending-bubble-cancel-pm-1"]')
    expect(cancel.attributes('disabled')).toBeUndefined()
    await cancel.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['pm-1']])
  })

  it('P2: 已提交态——× 禁用 + tooltip「已提交，等待投递」（撤销边界，D4）', async () => {
    const entry: QueuedMessage = { id: 'pm-2', text: '已提交消息', segments: [{ type: 'text', text: '已提交消息' }], mode: 'send' }
    const wrapper = mount(PendingBubble, { props: { entry } })
    await nextTick()

    // × disabled（disabled button 不派发 mouse 事件，tooltip 挂外层 anchor span）
    const cancel = wrapper.find('[data-testid="pending-bubble-cancel-pm-2"]')
    expect(cancel.attributes('disabled')).toBeDefined()
    const anchor = wrapper.find('[data-testid="pending-bubble-cancel-anchor"]')
    expect(anchor.attributes('title')).toBe('已提交，等待投递')
  })

  // ── [defer segments 化] 富内容 chip 计数徽标（MF-A 可见性面：入队富内容不丢段可感知）──

  it('P5: 富内容条目（非 text 段 >0）→ 文本旁显示 +N 徽标；纯文本条目不显示', async () => {
    const rich: QueuedMessage = {
      id: 'pm-3',
      text: '帮我看下这个报错',
      segments: [
        { type: 'text', text: '帮我看下这个报错' },
        { type: 'image', id: 'img-1', path: '/tmp/shot.png', fileName: 'shot.png', displayName: '截图.png' },
        { type: 'skill', name: 'code-review' },
      ],
    }
    const wrapper = mount(PendingBubble, { props: { entry: rich } })
    await nextTick()

    // 徽标可见 + 计数 = 非 text 段数（image + skill = 2）+ tooltip 说明
    const badge = wrapper.find('[data-testid="pending-bubble-chips-pm-3"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('+2')
    expect(badge.attributes('title')).toContain('2')
    // 气泡文本仍是 draft（展示文本）
    expect(wrapper.find('[data-testid="pending-bubble-body"]').text()).toContain('帮我看下这个报错')

    // 纯文本条目（仅 text 段）无徽标
    const plain: QueuedMessage = {
      id: 'pm-4',
      text: '纯文本',
      segments: [{ type: 'text', text: '纯文本' }],
    }
    const wrapper2 = mount(PendingBubble, { props: { entry: plain } })
    await nextTick()
    expect(wrapper2.find(`[data-testid="pending-bubble-chips-pm-4"]`).exists()).toBe(false)
  })
})

// ── [D1] hover 文案按 occupancy 三维分档（小时级 bash 场景「等什么结束」可操作）──

describe('PendingBubble hover 文案占用分档（D1）', () => {
  const PLAIN: QueuedMessage = { id: 'pm-d1', text: '排队消息', segments: [{ type: 'text', text: '排队消息' }] }

  /** mount + 写 occupancy 投影（真实 chat store sessionPhase 链路） */
  async function mountWithPhase(sessionId: string | undefined, phase: { turn: string; compacting: boolean; bash: boolean }) {
    if (sessionId) useChatStore().setOccupancy(sessionId, phase)
    const wrapper = mount(PendingBubble, { props: { entry: PLAIN, sessionId } })
    await nextTick()
    return wrapper
  }

  it('bash 占用 → 「等待命令执行结束后发送」', async () => {
    const wrapper = await mountWithPhase('s-d1-bash', { turn: 'idle', compacting: false, bash: true })
    expect(wrapper.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('等待命令执行结束后发送')
  })

  it('compacting 占用 → 「等待上下文压缩完成后发送」（优先级高于 bash）', async () => {
    const wrapper = await mountWithPhase('s-d1-compact', { turn: 'idle', compacting: true, bash: true })
    expect(wrapper.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('等待上下文压缩完成后发送')
  })

  it('turn=settling（无 compacting/bash）→ 「等待当前回合结束后发送」', async () => {
    const wrapper = await mountWithPhase('s-d1-settle', { turn: 'settling', compacting: false, bash: false })
    expect(wrapper.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('等待当前回合结束后发送')
  })

  it('全 idle / 投影缺失 / 未传 sessionId → 泛化「占用结束后发送」', async () => {
    const idle = await mountWithPhase('s-d1-idle', { turn: 'idle', compacting: false, bash: false })
    expect(idle.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('占用结束后发送')
    const noSid = await mountWithPhase(undefined, { turn: 'idle', compacting: false, bash: false })
    expect(noSid.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('占用结束后发送')
  })

  it('occupancy 帧驱动响应式更新：bash 结束（idle）→ 文案回落泛化', async () => {
    const chat = useChatStore()
    const wrapper = await mountWithPhase('s-d1-react', { turn: 'idle', compacting: false, bash: true })
    expect(wrapper.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('等待命令执行结束后发送')
    chat.setOccupancy('s-d1-react', { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    expect(wrapper.find('[data-testid="pending-bubble-body"]').attributes('title')).toBe('占用结束后发送')
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
