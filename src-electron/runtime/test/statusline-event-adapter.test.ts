import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventAdapter, type WsSender, type EventAdapterOptions } from '../src/event-adapter.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiMessage } from '../src/rpc-client.js'

/**
 * Statusline feature tests (TC-1-01 ~ TC-4-03, TC-8-01 partial)
 *
 * Covers: event-adapter setStatus translation, context.update callback,
 * and integration with server routing pipeline.
 */

type PiTestEvent = PiMessage & Record<string, unknown>

function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

function createAdapter(opts?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = new EventAdapter('test-session-1', send, opts)
  return { adapter, sent }
}

// ── TC-1-01: event-adapter translates setStatus to onStatusSetUpdate ────

describe('TC-1-01: setStatus → onStatusSetUpdate callback', () => {
  it('calls onStatusSetUpdate callback with sessionId, key, text', () => {
    const onStatusSetUpdate = vi.fn()
    const { adapter, sent } = createAdapter({ onStatusSetUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'extension_ui_request',
          method: 'setStatus',
          statusKey: 'goal',
          statusText: '◆ Goal 1/20',
        }))
        return () => {}
      },
    })

    // setStatus now also sends a WS event
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('extension:status')
    // Instead, it calls the callback
    expect(onStatusSetUpdate).toHaveBeenCalledTimes(1)
    expect(onStatusSetUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-1',
      key: 'goal',
      text: '◆ Goal 1/20',
    })
  })

  it('handles missing key/text with defaults', () => {
    const onStatusSetUpdate = vi.fn()
    const { adapter } = createAdapter({ onStatusSetUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'extension_ui_request',
          method: 'setStatus',
        }))
        return () => {}
      },
    })

    expect(onStatusSetUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-1',
      key: '',
      text: '',
    })
  })

  it('handles undefined text with empty string', () => {
    const onStatusSetUpdate = vi.fn()
    const { adapter } = createAdapter({ onStatusSetUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'extension_ui_request',
          method: 'setStatus',
          statusKey: 'todo',
          statusText: undefined,
        }))
        return () => {}
      },
    })

    expect(onStatusSetUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-1',
      key: 'todo',
      text: '',
    })
  })
})

// ── TC-1-02: event-adapter still discards setWidget ─────────────────────

describe('TC-1-02: setWidget bridges to extension:widget', () => {
  it('sends extension.widget WS event for setWidget', () => {
    const onStatusSetUpdate = vi.fn()
    const { adapter, sent } = createAdapter({ onStatusSetUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'extension_ui_request',
          method: 'setWidget',
          id: 'req-w1',
          widgetKey: 'widget-key',
          widgetLines: ['line1'],
        }))
        return () => {}
      },
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('extension:widget')
    expect(sent[0].payload.widgetKey).toBe('widget-key')
    expect(sent[0].payload.lines).toEqual(['line1'])
    expect(onStatusSetUpdate).not.toHaveBeenCalled()
  })
})

// ── TC-5 (context.update): onContextUpdate callback from agent_end ──────

describe('context.update: onContextUpdate from agent_end', () => {
  it('calls onContextUpdate when agent_end has usage with inputTokens > 0', async () => {
    const onContextUpdate = vi.fn()
    const { adapter, sent } = createAdapter({ onContextUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            stopReason: 'end_turn',
            usage: { input: 5000, output: 3000, totalTokens: 8000 },
          },
          ] as [{ role: string; stopReason: string; usage: { input: number; output: number; totalTokens: number } }]
        }))
        return () => {}
      },
    })

    // handleEvent is async (void), wait for microtask to flush
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].type).toBe('message.complete')

    // callback is called
    expect(onContextUpdate).toHaveBeenCalledTimes(1)
    expect(onContextUpdate).toHaveBeenCalledWith('test-session-1', {
      inputTokens: 5000,
      totalTokens: 8000,
    })
  })

  it('does NOT call onContextUpdate when inputTokens is 0', async () => {
    const onContextUpdate = vi.fn()
    const { adapter } = createAdapter({ onContextUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            stopReason: 'end_turn',
            usage: { input: 0, output: 0, totalTokens: 0 },
          }],
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => {
      expect(onContextUpdate).not.toHaveBeenCalled()
    })
  })

  it('does NOT call onContextUpdate when usage is missing', async () => {
    const onContextUpdate = vi.fn()
    const { adapter } = createAdapter({ onContextUpdate })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            stopReason: 'end_turn',
          }],
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => {
      expect(onContextUpdate).not.toHaveBeenCalled()
    })
  })
})

// ── TC-8-01 partial: end-to-end setStatus data flow ─────────────────────

describe('TC-8-01: full setStatus data flow (event-adapter → callback)', () => {
  it('setStatus event triggers complete callback chain', () => {
    // Simulate the full callback chain:
    // event-adapter → onStatusSetUpdate → [server would route to plugin hooks]
    const statusUpdates: Array<{ sessionId: string; key: string; text: string }> = []

    const { adapter, sent } = createAdapter({
      onStatusSetUpdate: (data) => {
        statusUpdates.push(data)
      },
    })

    // Simulate pi extension calling setStatus
    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'extension_ui_request',
          method: 'setStatus',
          statusKey: 'goal',
          statusText: '◆ Goal 3/20',
        }))
        return () => {}
      },
    })

    // Verify: setStatus now sends WS event
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('extension:status')
    // Verify: callback received correct data
    expect(statusUpdates).toHaveLength(1)
    expect(statusUpdates[0]).toEqual({
      sessionId: 'test-session-1',
      key: 'goal',
      text: '◆ Goal 3/20',
    })
  })

  it('multiple setStatus events are all captured', () => {
    const statusUpdates: Array<{ sessionId: string; key: string; text: string }> = []

    const { adapter } = createAdapter({
      onStatusSetUpdate: (data) => {
        statusUpdates.push(data)
      },
    })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'goal', statusText: '3/20' }))
        listener(piEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'todo', statusText: '5/10' }))
        listener(piEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'goal', statusText: '' }))  // clear
        return () => {}
      },
    })

    expect(statusUpdates).toHaveLength(3)
    expect(statusUpdates[0].key).toBe('goal')
    expect(statusUpdates[1].key).toBe('todo')
    expect(statusUpdates[2].text).toBe('')  // clear event
  })
})
// trigger CI
