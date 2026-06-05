import { describe, it, expect, vi, beforeEach } from 'vitest'
import { on, emit, off, clear } from '../event-bus'
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * Event-Bus type hardening (FR-7)
 *
 * Verifies that:
 *  - on/emit/off accept only valid ServerMessageType values
 *  - Handler signature is (msg: ServerMessage) => void
 *  - off() removes a specific handler
 *  - clear() empties the listener map
 *  - Multiple handlers on the same event all fire
 *  - A throwing handler does not prevent other handlers from running
 *  - Newly added ServerMessageType values (e.g. message.bashExecution) work
 *
 * The event-bus exposes a module-level `listeners` Map, so we must call
 * `clear()` between tests to avoid cross-test pollution.
 */

function makeMsg<T extends ServerMessage['type']>(
  type: T,
  payload: Record<string, unknown> = {},
): ServerMessage {
  return { type, payload }
}

beforeEach(() => {
  // The listeners Map lives at module scope; wipe it between tests.
  clear()
})

describe('event-bus — type hardening (FR-7)', () => {
  it('on() accepts a valid ServerMessageType and registers the handler', () => {
    const handler = vi.fn()

    on('message.text_delta', handler)

    const msg = makeMsg('message.text_delta', { delta: 'hi' })
    emit('message.text_delta', msg)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(msg)
  })

  it('emit() accepts a valid ServerMessageType and dispatches the message', () => {
    const handler = vi.fn()
    on('message.text_delta', handler)

    const msg: ServerMessage = {
      type: 'message.text_delta',
      payload: { delta: 'world' },
    }
    emit('message.text_delta', msg)

    expect(handler).toHaveBeenCalledWith(msg)
  })

  it('off() removes the handler from the map', () => {
    const handler = vi.fn()

    on('message.text_delta', handler)
    off('message.text_delta', handler)

    emit('message.text_delta', makeMsg('message.text_delta', { delta: 'x' }))

    expect(handler).not.toHaveBeenCalled()
  })

  it('off() only removes the targeted handler, leaving siblings intact', () => {
    const handlerA = vi.fn()
    const handlerB = vi.fn()

    on('message.text_delta', handlerA)
    on('message.text_delta', handlerB)
    off('message.text_delta', handlerA)

    emit('message.text_delta', makeMsg('message.text_delta'))

    expect(handlerA).not.toHaveBeenCalled()
    expect(handlerB).toHaveBeenCalledTimes(1)
  })

  it('clear() removes all listeners across all event types', () => {
    const handlerA = vi.fn()
    const handlerB = vi.fn()

    on('message.text_delta', handlerA)
    on('message.complete', handlerB)

    clear()

    emit('message.text_delta', makeMsg('message.text_delta'))
    emit('message.complete', makeMsg('message.complete'))

    expect(handlerA).not.toHaveBeenCalled()
    expect(handlerB).not.toHaveBeenCalled()
  })

  it('multiple handlers on the same event all fire on emit', () => {
    const order: string[] = []
    const handlerA = vi.fn(() => order.push('A'))
    const handlerB = vi.fn(() => order.push('B'))
    const handlerC = vi.fn(() => order.push('C'))

    on('message.text_delta', handlerA)
    on('message.text_delta', handlerB)
    on('message.text_delta', handlerC)

    emit('message.text_delta', makeMsg('message.text_delta', { delta: 'data' }))

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(handlerC).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('a throwing handler does not break the other handlers on the same event', () => {
    // Suppress the console.error that emit() logs when a handler throws,
    // so the test output stays clean.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handlerA = vi.fn(() => {
      throw new Error('boom')
    })
    const handlerB = vi.fn()
    const handlerC = vi.fn()

    on('message.text_delta', handlerA)
    on('message.text_delta', handlerB)
    on('message.text_delta', handlerC)

    emit('message.text_delta', makeMsg('message.text_delta'))

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(handlerC).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('a throwing handler on one event does not affect another event', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const badHandler = vi.fn(() => {
      throw new Error('boom')
    })
    const goodHandler = vi.fn()

    on('message.text_delta', badHandler)
    on('message.complete', goodHandler)

    emit('message.text_delta', makeMsg('message.text_delta'))
    emit('message.complete', makeMsg('message.complete'))

    expect(badHandler).toHaveBeenCalledTimes(1)
    expect(goodHandler).toHaveBeenCalledTimes(1)

    errorSpy.mockRestore()
  })

  it('newly added ServerMessageType values work (e.g. message.bashExecution)', () => {
    // message.bashExecution was added in Task 1 (protocol types) and must
    // be a valid event name from day one.
    const handler = vi.fn()

    on('message.bashExecution', handler)

    const msg: ServerMessage = {
      type: 'message.bashExecution',
      payload: { command: 'ls -la', exitCode: 0, output: 'total 4' },
    }
    emit('message.bashExecution', msg)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(msg)
  })

  it('emit() with no registered listeners is a no-op', () => {
    expect(() => {
      emit('message.complete', makeMsg('message.complete'))
    }).not.toThrow()
  })

  it('on() returns an unsubscribe function that removes the handler', () => {
    const handler = vi.fn()

    const unsubscribe = on('message.text_delta', handler)
    unsubscribe()
    emit('message.text_delta', makeMsg('message.text_delta'))

    expect(handler).not.toHaveBeenCalled()
  })
})
