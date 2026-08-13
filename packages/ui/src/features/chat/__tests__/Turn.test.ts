/**
 * Turn.vue 折叠作用域单测（streaming-trace-window design §3.3 D1）。
 *
 * 验证 D1：showTrace = isWorkingTurn || isExpanded(turnKey)，
 * 其中 isWorkingTurn = sessionActive && isLastTurn。仅工作 turn（session 进行中 + 末位 turn）
 * 在 run 期间展开 trace；历史 turn 不再因 sessionActive 翻真而重展开（F1 修复）。
 *
 * 三视角（构建者 / 使用者 / 观察者）之「观察者」：直接断言 trace 内 thinking/tool 块的 DOM 显隐
 * （showTrace 唯一可控的可见副作用——text 块恒渲染为末位正文，不受 showTrace 影响）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Turn.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Turn } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Message } from '@xyz-agent/shared'
import { mockChatProvide } from './helpers'

const NOW = 1_700_000_000_000
const SID = 'sess-turn-scope-test'

/** 构造带 thinking + tool + text 三块的完成态 turn（无 contentBlocks → expandAssistantBlocks
 *  走 fallback 产出 [text, thinking, tool]，恰好覆盖 showTrace 控制的 thinking/tool 两块
 *  与恒渲染的 text 块）。 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: '最终回复',
    status: 'complete',
    timestamp: NOW,
    thinking: [{ id: 'th1', content: '推理过程', collapsed: true }],
    toolCalls: [{ id: 'tc1', toolName: 'read', input: { path: '/tmp/x' }, status: 'completed', startTime: NOW }],
  }
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

/** Block stub：根节点带 .trace-blk（对齐真实 Block 根 class）+ data-type 标记 kind，
 *  供断言 trace 内各 kind 块的显隐。其余子组件（UserBubble/TurnMeta/TurnSummary/ChangeSetCard）
 *  一并 stub，隔离 Turn.vue 自身的 showTrace 逻辑（不拖入 pinia/i18n/store 依赖）。 */
const BlockStub = {
  name: 'Block',
  props: { type: { type: String, required: true } },
  template: '<div class="trace-blk" :data-type="type" />',
}

function mountTurn(opts: {
  isSessionActive?: boolean
  isLastTurn?: boolean
  /** isExpanded mock（ChatViewDeps inject）；缺省 () => false（无手动展开） */
  isExpanded?: (key: string) => boolean
} = {}) {
  return mount(Turn, {
    props: {
      turn: makeTurn(),
      sessionId: SID,
      ...(opts.isSessionActive !== undefined ? { isSessionActive: opts.isSessionActive } : {}),
      ...(opts.isLastTurn !== undefined ? { isLastTurn: opts.isLastTurn } : {}),
    },
    global: {
      provide: mockChatProvide({
        isExpanded: opts.isExpanded ?? (() => false),
      }),
      stubs: {
        UserBubble: true,
        TurnMeta: true,
        TurnSummary: true,
        ChangeSetCard: true,
        Block: BlockStub,
      },
    },
  })
}

describe('streaming-trace-window D1: Turn 折叠作用域降到 turn 级', () => {
  it('TC1: session 进行中但非末位 turn（isLastTurn=false）→ trace 折叠（thinking/tool 隐藏，仅 text 末位正文）', () => {
    // isWorkingTurn = sessionActive(true) && isLastTurn(false) = false；isExpanded=false → showTrace=false
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: false })
    // text 块恒渲染（末位正文，不受 showTrace 影响）
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    // thinking/tool 块受 showTrace 控制 → 折叠态不渲染（F1：历史 turn 不重展开）
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(false)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(false)
  })

  it('TC2: session 进行中且为末位 turn（isLastTurn=true）→ trace 展开（thinking/tool 渲染）', () => {
    // isWorkingTurn = true && true = true → showTrace=true（工作 turn 全程展开）
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: true })
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(true)
  })

  it('TC3: 手动展开（isExpanded=true）优先于作用域——非末位 turn 也展开 trace', () => {
    // isWorkingTurn=false，但 isExpanded=true → showTrace=true（用户显式展开不被作用域覆盖）
    const wrapper = mountTurn({
      isSessionActive: true,
      isLastTurn: false,
      isExpanded: () => true,
    })
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(true)
  })
})
