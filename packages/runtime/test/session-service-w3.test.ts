/**
 * W3 TDD tests：SessionService 副作用迁移（U7 + E2）。
 *
 * 背景：attachUsageListener（第二条 pi 事件订阅）承载 3 个副作用，W3 迁移到中间事件链路：
 *   1. isGenerating 复位（agent_end）—— handleTurnEndSideEffects
 *   2. tryPersistLabel（turn_end 主路径 + agent_end 兜底）—— handleTurnUsageSideEffects / handleTurnEndSideEffects
 *   3. tokenCount 写入（turn_end + agent_end）—— applyContextUpdate 接收 totalTokens
 *
 * U7：副作用经中间事件链路保留（不走 attachUsageListener）
 *   - onTurnFinalize→handleTurnEndSideEffects：isGenerating=false + tryPersistLabel 被调
 *   - onContextUpdate 含 totalTokens→applyContextUpdate：tokenCount 写入
 * E2：完整 pi 事件流集成（message_start→...→turn_end→agent_end），断言终态
 *   isGenerating===false + tokenCount>0 + inputTokens>0
 *
 * Mock 边界与 session-service.test.ts 一致（pm/broker/extensionService 注入 mock，existsSync 真实）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { MockInstance } from 'vitest'

// ── vi.hoisted：在 vi.mock 工厂执行前就绪的 mock 句柄 ───────────────
const mocks = vi.hoisted(() => ({
  mockScannedSessions: [] as Array<{
    id: string; filePath: string; cwd: string; name: string | null
    lastModified: number; timestamp: string; size: number
  }>,
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  persistSessionNameMock: vi.fn(),
}))

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => mocks.mockScannedSessions,
    persistSessionName: mocks.persistSessionNameMock,
    patchSessionCwd: vi.fn(() => true),
  }
})
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: vi.fn(),
    getDefaultModel: () => mocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/xyz-agent/pi/agent' }
})
vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: vi.fn((raw: unknown) => raw) }))
vi.mock('../src/services/session-history.js', () => ({ getHistoryFromFile: vi.fn().mockResolvedValue([]) }))

// ── Mock 之后再 import 被测对象 ─────────────────────────────────────
import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

type SendCommandFn = (type: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>

interface MockClient {
  prompt: MockInstance<(content: string) => Promise<unknown>>
  abort: MockInstance<() => Promise<unknown>>
  steer: MockInstance<(content: string) => Promise<unknown>>
  followUp: MockInstance<(content: string) => Promise<unknown>>
  setModel: MockInstance<(provider: string, modelId: string) => Promise<unknown>>
  setThinkingLevel: MockInstance<(level: string) => Promise<unknown>>
  compact: MockInstance<() => Promise<unknown>>
  clear: MockInstance<() => Promise<unknown>>
  getHistory: MockInstance<() => Promise<unknown>>
  sendCommand: MockInstance<SendCommandFn>
  /** 切换 pi session 文件（W2 收口：替代 sendCommand('switch_session')）。 */
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  /** 查询 pi get_state（W2 收口：替代 readPiState/sendCommand('get_state')）。 */
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  getCommands: MockInstance<() => Promise<unknown>>
  getSessionStats: MockInstance<() => Promise<unknown>>
  onEvent: MockInstance<(listener: PiEventListener) => () => void>
  onExit: MockInstance<(callback: (code: number | null) => void) => void>
  kill: MockInstance<() => Promise<void>>
  start: MockInstance<() => Promise<void>>
  eventListeners: PiEventListener[]
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  const eventListeners: PiEventListener[] = []
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: {} }),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
    getCommands: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn<(listener: PiEventListener) => () => void>((listener) => {
      eventListeners.push(listener)
      return () => {}
    }),
    onExit: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    eventListeners,
    ...overrides,
  }
}

let autoId = 0

function createSetup() {
  const clientMap = new Map<string, MockClient>()
  let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

  const pm: IProcessManager = {
    createSession: vi.fn(async () => {
      const piSid = `pi-auto-${++autoId}`
      const client = makeMockClient({
        // W2 收口后 create 用 client.getState()（返回归一后的 state 对象）
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
          sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
        }),
      })
      clientMap.set(piSid, client)
      return client
    }),
    destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn((client: MockClient) => {
      for (const [k, v] of clientMap) if (v === client) return k
      return undefined
    }),
    hasClient: vi.fn((id: string) => clientMap.has(id)),
    rekey: vi.fn(),
    onSessionExit: vi.fn((cb) => { exitCb = cb }),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
  } as unknown as IProcessManager

  const broker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  const extensionService: IExtensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (_sid: string, _send: unknown): IEventAdapter => ({
    attach: vi.fn(),
    detach: vi.fn(),
  })

  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }

  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }

  const service = new SessionService(
    pm, broker, adapterFactory, '/tmp', extensionService,
    new PiConfigStore(), new PiSessionStore(), gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
  )

  const seedSession = async (opts: { label?: string; sessionFile?: string } = {}) => {
    const piSid = `pi-seed-${++autoId}`
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()（返回归一后的 state 对象）
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: opts.sessionFile ?? `/fake/${piSid}.jsonl`,
      }),
    })
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)
    await service.create(tmpdir(), opts.label ?? 'seed')
    return { id: piSid, client }
  }

  return {
    service, pm, broker, clientMap,
    seedSession,
    triggerExit: (sid: string, code: number | null, stderr = '') => exitCb?.(sid, code, stderr),
  }
}

interface Setup {
  service: SessionService
  pm: IProcessManager
  broker: IMessageBroker
  clientMap: Map<string, MockClient>
  seedSession: (opts?: { label?: string; sessionFile?: string }) => Promise<{ id: string; client: MockClient }>
  triggerExit: (sid: string, code: number | null, stderr?: string) => void
}

function resetMockState(): void {
  mocks.mockScannedSessions.length = 0
  mocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
  mocks.persistSessionNameMock.mockClear()
}

describe('SessionService · W3 副作用迁移（U7）', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  // ── handleTurnUsageSideEffects（turn_end 主路径：tryPersistLabel）──
  describe('handleTurnUsageSideEffects（turn_end → tryPersistLabel 主路径）', () => {
    it('session 文件已存在时调 tryPersistLabel（首 turn 即持久化）', async () => {
      // 用真实临时文件让 existsSync 返回 true
      const dir = mkdtempSync(join(tmpdir(), 'w3-tu-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        const { id } = await setup.seedSession({ label: 'my-label', sessionFile: filePath })

        setup.service.handleTurnUsageSideEffects(id)

        // tryPersistLabel 经 persistSessionName 调用（label 已持久化到 session_info 行）
        expect(mocks.persistSessionNameMock).toHaveBeenCalledTimes(1)
        expect(mocks.persistSessionNameMock).toHaveBeenCalledWith(filePath, 'my-label', id, expect.any(String))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('文件尚不存在时跳过 tryPersistLabel（existsSync guard，不重置 labelPersisted）', async () => {
      const { id } = await setup.seedSession({ sessionFile: '/nonexistent/path/s.jsonl' })

      setup.service.handleTurnUsageSideEffects(id)

      // 文件不存在，不调 persistSessionName（规则 #6：禁止在 pi flush 前创建文件）
      expect(mocks.persistSessionNameMock).not.toHaveBeenCalled()
    })

    it('labelPersisted=true 时不再重复持久化（幂等）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'w3-tu-idem-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        const { id } = await setup.seedSession({ label: 'lbl', sessionFile: filePath })

        setup.service.handleTurnUsageSideEffects(id)
        setup.service.handleTurnUsageSideEffects(id)

        // 第二次因 labelPersisted=true 被短路，只调一次
        expect(mocks.persistSessionNameMock).toHaveBeenCalledTimes(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('未知 session 不抛错（静默 no-op）', () => {
      expect(() => setup.service.handleTurnUsageSideEffects('ghost')).not.toThrow()
      expect(mocks.persistSessionNameMock).not.toHaveBeenCalled()
    })
  })

  // ── handleTurnEndSideEffects（agent_end：isGenerating=false + tryPersistLabel 兜底）──
  describe('handleTurnEndSideEffects（agent_end → isGenerating 复位 + tryPersistLabel 兜底）', () => {
    it('复位 isGenerating=false（不迁移则 session 永远 busy，下条消息被拒）', async () => {
      const { id } = await setup.seedSession()
      // 先标记为生成中（模拟 sendPrompt 后的状态）
      await setup.service.sendMessage(id, 'hi')
      expect(setup.service.getSummary(id)?.status).toBe('active')

      setup.service.handleTurnEndSideEffects(id)

      // isGenerating 复位
      expect(setup.service.getSummary(id)?.status).toBe('idle')
    })

    it('兜底调 tryPersistLabel（turn_end 漏写时 agent_end 补写）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'w3-te-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        const { id } = await setup.seedSession({ label: 'fallback-label', sessionFile: filePath })

        // 模拟 turn_end 没触发 handleTurnUsageSideEffects，直接到 agent_end
        setup.service.handleTurnEndSideEffects(id)

        expect(mocks.persistSessionNameMock).toHaveBeenCalledTimes(1)
        expect(mocks.persistSessionNameMock).toHaveBeenCalledWith(filePath, 'fallback-label', id, expect.any(String))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('未知 session 不抛错', () => {
      expect(() => setup.service.handleTurnEndSideEffects('ghost')).not.toThrow()
    })
  })

  // ── applyContextUpdate 接收 totalTokens（tokenCount 写入）──
  describe('applyContextUpdate 接收 totalTokens（tokenCount 写入）', () => {
    it('传 totalTokens 时写入 session.tokenCount', async () => {
      const { id } = await setup.seedSession()
      // 初始 tokenCount=0
      expect(setup.service.getSummary(id)?.tokenCount).toBe(0)

      setup.service.applyContextUpdate(id, 25000, 30000)

      // tokenCount 写入（totalTokens）
      expect(setup.service.getSummary(id)?.tokenCount).toBe(30000)
    })

    it('未传 totalTokens 时 tokenCount 不变（向后兼容）', async () => {
      const { id } = await setup.seedSession()
      setup.service.applyContextUpdate(id, 25000)
      // tokenCount 保持 0（未传 totalTokens）
      expect(setup.service.getSummary(id)?.tokenCount).toBe(0)
      // inputTokens 仍正常回写
      expect(setup.service.getInputTokens(id)).toBe(25000)
    })

    it('totalTokens=0 时 tokenCount 写 0（agent_end usage 缺失场景）', async () => {
      const { id } = await setup.seedSession()
      setup.service.applyContextUpdate(id, 0, 0)
      // inputTokens=0 守卫，整个方法早退（不广播不回写）
      expect(setup.service.getSummary(id)?.tokenCount).toBe(0)
    })
  })
})

// ════════════════════════════════════════════════════════════════════
// E2：完整 pi 事件流集成（mock RpcClient 发完整事件序列，
//     经 EventAdapter→Interpreter→SessionService 全链路，断言终态）
// ════════════════════════════════════════════════════════════════════
describe('SessionService · W3 E2：完整 pi 事件流集成', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  it('全链路：message_start→text_delta→tool_execution_*→turn_end→agent_end → 终态 isGenerating=false + tokenCount>0 + inputTokens>0', async () => {
    // 用真实的 createAdapter 组合根装配（不走 mock adapterFactory）
    // 重新构造 service，注入真实 EventAdapter + EventInterpreter + 回调连线
    const { EventAdapter } = await import('../src/infra/pi/event-adapter.js')
    const { EventInterpreter } = await import('../src/services/session/event-interpreter.js')

    const clientMap = new Map<string, MockClient>()
    let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null
    const pm: IProcessManager = {
      createSession: vi.fn(async () => {
        const piSid = `pi-e2-${++autoId}`
        const client = makeMockClient({
          // W2 收口后 create 用 client.getState()
          getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
            sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
          }),
        })
        clientMap.set(piSid, client)
        return client
      }),
      destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
      getClient: vi.fn((id: string) => clientMap.get(id)),
      getSessionIdByClient: vi.fn((client: MockClient) => {
        for (const [k, v] of clientMap) if (v === client) return k
        return undefined
      }),
      hasClient: vi.fn((id: string) => clientMap.has(id)),
      rekey: vi.fn(),
      onSessionExit: vi.fn((cb) => { exitCb = cb }),
      destroyAll: vi.fn(async () => { clientMap.clear() }),
    } as unknown as IProcessManager
    const broker: IMessageBroker = {
      send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn(),
    } as unknown as IMessageBroker

    // 前向引用：createAdapter 闭包需引用 service（在构造后才赋值），
    // 用 holder 变量使闭包读到构造后的实例（组合根同样靠闭包捕获，sessionService 在 adapterFactory 之后赋值）。
    const holder: { service: SessionService } = { service: null as unknown as SessionService }
    const createAdapter = (sessionId: string, send: (msg: import('@xyz-agent/shared').ServerMessage) => void) => {
      const interpreter = new EventInterpreter(sessionId, {
        send,
        onContextUpdate: (sid, ctxData) => {
          holder.service.applyContextUpdate(sid, ctxData.inputTokens, ctxData.totalTokens)
        },
        onTurnUsage: (sid) => holder.service.handleTurnUsageSideEffects(sid),
        onTurnFinalize: (sid) => holder.service.handleTurnEndSideEffects(sid),
      })
      return new EventAdapter(sessionId, (events) => interpreter.interpret(events))
    }
    // 用真实 createAdapter 组合根装配（EventAdapter → Interpreter → SessionService 全链路）
    const service2 = new SessionService(
      pm, broker, createAdapter, '/tmp',
      { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
      new PiConfigStore(), new PiSessionStore(),
      { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as unknown as IGitInfoReader,
      { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as unknown as ConstructorParameters<typeof SessionService>[8],
    )
    holder.service = service2

    const piSid = `pi-e2-final-${++autoId}`
    const eventListeners: PiEventListener[] = []
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
      }),
      onEvent: vi.fn<(listener: PiEventListener) => () => void>((listener) => {
        eventListeners.push(listener)
        return () => {}
      }),
    })
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)

    const summary = await service2.create(tmpdir(), 'e2-label')
    expect(summary.id).toBe(piSid)

    // 标记生成中（模拟 sendPrompt）
    await service2.sendMessage(piSid, 'do something')
    expect(service2.getSummary(piSid)?.status).toBe('active')

    // 派发完整 pi 事件序列到 EventAdapter 注册的 listener
    const dispatch = (ev: Record<string, unknown>) => {
      eventListeners.forEach((fn) => fn(ev))
    }
    dispatch({ type: 'message_start', message: undefined }) // assistant turn 开始
    dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
    dispatch({
      type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' },
    })
    dispatch({
      type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file.txt' }] },
    })
    // turn_end：单 turn 用量（onTurnUsage + onContextUpdate）
    dispatch({
      type: 'turn_end',
      message: { role: 'assistant', usage: { input: 163418, output: 82, totalTokens: 163500 } },
    })
    // agent_end：整循环结束（onTurnFinalize + onContextUpdate）
    dispatch({
      type: 'agent_end',
      messages: [{
        stopReason: 'stop',
        usage: { input: 163418, output: 82, totalTokens: 163500 },
      }],
    })
    // flush 异步 hook（tool-call-* 是 void this.handle...）
    await new Promise<void>(r => setTimeout(r, 10))

    // ── 断言终态（3 个副作用全迁移后应满足）──
    const finalSummary = service2.getSummary(piSid)
    expect(finalSummary).toBeDefined()
    // 1. isGenerating 复位（agent_end onTurnFinalize → handleTurnEndSideEffects）
    expect(finalSummary!.status).toBe('idle')
    // 2. tokenCount 写入（>0，经 onContextUpdate totalTokens → applyContextUpdate）
    expect(finalSummary!.tokenCount).toBeGreaterThan(0)
    // 3. inputTokens 写入（>0，agent_end usage 回写）
    expect(service2.getInputTokens(piSid)).toBeGreaterThan(0)

    // 附带验证：message.complete 已广播（EventAdapter handleAgentEnd → interpreter 转发）
    const broadcasts = vi.mocked(broker.broadcast).mock.calls.map(c => c[0].type)
    expect(broadcasts).toContain('message.complete')
  })
})
