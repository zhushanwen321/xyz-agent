/**
 * TurnMeta.vue 组件测试（W4TC1/W4TC2）。
 *
 * 覆盖：
 * - W4TC1: badge 灰阶化（thinkCount/toolCount badge 从彩色改为中性灰 bg-surface-2 text-neutral-mid）
 * - W4TC2: sticky + streaming 状态（sessionActive 时 turn-meta sticky，streaming 态文字染 accent）
 *
 * W1 main-fusion 后：TurnMeta 直接调 useTurnExpansion（共享 store），不再走 expanded prop / update:expanded emit。
 * 测试需 setActivePinia + 传 turnIndex/sessionId，chevron 展开态通过 store 预置 isExpanded(sid, idx) 驱动。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/TurnMeta.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { TurnMeta } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import { turnStableId } from '@xyz-agent/core/domain/chat'
import { mockChatProvide } from './helpers'

const NOW = Date.now()
const SID = 'sess-turnmeta-test'

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
  /** 是否在挂载前预置该 turn 为展开（store 写入），驱动 chevron rotate-90 */
  expanded?: boolean
  elapsed?: string
}) {
  const turn = props.turn ?? makeTurn()
  return mount(TurnMeta, {
    props: {
      turn,
      sessionActive: props.sessionActive ?? false,
      isStreaming: props.isStreaming ?? false,
      thinkCount: props.thinkCount ?? 1,
      toolCount: props.toolCount ?? 1,
      elapsed: props.elapsed ?? '5s',
      turnIndex: turn.index,
      turnKey: turnStableId(turn),
      sessionId: SID,
    },
    global: {
      provide: mockChatProvide({ isExpanded: () => !!props.expanded }),
    },
  })
}

describe('W4TC1: TurnMeta badge 灰阶化', () => {
  it('i18n panel.message.working 在 zh/en 语言文件均定义（zh 工作中 / en Working…）', () => {
    const zh = readFileSync(resolve(__dirname, '../../../../../renderer/src/i18n/locales/zh-CN/panel.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '../../../../../renderer/src/i18n/locales/en-US/panel.ts'), 'utf8')
    expect(zh).toContain("working: '工作中'")
    expect(en).toContain("working: 'Working…'")
  })

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
    expect(wrapper.find('.lbl').text()).toBe('panel.message.worked')
    expect(wrapper.find('.elapsed').text()).toBe('12s')
  })

  it('turn-meta 按钮文字：working 态显示「工作中」（panel.message.working）+ elapsed', () => {
    const wrapper = mountMeta({ sessionActive: true, isStreaming: true, elapsed: '3s' })
    expect(wrapper.find('.lbl').text()).toBe('panel.message.working')
    expect(wrapper.find('.elapsed').text()).toBe('3s')
  })

  it('turn-meta 按钮文字：dispatching 占位态（assistants 空）保持「思考中」（panel.message.thinking）', () => {
    const wrapper = mountMeta({
      turn: makeTurn({ assistants: [] }),
      sessionActive: true,
      isStreaming: false,
      elapsed: '',
    })
    expect(wrapper.find('.lbl').text()).toBe('panel.message.thinking')
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

  it('非 sessionActive + hasFoldable → 点击 turn-meta 触发 toggleExpand(turnKey)', async () => {
    const turn = makeTurn()
    const toggleExpand = vi.fn()
    const wrapper = mount(TurnMeta, {
      props: { turn, sessionActive: false, isStreaming: false, thinkCount: 1, toolCount: 1, elapsed: '5s', turnIndex: turn.index, turnKey: turnStableId(turn), sessionId: SID },
      global: { provide: mockChatProvide({ toggleExpand }) },
    })
    await wrapper.find('.turn-meta').trigger('click')
    expect(toggleExpand).toHaveBeenCalledWith(turnStableId(turn))
  })

  it('hasFoldable=false + 非 sessionActive → 无 chevron', () => {
    const wrapper = mountMeta({
      turn: makeTurn({ hasFoldable: false }),
      sessionActive: false,
    })
    expect(wrapper.find('.chev').exists()).toBe(false)
  })

  it('hasFoldable=true + 非 sessionActive → 有 chevron + expanded 时 rotate-90', async () => {
    // 非 expanded → 无 rotate-90
    const wrapper = mountMeta({ sessionActive: false, expanded: false })
    expect(wrapper.find('.chev').exists()).toBe(true)
    expect(wrapper.find('.chev').classes()).not.toContain('rotate-90')
    // expanded → 有 rotate-90（store 预置展开态驱动）
    const wrapper2 = mountMeta({ sessionActive: false, expanded: true })
    expect(wrapper2.find('.chev').classes()).toContain('rotate-90')
  })
})
