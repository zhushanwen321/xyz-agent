import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'

function createMockPort(): ClientPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

describe('PluginRpcClient', () => {
  let client: PluginRpcClient
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    client = new PluginRpcClient()
    port = createMockPort()
    client.attach(port)
  })

  // ── TC-3-02: request timeout → RPC_TIMEOUT error ──────────────
  it('TC-3-02: request() rejects with RPC_TIMEOUT when server never responds', async () => {
    const promise = client.request('test.slow', {}, 50)

    // Verify request was sent
    assert.strictEqual(port.messages.length, 1)
    const sent = port.messages[0] as { type: string; method: string; id: number }
    assert.strictEqual(sent.type, 'rpc')
    assert.strictEqual(sent.method, 'test.slow')

    // No response arrives → timeout after 50ms
    const start = Date.now()
    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      const elapsed = Date.now() - start
      assert.ok(elapsed >= 45, `timeout should take ~50ms, took ${elapsed}ms`)
      assert.ok((e as Error).message.includes('RPC timeout'))
      assert.strictEqual((e as { code?: number }).code, PluginRpcErrorCodes.RPC_TIMEOUT)
    }
    assert.ok(caught, 'request should have rejected with timeout')
  })

  // ── request succeeds when response arrives before timeout ──────
  it('request() resolves when response arrives before timeout', async () => {
    const promise = client.request('test.fast', { x: 1 }, 500)

    // Simulate server response
    const sent = port.messages[0] as { id: number }
    client.handleResponse({
      jsonrpc: '2.0',
      id: sent.id,
      result: { echoed: true },
    })

    const result = await promise
    assert.deepStrictEqual(result, { echoed: true })
  })

  // ── request rejects with error response ────────────────────────
  it('request() rejects with error when server returns error', async () => {
    const promise = client.request('test.fail', {}, 500)

    const sent = port.messages[0] as { id: number }
    client.handleResponse({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32600, message: 'bad request' },
    })

    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      assert.ok((e as Error).message.includes('bad request'))
      assert.strictEqual((e as { code?: number }).code, -32600)
    }
    assert.ok(caught, 'should reject with error')
  })

  // ── dispose cancels pending requests ───────────────────────────
  it('dispose() cancels pending requests', async () => {
    const promise = client.request('test.pending', {}, 5000)

    // Dispose before response
    client.dispose()

    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      assert.ok((e as Error).message.includes('disposed'))
    }
    assert.ok(caught, 'pending request should reject after dispose')
  })

  // ── multiple concurrent requests get correct responses ─────────
  it('concurrent requests receive correct responses by id', async () => {
    const promises = [
      client.request('test.a', { val: 1 }, 500),
      client.request('test.b', { val: 2 }, 500),
      client.request('test.c', { val: 3 }, 500),
    ]

    // Respond out of order
    const ids = port.messages.map((m: unknown) => (m as { id: number }).id)
    client.handleResponse({ jsonrpc: '2.0', id: ids[2], result: 'C' })
    client.handleResponse({ jsonrpc: '2.0', id: ids[0], result: 'A' })
    client.handleResponse({ jsonrpc: '2.0', id: ids[1], result: 'B' })

    const results = await Promise.all(promises)
    assert.deepStrictEqual(results, ['A', 'B', 'C'])
  })

  // ── notification sends without id ──────────────────────────────
  it('notify() sends notification without id', () => {
    client.notify('test.event', { data: 42 })

    assert.strictEqual(port.messages.length, 1)
    const msg = port.messages[0] as { type: string; method: string; id?: number }
    assert.strictEqual(msg.type, 'rpc')
    assert.strictEqual(msg.method, 'test.event')
    assert.strictEqual(msg.id, undefined)
  })

  // ── onNotification receives notifications ──────────────────────
  it('onNotification() handler receives notifications', () => {
    const received: unknown[] = []
    client.onNotification('test.push', (params) => {
      received.push(params)
    })

    client.handleNotification({ jsonrpc: '2.0', method: 'test.push', params: { n: 1 } })
    client.handleNotification({ jsonrpc: '2.0', method: 'test.push', params: { n: 2 } })

    assert.strictEqual(received.length, 2)
    assert.deepStrictEqual(received[0], { n: 1 })
    assert.deepStrictEqual(received[1], { n: 2 })
  })

  // ── onNotification unsubscribe stops receiving ─────────────────
  it('onNotification() unsubscribe stops receiving', () => {
    const received: unknown[] = []
    const unsub = client.onNotification('test.temp', (params) => {
      received.push(params)
    })

    client.handleNotification({ jsonrpc: '2.0', method: 'test.temp', params: { a: 1 } })
    unsub()
    client.handleNotification({ jsonrpc: '2.0', method: 'test.temp', params: { a: 2 } })

    assert.strictEqual(received.length, 1)
  })
})
