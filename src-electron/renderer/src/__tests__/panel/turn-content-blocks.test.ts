/**
 * Turn contentBlocks 渲染顺序单测 —— Wave W2（对话流渲染层重组）。
 *
 * 背景：W1 已在数据层按到达顺序填充 message.contentBlocks
 * （streaming 路径 chat-chunk-processor + history 路径 message-converter）。
 * 本 Wave 改渲染层 Turn.vue：取消「trace 三段式 + 末尾 summary 分层」，
 * 改为按 contentBlocks 到达顺序的单一连续流渲染。关键设计——
 * text 块恒显（折叠时仍是最终答案可见），thinking/tool 块受 showTrace 控制。
 *
 * 用例清单（U12–U19），通过 stub 子组件 + 读 .stream DOM 顺序验证。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/turn-content-blocks.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Turn from '@/components/panel/message-stream/Turn.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { hasFoldable } from '@/composables/logic/messageTurns'
import type {
  ContentBlock,
  Message,
  ThinkingBlock,
  ToolCall,
} from '@xyz-agent/shared'

// mock 重依赖 composable（只测 Turn 自身渲染逻辑）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn() }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn() }),
}))

function thinking(over: Partial<ThinkingBlock> = {}): ThinkingBlock {
  return { id: 'th1', content: 'reasoning here', collapsed: true, ...over }
}
function toolCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolName: 'read_file',
    input: { path: 'a.ts' },
    output: 'out',
    status: 'completed',
    startTime: Date.now(),
    ...over,
  }
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp: Date.now(),
    ...over,
  }
}

/** 构造 MessageTurn；默认 working 态（最后 assistant streaming） */
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

/**
 * stub Block：渲染一个带 data-kind 的 span，便于按 DOM 顺序读取。
 * thinking → data-kind="thinking" data-content=...
 * tool → data-kind="tool" data-tid=tool.id
 */
const StubBlock = defineComponent({
  name: 'Block',
  props: ['type', 'content', 'tool', 'collapsed', 'working'],
  setup(p: Record<string, unknown>) {
    return () =>
      h('span', {
        'data-kind': p.type,
        'data-content': p.content ?? '',
        'data-tid': (p.tool as { id?: string } | undefined)?.id ?? '',
      })
  },
})

/** stub MarkdownRenderer（text 块走它）：渲染 data-kind="text" data-content */
const StubMd = defineComponent({
  name: 'MarkdownRenderer',
  props: ['content'],
  setup(p: Record<string, unknown>) {
    return () => h('span', { 'data-kind': 'text', 'data-content': p.content ?? '' })
  },
})

/** 从 .stream 容器按 DOM 顺序读出每块的 kind（thinking/tool/text） */
function streamOrder(wrapper: ReturnType<typeof mountTurn>): string[] {
  const el = wrapper.find('.stream').element as HTMLElement
  const spans = el.querySelectorAll('[data-kind]')
  return Array.from(spans).map((s) => s.getAttribute('data-kind') ?? '')
}

/** 从 .stream 读出 {kind, content/tid} 详情（验证内容归属） */
function streamItems(
  wrapper: ReturnType<typeof mountTurn>,
): { kind: string; content: string; tid: string }[] {
  const el = wrapper.find('.stream').element as HTMLElement
  const spans = el.querySelectorAll('[data-kind]')
  return Array.from(spans).map((s) => ({
    kind: s.getAttribute('data-kind') ?? '',
    content: s.getAttribute('data-content') ?? '',
    tid: s.getAttribute('data-tid') ?? '',
  }))
}

/** mount Turn：用 stub 子组件，隔离 Turn 自身渲染逻辑 */
function mountTurn(props: { turn: MessageTurn; sessionId?: string }) {
  return mount(Turn, {
    props: { turn: props.turn, sessionId: props.sessionId ?? 's1' },
    global: {
      plugins: [createPinia()],
      stubs: {
        ChangeSetCard: true,
        ForkConfirmModal: true,
        Block: StubBlock,
        MarkdownRenderer: StubMd,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('Turn contentBlocks 渲染顺序 · 正常用例', () => {
  it('U12: contentBlocks=[thinking,text,toolCall] working 态 → Block 顺序与 contentBlocks 一致', () => {
    const turn = makeTurn({
      assistants: [
        msg({
          id: 'a1',
          content: 'final answer',
          thinking: [thinking({ id: 'th1' })],
          toolCalls: [toolCall({ id: 'tc1' })],
          contentBlocks: [
            { type: 'thinking', refId: 'th1' },
            { type: 'text', refId: 'text' },
            { type: 'toolCall', refId: 'tc1' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // 顺序：thinking(th1) → text → tool(tc1)
    expect(streamOrder(wrapper)).toEqual(['thinking', 'text', 'tool'])
    const items = streamItems(wrapper)
    expect(items[0].content).toBe('reasoning here')
    expect(items[1].content).toBe('final answer')
    expect(items[2].tid).toBe('tc1')
  })

  it('U13: contentBlocks=[text,thinking]（text 先到）→ text 不被移到末尾，顺序保持', () => {
    const turn = makeTurn({
      assistants: [
        msg({
          content: 'answer first',
          thinking: [thinking({ id: 'th1' })],
          contentBlocks: [
            { type: 'text', refId: 'text' },
            { type: 'thinking', refId: 'th1' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    expect(streamOrder(wrapper)).toEqual(['text', 'thinking'])
  })

  it('U17: contentBlocks 含 toolCall 块 → 传给 Block 的 type="tool"（非 "toolCall"）', () => {
    const turn = makeTurn({
      assistants: [
        msg({
          content: 'done',
          toolCalls: [toolCall({ id: 'tc1' })],
          contentBlocks: [
            { type: 'toolCall', refId: 'tc1' },
            { type: 'text', refId: 'text' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // tool 块的 data-kind 必须是 'tool'（Block 接收 type='tool'）
    const toolItem = streamItems(wrapper).find((i) => i.tid === 'tc1')
    expect(toolItem).toBeDefined()
    expect(toolItem!.kind).toBe('tool')
  })

  it('U18: 末尾 assistant streaming，末块为 text → 光标接在 text 后；complete 后 hover actions 挂载', async () => {
    // streaming 态
    const turn = makeTurn({
      isWorking: true,
      assistants: [
        msg({
          id: 'a1',
          content: 'streaming answer',
          status: 'streaming',
          contentBlocks: [{ type: 'text', refId: 'text' }] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // streaming 光标存在
    expect(wrapper.find('.streaming-cursor').exists()).toBe(true)
    // complete 态 hover actions（非 streaming）显示 fork/复制
    await wrapper.setProps({
      turn: makeTurn({
        isWorking: false,
        assistants: [
          msg({
            id: 'a1',
            content: 'final answer',
            status: 'complete',
            contentBlocks: [{ type: 'text', refId: 'text' }] satisfies ContentBlock[],
          }),
        ],
      }),
    })
    // hover actions 区存在（fork button）
    expect(wrapper.find('[title="克隆并分叉到另一面板"]').exists()).toBe(true)
    // streaming 光标消失
    expect(wrapper.find('.streaming-cursor').exists()).toBe(false)
  })
})

describe('Turn contentBlocks 渲染顺序 · 折叠行为', () => {
  it('U14: complete turn hasFoldable expanded=false → thinking/tool 折叠隐藏，text 仍可见（核心回归）', () => {
    const turn = makeTurn({
      isWorking: false,
      hasFoldable: true,
      assistants: [
        msg({
          id: 'a1',
          content: 'final answer visible',
          status: 'complete',
          thinking: [thinking({ id: 'th1' })],
          toolCalls: [toolCall({ id: 'tc1' })],
          contentBlocks: [
            { type: 'thinking', refId: 'th1' },
            { type: 'text', refId: 'text' },
            { type: 'toolCall', refId: 'tc1' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // complete + expanded=false → showTrace=false → thinking/tool 不渲染
    expect(streamOrder(wrapper)).not.toContain('thinking')
    expect(streamOrder(wrapper)).not.toContain('tool')
    // 但 text 必须渲染可见（最终答案不能被折叠藏掉）
    expect(streamOrder(wrapper)).toContain('text')
    expect(streamItems(wrapper).find((i) => i.kind === 'text')?.content).toBe(
      'final answer visible',
    )
  })
})

describe('Turn contentBlocks 渲染顺序 · 边界', () => {
  it('U15: 两 assistant，a1(text) + a2(thinking,text) streaming → a1 text 保持原位，不跳到折叠区', () => {
    const turn = makeTurn({
      isWorking: true,
      hasFoldable: true,
      assistants: [
        msg({
          id: 'a1',
          content: 'first answer',
          thinking: [thinking({ id: 'th0', content: 't0' })],
          contentBlocks: [
            { type: 'thinking', refId: 'th0' },
            { type: 'text', refId: 'text' },
          ] satisfies ContentBlock[],
        }),
        msg({
          id: 'a2',
          content: 'second answer',
          thinking: [thinking({ id: 'th1' })],
          contentBlocks: [
            { type: 'thinking', refId: 'th1' },
            { type: 'text', refId: 'text' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // 顺序：th0 → text(a1) → th1 → text(a2)，a1 的 text 不跳到末尾或折叠区
    expect(streamOrder(wrapper)).toEqual(['thinking', 'text', 'thinking', 'text'])
    const items = streamItems(wrapper)
    expect(items[1].content).toBe('first answer')
    expect(items[3].content).toBe('second answer')
  })

  it('U16: assistant 无 contentBlocks（旧数据）→ 回退渲染 thinking→tool（受折叠）+ text 恒显，不报错', () => {
    const turn = makeTurn({
      isWorking: true,
      hasFoldable: true,
      assistants: [
        msg({
          id: 'a1',
          content: 'legacy answer',
          thinking: [thinking({ id: 'th1' })],
          toolCalls: [toolCall({ id: 'tc1' })],
          // 故意无 contentBlocks（旧数据）
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // 回退：thinking → tool → text
    expect(streamOrder(wrapper)).toEqual(['thinking', 'tool', 'text'])
  })
})

describe('Turn contentBlocks 渲染顺序 · 异常/空值', () => {
  it('U18b: contentBlocks=[{thinking,th1}] 但 thinking=[]（refId 不匹配）→ 跳过该块，不抛错', () => {
    const turn = makeTurn({
      isWorking: true,
      hasFoldable: true,
      assistants: [
        msg({
          id: 'a1',
          content: 'orphan block test',
          thinking: [], // th1 找不到
          contentBlocks: [
            { type: 'thinking', refId: 'th1' }, // refId 未命中
            { type: 'text', refId: 'text' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // orphan thinking 被跳过，只剩 text
    expect(streamOrder(wrapper)).toEqual(['text'])
  })

  it('U18c: contentBlocks 含 text 块但 assistant.content="" → 不渲染空 text 块', () => {
    const turn = makeTurn({
      isWorking: true,
      hasFoldable: true,
      assistants: [
        msg({
          id: 'a1',
          content: '', // 空 text
          thinking: [thinking({ id: 'th1' })],
          contentBlocks: [
            { type: 'thinking', refId: 'th1' },
            { type: 'text', refId: 'text' }, // 空内容
          ] satisfies ContentBlock[],
        }),
      ],
    })
    const wrapper = mountTurn({ turn })
    // thinking 渲染，text 因空内容被跳过
    expect(streamOrder(wrapper)).toEqual(['thinking'])
  })
})

describe('messageTurns hasFoldable · contentBlocks 判定', () => {
  it('U19: contentBlocks 仅含 text → false；含 thinking → true', () => {
    const onlyText = makeTurn({
      assistants: [
        msg({
          contentBlocks: [{ type: 'text', refId: 'text' }] satisfies ContentBlock[],
        }),
      ],
    })
    const withThinking = makeTurn({
      assistants: [
        msg({
          contentBlocks: [
            { type: 'thinking', refId: 'th1' },
            { type: 'text', refId: 'text' },
          ] satisfies ContentBlock[],
        }),
      ],
    })
    expect(hasFoldable(onlyText)).toBe(false)
    expect(hasFoldable(withThinking)).toBe(true)
  })

  it('U19b: 旧数据无 contentBlocks → 回退看 thinking/toolCalls（兼容）', () => {
    const legacyWithThinking = makeTurn({
      assistants: [msg({ thinking: [thinking()], /* 无 contentBlocks */ })],
    })
    const legacyPlainText = makeTurn({
      assistants: [msg({ content: 'hi' /* 无 thinking/tool/contentBlocks */ })],
    })
    expect(hasFoldable(legacyWithThinking)).toBe(true)
    expect(hasFoldable(legacyPlainText)).toBe(false)
  })
})
