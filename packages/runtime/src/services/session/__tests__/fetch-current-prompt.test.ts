/**
 * fetchCurrentSystemPrompt runtime 链路测试（session-trace design §3.1 失败路径 / D2）。
 *
 * 覆盖：
 * - 非活跃 session（无 pi 进程）→ throw code=session_not_active
 * - busy 预检（isGenerating/isCompacting）→ throw code=session_busy
 * - 成功路径：prompt 发 /__xyz_get_system_prompt__ → 轮询 get_entries(since=基线) 命中
 *   xyz:current-system-prompt custom entry → 返回 fullText/charCount/fetchedAt +
 *   traceLeafCache 基线滚动 + bus.publish session.traceEntryAppended（DATA 行留痕）
 * - 轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout
 * - WS handler：reply session.currentSystemPrompt（含 sessionId，规则 7）/ 错误 sendError code
 *
 * 运行：cd packages/runtime && npx vitest run fetch-current-prompt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionService } from '../session-service.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import { SessionMessageHandler } from '../../../transport/session-message-handler.js'
import type { IMessageBroker } from '../../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { ServerMessage } from '@xyz-agent/shared'

const SID = 'sid-fetch-prompt'

/** 现取命令产出的 custom entry（常驻扩展 handler 写入形态）。 */
function currentPromptEntry(fullText: string): { type: string; id: string; customType: string; data: Record<string, unknown> } {
  return {
    type: 'custom',
    id: 'csp1',
    customType: 'xyz:current-system-prompt',
    data: { fullText, charCount: fullText.length, fetchedAt: '2026-08-20T10:00:00.000Z' },
  }
}

function makeSessionStore(): ISessionStore {
  return {
    scanSessions: () => [],
    invalidateScanCache: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    persistAgentBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: () => [],
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    persistHandoffSidecar: () => {},
    trash: () => {},
  }
}

/**
 * 构造测试环境。getEntriesImpl 控制 get_entries(since) 的返回序列；
 * promptImpl 可选控制 /__xyz_get_system_prompt__ 命令行为（默认记录调用）。
 */
function makeEnv(opts: { active?: boolean; busy?: boolean } = {}) {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
  let sinceBaseline: string | undefined
  const promptCalls: string[] = []
  const client = {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => ({ thinkingLevel: 'low' })),
    getSessionStats: vi.fn(async () => ({})),
    getEntries: vi.fn(async (since?: string) => {
      if (since === undefined) {
        // 全量（建基线）：一个旧 entry，leafId=leaf0
        return { data: { entries: [{ type: 'message', id: 'e0', message: { role: 'user', content: 'q' } }], leafId: 'leaf0' } }
      }
      sinceBaseline = since
      // 增量（since=leaf0）：命中现取 entry，新 leafId=leaf1
      return { data: { entries: [currentPromptEntry('PROMPT-BODY')], leafId: 'leaf1' } }
    }),
    prompt: vi.fn(async (content: string) => {
      promptCalls.push(content)
      return {}
    }),
  }
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => (opts.active === false ? undefined : (client as unknown as IPiEngine))),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never,
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    makeSessionStore(),
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
    {} as never,
    bus,
  )
  svc.setMessageBus(bus)
  let busyReady: Promise<void> | undefined
  if (opts.busy) {
    // S3 写点归位：sessions Map 所有权迁 lifecycle（svc.sessions 直戳不再可用）——经
    // initializeManagedSession 委托真注册（构造订阅接线会真跑 registerReplicatedStates
    // 播种，mock client 已覆盖 getState/getCommands/getSessionStats），注册后置 busy 标记
    // （isGenerating=true → busy 预检拒绝）。busy 用例须 await busyReady 后再断言。
    busyReady = svc.initializeManagedSession(SID, client as unknown as IPiEngine, '/tmp', 't').then((session) => {
      session.isGenerating = true
    })
  }
  return { svc, bus, publishSpy, broadcasts, client, pm, promptCalls, sinceBaselineRef: () => sinceBaseline, busyReady }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchCurrentSystemPrompt（常驻扩展现取通道）', () => {
  it('非活跃 session（无 pi 进程）→ throw code=session_not_active', async () => {
    const { svc } = makeEnv({ active: false })
    await expect(svc.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_not_active' })
  })

  it('busy 预检：isGenerating → throw code=session_busy（命令会排队，预检拒绝更诚实）', async () => {
    const { svc, busyReady } = makeEnv({ busy: true })
    await busyReady
    await expect(svc.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_busy' })
  })

  it('成功路径：发命令 → 轮询 since 命中 custom entry → 返回值 + 基线滚动 + 台账增量广播', async () => {
    const { svc, client, publishSpy, promptCalls, sinceBaselineRef } = makeEnv({ active: true })
    const result = await svc.fetchCurrentSystemPrompt(SID)
    // 命令发出（双下划线内部命令，不经 LLM）
    expect(promptCalls).toEqual(['/__xyz_get_system_prompt__'])
    // 增量轮询以全量建的基线为 since
    expect(sinceBaselineRef()).toBe('leaf0')
    // 返回值 = entry data 提取
    expect(result).toEqual({
      sessionId: SID,
      fullText: 'PROMPT-BODY',
      charCount: 11,
      fetchedAt: '2026-08-20T10:00:00.000Z',
    })
    // 台账增量：traceEntryAppended 广播（含 sessionId，规则 7）带现取 entry
    const push = publishSpy.mock.calls.find(([, m]) => (m as ServerMessage).type === 'session.traceEntryAppended')
    expect(push).toBeDefined()
    const payload = (push?.[1] as { payload: { sessionId: string; entries: unknown[]; leafId: string | null } }).payload
    expect(payload.sessionId).toBe(SID)
    expect(payload.leafId).toBe('leaf1')
    expect((payload.entries[0] as { customType?: string }).customType).toBe('xyz:current-system-prompt')
    // 基线滚动：后续 trace 增量从 leaf1 起（第二次 since）
    expect(client.getEntries).toHaveBeenCalledWith('leaf0')
  })

  it('轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout', async () => {
    vi.useFakeTimers()
    const { svc, client } = makeEnv({ active: true })
    // 增量恒空（命令未产出）
    client.getEntries.mockImplementation(async (since?: string) =>
      since === undefined
        ? { data: { entries: [], leafId: 'leaf0' } }
        : { data: { entries: [], leafId: 'leaf0' } })
    const pending = svc.fetchCurrentSystemPrompt(SID)
    // 先 attach rejection 断言再推进 timer（否则 rejection 发生时无 handler，报 unhandled）
    const expectation = expect(pending).rejects.toMatchObject({ code: 'fetch_current_prompt_timeout' })
    await vi.advanceTimersByTimeAsync(8500)
    await expectation
  })
})

describe('session.fetchCurrentSystemPrompt WS handler', () => {
  it('reply session.currentSystemPrompt（含 sessionId）；非活跃 → sendError code=session_not_active', async () => {
    const { svc } = makeEnv({ active: true })
    const replies: { type: string; payload: Record<string, unknown> }[] = []
    const errors: { code: string }[] = []
    const handler = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, _id: string | undefined, type: string, payload: Record<string, unknown>) => {
        replies.push({ type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string) => {
        errors.push({ code })
      }),
      sessionService: svc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    const WS = { readyState: 1, send: vi.fn() } as never

    await handler.handleSessionMessage({ type: 'session.fetchCurrentSystemPrompt', id: 'm1', payload: { sessionId: SID } } as never, WS)
    expect(replies[0]?.type).toBe('session.currentSystemPrompt')
    expect(replies[0]?.payload.sessionId).toBe(SID)
    expect(replies[0]?.payload.fullText).toBe('PROMPT-BODY')

    const { svc: deadSvc } = makeEnv({ active: false })
    const handler2 = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn(),
      sendError: vi.fn((_ws: unknown, code: string) => {
        errors.push({ code })
      }),
      sessionService: deadSvc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    await handler2.handleSessionMessage({ type: 'session.fetchCurrentSystemPrompt', id: 'm2', payload: { sessionId: SID } } as never, WS)
    expect(errors.map((e) => e.code)).toContain('session_not_active')
  })
})
