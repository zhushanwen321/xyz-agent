import { describe, it, expect } from 'vitest'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'
import type { PiHistoryMessage, PiHistoryToolResult } from '../src/infra/pi/pi-protocol.js'

describe('convertPiHistory', () => {
  it('converts user and assistant text messages', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: 1000,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(raw)

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect((messages[0].content as Array<{ type: string; text?: string }>)
      .find((s) => s.type === 'text')?.text).toBe('Hello')
    expect(messages[0].timestamp).toBe(1000)
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toBe('Hi there')
    expect(messages[1].status).toBe('complete')
  })

  it('merges toolResult into parent assistant toolCall', () => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'readFile', arguments: { path: '/foo' } }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'file contents here' }],
        timestamp: 2000,
        toolCallId: 'tc1',
        toolName: 'readFile',
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    // toolResult should be merged, not a separate message
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls![0].id).toBe('tc1')
    expect(messages[0].toolCalls![0].output).toBe('file contents here')
    expect(messages[0].toolCalls![0].status).toBe('completed')
  })

  it('marks toolCall as error when toolResult has isError', () => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'exit 1' } }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'command failed' }],
        timestamp: 2000,
        toolCallId: 'tc2',
        toolName: 'bash',
        isError: true,
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls![0].status).toBe('error')
    expect(messages[0].toolCalls![0].output).toBe('command failed')
  })
})

describe('convertPiHistory - skill block parsing', () => {
  // user 消息中的 <skill name="..." location="...">...</skill> 块由 pi backend 注入，
  // convertPiHistory 应剖出 skillName/skillLocation 并只保留用户真实文本。
  const skillUser = (text: string) => [{
    role: 'user',
    content: [{ type: 'text' as const, text }],
    timestamp: 1000,
  } satisfies PiHistoryMessage]

  it('parses a skill block with location, leaves trailing user text', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="code-review" location="/abs/path/SKILL.md">skill body</skill>do the thing',
    ))
    const skillSeg = (messages[0].content as any[]).find((s) => s.type === 'skill')
    expect(skillSeg?.name).toBe('code-review')
    expect(skillSeg?.location).toBe('/abs/path/SKILL.md')
    expect((messages[0].content as any[]).find((s) => s.type === 'text')?.text).toBe('do the thing')
  })

  it('parses a skill block without location (skillLocation undefined)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="merge">body</skill>ship it',
    ))
    const skillSeg = (messages[0].content as any[]).find((s) => s.type === 'skill')
    expect(skillSeg?.name).toBe('merge')
    expect(skillSeg?.location).toBeUndefined()
    expect((messages[0].content as any[]).find((s) => s.type === 'text')?.text).toBe('ship it')
  })

  it('leaves content as-is when skill block lacks name attribute (regex no match)', () => {
    const raw = '<skill location="/x">body</skill>keep me'
    const messages = convertPiHistory(skillUser(raw))
    const content = messages[0].content as any[]
    // 无 skill 匹配 → 整段包成单个 text segment，无 skill segment
    expect(content.find((s) => s.type === 'skill')).toBeUndefined()
    expect(content.find((s) => s.type === 'text')?.text).toBe(raw)
  })

  it('leaves content as-is when skill block is unclosed (regex no match)', () => {
    const raw = '<skill name="x">body without close'
    const messages = convertPiHistory(skillUser(raw))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')).toBeUndefined()
    expect(content.find((s) => s.type === 'text')?.text).toBe(raw)
  })

  it('takes only the first skill block (non-greedy), rest stays in user text', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="first">A</skill><skill name="second">B</skill>tail',
    ))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')?.name).toBe('first')
    expect(content.find((s) => s.type === 'text')?.text).toBe('<skill name="second">B</skill>tail')
  })

  it('trims trailing user text (whitespace only after close)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="x">body</skill>   \n  ',
    ))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')?.name).toBe('x')
    // trim 后无剩余用户文本 → 不追加 text segment
    expect(content.find((s) => s.type === 'text')).toBeUndefined()
  })
})

describe('convertPiHistory - contentBlocks 到达顺序（循环内 push）', () => {
  // U9：parts=[thinking, text, toolCall] → contentBlocks 按真实到达顺序
  it('U9: parts=[thinking, text, toolCall] → contentBlocks 顺序=[thinking, text, toolCall]', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先思考' },
          { type: 'text', text: '结论' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
        ],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    const cb = messages[0].contentBlocks
    expect(cb).toBeDefined()
    expect(cb?.map((b) => b.type)).toEqual(['thinking', 'text', 'toolCall'])
    // text 块 refId 统一为 'text'，不再被强制置顶
    const textBlock = cb?.find((b) => b.type === 'text')
    expect(textBlock?.refId).toBe('text')
  })

  // U10：纯 text part → contentBlocks 仅一个 text 块
  it('U10: parts=[{type:text}] → contentBlocks=[{type:text,refId:text}]（仅一个）', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '纯文字回答' }],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    expect(messages[0].contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  // U10b：text part 在前（非末位）→ text 能落在 contentBlocks 非末位
  it('U10b: parts=[text, thinking] → contentBlocks=[text, thinking]（text 不被强制置顶）', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先说话' },
          { type: 'thinking', thinking: '后思考' },
        ],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    const cb = messages[0].contentBlocks
    expect(cb?.map((b) => b.type)).toEqual(['text', 'thinking'])
  })

  // ── custom message（pi CustomMessage，扩展经 sendMessage 注入）──
  describe('custom message（role:"custom"）', () => {
    it('subagent-bg-notify 单条 → system + customType + bgNotify(单条 record)', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'Subagent "coder" (job-1) completed. Result:\nDone.',
          details: {
            id: 'job-1',
            status: 'done',
            agent: 'coder',
            model: 'claude-4.5',
            result: 'Done.',
            startedAt: 1000,
            endedAt: 13000,
          },
          timestamp: 13000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.customType).toBe('subagent-bg-notify')
      expect(m.content).toContain('coder')
      // bgNotify 解析为单条 record（非 batch）
      expect(m.bgNotify).toBeDefined()
      expect(!('batch' in (m.bgNotify as object))).toBe(true)
      const rec = m.bgNotify as { id: string; status: string; agent: string; model: string }
      expect(rec.id).toBe('job-1')
      expect(rec.status).toBe('done')
      expect(rec.agent).toBe('coder')
      expect(rec.model).toBe('claude-4.5')
    })

    it('subagent-bg-notify 批量 → bgNotify = {batch, items}', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'batch content',
          details: {
            batch: true,
            items: [
              { id: 'j1', status: 'done', agent: 'a1', startedAt: 1000 },
              { id: 'j2', status: 'failed', agent: 'a2', startedAt: 2000, error: 'boom' },
            ],
          },
          timestamp: 5000,
        },
      ]
      const messages = convertPiHistory(raw)
      const m = messages[0]
      expect(m.bgNotify).toBeDefined()
      expect('batch' in (m.bgNotify as object)).toBe(true)
      const batch = m.bgNotify as { batch: boolean; items: Array<{ id: string; status: string }> }
      expect(batch.items).toHaveLength(2)
      expect(batch.items[0].id).toBe('j1')
      expect(batch.items[1].status).toBe('failed')
    })

    it('其他 customType → system + customType，无 bgNotify', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'some-other-extension',
          content: 'hello',
          details: { foo: 'bar' },
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('system')
      expect(messages[0].customType).toBe('some-other-extension')
      expect(messages[0].bgNotify).toBeUndefined()
    })

    // ── display 字段透传（FR-3 / AC-6）──────────────────────────────────
    // pi CustomMessage.display 是必填 boolean（false=隐藏不渲染，true=渲染）。
    // convertPiHistory 此前转 custom → system 时丢了 display，本次修复透传。
    it('display:false 的 custom message → 透传到 msg.display（goal/todo context 类应隐藏）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'goal-context',
          content: '<goal_context>...</goal_context>',
          display: false,
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      expect(messages[0].display).toBe(false)
    })

    it('display:true 的 custom message → 透传到 msg.display（workflow-result/subagent-bg-notify 类应显示）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'workflow-result',
          content: 'done',
          display: true,
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBe(true)
    })

    it('display 缺失的旧 custom message → msg.display 为 undefined（渲染层按 !== false 判断，保留显示）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'legacy',
          content: 'old',
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBeUndefined()
    })

    it('display:false 的 custom message 仍进 result（converter 不丢消息，过滤在渲染层）', () => {
      // AC-3 / FR-7：chat store 保留完整 messages，filterDisplayableMessages 只在渲染层过滤。
      // converter 若丢消息会破坏规则 7.5（fork/compact/replay 需完整历史）。
      const raw = [
        { role: 'user', content: 'hi', timestamp: 1000 },
        {
          role: 'custom',
          customType: 'todo-context',
          content: '<todo_context>...</todo_context>',
          display: false,
          timestamp: 2000,
        },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 3000 },
      ]
      const messages = convertPiHistory(raw)
      // user + custom(system) + assistant = 3 条，display:false 的 custom 不丢
      expect(messages).toHaveLength(3)
      expect(messages[1].display).toBe(false)
    })

    it('subagent-bg-notify details 缺必需字段 → bgNotify 为 undefined（降级纯文本）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'partial',
          // 缺 id / agent / startedAt
          details: { status: 'done' },
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].bgNotify).toBeUndefined()
      expect(messages[0].content).toBe('partial')
    })
  })

  describe('piEntryId（文件路径读取时注入的 entry id）', () => {
    it('__entryId 存在时填充到 Message.piEntryId', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
          __entryId: 'abc123',
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBe('abc123')
    })

    it('无 __entryId 时 piEntryId 为 undefined（RPC 路径）', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBeUndefined()
    })

    it('__entryId 非字符串时不填充', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
          __entryId: 123,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBeUndefined()
    })
  })
})
