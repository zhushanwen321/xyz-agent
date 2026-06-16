import { describe, it, expect } from 'vitest'
import { convertPiHistory } from '../src/adapters/message-converter.js'
import type { PiHistoryMessage, PiHistoryToolResult } from '../src/types.js'

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
