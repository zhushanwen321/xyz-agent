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
    expect(messages[0].content).toBe('Hello')
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
    expect(messages[0].skillName).toBe('code-review')
    expect(messages[0].skillLocation).toBe('/abs/path/SKILL.md')
    expect(messages[0].content).toBe('do the thing')
  })

  it('parses a skill block without location (skillLocation undefined)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="merge">body</skill>ship it',
    ))
    expect(messages[0].skillName).toBe('merge')
    expect(messages[0].skillLocation).toBeUndefined()
    expect(messages[0].content).toBe('ship it')
  })

  it('leaves content as-is when skill block lacks name attribute (regex no match)', () => {
    const raw = '<skill location="/x">body</skill>keep me'
    const messages = convertPiHistory(skillUser(raw))
    expect(messages[0].skillName).toBeUndefined()
    expect(messages[0].content).toBe(raw)
  })

  it('leaves content as-is when skill block is unclosed (regex no match)', () => {
    const raw = '<skill name="x">body without close'
    const messages = convertPiHistory(skillUser(raw))
    expect(messages[0].skillName).toBeUndefined()
    expect(messages[0].content).toBe(raw)
  })

  it('takes only the first skill block (non-greedy), rest stays in user text', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="first">A</skill><skill name="second">B</skill>tail',
    ))
    expect(messages[0].skillName).toBe('first')
    expect(messages[0].content).toBe('<skill name="second">B</skill>tail')
  })

  it('trims trailing user text (whitespace only after close)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="x">body</skill>   \n  ',
    ))
    expect(messages[0].skillName).toBe('x')
    expect(messages[0].content).toBe('')
  })
})
