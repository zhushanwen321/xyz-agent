import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventAdapter, type WsSender } from '../src/event-adapter.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiMessage } from '../src/rpc-client.js'

/**
 * Task 2 tests: EventAdapter extension event translation.
 *
 * Verifies that:
 * 1. extension_ui_request with confirm/select/input/notify → extension.ui_request ServerMessage
 * 2. extension_ui_request with setStatus/setWidget → null (discarded)
 * 3. extension_error → extension.error ServerMessage
 * 4. tool_execution_update → message.tool_call_update ServerMessage
 * 5. Original mapping of confirm/select to message.tool_call_pending is REMOVED
 * 6. All ServerMessages include sessionId
 */

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

function createAdapter(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = new EventAdapter('test-session-1', send)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

describe('EventAdapter: extension event translation', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  // ── extension_ui_request → extension.ui_request ──────────────

  describe('extension_ui_request (interactive methods)', () => {
    it('translates confirm method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-1',
            title: 'Allow file access?',
            message: 'Extension wants to read /tmp/test.txt',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-1',
        method: 'confirm',
        title: 'Allow file access?',
        message: 'Extension wants to read /tmp/test.txt',
      })
    })

    it('translates select method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-2',
            title: 'Pick an option',
            options: [
              { label: 'A', value: 'a', description: 'Option A' },
              { label: 'B', value: 'b' },
            ],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      const payload = sent[0].payload as Record<string, unknown>
      expect(payload.method).toBe('select')
      // options should be string[] (labels extracted)
      expect(payload.options).toEqual(['A', 'B'])
    })

    it('translates input method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'input',
            id: 'req-3',
            title: 'Enter a value',
            default: 'placeholder text',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-3',
        method: 'input',
        title: 'Enter a value',
        default: 'placeholder text',
      })
    })

    it('translates notify method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'notify',
            id: 'req-4',
            message: 'Operation completed',
            level: 'info',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-4',
        method: 'notify',
        message: 'Operation completed',
        level: 'info',
      })
    })

    it('does NOT produce message.tool_call_pending for confirm', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-5',
            title: 'Allow?',
          }))
          return () => {}
        },
      })
      await flushAsync()

      const toolCallPending = sent.find((m) => m.type === 'message.tool_call_pending')
      expect(toolCallPending).toBeUndefined()
    })

    it('does NOT produce message.tool_call_pending for select', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-6',
            options: [{ label: 'X', value: 'x' }],
          }))
          return () => {}
        },
      })
      await flushAsync()

      const toolCallPending = sent.find((m) => m.type === 'message.tool_call_pending')
      expect(toolCallPending).toBeUndefined()
    })
  })

  // ── extension_ui_request (bridge methods) ─────────────────────

  describe('extension_ui_request (bridge methods)', () => {
    it('bridges setStatus to extension.status WS event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'setStatus',
            id: 'req-d1',
            key: 'status-key',
            text: 'some status',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:status')
      expect(sent[0].payload.statusKey).toBe('status-key')
      expect(sent[0].payload.text).toBe('some status')
    })

    it('bridges setWidget to extension.widget WS event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'setWidget',
            id: 'req-d2',
            key: 'widget-key',
            lines: ['line1', 'line2'],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:widget')
      expect(sent[0].payload.widgetKey).toBe('widget-key')
      expect(sent[0].payload.lines).toEqual(['line1', 'line2'])
    })
  })

  // ── extension_error → extension.error ─────────────────────────

  describe('extension_error', () => {
    it('translates extension_error to extension.error', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_error',
            extensionName: 'my-extension',
            error: 'Extension crashed unexpectedly',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        extensionName: 'my-extension',
        error: 'Extension crashed unexpectedly',
      })
    })

    it('handles extension_error without sessionId in raw event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_error',
            extensionName: 'ext-2',
            error: 'some error',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        extensionName: 'ext-2',
      })
    })
  })

  // ── tool_execution_update → message.tool_call_update ──────────

  describe('tool_execution_update', () => {
    it('translates tool_execution_update to message.tool_call_update', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            partialResult: 'partial content here',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        toolCallId: 'tc-1',
        detail: 'partial content here',
      })
    })

    it('handles tool_execution_update without partialResult', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-2',
            toolName: 'search',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        toolCallId: 'tc-2',
      })
    })
  })

  // ── SessionId injection ────────────────────────────────────────

  describe('sessionId injection', () => {
    it('injects constructor sessionId into all extension messages', async () => {
      const localSent: ServerMessage[] = []
      const localSend: WsSender = (msg) => { localSent.push(msg) }
      const localAdapter = new EventAdapter('custom-session-42', localSend)

      localAdapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'extension_error', extensionName: 'e', error: 'err' }))
          listener(piEvent({ type: 'extension_ui_request', method: 'confirm', id: 'r1' }))
          listener(piEvent({ type: 'tool_execution_update', toolCallId: 'tc1', toolName: 't' }))
          return () => {}
        },
      })
      await flushAsync()

      for (const msg of localSent) {
        expect((msg.payload as Record<string, unknown>).sessionId).toBe('custom-session-42')
      }
    })
  })

  // ── Non-extension events unchanged ─────────────────────────────

  describe('non-extension events (regression)', () => {
    it('still translates tool_execution_start correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_start',
            toolCallId: 'tc-reg',
            toolName: 'write_file',
            args: { path: '/tmp/x' },
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_start')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        toolCallId: 'tc-reg',
        toolName: 'write_file',
      })
    })

    it('still translates status events correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'status',
            status: 'thinking',
            detail: 'processing',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.status')
    })
  })
})
