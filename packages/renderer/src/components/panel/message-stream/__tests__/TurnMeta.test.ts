/**
 * TurnMeta.vue 组件测试（W4TC1/W4TC2）。
 *
 * 覆盖：
 * - W4TC1: badge 灰阶化（thinkCount/toolCount badge 从彩色改为中性灰 bg-surface-2 text-neutral-mid）
 * - W4TC2: sticky + streaming 状态（sessionActive 时 turn-meta sticky，streaming 态文字染 accent）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/TurnMeta.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TurnMeta from '@/components/panel/message-stream/TurnMeta.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'

const NOW = Date.now()

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [{ id: 'a1', role: 'assistant', content: 'done', status: 'complete', timestamp: NOW, thinking: [{ id: 'th1', content: 'reasoning', collapsed: true }], toolCalls: [{ id: 'tc1', toolName: 'read', input: {}, status: 'completed', startTime: NOW }] }],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

function mountMeta(props: {
  turn?: MessageTurn
  sessionActive?: boolean
  isStreaming?: boolean
  thinkCount?: number
  toolCount?: number
  expanded?: boolean
  elapsed?: string
}) {
  return mount(TurnMeta, {
    props: {
      turn: props.turn ?? makeTurn(),
      sessionActive: props.sessionActive ?? false,
      isStreaming: props.isStreaming ?? false,
      thinkCount: props.thinkCount ?? 1,
      toolCount: props.toolCount ?? 1,
      expanded: props.expanded ?? false,
      elapsed: props.elapsed ?? '5s',
    },
  })
}

describe('W4TC1: TurnMeta badge 灰阶化', () => {
  it('thinkCount badge 使用 bg-surface-2 text-neutral-mid（不再是 bg-reasoning-soft text-reasoning）', () => {
    const wrapper = mountMeta({ thinkCount: 3, toolCount: 0 })
    const badge = wrapper.find('.badge-think')
    expect(badge.exists()).toBe(true)
    // 灰阶化：bg-surface-2 + text-neutral-mid
    expect(badge.classes()).toContain('bg-surface-2')
    expect(badge.classes()).toContain('text-neutral-mid')
    // 旧彩色不应存在
    expect(badge.classes()).not.toContain('bg-reasoning-soft')
    expect(badge.classes()).not.toContain('text-reasoning')
    // badge 内容
    expect(badge.text()).toContain('3')
  })

  it('toolCount badge 使用 bg-surface-2 text-neutral-mid（不再是 bg-info-soft text-info）', () => {
    const wrapper = mountMeta({ thinkCount: 0, toolCount: 5 })
    const badge = wrapper.find('.badge-tool')
    expect(badge.exists()).toBe(true)
    // 灰阶化：bg-surface-2 + text-neutral-mid
    expect(badge.classes()).toContain('bg-surface-2')
    expect(badge.classes()).toContain('text-neutral-mid')
    // 旧彩色不应存在
    expect(badge.classes()).not.toContain('bg-info-soft')
    expect(badge.classes()).not.toContain('text-info')
    expect(badge.text()).toContain('5')
  })

  it('turn-meta 按钮文字：完成态显示「已工作」+ elapsed', () => {
    const wrapper = mountMeta({ sessionActive: false, elapsed: '12s' })
    expect(wrapper.find('.lbl').text()).toBe('已工作')
    expect(wrapper.find('.elapsed').text()).toBe('12s')
  })

  it('turn-meta 按钮文字：streaming 态显示「思考中」+ elapsed', () => {
    const wrapper = mountMeta({ sessionActive: true, isStreaming: true, elapsed: '3s' })
    expect(wrapper.find('.lbl').text()).toBe('思考中')
    expect(wrapper.find('.elapsed').text()).toBe('3s')
  })

  it('thinkCount=0 时不渲染 think badge', () => {
    const wrapper = mountMeta({ thinkCount: 0, toolCount: 1 })
    expect(wrapper.find('.badge-think').exists()).toBe(false)
    expect(wrapper.find('.badge-tool').exists()).toBe(true)
  })

  it('toolCount=0 时不渲染 tool badge', () => {
    const wrapper = mountMeta({ thinkCount: 1, toolCount: 0 })
    expect(wrapper.find('.badge-think').exists()).toBe(true)
    expect(wrapper.find('.badge-tool').exists()).toBe(false)
  })
})

describe('W4TC2: TurnMeta sticky + streaming 状态', () => {
  it('sessionActive 时 turn-meta 父 div 含 sticky class', () => {
    const wrapper = mountMeta({ sessionActive: true })
    const outerDiv = wrapper.find('.sticky')
    expect(outerDiv.exists()).toBe(true)
    expect(outerDiv.classes()).toContain('top-0')
    expect(outerDiv.classes()).toContain('z-[1]')
  })

  it('非 sessionActive 时无 sticky class', () => {
    const wrapper = mountMeta({ sessionActive: false })
    expect(wrapper.find('.sticky').exists()).toBe(false)
  })

  it('streaming 态 + sessionActive → Loader2 spinner 存在 + 文字染 text-accent', () => {
    const wrapper = mountMeta({ sessionActive: true, isStreaming: true })
    // spinner 存在
    expect(wrapper.find('.animate-spin').exists()).toBe(true)
    // thinking 文案染 text-accent
    expect(wrapper.find('.lbl').classes()).toContain('text-accent')
  })

  it('完成态 → 无 spinner + 文字染 text-neutral-mid', () => {
    const wrapper = mountMeta({ sessionActive: false, isStreaming: false })
    expect(wrapper.find('.animate-spin').exists()).toBe(false)
    expect(wrapper.find('.lbl').classes()).toContain('text-neutral-mid')
  })

  it('sessionActive 时 turn-meta disabled（禁止折叠 trace）', () => {
    const wrapper = mountMeta({ sessionActive: true })
    expect(wrapper.find('.turn-meta').attributes('disabled')).toBeDefined()
  })

  it('非 sessionActive + hasFoldable → turn-meta 可点击 + emit update:expanded', async () => {
    const wrapper = mountMeta({ sessionActive: false, expanded: false })
    await wrapper.find('.turn-meta').trigger('click')
    expect(wrapper.emitted('update:expanded')).toBeTruthy()
    expect(wrapper.emitted('update:expanded')![0]).toEqual([true])
  })

  it('hasFoldable=false + 非 sessionActive → 无 chevron', () => {
    const wrapper = mountMeta({
      turn: makeTurn({ hasFoldable: false }),
      sessionActive: false,
    })
    expect(wrapper.find('.chev').exists()).toBe(false)
  })

  it('hasFoldable=true + 非 sessionActive → 有 chevron + expanded 时 rotate-90', async () => {
    const wrapper = mountMeta({ sessionActive: false, expanded: false })
    expect(wrapper.find('.chev').exists()).toBe(true)
    // 非 expanded → 无 rotate-90
    expect(wrapper.find('.chev').classes()).not.toContain('rotate-90')
    // expanded → 有 rotate-90
    await wrapper.setProps({ expanded: true })
    expect(wrapper.find('.chev').classes()).toContain('rotate-90')
  })
})
