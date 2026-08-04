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
      // HoverCard 子组件 stub 成内联渲染（绕开 reka-ui HoverCardPortal 在 happy-dom 不渲染，
      // 详见 DetailPane.test.ts 同范式）；使 split-button 的 hover 第二选项在测试 DOM 内可定位。
      stubs: {
        MarkdownRenderer: true,
        HoverCard: { template: '<div class="hover-card-stub"><slot /></div>' },
        HoverCardTrigger: { template: '<div class="hover-card-trigger-stub"><slot /></div>' },
        HoverCardContent: { template: '<div class="hover-card-content-stub"><slot /></div>' },
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
  it('有 lastAssistant 时 hover actions 容器存在 + 按钮组渲染', () => {
    const wrapper = mountSummary()
    // hover actions 容器存在（opacity-0 group-hover:opacity-100）
    const actionsDiv = wrapper.find('.turn-summary .mt-1\\.5')
    expect(actionsDiv.exists()).toBe(true)
    // 容器内有多个 button（3 个 split-button：copy / fork / handoff 各主按钮 + hover 第二选项）
    const buttons = actionsDiv.findAll('button')
    expect(buttons.length).toBeGreaterThanOrEqual(4)
  })

  it('无 lastAssistant 时不渲染 hover actions', () => {
    const wrapper = mountSummary({ lastAssistant: null })
    // 无 hover actions 容器
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
  })

  it('copy-btn 主按钮存在（data-testid）', () => {
    const wrapper = mountSummary()
    const btn = wrapper.find('[data-testid="copy-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('copy-markdown-btn 作为 copy split-button 的 hover 第二选项存在', () => {
    const wrapper = mountSummary()
    // copy-MD 现在是 copy split-button 的 HoverCard 内容（hover 浮层第二选项）
    const btn = wrapper.find('[data-testid="copy-markdown-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('fork-background-btn 主按钮存在（data-testid）', () => {
    const wrapper = mountSummary()
    // fork 按钮存在
    const btn = wrapper.find('[data-testid="fork-background-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('fork-ask-btn 作为 fork split-button 的 hover 第二选项存在', () => {
    const wrapper = mountSummary()
    const btn = wrapper.find('[data-testid="fork-ask-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('handoff-btn 主按钮存在（data-testid）', () => {
    const wrapper = mountSummary()
    // handoff 现为 split-button 主按钮（始终可见，不再藏 overflow）
    const btn = wrapper.find('[data-testid="handoff-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('handoff-ask-btn 作为 handoff split-button 的 hover 第二选项存在', () => {
    const wrapper = mountSummary()
    const btn = wrapper.find('[data-testid="handoff-ask-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('不再渲染 ⋯ overflow（more-actions-btn）', () => {
    const wrapper = mountSummary()
    // 重构后 3 个 split-button 替代原 4 可见 + overflow 结构，⋯ 按钮移除
    expect(wrapper.find('[data-testid="more-actions-btn"]').exists()).toBe(false)
  })

  it('fork/handoff 按钮在 subagent session 隐藏', () => {
    const wrapper = mountSummary({ sessionId: 'subagent:main1:sub1' })
    // subagent session 仅 copy split-button，无 fork/handoff
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="handoff-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(false)
  })
})
