/**
 * MobileChatView 测试（P4-s3-w1 AC5 chat 渲染）。
 *
 * 验收：mock chat store messages 后消息文本可见（user/assistant 区分）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobileChatView from '../MobileChatView.vue'

// Mock useChat（避免真实 ws-client 调用）
const sendMock = vi.fn()
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ send: sendMock }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  sendMock.mockClear()
})

describe('MobileChatView（P4-s3-w1 AC5 chat 渲染）', () => {
  it('无消息时显示空态', () => {
    const wrapper = mount(MobileChatView, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="mobile-chat-empty"]').exists()).toBe(true)
  })

  it('mock WS 消息后消息文本可见（user/assistant 区分）', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    // 注入 mock messages（user text + assistant text）
    store.setMessages('s1', [
      { id: 'm1', role: 'user', content: '帮我看看这个 session', status: 'complete', timestamp: Date.now() } as never,
      { id: 'm2', role: 'assistant', content: '这个 session 包含 3 个文件改动', status: 'complete', timestamp: Date.now() } as never,
    ])

    const wrapper = mount(MobileChatView, { props: { sessionId: 's1' } })
    const msgs = wrapper.find('[data-testid="mobile-chat-messages"]')
    expect(msgs.text()).toContain('帮我看看这个 session')
    expect(msgs.text()).toContain('这个 session 包含 3 个文件改动')
    // user/assistant role 标签
    expect(msgs.text()).toContain('你')
    expect(msgs.text()).toContain('Agent')
  })

  it('header 显示 session label + 返回按钮 emit back', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const sessionStore = useSessionStore()
    sessionStore.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-remote', cwd: '/p', state: 'idle' } as never,
    ] }])
    const wrapper = mount(MobileChatView, { props: { sessionId: 's1' } })
    expect(wrapper.text()).toContain('feat-remote')
    await wrapper.find('[data-testid="mobile-chat-back"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })
})
