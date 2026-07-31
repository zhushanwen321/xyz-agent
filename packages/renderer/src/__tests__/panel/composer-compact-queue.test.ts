/**
 * Composer compact 待发队列 UI 集成测试（compact-queued-messages W2，TC11-TC16/TC18）。
 *
 * 验证：
 * - TC11: compact 期间 ⏎ 发送 → 入队 + 输入清空 + badge 可见
 * - TC12: compact 期间发送按钮点击 → 入队（按钮可点非 spinner）
 * - TC13: compact 期间 `/` 前缀文本 → 拒绝入队 + toast + draft 保留
 * - TC13b: compact 期间 `!`/`!!` 前缀 bash 命令 → 拒绝入队 + toast + draft 保留（对称于 `/`）
 * - TC14: badge 显示条数 + 首条预览 + 取消按钮移除单条
 * - TC15: compacted 成功（flush 清空）→ 队列清空 + badge 消失
 * - TC16: compacted 失败（队列保留）→ badge 仍在
 * - TC18: compact 期间 Alt+⏎ → 入队而非 followUp
 *
 * 策略（对齐 composer-bash-mode.test.ts 结构范本）：
 * - 真 pinia + 真 chatStore（isCompacting 用 chat.setCompacting(sid, true) 驱动）
 * - mock useChat（spy 化 send/steer/followUp/compact...）+ useToast（断言 toastError）
 * - mock ComposerInput（emit input 设 draft + emit keydown Enter 触发 onSend）
 * - stub 子组件（保留真实 CompactQueueBadge——断言其 DOM）
 * - 每用例 useCompactQueue()._clearAllForTest() + resetChatModuleState() 隔离
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-compact-queue.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { useChatStore } from '@/stores/chat'

// ── mock useChat（spy 化 send / steer / followUp / compact）+ useToast ──
const chatApiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
  sendBash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
}))
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))

vi.mock('@/composables/features/useChat', () => ({
  useChat: () => chatApiMock,
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  // chat: useCompactQueue.flush 依赖（TC15 flush 真实路径，非仅 useChat mock）
  chat: { send: chatApiMock.send, steer: chatApiMock.steer },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], updateSessionState: vi.fn() }),
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ defaultModel: '' }),
}))

// ── ComposerInput mock：emit input 设 draft + emit keydown Enter 触发 onSend ──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: {
    input: (val: string) => {
      lastInputText.value = val
      return true
    },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose }) {
    const clear = vi.fn()
    const setText = vi.fn()
    expose({ clear, setText, insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return { clear, setText }
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

import Composer from '@/components/panel/Composer.vue'
// resetChatModuleState 来自被 mock 的 useChat 模块（vi.fn，测试隔离占位）
import { resetChatModuleState } from '@/composables/features/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
  // 单例首次创建放 active effect scope（onScopeDispose 注册 cleanup，对齐 W1 测试契约）
  effectScope().run(() => {
    useCompactQueue()
  })
  // 单例跨用例共享，不 reset 会泄漏到下一用例
  useCompactQueue()._clearAllForTest()
  resetChatModuleState()
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

/** 模拟用户输入文本 + Enter 发送 */
async function typeAndEnter(wrapper: ReturnType<typeof mountComposer>, text: string): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
  await wrapper.vm.$nextTick()
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick() // onSend 是 async，需 flush
}

describe('Composer compact 待发队列（TC11-TC16/TC18）', () => {
  it('TC11: compact 期间 ⏎ 发送 → 入队 + 输入清空 + badge 可见', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, 'hello')

    // 入队 'hello'（peek 含该文本）
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('hello')
    // 输入已清空（clearInput → ComposerInput.clear）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    // DOM：badge 可见 + 含条数文案 + 预览
    const badge = wrapper.find('[data-testid="compact-queue-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('1 条')
    expect(badge.text()).toContain('hello')
    // 未走真实发送（send 未被调）
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('TC12: compact 期间发送按钮点击 → 入队（按钮可点非 spinner）', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'world')
    await wrapper.vm.$nextTick()

    // 发送位在 compact 态是可点击 Button（title=queueSend「排队发送」），非 disabled
    const sendBtn = wrapper.find('[title="排队发送"]')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('disabled')).toBeUndefined()

    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 入队 'world' + badge 显示
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('world')
    const badge = wrapper.find('[data-testid="compact-queue-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('world')
  })

  it('TC13: compact 期间 `/` 前缀文本 → 拒绝入队 + toast + draft 保留', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '/compact')

    // 队列为空（enqueue 未被调）+ compact RPC 未被调
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(chatApiMock.compact).not.toHaveBeenCalled()
    // toast 拒绝提示（zh-CN commandQueuedRejected）
    expect(toastMock.error).toHaveBeenCalledWith('压缩进行中，命令请等待完成后使用')
    // draft 未清空（clear 未被调），badge 不出现
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="compact-queue-badge"]').exists()).toBe(false)
  })

  it('TC13b: compact 期间 `!` 前缀 bash 命令 → 拒绝入队 + toast + draft 保留', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '!ls')

    // 队列为空（enqueue 未被调）+ sendBash 未被调（未静默降级为纯文本，也未执行 bash）
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(chatApiMock.sendBash).not.toHaveBeenCalled()
    // toast 拒绝提示（与 `/` 命令同一文案，zh-CN commandQueuedRejected）
    expect(toastMock.error).toHaveBeenCalledWith('压缩进行中，命令请等待完成后使用')
    // draft 未清空（clear 未被调），badge 不出现
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="compact-queue-badge"]').exists()).toBe(false)
  })

  it('TC14: badge 显示条数 + 首条预览 + 取消按钮移除单条', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    const m1 = queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    await wrapper.vm.$nextTick()

    // badge 显示条数 + 首条预览（m1）
    const badge = wrapper.find('[data-testid="compact-queue-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('2 条')
    expect(badge.text()).toContain('m1')

    // 取消第一条 → count 1 + 预览变 m2 + 文案变 '1 条'
    await wrapper.find(`[data-testid="compact-queue-cancel-${m1.id}"]`).trigger('click')
    expect(queue.count('s1')).toBe(1)
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m2'])
    await wrapper.vm.$nextTick()
    expect(badge.text()).toContain('1 条')
    expect(badge.text()).toContain('m2')
    expect(badge.text()).not.toContain('m1')
  })

  it('TC15: compacted 成功（flush 清空队列）→ 队列清空 + badge 消失', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    queue.enqueue('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="compact-queue-badge"]').exists()).toBe(true)

    // compacted 成功链路：flush 重放成功（send mock resolve）→ 队列清空 + 压缩态结束
    await expect(queue.flush('s1')).resolves.toBe(true)
    chat.setCompacting('s1', false)
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(0)
    expect(wrapper.find('[data-testid="compact-queue-badge"]').exists()).toBe(false)
  })

  it('TC16: compacted 失败（队列保留）→ badge 仍在', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    queue.enqueue('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="compact-queue-badge"]').exists()).toBe(true)

    // compacted 失败：压缩态结束但队列未 flush（保留待下次重试）
    chat.setCompacting('s1', false)
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(1)
    expect(wrapper.find('[data-testid="compact-queue-badge"]').exists()).toBe(true)
  })

  it('TC18: compact 期间 Alt+⏎ → 入队而非 followUp', async () => {
    const chat = useChatStore()
    chat.setCompacting('s1', true)
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'alt-msg')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', altKey: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // followUp 未被调（重路由到 onSend → 入队）
    expect(chatApiMock.followUp).not.toHaveBeenCalled()
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('alt-msg')
    // DOM：badge 可见（入队结果反映到 UI）
    const badge = wrapper.find('[data-testid="compact-queue-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('alt-msg')
  })
})
