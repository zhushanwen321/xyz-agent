/**
 * Turn working 态单测 —— 完成复位 + elapsed live 计时 + 清理（plan.md U9–U12）。
 *
 * 覆盖：
 * - U9：isWorking true→false 时 expanded 复位，trace 区从 DOM 消失（完成自动收起成一行）
 * - U10：working 态 elapsed 随 setInterval 实时增长（live 计时）
 * - U11：非 working 态 elapsed 静态，advance 不变（无 setInterval 驱动）
 * - U12：working 态 unmount 不抛错、无 timer 泄漏
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/turn-working.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Turn from '@/components/panel/message-stream/Turn.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

// mock 重依赖 composable（只测 Turn 自身响应式逻辑，不测 store 副作用）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn() }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn() }),
}))

function msg(over: Partial<Message> = {}): Message {
  return { id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now(), ...over }
}

/** 构造 MessageTurn：默认 working 态（最后 assistant streaming），含可折叠块 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() },
    assistants: [msg()],
    isWorking: true,
    hasFoldable: true,
    ...over,
  }
}

/** mount Turn，stub 掉子组件（Block/ChangeSetCard/ForkConfirmModal/MarkdownRenderer），隔离 Turn 自身逻辑 */
function mountTurn(props: { turn: MessageTurn; sessionId?: string }) {
  return mount(Turn, {
    props: { turn: props.turn, sessionId: props.sessionId ?? 's1' },
    global: {
      plugins: [createPinia()],
      stubs: { Block: true, ChangeSetCard: true, ForkConfirmModal: true, MarkdownRenderer: true },
    },
  })
}

/** 从 wrapper 提取 elapsed 文本（meta 按钮里的 .elapsed span） */
function elapsedText(wrapper: ReturnType<typeof mountTurn>): string {
  const el = wrapper.find('.elapsed')
  return el.exists() ? el.text() : ''
}

describe('Turn working 态 · 完成复位 + elapsed live', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('U9: isWorking true→false 复位 expanded，trace 从 DOM 消失', async () => {
    const wrapper = mountTurn({ turn: makeTurn({ isWorking: true }) })
    // working 态 trace 展开
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 切换到完成态
    await wrapper.setProps({ turn: makeTurn({ isWorking: false }) })
    // trace 区消失（expanded 复位，showTrace=false）
    expect(wrapper.find('.trace').exists()).toBe(false)
  })

  it('U10: working 态 elapsed 随 setInterval 实时增长', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    // 单条 assistant，timestamp=t0 → elapsed 初始基线
    const turn = makeTurn({
      isWorking: true,
      assistants: [msg({ timestamp: t0 })],
    })
    const wrapper = mountTurn({ turn })
    const before = elapsedText(wrapper)
    // 推进 5 秒：interval 触发，Date.now 前进，elapsed 重算
    vi.advanceTimersByTime(5000)
    await wrapper.vm.$nextTick()
    const after = elapsedText(wrapper)
    // 文本必须变化（live 计时驱动），且数值增大
    expect(after).not.toBe(before)
    expect(after).not.toBe('')
  })

  it('U11: 非 working 态 elapsed 静态，advance 不变', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const turn = makeTurn({
      isWorking: false,
      assistants: [msg({ status: 'complete', timestamp: t0 })],
    })
    const wrapper = mountTurn({ turn })
    const before = elapsedText(wrapper)
    vi.advanceTimersByTime(10000)
    await wrapper.vm.$nextTick()
    // 无 setInterval 驱动 → elapsed 不变
    expect(elapsedText(wrapper)).toBe(before)
  })

  it('U12: working 态 unmount 不抛错、无 timer 泄漏', () => {
    vi.useFakeTimers()
    const wrapper = mountTurn({ turn: makeTurn({ isWorking: true }) })
    // unmount 应清理 interval，不抛错
    expect(() => wrapper.unmount()).not.toThrow()
    // unmount 后推进时间不应有副作用（无泄漏的 interval 触发 DOM 更新）
    expect(() => vi.advanceTimersByTime(60000)).not.toThrow()
  })

  // U13:回归防护 — pi 0.80.3 对短消息不发 thinking，纯文本回合 hasFoldable=false，
  // 仍须显示「已工作」+ elapsed（回合级耗时，不应依赖可折叠块存在）。设计稿 §2 case A
  // 原写「纯文字回合无按钮」，用户决策：所有回合都显示，设计稿更新。
  it('U13: 纯文本回合（hasFoldable=false）完成态仍显示「已工作」+ elapsed，无 chevron', () => {
    const wrapper = mountTurn({
      turn: makeTurn({
        isWorking: false,
        hasFoldable: false,
        assistants: [msg({ status: 'complete', content: 'Hi!' })],
      }),
    })
    // turn-meta 按钮存在（v-if 改为 assistants.length>0，不再 gate 在 hasFoldable）
    expect(wrapper.find('.turn-meta').exists()).toBe(true)
    expect(wrapper.find('.lbl').text()).toBe('已工作')
    expect(elapsedText(wrapper)).not.toBe('')
    // 无 chevron（无可折叠内容 → 不渲染展开按钮，用户说的「展开按钮没渲染」即此场景）
    expect(wrapper.find('.chev').exists()).toBe(false)
    // 无 trace（无内容可折）
    expect(wrapper.find('.trace').exists()).toBe(false)
  })

  // U14:纯文本回合 working 态（pi 流式纯文本，无 thinking）也须显示「工作中」+ 脉冲点
  it('U14: 纯文本回合 working 态显示「工作中」+ 脉冲点 + 无 chevron + trace 强制展开', () => {
    const wrapper = mountTurn({
      turn: makeTurn({
        isWorking: true,
        hasFoldable: false,
        assistants: [msg({ status: 'streaming', content: 'Hi' })],
      }),
    })
    expect(wrapper.find('.turn-meta').exists()).toBe(true)
    expect(wrapper.find('.lbl').text()).toBe('工作中')
    expect(wrapper.find('.working-dot').exists()).toBe(true)
    expect(wrapper.find('.chev').exists()).toBe(false)
    expect(wrapper.find('.trace').exists()).toBe(true)
  })
})
