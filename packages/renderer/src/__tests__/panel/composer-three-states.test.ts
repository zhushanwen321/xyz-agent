/**
 * Composer 三态 UI + B 策略 E2E 测试（T2.2/T2.3/T2.5/T9.14）。
 *
 * 锁定 fix-state-tearing 的 UI 层核心：
 * - D-001 B 策略：busy 时 Enter / 点发送位 → 调 steer（不调 send）
 * - T2.5：busy 时停止按钮始终可见（isActive 驱动 v-if="isActive"）
 * - T9.14：Composer 三态渲染回归（idle=发送按钮 / sending=spinner / busy=停止按钮）
 *
 * 策略：
 * - 真实 chat store（测的就是 store 的派生 isActive 行为）
 * - mock useChat（send/steer/abort/followUp/compact/editAndResend），保留 spy 断言调用
 * - mock useNewTaskFlow（landing 态 submitFirstMessage）
 * - 子组件 stub（CommandPopover 保留 slot，其余空 div）
 * - ComposerInput mock：defineExpose + emit keydown/input（用于触发 Enter → steer）
 *
 * 运行：npx vitest run src/__tests__/panel/composer-three-states.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock useChat（spy 化 send/steer/abort）──
const chatApiMock = {
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
}
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => chatApiMock,
}))
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, updateSessionState: vi.fn() }),
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ defaultModel: '' }),
}))

// ── ComposerInput mock：defineExpose + emit ──
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
  setup(_, { expose }) {
    const clear = vi.fn()
    const setText = vi.fn()
    expose({ clear, setText, insertSlashChip: vi.fn() })
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
import { useChatStore } from '@/stores/chat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

describe('T9.14 Composer 三态渲染回归', () => {
  it('idle 态：显示发送按钮（ArrowUp），无停止按钮', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // idle：无 stop-btn，有发送按钮
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // 发送位是 Button（最后一个 Button）
    const sendBtn = wrapper.findAll('button').at(-1)
    expect(sendBtn?.attributes('title')).toContain('发送')
  })

  it('busy 态（isActive=true）：显示停止按钮，无发送按钮', () => {
    const chat = useChatStore()
    const sid = 's-busy'
    // 制造 streaming entity → isGenerating=true → isActive=true
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)
    // 停止按钮存在
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
    // 无发送按钮（v-if isActive 互斥）
    const buttons = wrapper.findAll('button')
    const sendBtns = buttons.filter((b) => b.attributes('title')?.includes('发送'))
    expect(sendBtns.length).toBe(0)
  })

  it('pendingSend 态（isActive=true via pendingSend）：停止按钮也可见', () => {
    const chat = useChatStore()
    const sid = 's-pending'
    chat.addPendingSend(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
  })
})

describe('T2.5 busy 时停止按钮始终可见', () => {
  it('streaming + pendingSend 同时存在：停止按钮仍只有一个', () => {
    const chat = useChatStore()
    const sid = 's-both'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    chat.addPendingSend(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(wrapper.findAll('.stop-btn')).toHaveLength(1)
  })
})

describe('T2.2 B 策略：busy 时 Enter → steer（不调 send）', () => {
  it('busy 时 Enter → 调 steer，不调 send', async () => {
    const chat = useChatStore()
    const sid = 's-steer-enter'
    // 制造 busy 态
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)

    // 输入文本（让 hasInput=true，steer guard 放行）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充内容')
    await wrapper.vm.$nextTick()

    // 模拟 Enter 键
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick() // steer 是 async，需 flush

    expect(chatApiMock.steer).toHaveBeenCalledWith('补充内容')
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })
})

describe('T2.3 B 策略：idle 时 Enter → send', () => {
  it('idle 时 Enter → 调 send，不调 steer', async () => {
    const wrapper = mountComposer({ sessionId: 's-send-enter' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
    await wrapper.vm.$nextTick()

    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(chatApiMock.send).toHaveBeenCalledWith('第一条消息')
    expect(chatApiMock.steer).not.toHaveBeenCalled()
  })
})

describe('停止按钮点击 → abort', () => {
  it('busy 态点停止按钮 → 调 abort', async () => {
    const chat = useChatStore()
    const sid = 's-abort'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    await wrapper.find('.stop-btn').trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })
})
