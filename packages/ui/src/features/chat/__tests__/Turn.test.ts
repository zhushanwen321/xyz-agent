/**
 * Turn.vue trace 窗口单测（streaming-trace-window design §3.3）。
 *
 * 覆盖三个 describe：
 * 1. D1 折叠作用域（scope wave，回归保护）：showTrace = isWorkingTurn || isExpanded
 * 2. 窗口切片（window wave）：computeTraceWindow 的 visible 渲染 + TraceCompactorRow v-if + takeover 切换
 * 3. TraceCompactorRow 组件：双态文案 + failed danger + 零 chrome（D5）
 *
 * 用真实 flattenTurnBlocks/computeTraceWindow（RC-1，不 mock core）。
 * TraceCompactorRow 真实组件经内联 i18n plugin mount（RC-2）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Turn.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// mock vue-i18n 的 useI18n：自包含 t（vue-i18n v10 的 createI18n 返回对象作 test-utils plugin 时报
// 「must be a function or object with install」，直接 mock useI18n 最可靠）。
// TraceCompactorRow 真实渲染时 useI18n() 拿到此 mock，文案 + count 插值均可断言（RC-2 i18n provide）。
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const msgs: Record<string, string> = {
        'panel.message.traceExpandAll': '展开全部（{count} 步）',
        'panel.message.traceCollapse': '收起精简',
        'panel.message.traceFailed': '含 {count} 次失败',
      }
      let s = msgs[key] ?? key
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
      return s
    },
  }),
}))

import { mount } from '@vue/test-utils'
import { Turn } from '@xyz-agent/ui'
import TraceCompactorRow from '../TraceCompactorRow.vue'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { ContentBlock, Message, ToolCall } from '@xyz-agent/shared'
import { mockChatProvide } from './helpers'

const NOW = 1_700_000_000_000
const SID = 'sess-trace-window-test'

// ─── fixture 构造 ───────────────────────────────────────────────

/** scope wave 用：带 thinking + tool + text 三块的完成态 turn（fallback 路径产出 [text, thinking, tool]）。 */
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

/**
 * window wave 用：构造指定数量过程块（toolCall）+ 末位 text 的 turn。
 * 走 contentBlocks 显式时序（expandAssistantBlocks 走 contentBlocks 路径，非 fallback），
 * 前 `failedCount` 个 tool 标 status='error'（测 failed 子计数 danger）。
 */
function makeWindowTurn(opts: {
  toolCount?: number
  failedCount?: number
  assistantStatus?: Message['status']
} = {}): MessageTurn {
  const toolCount = opts.toolCount ?? 12
  const failedCount = opts.failedCount ?? 0
  const status = opts.assistantStatus ?? 'complete'
  const toolCalls: ToolCall[] = []
  const contentBlocks: ContentBlock[] = []
  for (let i = 0; i < toolCount; i++) {
    const id = `tc-${i}`
    const isFail = i < failedCount
    toolCalls.push({
      id,
      toolName: 'read',
      input: { path: `/tmp/f${i}` },
      status: isFail ? 'error' : 'completed',
      startTime: NOW + i,
    })
    contentBlocks.push({ type: 'toolCall', refId: id })
  }
  contentBlocks.push({ type: 'text', refId: 'text' })
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: '最终回复',
    status,
    timestamp: NOW,
    toolCalls,
    contentBlocks,
  }
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming: status === 'streaming',
    hasFoldable: toolCount > 0,
  }
}

// ─── mount helper ───────────────────────────────────────────────

/** Block stub：根节点带 .trace-blk + data-type/data-status/data-streaming，供断言 trace 块渲染与 props 透传。 */
const BlockStub = {
  name: 'Block',
  props: {
    type: { type: String, required: true },
    status: { type: String, default: '' },
    streaming: { type: Boolean, default: false },
    tool: { type: Object, default: undefined },
  },
  template: `<div class="trace-blk" :data-type="type" :data-status="status" :data-streaming="streaming ? 'true' : 'false'" />`,
}

function mountTurn(opts: {
  turn?: MessageTurn
  isSessionActive?: boolean
  isLastTurn?: boolean
  isExpanded?: (key: string) => boolean
  isTakeover?: (key: string) => boolean
  /** TraceCompactorRow 真实渲染（默认 stub，隔离 i18n）；true 时 provide i18n + 真实组件 */
  realCompactor?: boolean
} = {}) {
  const useRealCompactor = opts.realCompactor ?? false
  return mount(Turn, {
    props: {
      turn: opts.turn ?? makeTurn(),
      sessionId: SID,
      ...(opts.isSessionActive !== undefined ? { isSessionActive: opts.isSessionActive } : {}),
      ...(opts.isLastTurn !== undefined ? { isLastTurn: opts.isLastTurn } : {}),
    },
    global: {
      provide: mockChatProvide({
        isExpanded: opts.isExpanded ?? (() => false),
        isTakeover: opts.isTakeover ?? (() => false),
      }),
      stubs: {
        UserBubble: true,
        TurnMeta: true,
        TurnSummary: true,
        ChangeSetCard: true,
        Block: BlockStub,
        ...(useRealCompactor ? {} : { TraceCompactorRow: true }),
      },
    },
  })
}

// (i18n 由顶部 vi.mock('vue-i18n') 注入 useI18n，无需 createI18n plugin)

// ═════════════════════════════════════════════════════════════════
// describe 1：scope wave D1 折叠作用域（回归保护）
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window D1: Turn 折叠作用域降到 turn 级', () => {
  it('非末位 turn（isLastTurn=false）→ trace 折叠（仅 text 末位正文，thinking/tool 隐藏）', () => {
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: false })
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(false)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(false)
  })

  it('末位工作 turn（isLastTurn=true, sessionActive）→ trace 展开', () => {
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: true })
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(true)
  })

  it('手动展开（isExpanded=true）优先于作用域——非末位 turn 也展开', () => {
    const wrapper = mountTurn({
      isSessionActive: true,
      isLastTurn: false,
      isExpanded: () => true,
    })
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 2：window wave 窗口切片
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window window: Turn 窗口切片渲染', () => {
  it('TC1: 12 块 turn（W=8）折叠窗口 → 仅渲染 visible（末 W=8 过程块 + 末位 text），前 4 块收编不在 DOM', () => {
    // showTrace=true（末位工作 turn），takeover=false
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: true,
    })
    // visible = 8 个 completed tool（tc-4..tc-11）+ 1 text = 9 块
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(9)
    // 收编区前 4 个 tool（tc-0..tc-3）不在 DOM
    expect(wrapper.find('.trace-blk[data-type="tool"]').exists()).toBe(true)
    // 收编行存在（compactedCount=4）
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(true)
  })

  it('TC2: takeover=true 全展开 → 渲染全部块（12 tool + text = 13），收编行不显示（计数归零）', () => {
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: true,
      isTakeover: () => true,
    })
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(13)
    // takeover=true → compactedCount=0, failedCount=0 → 收编行 v-if=false
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
  })

  it('TC14: 块数 ≤ W（3 块）→ 无收编，收编行不渲染', () => {
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 3 }),
      isSessionActive: true,
      isLastTurn: true,
    })
    // visible = 3 tool + text = 4 块，compactedCount=0
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(4)
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
  })

  it('TC14: 折叠态（!showTrace）→ 收编行不渲染（连 trace 都没展开，谈不上收编）', () => {
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: false, // 非末位 → showTrace=false
    })
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
    // 折叠态仅末位 text
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(1)
  })

  it('TC4: 含 failed tool（3 failed）→ 收编行 danger 子计数存在且高亮 text-danger', () => {
    // realCompactor=true 用真实 TraceCompactorRow + i18n，验 danger 文案/class
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12, failedCount: 3 }),
      isSessionActive: true,
      isLastTurn: true,
      realCompactor: true,
    })
    const failed = wrapper.find('[data-testid="trace-compactor-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.classes()).toContain('text-danger')
    expect(failed.text()).toContain('3')
  })

  it('TC9: Block props 透传——streaming assistant 的块收到 streaming=true / status=streaming', () => {
    // assistantStatus='streaming' + 末位 running tool
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 1, assistantStatus: 'streaming' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    const tool = wrapper.find('.trace-blk[data-type="tool"]')
    expect(tool.exists()).toBe(true)
    expect(tool.attributes('data-streaming')).toBe('true')
    expect(tool.attributes('data-status')).toBe('streaming')
  })

  it('TC2-toggle: 点击收编行 emit toggle → 调用 setTakeover（takeover false→true）', async () => {
    // TraceCompactorRow 真实渲染（需 i18n plugin），点击根 div 触发 emit toggle → onToggleTakeover
    const setTakeover = vi.fn()
    const wrapper = mount(Turn, {
      props: { turn: makeWindowTurn({ toolCount: 12 }), sessionId: SID, isSessionActive: true, isLastTurn: true },
      global: {
        provide: mockChatProvide({ isTakeover: () => false, setTakeover }),
        stubs: { UserBubble: true, TurnMeta: true, TurnSummary: true, ChangeSetCard: true, Block: BlockStub },
      },
    })
    await wrapper.find('[data-testid="trace-compactor"]').trigger('click')
    expect(setTakeover).toHaveBeenCalledTimes(1)
    // isTakeover mock 返回 false，onToggleTakeover 取反 → setTakeover(key, true)
    expect(setTakeover).toHaveBeenCalledWith(expect.any(String), true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 3：TraceCompactorRow 组件（双态 + danger + 零 chrome）
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window TraceCompactorRow', () => {
  function mountRow(props: { compactedCount: number; failedCount: number; takeover: boolean }) {
    return mount(TraceCompactorRow, { props })
  }

  it('TC3: 折叠态（takeover=false）显示「展开全部」+ compactedCount', () => {
    const w = mountRow({ compactedCount: 4, failedCount: 0, takeover: false })
    expect(w.text()).toContain('展开全部')
    expect(w.text()).toContain('4')
    // 无 failed 时不渲染 danger 子计数
    expect(w.find('[data-testid="trace-compactor-failed"]').exists()).toBe(false)
  })

  it('TC3: 全展态（takeover=true）显示「收起精简」', () => {
    const w = mountRow({ compactedCount: 0, failedCount: 0, takeover: true })
    expect(w.text()).toContain('收起精简')
  })

  it('TC4: failedCount>0 渲染 danger 子计数（含 count + text-danger class）', () => {
    const w = mountRow({ compactedCount: 4, failedCount: 3, takeover: false })
    const failed = w.find('[data-testid="trace-compactor-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.classes()).toContain('text-danger')
    expect(failed.text()).toContain('3')
  })

  it('TC12: 零 chrome——根元素 class 不含 border/bg-/divider/gradient/mask', () => {
    const w = mountRow({ compactedCount: 4, failedCount: 0, takeover: false })
    const cls = w.find('[data-testid="trace-compactor-row"]').classes().join(' ')
    expect(cls).not.toMatch(/\bborder\b|bg-|divider|gradient|mask/)
  })

  it('emit toggle on click', async () => {
    const w = mountRow({ compactedCount: 4, failedCount: 0, takeover: false })
    await w.find('[data-testid="trace-compactor-row"]').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
  })
})
