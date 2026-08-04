/**
 * CompanionBand 组件测试（W2 · T5，TC-1~TC-6 + editor 变体）。
 *
 * 覆盖用例（design-review TC-1~TC-6，IF3/ERR3 契约）：
 *  - TC-1 confirm 渲染 + 确认/取消回传（AC3）
 *  - TC-2 select 渲染选项 + 选中回传；未选确认禁用（AC3）
 *  - TC-3 input 渲染 + 文本回传（prefill 预填）；editor 变体（Textarea）
 *  - TC-4 askUser 渲染（AskUserForm）+ 单选提交回传（AC3）
 *  - TC-5 无请求自隐藏（根元素 v-if 隐藏）
 *  - TC-6 未知 method 只读降级（ERR3，无按钮 + console.warn）
 *
 * Mock 策略：MockDialogRequestSource（onUiRequest/onUiTimeout vi.fn 存 handler 供触发，
 * 同 W1 测试模式）+ MockTransport（sendPiResponse/sendPluginResponse vi.fn），
 * global.provide 注入 DIALOG_REQUEST_SOURCE_KEY / UI_RESPONSE_TRANSPORT_KEY。
 * 不 mock useSessionScopedState（Map 分区是 W1 已验对象，组件测试透传验证集成）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import CompanionBand from '../CompanionBand.vue'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
} from '../companion-band-source'
import type { DialogRequest, DialogRequestSource, UiResponseTransport } from '../dialog-request-queue'

// ── Mocks ────────────────────────────────────────────────────────────

class MockDialogRequestSource implements DialogRequestSource {
  onUiRequest = vi.fn((handler: (req: DialogRequest) => void): (() => void) => {
    this.requestHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })
  onUiTimeout = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.timeoutHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })

  requestHandler: ((req: DialogRequest) => void) | null = null
  timeoutHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null

  triggerUiRequest(req: Partial<DialogRequest> & { requestId: string; sessionId: string }): void {
    this.requestHandler?.(makeRequest(req))
  }
}

function makeRequest(overrides: Partial<DialogRequest> & { requestId: string; sessionId: string }): DialogRequest {
  return {
    source: 'pi',
    method: 'confirm',
    receivedAt: Date.now(),
    ...overrides,
  }
}

function makeTransport(): UiResponseTransport {
  return {
    sendPiResponse: vi.fn(),
    sendPluginResponse: vi.fn(),
  }
}

function mountBand(sessionId = 'A') {
  const source = new MockDialogRequestSource()
  const transport = makeTransport()
  const wrapper = mount(CompanionBand, {
    props: { sessionId },
    global: {
      provide: {
        [DIALOG_REQUEST_SOURCE_KEY as symbol]: source,
        [UI_RESPONSE_TRANSPORT_KEY as symbol]: transport,
      },
    },
  })
  return { wrapper, source, transport }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CompanionBand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC-1 confirm 渲染 + 确认/取消回传（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认操作', message: '是否继续？' })
    await nextTick()

    // DOM：band + title + message + 确认/取消按钮
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toContain('确认操作')
    expect(wrapper.find('[data-testid="companion-band-message"]').text()).toContain('是否继续？')
    expect(wrapper.find('[data-testid="companion-confirm-ok"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-confirm-cancel"]').exists()).toBe(true)

    // 确认 → respond(true)
    await wrapper.find('[data-testid="companion-confirm-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1', 'confirm', true)

    // 取消 → respond(null)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1b', method: 'confirm' })
    await nextTick()
    await wrapper.find('[data-testid="companion-confirm-cancel"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1b', 'confirm', null)
  })

  it('TC-2 select 渲染选项 + 选中回传；未选确认禁用（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({
      sessionId: 'A',
      requestId: 'r2',
      method: 'select',
      options: [
        { label: 'A', value: 'opt-a' },
        { label: 'B', value: 'opt-b' },
      ],
    })
    await nextTick()

    // 选项 DOM（label 文本）
    const labels = wrapper.findAll('[data-testid="companion-select-option-label"]')
    expect(labels).toHaveLength(2)
    expect(labels[0]!.text()).toBe('A')
    expect(labels[1]!.text()).toBe('B')

    // 未选：确认禁用
    const okBtn = wrapper.find('[data-testid="companion-select-ok"]')
    expect(okBtn.attributes('disabled')).toBeDefined()

    // 选中 B → 确认启用 → 点确认 → respond(value)
    await wrapper.find('[data-testid="companion-select-option-opt-b"]').trigger('click')
    expect(okBtn.attributes('disabled')).toBeUndefined()
    await okBtn.trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r2', 'select', 'opt-b')
  })

  it('TC-3 input 渲染 + 文本回传（prefill 预填）；editor 变体走 Textarea（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3', method: 'input', prefill: '默认值' })
    await nextTick()

    // Input DOM + prefill 预填
    const input = wrapper.find('[data-testid="companion-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('默认值')

    // 输入文本 → 确认 → respond(value)
    await input.setValue('abc')
    await wrapper.find('[data-testid="companion-input-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r3', 'input', 'abc')

    // editor 变体：Textarea 渲染 + 回传
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3e', method: 'editor' })
    await nextTick()
    const textarea = wrapper.find('[data-testid="companion-editor"]')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('multi\nline')
    await wrapper.find('[data-testid="companion-input-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r3e', 'editor', 'multi\nline')
  })

  it('TC-4 askUser 渲染（AskUserForm）+ 单选提交回传（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({
      sessionId: 'A',
      requestId: 'r4',
      method: 'askUser',
      askUserQuestions: [{ header: 'db', question: '选库?', options: [{ label: 'PG', value: 'pg' }] }],
    })
    await nextTick()

    // AskUserForm DOM
    expect(wrapper.find('[data-testid="ask-user-form"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-option-pg"]').exists()).toBe(true)

    // 单选 → 提交 → respond(answersJson)
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r4', 'askUser', '{"db":"pg"}')
  })

  it('TC-5 无请求自隐藏（根元素 v-if 隐藏，不占位）（IF3）', async () => {
    const { wrapper } = mountBand()
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
  })

  it('TC-6 未知 method 只读降级：title/message 展示 + 无按钮 + console.warn（ERR3）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { wrapper, source } = mountBand()
      source.triggerUiRequest({
        sessionId: 'A',
        requestId: 'r9',
        method: 'futureMethod',
        title: '未来方法',
        message: '只读信息',
      } as unknown as Partial<DialogRequest> & { requestId: string; sessionId: string })
      await nextTick()

      // band + title/message 只读展示
      expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="companion-band-title"]').text()).toContain('未来方法')
      expect(wrapper.find('[data-testid="companion-band-message"]').text()).toContain('只读信息')

      // 无任何交互按钮
      expect(wrapper.findAll('button')).toHaveLength(0)

      // console.warn 记录未知 method
      expect(warnSpy).toHaveBeenCalledWith('[CompanionBand] unknown dialog method:', 'futureMethod')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
