/**
 * TurnSummary.vue 组件测试（W4TC4）。
 *
 * 覆盖：
 * - W4TC4: TurnSummary 拆分后渲染一致（summary + streaming cursor + hover actions 复制/MD/fork/handoff）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/TurnSummary.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { TurnSummary } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Message } from '@xyz-agent/shared'
import { mockChatProvide } from './helpers'

const NOW = Date.now()

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [{ id: 'a1', role: 'assistant', content: 'Here is the result.', status: 'complete', timestamp: NOW }],
    isStreaming: false,
    hasFoldable: false,
    ...over,
  }
}

function mountSummary(props: {
  turn?: MessageTurn
  sessionId?: string
  isStreaming?: boolean
  lastAssistant?: Message | null
} = {}) {
  const turn = props.turn ?? makeTurn()
  return mount(TurnSummary, {
    props: {
      turn,
      sessionId: props.sessionId ?? 's1',
      isStreaming: props.isStreaming ?? false,
      lastAssistant: 'lastAssistant' in props ? (props.lastAssistant ?? null) : (turn.assistants[turn.assistants.length - 1] ?? null),
    },
    global: {
      provide: mockChatProvide(),
      stubs: {
        MarkdownRenderer: true,
      },
    },
  })
}

describe('W4TC4: TurnSummary 基本渲染', () => {
  it('summary 文本存在（turn-summary div）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
  })

  it('isStreaming=false 时 summary 文字染 text-neutral-fg', () => {
    const wrapper = mountSummary({ isStreaming: false })
    expect(wrapper.find('.turn-summary').classes()).toContain('text-neutral-fg')
  })

  it('isStreaming=true 时 summary 文字染 text-neutral-mid', () => {
    const wrapper = mountSummary({ isStreaming: true })
    expect(wrapper.find('.turn-summary').classes()).toContain('text-neutral-mid')
  })

  it('空 content 不渲染 turn-summary', () => {
    const wrapper = mountSummary({
      turn: makeTurn({ assistants: [{ id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: NOW }] }),
      lastAssistant: null,
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(false)
  })
})

describe('W4TC4: TurnSummary streaming cursor', () => {
  it('isStreaming=true 时 streaming-cursor 存在', () => {
    const wrapper = mountSummary({ isStreaming: true })
    expect(wrapper.find('.streaming-cursor').exists()).toBe(true)
  })

  it('isStreaming=false 时 streaming-cursor 消失', () => {
    const wrapper = mountSummary({ isStreaming: false })
    expect(wrapper.find('.streaming-cursor').exists()).toBe(false)
  })
})

describe('W4TC4: TurnSummary hover actions', () => {
  it('有 lastAssistant 时 hover actions 容器存在 + 4 并列按钮渲染', () => {
    const wrapper = mountSummary()
    // hover actions 容器存在（opacity-0 group-hover:opacity-100）
    const actionsDiv = wrapper.find('.turn-summary .mt-1\\.5')
    expect(actionsDiv.exists()).toBe(true)
    // 4 个并列按钮：复制 / 复制MD / fork / handoff（无两层 hover 变体）
    const buttons = actionsDiv.findAll('button')
    expect(buttons.length).toBe(4)
  })

  it('无 lastAssistant 时不渲染 hover actions', () => {
    const wrapper = mountSummary({ lastAssistant: null })
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
  })

  it('copy-btn 存在（复制纯文本）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="copy-btn"]').exists()).toBe(true)
  })

  it('copy-markdown-btn 作为独立按钮存在（复制 Markdown）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="copy-markdown-btn"]').exists()).toBe(true)
  })

  it('fork-ask-btn 存在（fork 进 composer 模式）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
  })

  it('不再渲染 fork-background-btn（已并入 fork-ask 空提交）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
  })

  it('handoff-ask-btn 存在（handoff 进 composer 模式）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(true)
  })

  it('不再渲染 handoff-btn（已并入 handoff-ask 空提交）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="handoff-btn"]').exists()).toBe(false)
  })

  it('不再渲染 ⋯ overflow（more-actions-btn）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="more-actions-btn"]').exists()).toBe(false)
  })

  it('fork/handoff 按钮在 subagent session 隐藏', () => {
    const wrapper = mountSummary({ sessionId: 'subagent:main1:sub1' })
    // subagent session 仅复制类按钮，无 fork/handoff
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(false)
  })
})
