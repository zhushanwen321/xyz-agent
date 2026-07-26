/**
 * BashOutputBlock 组件测试（composer-bash-execute W3 TK8）。
 *
 * 验证：
 * - complete 态 exit 0 → command + output + 「exit 0」success 标签
 * - streaming 态 → spinner + 取消按钮；点击取消触发 abortBash
 * - exit N(>0) → 「exit N」danger 标签
 * - excludeFromContext=true → no context 标记
 * - cancelled=true → 「cancelled」标签
 * - output='' → 「(no output)」
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/BashOutputBlock.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@xyz-agent/shared'

// Mock useChat.abortBash（BashOutputBlock 取消按钮的唯一外部依赖）
const mockAbortBash = vi.fn()
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ abortBash: mockAbortBash }),
}))

import BashOutputBlock from '@/components/panel/message-stream/BashOutputBlock.vue'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'bash-1',
    role: 'system',
    content: '',
    status: 'complete',
    bashExecution: {
      command: 'ls -la',
      output: 'total 0',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 1000,
    },
    timestamp: 1000,
    ...overrides,
  } as Message
}

function mountBlock(message: Message) {
  return mount(BashOutputBlock, {
    props: { message, sessionId: 'sess-1' },
    global: { plugins: [] },
  })
}

describe('BashOutputBlock', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockAbortBash.mockReset()
  })

  it('complete 态 exit 0 → 显示 command + output + 「exit 0」标签（success 类）', () => {
    const wrapper = mountBlock(makeMessage())
    expect(wrapper.find('[data-testid="bash-output-block"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('ls -la')
    expect(wrapper.text()).toContain('total 0')
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('exit 0')
    expect(tag.classes()).toContain('text-success')
  })

  it('streaming 态 → spinner + 取消按钮存在；点击取消触发 abortBash', async () => {
    const msg = makeMessage({
      status: 'streaming',
      bashExecution: {
        command: 'sleep 10',
        output: '',
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    // streaming 不渲染 status-tag（spinner 无 testid），取消按钮存在
    expect(wrapper.find('[data-testid="bash-status-tag"]').exists()).toBe(false)
    const cancelBtn = wrapper.find('[data-testid="bash-cancel-btn"]')
    expect(cancelBtn.exists()).toBe(true)
    await cancelBtn.trigger('click')
    expect(mockAbortBash).toHaveBeenCalledWith('sess-1')
  })

  it('exitCode=2 → 「exit 2」标签（danger 类）', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'false',
        output: '',
        exitCode: 2,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.text()).toBe('exit 2')
    expect(tag.classes()).toContain('text-danger')
  })

  it('excludeFromContext=true → 显示 no context 标记', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    expect(wrapper.find('[data-testid="bash-no-context-tag"]').exists()).toBe(true)
  })

  it('cancelled=true → 「cancelled」标签', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'sleep 5',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    // i18n 文案随 locale（zh-CN 「已取消」/en-US 「cancelled」），断言非空即可
    expect(tag.text().length).toBeGreaterThan(0)
    expect(tag.classes()).toContain('text-muted')
  })

  it('output 为空且非 streaming → 显示 (no output)', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'true',
        output: '',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    // 输出区不渲染（无 output），空输出提示渲染
    expect(wrapper.find('[data-testid="bash-output"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bash-output-empty"]').exists()).toBe(true)
  })
})
