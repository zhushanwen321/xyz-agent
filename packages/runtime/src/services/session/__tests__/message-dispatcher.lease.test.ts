/**
 * MessageDispatcher P5 lease 测试（隐式 acquire + 定向 busy 拒绝 + 四释放路径）。
 *
 * 覆盖：
 * - TC1: busy 拒绝——B 收 reply sendToClient send.rejected，broadcastExcept session.busy，不调 prompt
 * - TC2: 无 owner acquire 成功 + prompt 调用
 * - TC3: sendPrompt 抛错 → leaseManager.release('send_failed')
 * - TC4: abort → leaseManager.release('aborted')
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/message-dispatcher.lease.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../message-dispatcher.js'
import type { ISessionServiceInternal } from '../session-internal.js'
import type { IManagedSessionView } from '../types.js'
import type { IMessageBroker } from '../../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { LeaseManager } from '../lease-manager.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1', cwd: '/test', label: 'test', modelId: 'm1', createdAt: 1, lastActiveAt: 1,
    tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, labelPersisted: false,
    ...overrides,
  }
}

function makeBroker() {
  const sent: Record<string, ServerMessage[]> = {}
  const broadcasts: ServerMessage[] = []
  return {
    broker: {
      send: vi.fn(),
      broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }),
      sendError: vi.fn(),
      sendToClient: vi.fn((clientId: string, m: ServerMessage) => {
        (sent[clientId] ??= []).push(m)
      }),
      broadcastExcept: vi.fn((_exclude: string, m: ServerMessage) => { broadcasts.push(m) }),
    } as unknown as IMessageBroker,
    sent,
    broadcasts,
  }
}

function makeMocks(opts: {
  session?: Partial<IManagedSessionView>
  promptError?: Error
  withLeaseManager?: boolean
  acquireResult?:
    | { kind: 'acquired'; expiresAt: number }
    | { kind: 'busy'; owner: string; expiresAt: number }
    | { kind: 'not_found' }
  ownerDeviceName?: string
} = {}) {
  const session = makeMockSession(opts.session ?? {})
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  const client = { prompt: promptFn, abort: vi.fn(async () => undefined) } as unknown as IPiEngine
  const { broker, sent, broadcasts } = makeBroker()
  const svc = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
  } as unknown as ISessionServiceInternal
  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, broker, workspace)

  // mock LeaseManager（acquire/release spy）
  const releaseSpy = vi.fn()
  const leaseManager = {
    acquire: vi.fn(() => opts.acquireResult ?? { kind: 'acquired' as const, expiresAt: 9999 }),
    renew: vi.fn(() => true),
    release: releaseSpy,
    sweepExpired: vi.fn(() => []),
    getBusySession: vi.fn(() => undefined),
  } as unknown as LeaseManager
  if (opts.withLeaseManager) dispatcher.setLeaseManager(leaseManager)
  // Major1：注入 deviceName 反查——模拟连接池按 clientId 返回 deviceName。
  // ownerDeviceName 选项控制 owner（lease.owner）的设备名；其余 clientId 返回 undefined（兜底 ''）。
  const ownerDevice = opts.ownerDeviceName
  dispatcher.setDeviceNameLookup((cid) => (cid === 'clientA' ? ownerDevice : undefined))

  return { dispatcher, session, promptFn, client, broker, sent, broadcasts, leaseManager, releaseSpy, svc }
}

describe('MessageDispatcher P5 lease（隐式 acquire + 定向 busy 拒绝 + 释放）', () => {
  beforeEach(() => vi.clearAllMocks())

  // TC1: busy 定向拒绝
  it('TC1: lease busy 时 sendToClient send.rejected 给发起方 + broadcast session.busy，不调 prompt', async () => {
    const { dispatcher, promptFn, sent, broadcasts, leaseManager, broker } = makeMocks({
      withLeaseManager: true,
      acquireResult: { kind: 'busy', owner: 'clientA', expiresAt: 5000 },
      ownerDeviceName: 'Mac',
    })

    const result = await dispatcher.sendMessage('s1', 'hello', 'clientB', 'Phone')

    expect(result).toEqual({ blocked: true, rejected: true })
    expect(leaseManager.acquire).toHaveBeenCalledWith('s1', 'clientB', 'Phone')
    // B 收 send.rejected（判别联合 busy 分支含 owner/device/expiresAt）
    expect(sent['clientB']).toHaveLength(1)
    expect(sent['clientB'][0]).toMatchObject({
      type: 'send.rejected',
      payload: { sessionId: 's1', reason: 'busy', busyOwnerId: 'clientA', leaseExpiresAt: 5000 },
    })
    // 广播 session.busy（走 broker.broadcast，入 ring buffer）
    expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'session.busy' }))
    // 未调 prompt
    expect(promptFn).not.toHaveBeenCalled()
    // Major2：session.busy 必须经 broker.broadcast（入 P2 桶），而非 broadcastExcept（不入桶）。
    expect(broker.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.busy' }))
    expect(broker.broadcastExcept).not.toHaveBeenCalled()
  })

  // TC1b（Major1）：send.rejected.busyOwnerDevice 必须是 owner(A='Mac') 的设备名，而非发起方(B='Phone')。
  it('TC1b: send.rejected.busyOwnerDevice 是 owner 的设备名（A=Mac），不是发起方（B=Phone）', async () => {
    const { dispatcher, sent } = makeMocks({
      withLeaseManager: true,
      acquireResult: { kind: 'busy', owner: 'clientA', expiresAt: 5000 },
      ownerDeviceName: 'Mac',
    })

    await dispatcher.sendMessage('s1', 'hello', 'clientB', 'Phone')

    expect(sent['clientB'][0]).toMatchObject({
      type: 'send.rejected',
      payload: { busyOwnerId: 'clientA', busyOwnerDevice: 'Mac' },
    })
    // 显式断言不是发起方 B 的设备名
    expect((sent['clientB'][0] as { payload: { busyOwnerDevice: string } }).payload.busyOwnerDevice).not.toBe('Phone')
  })

  // TC1c（Major1）：session.busy 广播的 deviceName 是 owner(A='Mac') 的设备名，不是发起方(B='Phone')。
  it('TC1c: session.busy 的 deviceName 是 owner 的设备名（A=Mac），不是发起方（B=Phone）', async () => {
    const { dispatcher, broadcasts } = makeMocks({
      withLeaseManager: true,
      acquireResult: { kind: 'busy', owner: 'clientA', expiresAt: 5000 },
      ownerDeviceName: 'Mac',
    })

    await dispatcher.sendMessage('s1', 'hello', 'clientB', 'Phone')

    const busyMsg = broadcasts.find((m) => m.type === 'session.busy')
    expect(busyMsg).toBeDefined()
    expect(busyMsg).toMatchObject({ payload: { clientId: 'clientA', deviceName: 'Mac' } })
    expect((busyMsg as { payload: { deviceName: string } }).payload.deviceName).not.toBe('Phone')
  })

  // TC1d（Major1）：deviceNameLookup 未注入时（owner 离线/旧调用）busyOwnerDevice 兜底 ''。
  it('TC1d: deviceNameLookup 未注入/owner 离线时 busyOwnerDevice 兜底空串', async () => {
    const { dispatcher, sent } = makeMocks({
      withLeaseManager: true,
      acquireResult: { kind: 'busy', owner: 'clientX', expiresAt: 5000 },
      // 不传 ownerDeviceName → lookup 对 clientX 返回 undefined → 兜底 ''
    })

    await dispatcher.sendMessage('s1', 'hello', 'clientB', 'Phone')

    expect(sent['clientB'][0]).toMatchObject({
      payload: { busyOwnerId: 'clientX', busyOwnerDevice: '' },
    })
  })

  // TC2: 无 owner acquire 成功
  it('TC2: lease acquired 时 prompt 被调，session.isGenerating 置 true', async () => {
    const { dispatcher, promptFn, session, leaseManager } = makeMocks({
      withLeaseManager: true,
      acquireResult: { kind: 'acquired', expiresAt: 9999 },
    })

    const result = await dispatcher.sendMessage('s1', 'hello', 'clientA', 'Mac')

    expect(result).toEqual({ blocked: false })
    expect(leaseManager.acquire).toHaveBeenCalledWith('s1', 'clientA', 'Mac')
    expect(promptFn).toHaveBeenCalledTimes(1)
    expect(session.isGenerating).toBe(true)
  })

  // TC3: sendPrompt 抛错 → release('send_failed')
  it('TC3: prompt 抛错时 leaseManager.release(send_failed) 被调', async () => {
    const { dispatcher, releaseSpy } = makeMocks({
      withLeaseManager: true,
      promptError: new Error('boom'),
    })

    const result = await dispatcher.sendMessage('s1', 'hello', 'clientA', 'Mac')

    expect(result).toEqual({ blocked: true })
    expect(releaseSpy).toHaveBeenCalledWith('s1', 'send_failed')
  })

  // TC4: abort → release('aborted')
  it('TC4: abort 成功时 leaseManager.release(aborted) 被调', async () => {
    const { dispatcher, releaseSpy } = makeMocks({ withLeaseManager: true })

    await dispatcher.abort('s1')

    expect(releaseSpy).toHaveBeenCalledWith('s1', 'aborted')
  })

  // TC6: lease acquire 返回 not_found（session 不存在，防御性拒绝）
  it('TC6: lease not_found 时 broadcast message.error + 不调 prompt + return blocked', async () => {
    const { dispatcher, promptFn, broadcasts, leaseManager } = makeMocks({
      withLeaseManager: true,
      acquireResult: { kind: 'not_found' },
    })

    const result = await dispatcher.sendMessage('s1', 'hello', 'clientA', 'Mac')

    expect(result).toEqual({ blocked: true, rejected: true })
    expect(leaseManager.acquire).toHaveBeenCalledWith('s1', 'clientA', 'Mac')
    // 广播 message.error（让前端对话流看到错误气泡）
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(true)
    // 未调 prompt（不向不存在的 session 发消息）
    expect(promptFn).not.toHaveBeenCalled()
  })

  // 向后兼容：无 leaseManager 走旧 isGenerating 预检
  it('TC5: 无 leaseManager 时降级走旧 isGenerating 预检（busy broadcast send.rejected）', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ session: { isGenerating: true } })

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result).toEqual({ blocked: true, rejected: true })
    expect(broadcasts.some((m) => m.type === 'send.rejected')).toBe(true)
    expect(promptFn).not.toHaveBeenCalled()
  })
})
