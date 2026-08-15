/**
 * SessionService × MessageBus 集成测试（wave:perf-w07，D1-1 接 bus 第一批的 session 侧）。
 *
 * 锁定两条新增 publish 语义：
 * - context.update（applyContextUpdate turn-end 路径）：state topic——分配 seq 写 stateSnapshot
 *   （'context' typeKey 同 key 覆盖）、不入 ring；重连订阅从 state 快照恢复。
 * - session.exited（onSessionExit 进程退出路径）：stream topic——带 seq，且 publish 必须发生在
 *   removeSessionEntry（内部 bus.clearSession 清订阅者集合）之前，否则订阅 renderer 收不到。
 *
 * 双写过渡态（W09 收口）：两处均保留 broker.broadcast——publish 先 mutate msg.seq、broadcast
 * 同对象后发，已订阅 renderer 靠 seq-gap drop 第二条。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-w07-bus.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'

/** mock ws（BusClient 契约：readyState + send），收集收到的原始 payload。 */
function createMockWs() {
  const sent: string[] = []
  return {
    readyState: 1 as const,
    sent,
    send: (payload: string) => { sent.push(payload) },
  }
}

function parseSent(ws: { sent: string[] }): ServerMessage[] {
  return ws.sent.map((s) => JSON.parse(s) as ServerMessage)
}

/** 从消息列表找指定 type。 */
function findMsg(msgs: ServerMessage[], type: string): ServerMessage | undefined {
  return msgs.find((m) => m.type === type)
}

/**
 * 构造真实 SessionService + 真实 MessageBus 的集成环境。
 * pm.onSessionExit 捕获 handler 供测试显式触发（模拟 pi 进程异常退出）。
 */
function makeEnv() {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  let exitHandler: ((sessionId: string, code: number | null, stderr: string) => void) | null = null
  const client = {
    getCommands: vi.fn(async () => []),
  } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn((h: (sessionId: string, code: number | null, stderr: string) => void) => {
      exitHandler = h
    }),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：initializeManagedSession / 被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore：fallbackModelId 需 'provider/model' 形状，resolveContextWindow 才会经 resolver
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn() } as never, // gitInfoReader：listPersistedSessions → pruneGitCache 用
    {} as never, // workspaceService：SessionLifecycle 构造存引用，被测路径未触发
    bus,
  )
  // 对齐组合根（index.ts）：构造参数的 bus 只喂给 dispatcher，SessionService 自身的
  // this.messageBus 靠 setMessageBus setter 注入（applyContextUpdate / onSessionExit 的 publish 用）。
  svc.setMessageBus(bus)
  // contextWindow resolver：computeUsage 算 usagePercent 用（128k 窗口）
  svc.setModelContextWindowResolver(() => 128000)

  return {
    svc, bus, broadcasts,
    triggerExit: (sid: string, code: number | null, stderr: string) => {
      if (!exitHandler) throw new Error('onSessionExit handler not registered')
      exitHandler(sid, code, stderr)
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionService × MessageBus（wave:perf-w07）', () => {
  it('W07-3: applyContextUpdate publish context.update（state）——重连订阅从 state 快照恢复，不入 ring', async () => {
    const { svc, bus, broadcasts } = makeEnv()
    await svc.initializeManagedSession('s-ctx', {} as unknown as IPiEngine, '/tmp', 'test')

    const online = createMockWs()
    bus.subscribe('s-ctx', online)

    svc.applyContextUpdate('s-ctx', 5000, 10000)

    // 在线订阅者收到带 seq 的 context.update
    const ctxMsg = findMsg(parseSent(online), 'context.update')
    expect(ctxMsg).toBeDefined()
    expect(typeof ctxMsg!.seq).toBe('number')
    expect(ctxMsg!.payload).toMatchObject({
      sessionId: 's-ctx',
      usagePercent: 4, // round(5000 / 128000 * 100)
      inputTokens: 5000,
      contextLimit: 128000,
    })

    // 重连订阅者：stateSnapshot 含 context.update（state 快照恢复），ring 不含（state 不入 ring）
    const late = bus.subscribe('s-ctx', createMockWs())
    const ctxFromSnapshot = findMsg(late.stateSnapshot, 'context.update')
    expect(ctxFromSnapshot).toBeDefined()
    expect(ctxFromSnapshot!.payload).toMatchObject({ inputTokens: 5000, usagePercent: 4 })
    expect(findMsg(late.snapshot, 'context.update')).toBeUndefined()

    // 双写过渡态：broker.broadcast 也收到同一条（同对象，seq 已被 publish 写入）
    const brokerCtx = findMsg(broadcasts, 'context.update')
    expect(brokerCtx).toBeDefined()
    expect(brokerCtx!.seq).toBe(ctxMsg!.seq)
  })

  it('W07-4: onSessionExit publish session.exited（stream）——订阅者在 bus.clearSession 之前收到', async () => {
    const { svc, bus, broadcasts, triggerExit } = makeEnv()
    await svc.initializeManagedSession('s-exit', {} as unknown as IPiEngine, '/tmp', 'test')

    const online = createMockWs()
    bus.subscribe('s-exit', online)

    triggerExit('s-exit', 1, 'boom stderr tail')

    // 订阅者收到带 seq 的 session.exited（publish 在 removeSessionEntry/clearSession 之前，
    // 若顺序错误 subscribers 已被清空，这里一条也收不到）
    const exited = findMsg(parseSent(online), 'session.exited')
    expect(exited).toBeDefined()
    expect(typeof exited!.seq).toBe('number')
    expect(exited!.payload).toMatchObject({ sessionId: 's-exit', code: 1 })
    expect((exited!.payload as { reason: string }).reason).toContain('boom stderr tail')

    // 双写过渡态：broker.broadcast 也收到 config.sessions + session.exited
    expect(findMsg(broadcasts, 'session.exited')).toBeDefined()
    expect(findMsg(broadcasts, 'config.sessions')).toBeDefined()

    // 退出后 bus 分区已清（clearSession）：新订阅拿到空 ring，无泄漏
    const late = bus.subscribe('s-exit', createMockWs())
    expect(late.snapshot).toHaveLength(0)
    expect(late.stateSnapshot).toHaveLength(0)
  })
})
