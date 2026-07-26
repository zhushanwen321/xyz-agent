/**
 * MessageStream bashExecution 路由测试（composer-bash-execute W3 TK9）。
 *
 * 验证：含 bashExecution 的 system 消息 → 路由到 BashOutputBlock 而非 SystemNotice。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-bash.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
import BashOutputBlock from '@/components/panel/message-stream/BashOutputBlock.vue'
import type { Message } from '@xyz-agent/shared'

// happy-dom 不提供 ResizeObserver
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globalStubs = {
  Turn: { name: 'Turn', template: '<div />' },
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BgNotifyCard: { name: 'BgNotifyCard', template: '<div />' },
  GuiComponentRenderer: { name: 'GuiComponentRenderer', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

describe('MessageStream bashExecution 路由', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('T10: messages 含 bashExecution system 消息 → BashOutputBlock 渲染，SystemNotice 不渲染', () => {
    const chat = useChatStore()
    const sid = 'sess-bash-route'
    const bashMsg: Message = {
      id: 'bash-1',
      role: 'system',
      content: '',
      status: 'complete',
      bashExecution: {
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
      timestamp: 1000,
    } as Message
    chat.hydrate(sid, [bashMsg])

    const wrapper = mountStream(sid)
    // BashOutputBlock 真组件渲染（未被 stub）
    const block = wrapper.findComponent(BashOutputBlock)
    expect(block.exists()).toBe(true)
    // SystemNotice stub 不应出现（bash 消息走 BashOutputBlock 分支）
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
  })
})
