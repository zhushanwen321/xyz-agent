/**
 * SessionData Local Cache + Flush — TDD tests for BG2 Task 4
 *
 * Tests the enhanced sessionData cache system with:
 *   - Dirty tracking
 *   - Size tracking + capacity limits (10MB per session)
 *   - Timer-based flush (5s interval)
 *   - Forced flush on session clear / deactivate
 *   - Clear session cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerSessionDataRpcHandlers } from '../src/services/plugin-service/api/session-data-api.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { SessionDataStore } from '../src/services/plugin-service/session-data-store.js'
import type { IMessageBroker } from '../src/interfaces.js'

// ── Helpers ────────────────────────────────────────────────────

const MAX_TEST_SIZE = 200 // Small limit for capacity test

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** Build a mock RPC port that captures dispatched responses */
function createCapturingPort() {
  const sent: unknown[] = []
  return {
    port: { postMessage: (msg: unknown) => sent.push(msg) },
    sent,
  }
}

/** Access PluginService internals for test setup */
function serviceInternals(service: PluginService) {
  return service as unknown as {
    sessionDataStore: SessionDataStore
    flushSessionData(): Promise<void>
    flushSessionDataForSession(sessionId: string): Promise<void>
    clearSessionData(sessionId: string): void
  }
}

// ══════════════════════════════════════════════════════════════════
// SessionData RPC Handlers — cache, dirty, size, capacity
// ══════════════════════════════════════════════════════════════════

describe('SessionData RPC Handlers (Cache + Dirty + Size)', () => {
  let rpcServer: PluginRpcServer
  let cache: Map<string, Map<string, unknown>>
  let dirty: Map<string, Set<string>>
  let sizeTracker: Map<string, number>
  let capturingPort: ReturnType<typeof createCapturingPort>
  let nextId = 1

  beforeEach(() => {
    rpcServer = new PluginRpcServer()
    cache = new Map()
    dirty = new Map()
    sizeTracker = new Map()
    capturingPort = createCapturingPort()
    rpcServer.registerWorker('worker-1', capturingPort.port)
    nextId = 1

    registerSessionDataRpcHandlers(rpcServer, {
      getCache: () => cache,
      getDirty: () => dirty,
      getSizeTracker: () => sizeTracker,
      appendEntry: vi.fn().mockResolvedValue(undefined),
      maxSizeBytes: MAX_TEST_SIZE,
    })
  })

  /** Dispatch an RPC request and return the response */
  async function dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcResponse> {
    capturingPort.sent.length = 0
    const id = nextId++
    await rpcServer.dispatch('worker-1', {
      jsonrpc: '2.0',
      id,
      method,
      params: { pluginId: 'test-plugin', ...params },
    })
    const msg = capturingPort.sent[0] as { response: RpcResponse }
    return msg.response
  }

  // ── TC-4-01: Cache write + read ──────────────────────────────
  it('cache write + read', async () => {
    // Set value
    const setResp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'hello',
    })
    expect((setResp as { result?: unknown }).result).toBeUndefined()

    // Get value from cache
    const getResp = await dispatch('plugin.sessionData.get', {
      sessionId: 's1',
      key: 'k1',
    })
    expect((getResp as { result: unknown }).result).toBe('hello')

    // Non-existent key returns undefined
    const missResp = await dispatch('plugin.sessionData.get', {
      sessionId: 's1',
      key: 'nope',
    })
    expect((missResp as { result?: unknown }).result).toBeUndefined()
  })

  // ── TC-4-02: Dirty tracking ──────────────────────────────────
  it('dirty tracking: set marks key dirty, flush clears dirty', async () => {
    // Set value
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'v1',
    })

    // Dirty should have the key
    expect(dirty.get('s1')).toBeInstanceOf(Set)
    expect(dirty.get('s1')!.has('k1')).toBe(true)

    // Simulate flush clearing dirty
    dirty.get('s1')!.clear()

    // Dirty should be empty
    expect(dirty.get('s1')!.size).toBe(0)

    // Cache still has the value
    expect(cache.get('s1')?.get('k1')).toBe('v1')
  })

  // ── TC-4-03: Bridge down → cache still works ─────────────────
  it('bridge down → cache still works', async () => {
    // appendEntry is already a no-op mock
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'v1',
    })

    // Cache should have the value regardless of bridge status
    expect(cache.get('s1')?.get('k1')).toBe('v1')

    // Get should work from cache
    const getResp = await dispatch('plugin.sessionData.get', {
      sessionId: 's1',
      key: 'k1',
    })
    expect((getResp as { result: unknown }).result).toBe('v1')
  })

  // ── TC-4-04: Capacity limit ──────────────────────────────────
  it('capacity limit: over 10MB → STORAGE_FULL error', async () => {
    // Set a value within limit (50 chars → 52 bytes with JSON quotes)
    const okResp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'a'.repeat(50),
    })
    expect((okResp as { result: unknown }).result).toBeUndefined() // Should succeed

    // Set a value that exceeds limit
    const overResp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k2',
      value: 'b'.repeat(MAX_TEST_SIZE),
    })

    expect((overResp as { error: { code: number; message: string } }).error).toBeDefined()
    expect((overResp as { error?: { code: number; message: string } }).error!.code).toBe(PluginRpcErrorCodes.STORAGE_FULL)
  })

  // ── TC-4-04b: Size tracks correctly on overwrite ─────────────
  it('size tracking: overwrite adjusts size correctly', async () => {
    // Set initial value
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'short',
    })
    expect(sizeTracker.get('s1')).toBe(JSON.stringify('short').length)

    // Overwrite with longer value
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'a'.repeat(100),
    })
    expect(sizeTracker.get('s1')).toBe(JSON.stringify('a'.repeat(100)).length)

    // Delete adjusts size
    await dispatch('plugin.sessionData.delete', {
      sessionId: 's1',
      key: 'k1',
    })
    expect(sizeTracker.get('s1')).toBe(0)
  })

  // ── TC-4-07: keys returns correct list ────────────────────────
  it('keys returns correct list', async () => {
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k1',
      value: 'v1',
    })
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1',
      key: 'k2',
      value: 'v2',
    })

    const resp = await dispatch('plugin.sessionData.keys', {
      sessionId: 's1',
    })
    expect((resp as { result?: unknown }).result).toEqual(['k1', 'k2'])
  })
})

// ══════════════════════════════════════════════════════════════════
// SessionData Flush — PluginService methods
// ══════════════════════════════════════════════════════════════════

describe('SessionData Flush (PluginService)', () => {
  let service: PluginService
  let internals_: ReturnType<typeof serviceInternals>

  beforeEach(() => {
    const broker = createMockBroker()
    service = new PluginService({} as never, broker)
    internals_ = serviceInternals(service)
  })

  // ── TC-4-05: Deactivate flush ────────────────────────────────
  it('flushSessionDataForSession clears dirty entries', async () => {
    // Set up dirty data
    internals_.sessionDataStore.getCache().set('s1', new Map([['k1', 'v1']]))
    internals_.sessionDataStore.getDirty().set('s1', new Set(['k1']))
    internals_.sessionDataStore.getSizeTracker().set('s1', 10)

    // Flush for session
    await internals_.flushSessionDataForSession('s1')

    // Dirty should be cleared
    expect(internals_.sessionDataStore.getDirty().get('s1')?.size ?? 0).toBe(0)

    // Cache should still have the data
    expect(internals_.sessionDataStore.getCache().get('s1')?.get('k1')).toBe('v1')
  })

  // ── TC-4-05b: Flush non-existent session is no-op ────────────
  it('flushSessionDataForSession is no-op for clean session', async () => {
    // No dirty data → should not throw
    await internals_.flushSessionDataForSession('nonexistent')
  })

  // ── TC-4-06: Timer flush ──────────────────────────────────────
  it('timer flush: advance 5s → flush clears dirty', async () => {
    vi.useFakeTimers()

    // Set up dirty data
    internals_.sessionDataStore.getCache().set('s1', new Map([['k1', 'v1']]))
    internals_.sessionDataStore.getDirty().set('s1', new Set(['k1']))
    internals_.sessionDataStore.getSizeTracker().set('s1', 10)

    // Start timer
    internals_.sessionDataStore.startFlushTimer()

    // Advance 5s
    await vi.advanceTimersByTimeAsync(5_000)

    // Dirty should be cleared by flush
    expect(internals_.sessionDataStore.getDirty().get('s1')?.size ?? 0).toBe(0)

    internals_.sessionDataStore.stopFlushTimer()
    vi.useRealTimers()
  })

  // ── TC-4-06b: Timer does not fire before 5s ──────────────────
  it('timer flush: does not fire before 5s', async () => {
    vi.useFakeTimers()

    internals_.sessionDataStore.getCache().set('s1', new Map([['k1', 'v1']]))
    internals_.sessionDataStore.getDirty().set('s1', new Set(['k1']))

    internals_.sessionDataStore.startFlushTimer()

    // Advance 4s — not enough
    await vi.advanceTimersByTimeAsync(4_000)

    // Dirty should NOT be cleared yet
    expect(internals_.sessionDataStore.getDirty().get('s1')?.size).toBe(1)

    internals_.sessionDataStore.stopFlushTimer()
    vi.useRealTimers()
  })

  // ── TC-4-07b: Clear session ───────────────────────────────────
  it('clearSessionData clears cache, dirty, and size', () => {
    // Set up data
    internals_.sessionDataStore.getCache().set('s1', new Map([['k1', 'v1']]))
    internals_.sessionDataStore.getDirty().set('s1', new Set(['k1']))
    internals_.sessionDataStore.getSizeTracker().set('s1', 10)

    // Clear
    internals_.clearSessionData('s1')

    // All should be gone
    expect(internals_.sessionDataStore.getCache().has('s1')).toBe(false)
    expect(internals_.sessionDataStore.getDirty().has('s1')).toBe(false)
    expect(internals_.sessionDataStore.getSizeTracker().has('s1')).toBe(false)
  })

  // ── TC-4-07c: Clear non-existent session is no-op ─────────────
  it('clearSessionData is no-op for non-existent session', () => {
    expect(() => internals_.clearSessionData('nonexistent')).not.toThrow()
  })

  // ── flushSessionData iterates all sessions ────────────────────
  it('flushSessionData flushes all dirty sessions', async () => {
    internals_.sessionDataStore.getCache().set('s1', new Map([['k1', 'v1']]))
    internals_.sessionDataStore.getDirty().set('s1', new Set(['k1']))
    internals_.sessionDataStore.getSizeTracker().set('s1', 10)

    internals_.sessionDataStore.getCache().set('s2', new Map([['k2', 'v2']]))
    internals_.sessionDataStore.getDirty().set('s2', new Set(['k2']))
    internals_.sessionDataStore.getSizeTracker().set('s2', 20)

    await internals_.flushSessionData()

    expect(internals_.sessionDataStore.getDirty().get('s1')?.size ?? 0).toBe(0)
    expect(internals_.sessionDataStore.getDirty().get('s2')?.size ?? 0).toBe(0)
  })

  // ── stopFlushTimer clears the timer ──────────────────────────
  it('stopFlushTimer clears the interval', async () => {
    vi.useFakeTimers()

    internals_.sessionDataStore.getCache().set('s1', new Map([['k1', 'v1']]))
    internals_.sessionDataStore.getDirty().set('s1', new Set(['k1']))

    internals_.sessionDataStore.startFlushTimer()
    internals_.sessionDataStore.stopFlushTimer()

    // Timer should be null
    expect((internals_.sessionDataStore as unknown as { flushTimer: ReturnType<typeof setInterval> | null }).flushTimer).toBeNull()

    // Advance 10s — flush should NOT happen (timer stopped)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(internals_.sessionDataStore.getDirty().get('s1')?.size).toBe(1)

    vi.useRealTimers()
  })
})
