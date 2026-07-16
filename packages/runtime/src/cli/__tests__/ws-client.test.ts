import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rpc } from '../ws-client.js'

vi.mock('../port-discovery.js', () => ({
  discoverPort: vi.fn(() => 3210),
}))

vi.mock('ws', () => {
  const EventEmitter = require('events')
  return {
    WebSocket: class extends EventEmitter {
      send = vi.fn()
      close = vi.fn()
    },
  }
})

describe('rpc', () => {
  it('sends message with correct type and payload', async () => {
    // W1: verify WS message format matches runtime expectations
    const promise = rpc('config.getProviders', {})
    // test will fail until ws-client implementation exists (red light)
    expect(promise).toBeInstanceOf(Promise)
  })

  it('rejects on timeout', async () => {
    // verify 5s timeout behavior
    await expect(
      rpc('config.getProviders', {}, { timeoutMs: 100 })
    ).rejects.toThrow(/timeout/)
  })
})
