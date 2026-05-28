import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort, RpcMethodHandler } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'

/** 记录 postMessage 收到的消息 */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

describe('PluginRpcServer', () => {
  let rpc: PluginRpcServer

  beforeEach(() => {
    rpc = new PluginRpcServer()
  })

  // ── TC-3-01: registerMethod + dispatch → success response ─────
  it('TC-3-01: registerMethod + dispatch → success response', async () => {
    const handler: RpcMethodHandler = async (params) => {
      return { echo: params.msg }
    }
    rpc.registerMethod('test.echo', handler)

    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'test.echo',
      params: { msg: 'hello' },
    })

    assert.strictEqual(port.messages.length, 1)
    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    assert.strictEqual(wrapper.type, 'rpc')
    const resp = wrapper.response
    assert.strictEqual(resp.jsonrpc, '2.0')
    assert.strictEqual(resp.id, 1)
    assert.ok('result' in resp)
    assert.deepStrictEqual(resp.result, { echo: 'hello' })
  })

  // ── TC-3-02: unregistered method → METHOD_NOT_FOUND error ────
  it('TC-3-02: unregistered method → METHOD_NOT_FOUND error', async () => {
    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'nonexistent.method',
      params: {},
    })

    assert.strictEqual(port.messages.length, 1)
    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    assert.strictEqual(wrapper.type, 'rpc')
    const resp = wrapper.response
    assert.ok('error' in resp)
    assert.strictEqual(resp.error.code, PluginRpcErrorCodes.METHOD_NOT_FOUND)
    assert.ok(resp.error.message.includes('nonexistent.method'))
  })

  // ── TC-3-03: handler throws → INTERNAL_ERROR response ─────────
  it('TC-3-03: handler throws → INTERNAL_ERROR response', async () => {
    const handler: RpcMethodHandler = async () => {
      throw new Error('boom')
    }
    rpc.registerMethod('test.fail', handler)

    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'test.fail',
      params: {},
    })

    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    assert.strictEqual(wrapper.type, 'rpc')
    const resp = wrapper.response
    assert.ok('error' in resp)
    // 无自定义 code → 默认 INTERNAL_ERROR
    assert.strictEqual(resp.error.code, PluginRpcErrorCodes.INTERNAL_ERROR)
    assert.strictEqual(resp.error.message, 'boom')
  })

  // ── TC-3-04: notify → sends notification to worker ────────────
  it('TC-3-04: notify → sends notification to specific worker', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    rpc.registerWorker('w1', port1)
    rpc.registerWorker('w2', port2)

    rpc.notify('w1', 'test.event', { data: 42 })

    assert.strictEqual(port1.messages.length, 1, 'target worker should receive notification')
    assert.strictEqual(port2.messages.length, 0, 'other worker should not receive notification')

    const msg = port1.messages[0] as { type: string; notification: { jsonrpc: string; method: string; params: Record<string, unknown> } }
    assert.strictEqual(msg.type, 'rpc')
    assert.strictEqual(msg.notification.jsonrpc, '2.0')
    assert.strictEqual(msg.notification.method, 'test.event')
    assert.deepStrictEqual(msg.notification.params, { data: 42 })
  })

  // ── TC-3-05: broadcast → sends to all workers ─────────────────
  it('TC-3-05: broadcast → sends to all registered workers', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    const port3 = createMockPort()
    rpc.registerWorker('w1', port1)
    rpc.registerWorker('w2', port2)
    rpc.registerWorker('w3', port3)

    rpc.broadcast('system.update', { version: '2.0' })

    assert.strictEqual(port1.messages.length, 1)
    assert.strictEqual(port2.messages.length, 1)
    assert.strictEqual(port3.messages.length, 1)

    for (const port of [port1, port2, port3]) {
      const msg = port.messages[0] as { type: string; notification: { method: string } }
      assert.strictEqual(msg.type, 'rpc')
      assert.strictEqual(msg.notification.method, 'system.update')
    }
  })
})
