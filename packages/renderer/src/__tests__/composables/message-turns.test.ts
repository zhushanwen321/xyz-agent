/**
 * expandAssistantBlocks 纯函数单测 —— 单条 assistant Message 内部块按真实时序展开。
 *
 * 背景（draft-message-stream §4）：trace 区应按 contentBlocks 真实时序渲染 7 类块。
 * expandAssistantBlocks 把 contentBlocks（索引数组）解成 OrderedBlock[]（带 ref），
 * 供 Turn.vue v-for 渲染。修复「text 在最下方、上方 tool call 还在更新」乱序 bug。
 *
 * 覆盖：
 * - B1：有 contentBlocks，严格按其顺序输出（thinking/text/tool/thinking 交替）
 * - B2：text 块 ref = msg.content（完整字符串，非单 chunk）
 * - B3：无 contentBlocks（降级）→ 旧顺序 text→thinking→tool
 * - B4：contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）
 * - B5：空 contentBlocks + 无内容 → 空数组
 * - B6/B7：subagent/workflow toolCall → kind=agentgraph（contentBlocks 路径 + 降级路径）
 *
 * 运行：npx vitest run src/__tests__/composables/message-turns.test.ts
 */
import { describe, it, expect } from 'vitest'
import { expandAssistantBlocks, filterDisplayableMessages } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

function makeMsg(over: Partial<Message> = {}): Message {
  return { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: Date.now(), ...over }
}

describe('filterDisplayableMessages —— 按 display 字段过滤（FR-5 / AC-1/2/3）', () => {
  // [HISTORICAL] pi CustomMessage.display 是必填 boolean（false=隐藏不渲染）。
  // pi-goal/pi-todo 的 context 消息（<goal_context>/<todo_context>）声明 display:false。
  // 本次修复 message-converter/session-history/customStart 三路径透传 display 后，
  // filterDisplayableMessages 从 HIDDEN_CUSTOM_TYPES 黑名单改为读 m.display !== false。
  // 过滤只在渲染层（本函数），chat store 保留完整 messages（规则 7.5 fork/compact/replay）。
  it('display:false 的消息过滤掉（goal/todo context 类）', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: '开始' }),
      makeMsg({ id: 's1', role: 'system', customType: 'goal-context', display: false, content: '<goal_context>...' }),
      makeMsg({ id: 'a1', role: 'assistant', content: '好的' }),
      makeMsg({ id: 's2', role: 'system', customType: 'todo-context', display: false, content: '<todo_context>...' }),
      makeMsg({ id: 's3', role: 'system', customType: 'goal-context-exceeded', display: false, content: '超限' }),
    ]
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  // [FEAT] 完成通知（subagent-bg-notify / workflow-result）不渲染——用户选择「不展示通知」，
  // 通知触发 agent 后续 turn（triggerTurn:true）处理结果，结果由新 turn 体现，通知本身是噪声。
  // 即使 display:true 也过滤；消息仍进 store 供 fork/compact/replay（filter 不丢消息）。
  it('subagent-bg-notify customType 的消息被过滤（即使 display:true）', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
      makeMsg({ id: 'n1', role: 'system', customType: 'subagent-bg-notify', display: true, content: '子代理完成' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'ok' }),
    ]
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('workflow-result customType 的消息被过滤（即使 display:true）', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
      makeMsg({ id: 'w1', role: 'system', customType: 'workflow-result', display: true, content: 'done' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'ok' }),
    ]
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('普通 customType 消息（display:true）仍保留', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
      // 非 HIDDEN_NOTIFY_CUSTOM_TYPES 的 customType，display:true → 保留
      makeMsg({ id: 'x1', role: 'system', customType: 'future-extension-notify', display: true, content: '显示' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'ok' }),
    ]
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['u1', 'x1', 'a1'])
  })

  it('display:undefined 保留（普通消息无 display 字段，按 !== false 判断安全）', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'hello' }),
      // compactionSummary / branchSummary 走独立字段，无 customType 无 display
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
    ]
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['u1', 'a1', 'c1'])
  })

  it('AC-3 双层：原数组含 display:false（store 保留）+ filter 后不含（渲染过滤）', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
      makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: '隐藏' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'ok' }),
    ]
    // store 层：原数组完整保留 display:false 消息（filter 不改原数组，不丢消息）
    expect(messages.map((m) => m.id)).toEqual(['u1', 'h1', 'a1'])
    expect(messages.find((m) => m.id === 'h1')?.display).toBe(false)
    // 渲染层：filter 后不含 display:false
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(filtered.find((m) => m.display === false)).toBeUndefined()
  })

  // 关键红灯验证：customType 不在旧黑名单、但 display:false 的消息也必须被过滤。
  // 证明 filter 读的是 display 字段而非 customType 黑名单（旧实现会漏这个）。
  it('customType 未知的 display:false 消息也被过滤（证明读 display 字段非黑名单）', () => {
    const messages: Message[] = [
      makeMsg({ id: 'x1', role: 'system', customType: 'future-extension-context', display: false, content: '隐藏' }),
      makeMsg({ id: 'y1', role: 'system', customType: 'future-extension-notify', display: true, content: '显示' }),
    ]
    const filtered = filterDisplayableMessages(messages)
    expect(filtered.map((m) => m.id)).toEqual(['y1'])
  })
})

describe('expandAssistantBlocks —— 单条 assistant 内部块按时序展开', () => {
  it('B1: 有 contentBlocks → 严格按其顺序输出（thinking→text→tool→thinking 交替）', () => {
    const msg = makeMsg({
      content: '中间产出',
      thinking: [
        { id: 'th1', content: '推理1', collapsed: true },
        { id: 'th2', content: '推理2', collapsed: true },
      ],
      toolCalls: [
        { id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      contentBlocks: [
        { type: 'thinking', refId: 'th1' },
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'thinking', refId: 'th2' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    expect(result.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'thinking'])
    expect(result.map((b) => b.kind)).not.toEqual(['text', 'thinking', 'tool', 'thinking'])
  })

  it('B2: text 块 ref = msg.content（完整字符串，非单 chunk delta）', () => {
    const msg = makeMsg({
      content: '完整文本',
      contentBlocks: [{ type: 'text', refId: 'text' }],
    })
    const result = expandAssistantBlocks(msg)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('text')
    expect(result[0].ref).toBe('完整文本')
  })

  it('B3: 无 contentBlocks（降级）→ 旧顺序 text→thinking→tool', () => {
    const msg = makeMsg({
      content: '文本',
      thinking: [{ id: 'th1', content: '推理', collapsed: true }],
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
      // 无 contentBlocks
    })
    const result = expandAssistantBlocks(msg)
    expect(result.map((b) => b.kind)).toEqual(['text', 'thinking', 'tool'])
  })

  it('B4: contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）', () => {
    const msg = makeMsg({
      content: '文本',
      thinking: [{ id: 'th1', content: '推理', collapsed: true }],
      // 只有一个 toolCall，但 contentBlocks 引用了 tc2（不存在）
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'thinking', refId: 'th_missing' }, // 不存在 → 跳过
        { type: 'toolCall', refId: 'tc_missing' }, // 不存在 → 跳过
        { type: 'thinking', refId: 'th1' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    // 只解出 text + th1（两个 missing 被跳过）
    expect(result.map((b) => b.kind)).toEqual(['text', 'thinking'])
    const thRef = result[1].ref as { id: string }
    expect(thRef.id).toBe('th1')
  })

  it('B5: 空 contentBlocks + 无内容 → 空数组', () => {
    const msg = makeMsg({ content: '', contentBlocks: [] })
    expect(expandAssistantBlocks(msg)).toEqual([])
  })

  /* ── agentgraph 识别：subagent/workflow toolCall 解为 kind='agentgraph'（IF3）── */

  it('B6: 有 contentBlocks 时 subagent/workflow toolCall → kind=agentgraph（contentBlocks 路径）', () => {
    // subagent/workflow 是图结构重型操作，按 toolName 识别为 agentgraph（不是普通 tool）
    const msg = makeMsg({
      content: 'done',
      toolCalls: [
        { id: 'sa1', toolName: 'subagent', input: {}, status: 'completed', startTime: 0 },
        { id: 'wf1', toolName: 'workflow', input: {}, status: 'completed', startTime: 0 },
        { id: 'grep1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'sa1' },
        { type: 'toolCall', refId: 'wf1' },
        { type: 'toolCall', refId: 'grep1' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    // subagent + workflow → agentgraph；grep → 普通 tool
    expect(result.map((b) => b.kind)).toEqual(['text', 'agentgraph', 'agentgraph', 'tool'])
    // ref 仍是 ToolCall（数据结构不变，仅 kind 不同）
    const saRef = result[1].ref as { id: string; toolName: string }
    expect(saRef.id).toBe('sa1')
    expect(saRef.toolName).toBe('subagent')
  })

  it('B7: 无 contentBlocks（降级）时 subagent/workflow toolCall → kind=agentgraph（fallback 路径同步识别）', () => {
    // 降级路径（无 contentBlocks）同样按 toolName 识别 agentgraph，与 contentBlocks 路径一致
    const msg = makeMsg({
      content: '文本',
      toolCalls: [
        { id: 'sa1', toolName: 'subagent', input: {}, status: 'completed', startTime: 0 },
        { id: 'grep1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      // 无 contentBlocks → 走降级路径
    })
    const result = expandAssistantBlocks(msg)
    // 降级顺序 text→tool：subagent 标 agentgraph，grep 标 tool
    expect(result.map((b) => b.kind)).toEqual(['text', 'agentgraph', 'tool'])
  })
})
