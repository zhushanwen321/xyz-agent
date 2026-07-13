/**
 * W1 contract tests: pi-protocol.ts deepened into a real contract.
 *
 * Covers plan.json U1/U2/U3:
 *  - U1: PiEvent union includes all 10 newly-added event types
 *        (compaction_start/end, auto_retry_start/end, thinking_level_changed,
 *         queue_update, entry_appended, session_info_changed, agent_settled,
 *         extension_error)
 *  - U2: PiToolExecutionResult mirrors pi AgentToolResult
 *        (content with image blocks + details + addedToolNames + terminate)
 *  - U3: PiTurnEndEvent carries message + toolResults
 *
 * Method: assignment compile checks (assigning a literal to a typed variable
 * proves membership in the union / shape conformance) + `@ts-expect-error`
 * negative cases + runtime shape assertions on the same fixtures.
 */

import { describe, it, expect } from 'vitest'
import type {
  PiEvent,
  PiToolExecutionResult,
  PiTurnEndEvent,
  PiCompactionStartEvent,
  PiCompactionEndEvent,
  PiAutoRetryStartEvent,
  PiAutoRetryEndEvent,
  PiThinkingLevelChangedEvent,
  PiQueueUpdateEvent,
  PiEntryAppendedEvent,
  PiSessionInfoChangedEvent,
  PiAgentSettledEvent,
  PiExtensionErrorEvent,
} from '../src/infra/pi/pi-protocol.js'

// ════════════════════════════════════════════════════════════════════════
// U1: PiEvent union covers all 10 new event types
// ════════════════════════════════════════════════════════════════════════

describe('U1: PiEvent union — 10 new event types present', () => {
  it('compaction_start is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'compaction_start', reason: 'manual' }
    expect(e.type).toBe('compaction_start')
  })

  it('compaction_end is assignable to PiEvent (full shape)', () => {
    const e: PiEvent = {
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: true,
      errorMessage: 'oom',
    }
    expect(e.type).toBe('compaction_end')
  })

  it('auto_retry_start is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'timeout',
    }
    expect(e.type).toBe('auto_retry_start')
  })

  it('auto_retry_end is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'auto_retry_end', success: true, attempt: 2 }
    expect(e.type).toBe('auto_retry_end')
  })

  it('thinking_level_changed is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'thinking_level_changed', level: 'high' }
    expect(e.type).toBe('thinking_level_changed')
  })

  it('queue_update is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'queue_update',
      steering: ['s1'],
      followUp: ['f1'],
    }
    expect(e.type).toBe('queue_update')
  })

  it('entry_appended is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'entry_appended',
      entry: { id: 'e1', role: 'user' },
    }
    expect(e.type).toBe('entry_appended')
  })

  it('session_info_changed is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'session_info_changed', name: 'renamed' }
    expect(e.type).toBe('session_info_changed')
  })

  it('agent_settled is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'agent_settled' }
    expect(e.type).toBe('agent_settled')
  })

  it('extension_error is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'extension_error',
      extensionPath: 'a/b.ts',
      event: 'tool_execution',
      error: 'boom',
    }
    expect(e.type).toBe('extension_error')
  })

  // Negative case: a non-existent type must NOT be assignable.
  it('rejects unknown event types at compile time', () => {
    // @ts-expect-error — 'not_a_real_type' is not a member of the PiEvent union
    const _e: PiEvent = { type: 'not_a_real_type' }
    expect(_e).toBeDefined()
  })
})

// Independent existence of the exported interfaces (so importing the names
// is valid even when used outside the union).
describe('U1: event interfaces are independently exported', () => {
  it('PiCompactionStartEvent accepts manual|threshold|overflow', () => {
    const e: PiCompactionStartEvent = { type: 'compaction_start', reason: 'overflow' }
    expect(e.reason).toBe('overflow')
  })

  it('PiCompactionEndEvent carries aborted/willRetry/errorMessage', () => {
    const e: PiCompactionEndEvent = {
      type: 'compaction_end',
      reason: 'manual',
      aborted: true,
      willRetry: false,
    }
    expect(e.aborted).toBe(true)
  })

  it('PiAutoRetryStartEvent / PiAutoRetryEndEvent shapes', () => {
    const s: PiAutoRetryStartEvent = {
      type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: 'e',
    }
    const en: PiAutoRetryEndEvent = { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'x' }
    expect(s.attempt).toBe(1)
    expect(en.success).toBe(false)
  })

  it('PiThinkingLevelChangedEvent', () => {
    const e: PiThinkingLevelChangedEvent = { type: 'thinking_level_changed', level: 'xhigh' }
    expect(e.level).toBe('xhigh')
  })

  it('PiQueueUpdateEvent', () => {
    const e: PiQueueUpdateEvent = { type: 'queue_update', steering: [], followUp: [] }
    expect(e.steering).toHaveLength(0)
  })

  it('PiEntryAppendedEvent', () => {
    const e: PiEntryAppendedEvent = { type: 'entry_appended', entry: { a: 1 } }
    expect(e.entry).toEqual({ a: 1 })
  })

  it('PiSessionInfoChangedEvent accepts undefined name', () => {
    const e: PiSessionInfoChangedEvent = { type: 'session_info_changed', name: undefined }
    expect(e.name).toBeUndefined()
  })

  it('PiAgentSettledEvent', () => {
    const e: PiAgentSettledEvent = { type: 'agent_settled' }
    expect(e.type).toBe('agent_settled')
  })

  it('PiExtensionErrorEvent', () => {
    const e: PiExtensionErrorEvent = {
      type: 'extension_error', extensionPath: 'p', event: 'ev', error: 'err',
    }
    expect(e.extensionPath).toBe('p')
  })
})

// ════════════════════════════════════════════════════════════════════════
// U2: PiToolExecutionResult mirrors pi AgentToolResult
// ════════════════════════════════════════════════════════════════════════

describe('U2: PiToolExecutionResult — mirrors pi AgentToolResult', () => {
  it('accepts content with text + image blocks, plus details/addedToolNames/terminate', () => {
    const r: PiToolExecutionResult = {
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'base64==', mimeType: 'image/png' },
      ],
      details: { truncated: true },
      addedToolNames: ['newTool'],
      terminate: true,
    }
    expect(r.content).toHaveLength(2)
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(r.details).toEqual({ truncated: true })
    expect(r.addedToolNames).toEqual(['newTool'])
    expect(r.terminate).toBe(true)
  })

  it('details is required (unknown), addedToolNames/terminate optional', () => {
    const r: PiToolExecutionResult = {
      content: [{ type: 'text', text: 'plain' }],
      details: null,
    }
    expect(r.details).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════
// U3: PiTurnEndEvent carries message + toolResults
// ════════════════════════════════════════════════════════════════════════

describe('U3: PiTurnEndEvent — message + toolResults', () => {
  it('accepts message (role/content/usage/stopReason) + toolResults array', () => {
    const e: PiTurnEndEvent = {
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: 'done',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: 'end_turn',
      },
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'out' }],
          isError: false,
        },
      ],
    }
    expect(e.message.stopReason).toBe('end_turn')
    expect(e.toolResults).toHaveLength(1)
    expect(e.toolResults[0].toolName).toBe('bash')
  })

  it('toolResults may be empty', () => {
    const e: PiTurnEndEvent = {
      type: 'turn_end',
      message: { role: 'assistant', content: 'no tools' },
      toolResults: [],
    }
    expect(e.toolResults).toEqual([])
  })
})
