/**
 * Hook Serial Execution — TDD tests for BG1 Task 2
 *
 * Tests the serial await execution of hooks with block/transform support:
 *   PluginService.executeHooks
 *     → hookRegistry.get(hookType) → sorted by priority
 *     → serial invoke per handler: rpcServer.invoke(workerId, 'plugin.hooks.invoke', ...)
 *     → block detection (proceed === false)
 *     → content transform (modifiedData)
 *     → timeout/error → skip handler
 *
 * Key design:
 *   - Serial, not parallel (each handler sees transformed context)
 *   - Priority ordering: built-in (0) → trusted (100) → sandbox (200)
 *   - Blocked detection: proceed === false terminates chain
 *   - Transform passing: modifiedData replaces context.data
 *   - Timeout 5s per handler → skip (pass-through)
 *   - Worker crash → skip handler
 */

import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HookEntry, HookContext, HookResult } from '../src/services/plugin-service/plugin-types.js'

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** Access PluginService internals for test setup */
function internals(service: PluginService) {
  return service as unknown as {
    hookRegistry: Map<string, HookEntry[]>
    rpcServer: {
      invoke: ReturnType<typeof vi.fn>
      broadcast: ReturnType<typeof vi.fn>
    }
    host: {
      getWorkerHandle: ReturnType<typeof vi.fn>
    }
  }
}

function makeContext(data: unknown = {}): HookContext {
  return {
    pluginId: '',
    hookType: 'onBeforeSendMessage',
    data,
    timestamp: Date.now(),
  }
}

// ══════════════════════════════════════════════════════════════════
// executeHooks — serial await with block/transform
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks (BG1 T2)', () => {
  // ── TC-SH-01: No handlers → immediate { blocked: false } ──────
  it('TC-SH-01: no handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker())
    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-02: Single handler passes → { blocked: false } ──────
  it('TC-SH-02: single handler passes returns { blocked: false }', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      proceed: true,
    })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext({ text: 'hello' }))

    expect(result).toEqual({ blocked: false })
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({
        handlerId: 'h1',
        hookType: 'onBeforeSendMessage',
      }),
      5_000,
    )
  })

  // ── TC-SH-03: Single handler blocks → { blocked: true, blockedBy, reason } ──
  it('TC-SH-03: single handler blocks returns blocked result', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      proceed: false,
      reason: 'API key detected',
    })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-blocker')
    expect(result.reason).toBe('API key detected')
  })

  // ── TC-SH-04: Priority ordering — trusted before sandbox ──────
  it('TC-SH-04: handlers execute in priority order', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // Register out of order
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-sandbox', handlerId: 'h-sandbox', priority: 200 },
      { pluginId: 'p-trusted', handlerId: 'h-trusted', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn()
      .mockReturnValueOnce({ workerId: 'worker-trusted', postMessage: vi.fn() })
      .mockReturnValueOnce({ workerId: 'worker-sandbox', postMessage: vi.fn() })

    const invokeOrder: string[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_workerId: string, _method: string, params: Record<string, unknown>) => {
      invokeOrder.push(params.handlerId as string)
      return { proceed: true }
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(invokeOrder).toEqual(['h-trusted', 'h-sandbox'])
  })

  // ── TC-SH-05: Blocked stops chain — second handler never invoked ──
  it('TC-SH-05: blocked handler stops chain', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-first', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-second', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockResolvedValueOnce({ proceed: false, reason: 'Blocked' })
      .mockResolvedValueOnce({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1) // second never called
  })

  // ── TC-SH-06: Transform passes — modifiedData flows to next handler ──
  it('TC-SH-06: modifiedData flows to next handler', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-transformer', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-observer', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const capturedContexts: unknown[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_workerId: string, _method: string, params: Record<string, unknown>) => {
      capturedContexts.push(params.context)
      if (params.handlerId === 'h1') {
        return { proceed: true, modifiedData: 'MODIFIED' }
      }
      return { proceed: true }
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext('ORIGINAL'))

    // First handler gets original data
    expect((capturedContexts[0] as HookContext).data).toBe('ORIGINAL')
    // Second handler gets modified data
    expect((capturedContexts[1] as HookContext).data).toBe('MODIFIED')
  })

  // ── TC-SH-07: Worker timeout → handler skipped, chain continues ──
  it('TC-SH-07: timeout skips handler, chain continues', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-slow', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-fast', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result).toEqual({ blocked: false })
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(2)
  })

  // ── TC-SH-08: Worker crashed → handler skipped ──
  it('TC-SH-08: worker crashed skips handler, chain continues', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-crashed', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-alive', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn()
      .mockReturnValueOnce(undefined) // crashed worker
      .mockReturnValueOnce({ workerId: 'worker-2', postMessage: vi.fn() })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result).toEqual({ blocked: false })
    // Only second handler invoked
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-2',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h2' }),
      5_000,
    )
  })

  // ── TC-SH-09: Mixed — trusted transforms, sandbox blocks ──────
  it('TC-SH-09: mixed scenario — transform then block', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-trusted', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-sandbox', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockResolvedValueOnce({ proceed: true, modifiedData: 'TRANSFORMED' })
      .mockResolvedValueOnce({ proceed: false, reason: 'Sensitive data' })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-sandbox')
    expect(result.reason).toBe('Sensitive data')
  })

  // ── TC-SH-10: Generic error in invoke → handler skipped ──────
  it('TC-SH-10: generic invoke error skips handler', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-error', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockRejectedValue(new Error('Worker crashed'))

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    // Error → treated as pass-through
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-11: Block without reason → default reason includes pluginId ──
  it('TC-SH-11: block without reason uses default message', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // proceed=false without reason
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: false })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-blocker')
    expect(result.reason).toContain('p-blocker')
  })

  // ── TC-SH-12: Transform returns undefined modifiedData → no change ──
  it('TC-SH-12: undefined modifiedData does not change context', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
      { pluginId: 'p2', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const capturedContexts: unknown[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_w: string, _m: string, params: Record<string, unknown>) => {
      capturedContexts.push(params.context)
      return { proceed: true } // no modifiedData
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext('ORIGINAL'))

    // Second handler should still see ORIGINAL (not undefined)
    expect((capturedContexts[1] as HookContext).data).toBe('ORIGINAL')
  })
})
