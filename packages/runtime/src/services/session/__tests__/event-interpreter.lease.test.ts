/**
 * event-interpreter + session-service P5 lease 续租/释放测试。
 *
 * 覆盖：
 * - TC5: event-interpreter pingTick 成功时 onLeaseRenew 被调；失败时不调
 * - TC6: session-service handleTurnEndSideEffects 调 leaseManager.release('turn_end')
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/event-interpreter.lease.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventInterpreter, PING_INTERVAL_MS } from '../event-interpreter.js'
import type { LeaseManager } from '../lease-manager.js'

describe('event-interpreter P5 lease 续租（pingTick onLeaseRenew）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('TC5a: pingTick 成功时 onLeaseRenew 被调含 sessionId', async () => {
    const onLeaseRenew = vi.fn()
    const interpreter = new EventInterpreter('s-renew', {
      send: vi.fn(),
      pingPi: vi.fn(async () => ({ ok: true })),
      onLeaseRenew,
    })
    // turn-start 启动 ping loop
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(onLeaseRenew).toHaveBeenCalledWith('s-renew')
    expect(onLeaseRenew).toHaveBeenCalledTimes(1)
  })

  it('TC5b: pingTick 失败时 onLeaseRenew 不被调', async () => {
    const onLeaseRenew = vi.fn()
    const interpreter = new EventInterpreter('s-renew2', {
      send: vi.fn(),
      pingPi: vi.fn(async () => { throw new Error('pi dead') }),
      onLeaseRenew,
    })
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(onLeaseRenew).not.toHaveBeenCalled()
  })

  it('TC5c: 未注入 onLeaseRenew 时 pingTick 成功不抛错（可选回调）', async () => {
    const interpreter = new EventInterpreter('s-renew3', {
      send: vi.fn(),
      pingPi: vi.fn(async () => ({ ok: true })),
    })
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    // 未注入 onLeaseRenew 时 pingTick 成功路径不应抛错（可选回调安全调用）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(true).toBe(true) // 到此即证明未抛错
  })
})

describe('session-service P5 lease turn-end 释放', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('TC6: handleTurnEndSideEffects 注入 leaseManager 时调 release(turn_end)', async () => {
    const { SessionService } = await import('../session-service.js')
    const { ServerMessageBroker } = await import('../../../transport/message-broker.js')

    // 最小化 mock 依赖（沿用 decouple/shutdown 测试的 mock 范式）
    const client = { onEvent: () => () => {}, getState: vi.fn(), prompt: vi.fn(), abort: vi.fn(), steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(), getHistory: vi.fn(), getCommands: vi.fn().mockResolvedValue([]), getSessionStats: vi.fn().mockResolvedValue(undefined), switchSession: vi.fn(), sendExtensionUiResponse: vi.fn(), sendRaw: vi.fn() } as never
    const pm = {
      createSession: vi.fn(async () => client),
      getClient: vi.fn(() => client),
      hasClient: vi.fn(() => true),
      getSessionIdByClient: vi.fn(() => 's-turn'),
      onSessionExit: vi.fn(),
      destroyAll: vi.fn(async () => {}),
      destroySession: vi.fn(),
      rekey: vi.fn(),
      getPiVersion: vi.fn(() => '0.0.0'),
    } as never
    const broadcasts: unknown[] = []
    const broker = new ServerMessageBroker({ clients: new Map() }, {
      sessionService: { listPersistedSessions: () => [] } as never,
      configService: {} as never, modelService: { aggregateModels: () => [] } as never,
      pluginService: undefined, extensionService: undefined,
      extensionTimeoutMgr: { getAllPendingRequests: () => [] } as never,
      projectRoot: '/mock', appInfo: { appVersion: '0', piVersion: '0' },
    })
    // 监听 broadcast
    vi.spyOn(broker, 'broadcast').mockImplementation((m: unknown) => { broadcasts.push(m) })

    const service = new SessionService(
      pm, broker, () => ({ attach: () => {}, detach: vi.fn() } as never), '/mock',
      {} as never, { getSkillPaths: () => [], getDefaultModel: () => null } as never,
      { scanSessions: () => [], extractSessionOutcome: () => undefined, persistSessionEnd: vi.fn() } as never,
      { readGitInfo: () => undefined } as never,
      { record: vi.fn() } as never,
    )
    await service.initializeManagedSession('s-turn', client, '/mock', 'turn')

    // mock leaseManager + 注入
    const releaseSpy = vi.fn()
    const leaseManager = { acquire: vi.fn(), renew: vi.fn(), release: releaseSpy, sweepExpired: vi.fn(), getBusySession: vi.fn() } as unknown as LeaseManager
    service.setLeaseManager(leaseManager)

    service.handleTurnEndSideEffects('s-turn', 'end')

    expect(releaseSpy).toHaveBeenCalledWith('s-turn', 'turn_end')
  })

  it('TC6b: 未注入 leaseManager 时 handleTurnEndSideEffects 不抛错（向后兼容）', async () => {
    const { SessionService } = await import('../session-service.js')
    const { ServerMessageBroker } = await import('../../../transport/message-broker.js')
    const client = { onEvent: () => () => {}, getState: vi.fn(), prompt: vi.fn(), abort: vi.fn(), steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(), getHistory: vi.fn(), getCommands: vi.fn().mockResolvedValue([]), getSessionStats: vi.fn().mockResolvedValue(undefined), switchSession: vi.fn(), sendExtensionUiResponse: vi.fn(), sendRaw: vi.fn() } as never
    const pm = { createSession: vi.fn(async () => client), getClient: vi.fn(() => client), hasClient: vi.fn(() => true), getSessionIdByClient: vi.fn(() => 's2'), onSessionExit: vi.fn(), destroyAll: vi.fn(async () => {}), destroySession: vi.fn(), rekey: vi.fn(), getPiVersion: vi.fn(() => '0.0.0') } as never
    const broker = new ServerMessageBroker({ clients: new Map() }, {
      sessionService: { listPersistedSessions: () => [] } as never, configService: {} as never,
      modelService: { aggregateModels: () => [] } as never, pluginService: undefined, extensionService: undefined,
      extensionTimeoutMgr: { getAllPendingRequests: () => [] } as never, projectRoot: '/mock', appInfo: { appVersion: '0', piVersion: '0' },
    })
    vi.spyOn(broker, 'broadcast').mockImplementation(() => {})
    const service = new SessionService(
      pm, broker, () => ({ attach: () => {}, detach: vi.fn() } as never), '/mock',
      {} as never, { getSkillPaths: () => [], getDefaultModel: () => null } as never,
      { scanSessions: () => [], extractSessionOutcome: () => undefined, persistSessionEnd: vi.fn() } as never,
      { readGitInfo: () => undefined } as never, { record: vi.fn() } as never,
    )
    await service.initializeManagedSession('s2', client, '/mock', 'turn2')

    expect(() => service.handleTurnEndSideEffects('s2', 'end')).not.toThrow()
  })
})
