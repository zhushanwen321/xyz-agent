import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventAdapter, type EventAdapterOptions } from '../src/event-adapter.js'
import type { ServerMessage } from '@xyz-agent/shared'

function createAdapter(options?: EventAdapterOptions): {
  adapter: EventAdapter
  sent: ServerMessage[]
} {
  const sent: ServerMessage[] = []
  const send = vi.fn((msg: ServerMessage) => { sent.push(msg) })
  const adapter = new EventAdapter('test-session-id', send, options)
  return { adapter, sent }
}

describe('EventAdapter extension bridge', () => {
  describe('setWidget', () => {
    it('sends extension.widget WS event with widgetKey and lines', async () => {
      const { adapter, sent } = createAdapter()
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      // Get the event listener
      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      // Simulate setWidget event from pi
      listener({
        type: 'extension_ui_request',
        method: 'setWidget',
        widgetKey: 'my-widget',
        widgetLines: ['line 1', 'line 2', 'line 3'],
      })

      // Wait for async handling
      await vi.waitFor(() => sent.length > 0)

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:widget')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-id',
        widgetKey: 'my-widget',
        lines: ['line 1', 'line 2', 'line 3'],
      })
    })

    it('handles missing key and lines gracefully', async () => {
      const { adapter, sent } = createAdapter()
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setWidget',
      })

      await vi.waitFor(() => sent.length > 0)

      expect(sent[0].payload.widgetKey).toBe('')
      expect(sent[0].payload.lines).toEqual([])
    })

    it('converts non-string lines to strings', async () => {
      const { adapter, sent } = createAdapter()
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setWidget',
        widgetKey: 'widget',
        widgetLines: [42, null, 'text'],
      })

      await vi.waitFor(() => sent.length > 0)

      expect(sent[0].payload.lines).toEqual(['42', 'null', 'text'])
    })
  })

  describe('setStatus', () => {
    it('sends extension.status WS event and invokes callback', async () => {
      const onStatusSetUpdate = vi.fn()
      const { adapter, sent } = createAdapter({ onStatusSetUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'my-status',
        statusText: 'Loading...',
      })

      await vi.waitFor(() => sent.length > 0)

      // Callback should be called
      expect(onStatusSetUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        key: 'my-status',
        text: 'Loading...',
      })

      // WS event should be sent
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:status')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-id',
        statusKey: 'my-status',
        text: 'Loading...',
      })
    })

    it('sends WS event even without callback', async () => {
      const { adapter, sent } = createAdapter() // no onStatusSetUpdate
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'status',
        statusText: 'Done',
      })

      await vi.waitFor(() => sent.length > 0)

      expect(sent[0].type).toBe('extension:status')
      expect(sent[0].payload.statusKey).toBe('status')
      expect(sent[0].payload.text).toBe('Done')
    })
  })
})
