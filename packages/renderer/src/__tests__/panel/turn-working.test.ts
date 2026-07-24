/**
 * Turn working 态单测 —— 完成复位 + elapsed live 计时 + 清理（plan.md U9–U12）+
 * CW wave `session-active-ssot` T4：isWorking 拆分为 isStreaming / isSessionActive 两信号。
 *
 * 覆盖：
 * - U9：isStreaming true→false（isSessionActive 同步 false）时 expanded 复位，trace 消失（完成收起）
 * - U10：streaming 态 elapsed 随 setInterval 实时增长（live 计时）
 * - U11：非 streaming 态 elapsed 静态，advance 不变（无 setInterval 驱动）
 * - U12：streaming 态 unmount 不抛错、无 timer 泄漏
 * - TC4：ask-user 等待（isStreaming=false, isSessionActive=true）→ trace 展开/折叠 disabled/sticky；
 *        但 Loader 不转/光标不闪（A 类流式 UI 关闭，B 类进行中 UI 保留）
 * - TC5：ask-user 等待不收起（切走切回 isSessionActive 恒 true 期间 trace 不消失）
 * - TC6：message.complete 期间 ask-user pending 不误触发收起（isStreaming true→false 但 active 仍 true）
 * - TC8：subagent 后台跑（isSessionActive=true via working 态）→ 对话流不收起
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/turn-working.test.ts
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

/** 构造 MessageTurn：默认 streaming 态（最后 assistant streaming），含可折叠块 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() },
    assistants: [msg()],
    isStreaming: true,
    hasFoldable: true,
    ...over,
  }
}

/** mount Turn，stub 掉子组件（Block/ChangeSetCard/MarkdownRenderer），隔离 Turn 自身逻辑。
 *  isSessionActive prop 透传（T4：session 进行中信号，缺省回退到 turn.isStreaming）。 */
function mountTurn(props: { turn: MessageTurn; sessionId?: string; isSessionActive?: boolean }) {
  return mount(Turn, {
    props: {
      turn: props.turn,
      sessionId: props.sessionId ?? 's1',
      ...(props.isSessionActive !== undefined ? { isSessionActive: props.isSessionActive } : {}),
    },
    global: {
      plugins: [createPinia()],
      stubs: { Block: true, ChangeSetCard: true, MarkdownRenderer: true },
    },
  })
}

/**
 * mount Turn 但用真实 Block（仅 stub 重依赖 MarkdownRenderer/ChangeSetCard），
 * 用于断言 trace 内块的 DOM 顺序（三视角之「观察者」视角，防 contentBlocks 乱序回归）。
 */
function mountTurnWithRealBlock(props: { turn: MessageTurn; sessionId?: string }) {
  return mount(Turn, {
    props: { turn: props.turn, sessionId: props.sessionId ?? 's1' },
    global: {
      plugins: [createPinia()],
      stubs: { ChangeSetCard: true, MarkdownRenderer: true },
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

  it('U9: 完成态（isStreaming + isSessionActive 同步 false）复位 expanded，trace 从 DOM 消失', async () => {
    // 不传 isSessionActive → 回退到 turn.isStreaming（旧调用方/简单场景，streaming=false 即对话结束）
    const wrapper = mountTurn({ turn: makeTurn({ isStreaming: true }) })
    // streaming 态 trace 展开
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 切换到完成态（isStreaming false，无 prop 回退 → sessionActive 也 false）
    await wrapper.setProps({ turn: makeTurn({ isStreaming: false }) })
    // trace 区消失（expanded 复位，showTrace=false）
    expect(wrapper.find('.trace').exists()).toBe(false)
  })

  it('U10: working 态 elapsed 随 setInterval 实时增长', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    // 单条 assistant，timestamp=t0 → elapsed 初始基线
    const turn = makeTurn({
      isStreaming: true,
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
      isStreaming: false,
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
    const wrapper = mountTurn({ turn: makeTurn({ isStreaming: true }) })
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
        isStreaming: false,
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

  // U14:纯文本回合 working 态（pi 流式纯文本，无 thinking）也须显示「思考中」+ spinner
  it('U14: 纯文本回合 working 态显示「思考中」+ spinner + 无 chevron + trace 强制展开', () => {
    const wrapper = mountTurn({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: false,
        assistants: [msg({ status: 'streaming', content: 'Hi' })],
      }),
    })
    expect(wrapper.find('.turn-meta').exists()).toBe(true)
    expect(wrapper.find('.lbl').text()).toBe('思考中')
    // working 态用 spinner（Loader2 animate-spin），不再用 working-dot 脉冲点
    expect(wrapper.find('.turn-meta .animate-spin').exists()).toBe(true)
    expect(wrapper.find('.chev').exists()).toBe(false)
    expect(wrapper.find('.trace').exists()).toBe(true)
  })
})

/**
 * CW wave `session-active-ssot` T4：isWorking 拆分为 isStreaming / isSessionActive 两信号。
 *
 * ask-user 等待根因：原 isWorking 只由 message.status==='streaming' 驱动，但 ask-user 期间
 * status=complete → isWorking=false → 对话流自动收起。T4 把完成收起/折叠 disabled/trace 展开/
 * sticky 贴顶/thinking 文案归 sessionActive（对话进行中，ask-user 也算进行中），Loader/光标/计时/
 * summary 颜色归 isStreaming（文本流式生成）。下面 TC4–TC8 验证拆分后 UI 形态。
 */
describe('Turn · T4 isWorking 拆分（isStreaming vs isSessionActive）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // TC4：ask-user 等待——文本已 complete（isStreaming=false）但对话在进行（isSessionActive=true）。
  // 期望：A 类流式 UI 关闭（Loader 不转、光标不闪），B 类进行中 UI 保留（trace 展开、折叠 disabled、
  // sticky 贴顶、thinking 文案）。这是 ask-user 等待期对话流不收起的核心形态。
  it('TC4: ask-user 等待（isStreaming=false, isSessionActive=true）→ trace 展开/折叠 disabled/sticky；Loader 不转/光标不闪', () => {
    const wrapper = mountTurn({
      turn: makeTurn({
        // message 已 complete（ask-user 到达前 message 流完，status 转 complete）
        isStreaming: false,
        hasFoldable: true,
        assistants: [msg({ status: 'complete', content: '需要确认' })],
      }),
      isSessionActive: true,
    })
    // B 类进行中：trace 展开（sessionActive 驱动）
    expect(wrapper.find('.trace').exists()).toBe(true)
    // B 类进行中：折叠按钮 disabled（进行中禁止折叠 trace）
    expect(wrapper.find('.turn-meta').attributes('disabled')).toBeDefined()
    // B 类进行中：sticky 贴顶（turn-meta 父 wrapper 带 sticky class）
    expect(wrapper.find('.sticky').exists()).toBe(true)
    // C 类进行中：thinking 文案（对话在进行，显示「思考中」而非「已工作」）
    expect(wrapper.find('.lbl').text()).toBe('思考中')
    // A 类流式关闭：Loader 不转（isStreaming=false）
    expect(wrapper.find('.turn-meta .animate-spin').exists()).toBe(false)
    // A 类流式关闭：streaming 光标不闪
    expect(wrapper.find('.streaming-cursor').exists()).toBe(false)
  })

  // TC5：ask-user 等待期间 trace 持续展开（不收起）——切走切回 isSessionActive 恒 true 期间 trace 不消失。
  it('TC5: ask-user 等待不收起（isSessionActive 恒 true 期间 trace 不消失）', async () => {
    const wrapper = mountTurn({
      turn: makeTurn({ isStreaming: false, assistants: [msg({ status: 'complete' })] }),
      isSessionActive: true,
    })
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 切走再切回（重渲染）：isSessionActive 仍 true，trace 不收起
    await wrapper.setProps({ isSessionActive: true })
    expect(wrapper.find('.trace').exists()).toBe(true)
  })

  // TC6：message.complete 期间 ask-user pending 不误触发收起。
  // 时序：streaming(isStreaming true, active true) → message.complete(isStreaming false) 但 ask-user
  // pending（active 仍 true）→ 不该收起。验证 isStreaming true→false 单独变化不触发收起。
  it('TC6: message.complete 期间 ask-user pending 不误触发收起（isStreaming true→false 但 active 仍 true）', async () => {
    // 初始 streaming：isStreaming true, isSessionActive true → trace 展开
    const wrapper = mountTurn({
      turn: makeTurn({ isStreaming: true, assistants: [msg({ status: 'streaming' })] }),
      isSessionActive: true,
    })
    expect(wrapper.find('.trace').exists()).toBe(true)
    // message.complete：isStreaming 转 false（文本流完），但 ask-user pending → isSessionActive 仍 true
    await wrapper.setProps({
      turn: makeTurn({ isStreaming: false, assistants: [msg({ status: 'complete' })] }),
      isSessionActive: true,
    })
    // 不收起（对话仍在进行，trace 保留展开）
    expect(wrapper.find('.trace').exists()).toBe(true)
    // Loader 转为不转（A 类跟随 isStreaming 关闭）
    expect(wrapper.find('.turn-meta .animate-spin').exists()).toBe(false)
  })

  // TC8：subagent 后台跑——isSessionActive=true（derivedStatus 为 working 态，主 turn 已结束但有
  // background subagent 仍在 running）。期望对话流不收起（trace 保留）。验证 working 态也算进行中。
  it('TC8: subagent 后台跑（isSessionActive=true）→ 对话流不收起（isStreaming 已 false）', async () => {
    // 主 turn complete（isStreaming false），但有 background subagent 跑（isSessionActive true = working 态）
    const wrapper = mountTurn({
      turn: makeTurn({ isStreaming: false, assistants: [msg({ status: 'complete' })] }),
      isSessionActive: true,
    })
    expect(wrapper.find('.trace').exists()).toBe(true)
    // subagent 跑完（isSessionActive 转 false）→ 此刻才收起
    await wrapper.setProps({ isSessionActive: false })
    expect(wrapper.find('.trace').exists()).toBe(false)
  })

  // 补充：真正完成（isSessionActive true→false）才收起——M3 修复核心断言。
  it('完成自动收起：ask-user respond 后（isSessionActive true→false）才收起', async () => {
    const wrapper = mountTurn({
      turn: makeTurn({ isStreaming: false, assistants: [msg({ status: 'complete' })] }),
      isSessionActive: true,
    })
    expect(wrapper.find('.trace').exists()).toBe(true)
    // ask-user respond：对话真正结束 → 收起
    await wrapper.setProps({ isSessionActive: false })
    expect(wrapper.find('.trace').exists()).toBe(false)
  })
})

/**
 * 块顺序断言（contentBlocks 真实时序渲染回归基线）。
 *
 * 背景：streaming 时 text 出现在底部、上方 tool call 还在更新——根因是 Turn.vue 硬编码
 * text→thinking→tool 顺序 + 底部 summary 无脑拉 text。修复后 trace 按 contentBlocks
 * 真实时序渲染，streaming 态不显底部 summary。这组测试从「观察者」视角断言 DOM 形态，
 * 防止乱序回归（原 bug 漏掉的原因：旧测试只断言内部状态，缺块顺序 DOM 断言）。
 */
describe('Turn · trace 块按 contentBlocks 真实时序渲染', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** 构造 contentBlocks=[text, toolCall] 的 assistant（先 text 后 tool 的真实场景） */
  function textFirstAssistant(over: Partial<Message> = {}): Message {
    return msg({
      status: 'streaming',
      content: '我先查一下',
      toolCalls: [
        { id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'running', startTime: 0 },
      ],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'tc1' },
      ],
      ...over,
    })
  }

  /** 构造 contentBlocks=[thinking, toolCall] 的 assistant（先 think 后 tool 的时序对比）。
   *  用 thinking+tool 而非 text+tool：末位 text 始终在 summary 位渲染（不在 trace），
   *  thinking/tool 不受末位跳过影响，能稳定验证 contentBlocks 时序。 */
  function thinkToolAssistant(thinkFirst: boolean, over: Partial<Message> = {}): Message {
    const thinking = { id: 'th1', content: '让我想想', collapsed: true }
    const toolCall = { id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'completed', startTime: 0 }
    return msg({
      status: 'streaming',
      content: '查完了',
      thinking: [thinking],
      toolCalls: [toolCall],
      contentBlocks: thinkFirst
        ? [{ type: 'thinking', refId: 'th1' }, { type: 'toolCall', refId: 'tc1' }]
        : [{ type: 'toolCall', refId: 'tc1' }, { type: 'thinking', refId: 'th1' }],
      ...over,
    })
  }

  it('U15: streaming 态 trace 块顺序 = contentBlocks 顺序（think 在 tool 之前），末位 text 在 summary 位', () => {
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: true,
        assistants: [thinkToolAssistant(true)],
      }),
    })
    // trace 存在
    expect(wrapper.find('.trace').exists()).toBe(true)
    // trace 内所有 Block 根（.trace-blk）。末位 text 始终跳过，trace 只剩 thinking + tool
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(2)
    // 第一个块是 thinking（.trace-think 存在）
    expect(blocks[0].find('.trace-think').exists()).toBe(true)
    // 第二个块是 tool（.trace-tool 存在）
    expect(blocks[1].find('.trace-tool').exists()).toBe(true)
    // summary 也存在（末位 text 在 summary 位，streaming 态也渲染）
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
  })

  it('U16: streaming 态 trace 块顺序 = contentBlocks 顺序（tool 在 think 之前）', () => {
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: true,
        assistants: [thinkToolAssistant(false)],
      }),
    })
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(2)
    // 第一个块是 tool
    expect(blocks[0].find('.trace-tool').exists()).toBe(true)
    // 第二个块是 thinking
    expect(blocks[1].find('.trace-think').exists()).toBe(true)
    // summary 也存在（末位 text 在 summary 位）
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
  })

  it('U17: streaming 态末位 text 在 summary 位渲染（不在 trace 内重复），summary 带 streaming 光标', () => {
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: true,
        assistants: [textFirstAssistant()],
      }),
    })
    // streaming 态：turn-summary 存在（末位 text 在 summary 位渲染，消除停止时样式跳变）
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    // streaming 光标在 summary 内（streaming-cursor span）
    expect(wrapper.find('.turn-summary .streaming-cursor').exists()).toBe(true)
    // trace 内无 text 块（末位 text 跳过，只剩 tool）
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(1)
    expect(blocks[0].find('.trace-tool').exists()).toBe(true)
  })

  it('U18: streaming→complete 切换后，summary 仍在（text 位置不变），光标消失', async () => {
    // streaming 态：summary 已存在（text 在 summary 位），带光标
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: true,
        assistants: [textFirstAssistant()],
      }),
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    expect(wrapper.find('.turn-summary .streaming-cursor').exists()).toBe(true)

    // 切到 complete 态
    await wrapper.setProps({
      turn: makeTurn({
        isStreaming: false,
        hasFoldable: true,
        assistants: [textFirstAssistant({ status: 'complete' })],
      }),
    })
    // summary 仍存在（text 位置未变，这正是消除跳变的核心）
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    // 光标消失（isStreaming=false）
    expect(wrapper.find('.turn-summary .streaming-cursor').exists()).toBe(false)
    // 注意：MarkdownRenderer 被 stub，summary 文本可能不渲染，但 .turn-summary div 存在即可
  })

  it('U19: complete 态展开 trace，末位 assistant 的 text 块被跳过（仅显 tool 过程）', async () => {
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({
        isStreaming: false,
        hasFoldable: true,
        assistants: [textFirstAssistant({ status: 'complete' })],
      }),
    })
    // complete 态默认收起，手动展开 trace（点击 turn-meta）
    await wrapper.find('.turn-meta').trigger('click')
    expect(wrapper.find('.trace').exists()).toBe(true)
    // trace 内只剩 tool 块（text 被跳过，因已在底部 summary）
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(1)
    expect(blocks[0].find('.trace-tool').exists()).toBe(true)
  })
})
