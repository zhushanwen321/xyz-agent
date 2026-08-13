/**
 * MessageDispatcher + MessageBus 双写集成测试。
 *
 * 锁定 dispatcher 内所有 19 处 broker.broadcast 后同步调
 * messageBus?.publish(sessionId, msg) 的行为——确保 session 级事件
 * （message.error / send.rejected / message.bashStart / message.bashResult /
 * message.complete / session.compacting / session.compacted / message.compactionSummary）
 * 进入 bus ring buffer。
 *
 * 覆盖：
 * - sendMessage error path → bus.publish(message.error)
 * - sendMessage busy → bus.publish(send.rejected)
 * - hook blocked → bus.publish(message.error)
 * - hook error → bus.publish(message.error)
 * - abort failure → bus.publish(message.error)
 * - abort success → bus.publish(message.complete)
 * - sendBash ensureActive fail → bus.publish(message.error)
 * - sendBash busy → bus.publish(send.rejected)
 * - sendBash start → bus.publish(message.bashStart)
 * - sendBash success → bus.publish(message.bashResult)
 * - sendBash error → bus.publish(message.bashResult + message.error)
 * - abortBash cancelled → bus.publish(message.bashResult{cancelled:true})
 * - compact（M4 事件驱动）→ 零 compaction 广播（busy/start/fail/summary/success 各路径，生命周期归 interpreter）
 * - messageBus undefined → no crash（null-safety）
 *
 * mock 策略：全部依赖 mock，不 spawn pi。
 *
 * 运行：npx vitest run test/dispatcher-bus.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    labelPersisted: false,
    ...overrides,
  }
}

function makeMocks(opts: {
  isGenerating?: boolean
  isCompacting?: boolean
  isBashRunning?: boolean
  promptError?: Error
  session?: IManagedSessionView
  messageBus?: { publish: ReturnType<typeof vi.fn> }
} = {}) {
  const session = opts.session ?? makeMockSession({
    isGenerating: opts.isGenerating ?? false,
    isCompacting: opts.isCompacting ?? false,
    isBashRunning: opts.isBashRunning ?? false,
  })
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  const bashFn = vi.fn(async () => ({ output: 'ok', exitCode: 0, cancelled: false, truncated: false }))
  const abortFn = vi.fn(async () => {})
  const abortBashFn = vi.fn(async () => {})
  const steerFn = vi.fn(async () => {})
  const followUpFn = vi.fn(async () => {})
  const compactFn = vi.fn(async () => ({ summary: 'compacted summary', tokensBefore: 100, estimatedTokensAfter: 50 }))
  const client = {
    prompt: promptFn,
    bash: bashFn,
    abort: abortFn,
    abortBash: abortBashFn,
    steer: steerFn,
    followUp: followUpFn,
    compact: compactFn,
  } as unknown as IPiEngine

  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  const svc = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    applyContextUpdate: vi.fn(),
  } as unknown as ISessionServiceInternal

  const pm = {
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const messageBus = opts.messageBus ?? { publish: vi.fn() }

  const dispatcher = new MessageDispatcher(svc, pm, broker, workspace, messageBus as any)
  return { dispatcher, session, promptFn, bashFn, abortFn, abortBashFn, compactFn, broadcasts, broker, svc, pm, messageBus }
}

describe('message-dispatcher bus integration', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── sendMessage paths ──

  it('sendMessage error path → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('pi crashed'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
    const msg = messageBus.publish.mock.calls[0][1]
    expect(msg.payload.message).toContain('pi crashed')
  })

  it('sendMessage busy → bus.publish(send.rejected)', async () => {
    const { dispatcher, messageBus } = makeMocks({ isGenerating: true })
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'send.rejected' }))
  })

  it('hook blocked → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks()
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: 'blocked by hook' }),
    }))
  })

  it('hook error → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks()
    dispatcher.setSendMessageHook(vi.fn().mockRejectedValue(new Error('hook exploded')))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('hook exploded') }),
    }))
  })

  // ── abort paths ──

  it('abort failure → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus, abortFn } = makeMocks()
    abortFn.mockRejectedValue(new Error('abort timeout'))
    await dispatcher.abort('s1')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('abort timeout') }),
    }))
  })

  it('abort success → bus.publish(message.complete{stopReason:aborted})', async () => {
    const { dispatcher, messageBus } = makeMocks()
    await dispatcher.abort('s1')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.complete',
      payload: expect.objectContaining({ sessionId: 's1', stopReason: 'aborted' }),
    }))
  })

  // ── sendBash paths ──

  it('sendBash ensureActive fail → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus, svc } = makeMocks()
    svc.ensureActive = vi.fn(async () => { throw new Error('restore failed') })
    await expect(dispatcher.sendBash('s1', 'ls')).rejects.toThrow('restore failed')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
  })

  it('sendBash busy → bus.publish(send.rejected)', async () => {
    const { dispatcher, messageBus } = makeMocks({ isBashRunning: true })
    const result = await dispatcher.sendBash('s1', 'ls')
    expect(result.blocked).toBe(true)
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'send.rejected' }))
  })

  it('sendBash start → bus.publish(message.bashStart)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    // bashStart should be published
    const bashStartCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashStart',
    )
    expect(bashStartCall).toBeDefined()
    expect(bashStartCall![1].payload.command).toBe('ls')
  })

  it('sendBash success → bus.publish(message.bashResult)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    const bashResultCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashResult',
    )
    expect(bashResultCall).toBeDefined()
    expect(bashResultCall![1].payload.output).toBe('file.txt')
    expect(bashResultCall![1].payload.exitCode).toBe(0)
  })

  it('sendBash error → bus.publish(message.bashResult + message.error)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockRejectedValue(new Error('bash failed'))
    const result = await dispatcher.sendBash('s1', 'bad-cmd')
    expect(result.blocked).toBe(true)
    // Should have both bashResult and message.error
    const types = messageBus.publish.mock.calls.map((c: any[]) => c[1].type)
    expect(types).toContain('message.bashResult')
    expect(types).toContain('message.error')
  })

  // ── abortBash path ──

  it('abortBash cancelled → bus.publish(message.bashResult{cancelled:true})', async () => {
    const session = makeMockSession({ isBashRunning: true, bashRunToken: 'bash_123_abc' })
    const { dispatcher, messageBus } = makeMocks({ session })
    await dispatcher.abortBash('s1')
    const bashResultCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashResult',
    )
    expect(bashResultCall).toBeDefined()
    expect(bashResultCall![1].payload.cancelled).toBe(true)
  })

  // ── compact paths ──

  it('compact busy reject → 零 compaction 广播（M4：错误归 interpreter）', async () => {
    const { dispatcher, messageBus } = makeMocks({ isGenerating: true })
    await expect(dispatcher.compact('s1')).rejects.toThrow()
    // 零 compaction bus.publish（dispatcher 退化为预检+RPC+复位，生命周期由 interpreter 唯一编排）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact start → 零 compaction 广播（compacting 由 interpreter 从 compaction_start 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: '', tokensBefore: 0, estimatedTokensAfter: 0 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact fail → 零 compaction 广播（失败提示归 interpreter 的 compaction_end{errorMessage}）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockRejectedValue(new Error('compact exploded'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('compact exploded')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact summary → 零 compaction 广播（compactionSummary 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: 'Did stuff', tokensBefore: 200, estimatedTokensAfter: 100 })
    await dispatcher.compact('s1')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact success → 零 compaction 广播（compacted 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  // ── null safety ──

  it('messageBus undefined → no crash on sendMessage', async () => {
    const session = makeMockSession()
    const promptFn = vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
    const client = { prompt: promptFn } as unknown as IPiEngine
    const broadcasts: ServerMessage[] = []
    const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
    const svc = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
    } as unknown as ISessionServiceInternal
    const pm = {} as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, broker, workspace)
    // Should not throw
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(false)
  })

  it('messageBus undefined → no crash on abort', async () => {
    const session = makeMockSession()
    const client = { abort: vi.fn(async () => {}) } as unknown as IPiEngine
    const broadcasts: ServerMessage[] = []
    const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
    const svc = {
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
    } as unknown as ISessionServiceInternal
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, broker, workspace)
    await dispatcher.abort('s1')
    // Should broadcast but not throw
    expect(broker.broadcast).toHaveBeenCalled()
  })

  it('messageBus undefined → no crash on compact（零广播，null-safety）', async () => {
    const session = makeMockSession()
    const compactFn = vi.fn(async () => ({ summary: 'done', tokensBefore: 100, estimatedTokensAfter: 50 }))
    const client = { compact: compactFn } as unknown as IPiEngine
    const broadcasts: ServerMessage[] = []
    const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
    const svc = {
      getSessionByClient: vi.fn(() => session),
    } as unknown as ISessionServiceInternal
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, broker, workspace)
    await dispatcher.compact('s1')
    // M4：零 compaction 广播（no crash + 无 compaction 消息）
    expect(broadcasts.some(m => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes(m.type))).toBe(false)
  })

  // ── msg object identity: bus.publish receives same object as broker.broadcast ──

  it('bus.publish receives the same msg object reference as broker.broadcast', async () => {
    const { dispatcher, broker, messageBus } = makeMocks({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    const broadcastMsg = (broker.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const publishMsg = messageBus.publish.mock.calls[0][1]
    // Same object reference — bus.publish mutates seq on the shared object
    expect(broadcastMsg).toBe(publishMsg)
  })

  // ── sessionId passes through correctly ──

  it('bus.publish receives correct sessionId from sendMessage', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('my-session-123', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('my-session-123', expect.any(Object))
  })
})
