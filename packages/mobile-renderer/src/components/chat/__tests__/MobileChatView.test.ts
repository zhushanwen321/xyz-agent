/**
 * MobileChatView 测试（P4-s3-w1 AC5 chat 渲染 + D5 复用 message-stream）。
 *
 * 验收：MobileChatView 复用桌面 message-stream 渲染链路（MessageStream 组件），
 * 传入正确 sessionId；header 显示 session label；返回按钮 emit back。
 * 消息渲染的 markdown / 代码块 / tool call 等细节由 MessageStream 自身测试覆盖，
 * 此处只验证 MobileChatView 正确编排（避免重复测试 message-stream 内部）。
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

// Mock MessageStream（D5 复用对象）：验证编排而非 message-stream 内部渲染。
// 真实 message-stream 渲染链路（markdown / 代码块 / tool call）由其自身测试覆盖。
// 注意：vi.mock 工厂会被提升到文件顶部，不能引用外部变量，故 stub 内联在工厂内。
vi.mock('@/components/panel/MessageStream.vue', () => ({
  default: {
    name: 'MessageStream',
    props: ['sessionId'],
    template: '<div data-testid="message-stream-stub">{{ sessionId }}</div>',
  },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  sendMock.mockClear()
})

describe('MobileChatView（P4-s3-w1 AC5 chat 渲染 + D5 复用 message-stream）', () => {
  it('复用 message-stream 渲染消息（D5），传入 sessionId', () => {
    const wrapper = mount(MobileChatView, { props: { sessionId: 's1' } })
    const stream = wrapper.find('[data-testid="message-stream-stub"]')
    expect(stream.exists()).toBe(true)
    expect(stream.text()).toContain('s1')
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

  it('composer send 调用 useChat.send（segments 化）', async () => {
    const wrapper = mount(MobileChatView, { props: { sessionId: 's1' } })
    const composer = wrapper.findComponent({ name: 'MobileComposer' })
    await composer.vm.$emit('send', 'hello world')
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0]).toBe('s1')
    // textToSegments 把纯文本拆为 segments（至少一条 text segment）
    expect(Array.isArray(sendMock.mock.calls[0][1])).toBe(true)
    expect(sendMock.mock.calls[0][1].length).toBeGreaterThan(0)
  })
})
