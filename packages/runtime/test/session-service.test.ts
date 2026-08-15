/**
 * SessionService 行为测试（架构重构 Phase 3 第一步 · TDD 护栏）。
 *
 * 目的：在拆分 session-service.ts（722 行巨石）为 3 协作模块之前，
 * 用测试钉住全部 21 个 public 方法 + onSessionExit 回调的现有行为。
 * 拆分后此测试保持绿即证明行为不变。
 *
 * Mock 边界（不 spawn 真 pi、不碰真文件系统）：
 * - pi-config-bridge / trash / message-converter / session-history 全部 vi.mock。
 * - IGitInfoReader 经构造注入（不再 vi.mock 模块），createSetup 提供桩实现。
 * - 构造函数依赖（pm / broker / extensionService）注入 mock 对象。
 * - pm 通过共享 clientMap 让 getClient/hasClient/rekey/getSessionIdByClient 行为自洽。
 * - existsSync 用真实 node:fs，测试数据用真实存在的 cwd（tmpdir）。
 *
 * 覆盖分类（对应 plan 归属表）：
 * - dispatcher：sendMessage / sendSubagentMessage / abort / steerMessage / followUpMessage / compact
 * - lifecycle：create / delete / renameSession / restoreSession
 * - Facade：switchModel / setThinkingLevel / getHistory / hasActiveSession / getRpcClient /
 *           ensureActive / listPersistedSessions / getSummary / destroyAll / setSendMessageHook
 * - onSessionExit：构造函数注册的进程退出回调
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { tmpdir, homedir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { IGitInfoReader } from '../src/services/ports/git-info.js'

import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { SessionSummary, SessionGroup, Message, ServerMessage, ProviderId, SegmentsMetadataEntry, SegmentsMetadataFile } from '@xyz-agent/shared'
import { getAttachmentsDir } from '@xyz-agent/shared/paths'

// ── vi.hoisted：在 vi.mock 工厂执行前就绪的 mock 句柄 ───────────────

const mocks = vi.hoisted(() => ({
  mockScannedSessions: [] as Array<{
    id: string
    filePath: string
    cwd: string
    name: string | null
    lastModified: number
    timestamp: string
    size: number
    outcome: 'done' | 'error' | 'stopped' | null
  }>,
  // 可重新赋值：null 表示未配置 model
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAllMock: vi.fn(),
  persistSessionNameMock: vi.fn(),
  patchSessionCwdMock: vi.fn(() => true),
  trashMock: vi.fn(),
  convertPiHistoryMock: vi.fn((raw: unknown) => raw),
  // entry-tree-builder.rebuildHistoryFromEntries mock：默认 identity-ish（返 entries 当 messages），
  // 单测按需 mockReturnValueOnce 控制重建结果。与 convertPiHistoryMock 同范式（隔离重建逻辑）。
  rebuildHistoryFromEntriesMock: vi.fn((entries: unknown[]) => ({ messages: entries as unknown[], clientUuidMap: new Map<string, string>() })),
  getHistoryFromFileMock: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePathMock: vi.fn().mockResolvedValue([]),
  getHistoryTailFromFileMock: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
}))

const { mockScannedSessions } = mocks

// pi-config-bridge 已拆分：session 函数迁入 session-file-utils，model/settings 函数
// 归 pi-provider-store，配置目录归 pi-paths。按 session-store/pi-config-store 的实际
// import 来源分别 mock 各符号（其余实现保留原模块，importOriginal）。
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => mockScannedSessions,
    persistSessionName: mocks.persistSessionNameMock,
    patchSessionCwd: mocks.patchSessionCwdMock,
  }
})
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: mocks.refreshAllMock,
    getDefaultModel: () => mocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getPiAgentDir: () => '/mock/xyz-agent/pi/agent',
  }
})

vi.mock('../src/infra/system/trash.js', () => ({ trash: mocks.trashMock }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: mocks.convertPiHistoryMock }))
vi.mock('../src/infra/pi/entry-tree-builder.js', () => ({ rebuildHistoryFromEntries: mocks.rebuildHistoryFromEntriesMock }))
vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: mocks.getHistoryFromFileMock,
  getHistoryFromFilePath: mocks.getHistoryFromFilePathMock,
  getHistoryTailFromFile: mocks.getHistoryTailFromFileMock,
}))

// ── Mock 之后再 import 被测对象 ─────────────────────────────────────

import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

// ── Mock client / 依赖工厂 ─────────────────────────────────────────

// sendCommand 的完整签名（与 IPiEngine.sendCommand 对齐），复用于多处 mock。
type SendCommandFn = (type: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>

/**
 * IPiEngine 的最小可断言 mock。
 * 每个方法用 MockInstance<具体签名>，保证 MockClient 可结构赋给 IPiEngine，
 * 同时允许测试直接访问 client.xxx.mock.calls。
 */
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
  /** get_entries RPC mock（entry 树重建路径）。默认空 entries（触发 fallback 尾读）。 */
  getEntries: MockInstance<(since?: string) => Promise<unknown>>
  sendCommand: MockInstance<SendCommandFn>
  /** 切换 pi session 文件（W2 收口：替代 sendCommand('switch_session')）。 */
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  /** 查询 pi get_state（W2 收口：替代 readPiState/sendCommand('get_state')），返回归一后的 state 对象。 */
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  getCommands: MockInstance<() => Promise<unknown>>
  getSessionStats: MockInstance<() => Promise<unknown>>
  onEvent: MockInstance<(listener: PiEventListener) => () => void>
  onExit: MockInstance<(callback: (code: number | null) => void) => void>
  kill: MockInstance<() => Promise<void>>
  start: MockInstance<() => Promise<void>>
  exited: boolean
  /** onEvent 注册的 listener 列表（测试触发 agent_end 用） */
  eventListeners: PiEventListener[]
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  const eventListeners: PiEventListener[] = []
  return {
    prompt: vi.fn<(content: string) => Promise<unknown>>().mockResolvedValue(undefined),
    abort: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    steer: vi.fn<(content: string) => Promise<unknown>>().mockResolvedValue(undefined),
    followUp: vi.fn<(content: string) => Promise<unknown>>().mockResolvedValue(undefined),
    setModel: vi.fn<(provider: string, modelId: string) => Promise<unknown>>().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn<(level: string) => Promise<unknown>>().mockResolvedValue(undefined),
    compact: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    clear: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    getHistory: vi.fn<() => Promise<unknown>>().mockResolvedValue({ data: { messages: [] } }),
    // 默认空 entries → getHistory 走 fallback 尾读（与旧 getHistory 空 messages 行为一致）
    getEntries: vi.fn<(since?: string) => Promise<unknown>>().mockResolvedValue({ data: { entries: [], leafId: null } }),
    sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: {} }),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
    getCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
    getSessionStats: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    // 保存 listener 到 eventListeners，测试可取出触发 agent_end 事件
    onEvent: vi.fn<(listener: PiEventListener) => () => void>((listener) => {
      eventListeners.push(listener)
      return () => { /* noop unsub */ }
    }),
    onExit: vi.fn<(callback: (code: number | null) => void) => void>(),
    kill: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    exited: false,
    eventListeners,
    ...overrides,
  }
}

/** 重置跨用例共享状态。 */
function resetMockState(): void {
  mockScannedSessions.length = 0
  mocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
  mocks.convertPiHistoryMock.mockImplementation((raw: unknown) => raw)
  mocks.rebuildHistoryFromEntriesMock.mockImplementation((entries: unknown[]) => ({ messages: entries as unknown[], clientUuidMap: new Map<string, string>() }))
  mocks.getHistoryFromFileMock.mockResolvedValue([])
}

/** 一份完整测试装置：service + 各 mock 依赖 + clientMap + exit 触发器。 */
interface Setup {
  service: SessionService
  pm: IProcessManager
  broker: IMessageBroker
  /** mock IMessageBus（wave:perf-w09 单通道：session 级消息的发布目标） */
  messageBus: IMessageBus
  extensionService: IExtensionService
  clientMap: Map<string, MockClient>
  /** mock 的 IGitInfoReader（readGitInfo 恒 undefined → 摘要 git 字段留空）。供 localSession 复用。 */
  gitInfoReader: IGitInfoReader
  triggerExit: (sessionId: string, code: number | null, stderr?: string) => void
  /** 直接挂载一个 client 到 clientMap（不走 create），用于 dispatcher 类测试。 */
  mountClient: (sessionId: string, client?: MockClient) => MockClient
  /** 走真实 create 建立一个 session，返回其 id + client。 */
  seedSession: (opts?: {
    label?: string
    cwd?: string
    sessionFile?: string
    commands?: Array<{ name: string; source: string; sourceInfo?: Record<string, unknown> }>
    hidden?: boolean
  }) => Promise<{ id: string; client: MockClient }>
}

let autoId = 0

function createSetup(): Setup {
  const clientMap = new Map<string, MockClient>()
  let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

  const pm: IProcessManager = {
    // createSession：默认返回一个带唯一 pi sessionId 的 client（模拟 pi get_state）。
    createSession: vi.fn(async (_id: string, _cwd: string) => {
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
    rekey: vi.fn((oldId: string, newId: string) => {
      const c = clientMap.get(oldId)
      if (c) { clientMap.delete(oldId); clientMap.set(newId, c) }
    }),
    onSessionExit: vi.fn((cb) => { exitCb = cb }),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
  } as unknown as IProcessManager

  const broker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  // wave:perf-w09（02 文档 D1-2）：session 级消息单通道走 bus.publish（broker 双写腿已删）。
  // dispatcher（构造参数注入）与 session-service 自身（setMessageBus，对齐组合根）共用此 mock。
  const messageBus: IMessageBus = {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as IMessageBus

  const extensionService: IExtensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (_sid: string, _interceptor: unknown): IEventAdapter => ({
    attach: vi.fn(),
    detach: vi.fn(),
  })

  // IGitInfoReader 桩：readGitInfo 恒 undefined（摘要 git 字段留空），pruneStaleCache no-op。
  // 经构造注入（git-info 已 port 化，不再 vi.mock 模块）。
  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }

  // WorkspaceService 桩：record no-op，list 返空（W2 构造注入）。
  const workspaceService = {
    record: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  }

  const service = new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
    messageBus,
  )
  service.setMessageBus(messageBus)

  const mountClient = (sessionId: string, client?: MockClient): MockClient => {
    const c = client ?? makeMockClient()
    clientMap.set(sessionId, c)
    return c
  }

  const seedSession: Setup['seedSession'] = async (opts = {}) => {
    const piSid = `pi-seed-${++autoId}`
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()（返回归一后的 state 对象）
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: opts.sessionFile ?? `/fake/${piSid}.jsonl`,
      }),
      getCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue(opts.commands ?? []),
    })
    // 让 createSession mock 本次返回该 client
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)
    await service.create(opts.cwd ?? tmpdir(), opts.label ?? 'seed', { hidden: opts.hidden })
    return { id: piSid, client }
  }

  return {
    service, pm, broker, messageBus, extensionService, clientMap, gitInfoReader,
    triggerExit: (sid, code, stderr = '') => exitCb?.(sid, code, stderr),
    mountClient, seedSession,
  }
}

/** 辅助：找指定 type 的已发布消息（按 type 收窄返回 payload 类型）。
 * wave:perf-w09（D1-2）双通道查询：session 级消息走 bus.publish（call[1]），
 * 全局消息（config.sessions 等）仍走 broker.broadcast（call[0]）。 */
function findBroadcast<T extends ServerMessage['type']>(setup: Setup, type: T): ServerMessage<T> | undefined {
  for (const call of vi.mocked(setup.messageBus.publish).mock.calls) {
    if (call[1].type === type) return call[1] as ServerMessage<T>
  }
  for (const call of vi.mocked(setup.broker.broadcast).mock.calls) {
    if (call[0].type === type) return call[0] as ServerMessage<T>
  }
  return undefined
}

// ───────────────────────────────────────────────────────────────────
// dispatcher 类
// ───────────────────────────────────────────────────────────────────

describe('SessionService · dispatcher', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  describe('sendMessage', () => {
    it('calls client.prompt with the user content on normal send', async () => {
      const client = setup.mountClient('sid-1')
      await setup.service.sendMessage('sid-1', 'hello pi')
      expect(client.prompt).toHaveBeenCalledWith('hello pi', undefined)
    })

    it('does not call prompt when hook blocks, and broadcasts message.error with reason', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({ blocked: true, reason: 'plugin says no' }))
      await setup.service.sendMessage('sid-1', 'try')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-1', message: 'plugin says no' })
    })

    it('uses default reason when hook blocks without reason', async () => {
      setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({ blocked: true }))
      await setup.service.sendMessage('sid-1', 'try')
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ message: 'Message blocked by plugin hook' })
    })

    it('passes through when hook returns blocked:false', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({ blocked: false }))
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).toHaveBeenCalledWith('go', undefined)
    })

    it('passes through when hook returns null', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => null)
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).toHaveBeenCalledWith('go', undefined)
    })

    // Fix-1：onBeforeSendMessage 的 transform 语义消费侧——hook 返回 modifiedContent
    // 时 dispatcher 用改写后的文本发 pi（demo 插件 !important → IMPORTANT 的消费链路）
    it('sends the hook-modified content when hook returns modifiedContent', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async (_sid, content) => ({
        blocked: false,
        modifiedContent: content.replace('!important', 'IMPORTANT'),
      }))
      await setup.service.sendMessage('sid-1', 'hello !important world')
      expect(client.prompt).toHaveBeenCalledTimes(1)
      expect(client.prompt).toHaveBeenCalledWith('hello IMPORTANT world', undefined)
    })

    it('blocks take precedence over modifiedContent (no prompt sent)', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({
        blocked: true,
        reason: 'denied',
        modifiedContent: 'should not be sent',
      }))
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ message: 'denied' })
    })

    it('broadcasts message.error and skips prompt when hook throws', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => { throw new Error('hook boom') })
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-1' })
      expect(String(err?.payload.message)).toContain('hook boom')
    })

    it('broadcasts message.error when prompt rejects', async () => {
      const client = setup.mountClient('sid-1')
      client.prompt.mockRejectedValueOnce(new Error('pi down'))
      await setup.service.sendMessage('sid-1', 'go')
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-1', message: 'pi down' })
    })

    it('marks session isGenerating when session is active (via create)', async () => {
      const { id } = await setup.seedSession()
      await setup.service.sendMessage(id, 'hi')
      const summary = setup.service.getSummary(id)
      expect(summary?.status).toBe('active')
    })
  })

  describe('sendSubagentMessage', () => {
    it('injects base64 marker before the prompt text', async () => {
      const client = setup.mountClient('sid-sub')
      await setup.service.sendSubagentMessage('sid-sub', 'coder', 'fix the bug')
      expect(client.prompt).toHaveBeenCalledTimes(1)
      const arg = client.prompt.mock.calls[0][0] as string
      expect(arg).toContain('<!-- xyz-agent-force-subagent:')
      // base64 of {"agent":"coder","task":"fix the bug"}
      const expectedB64 = Buffer.from(JSON.stringify({ agent: 'coder', task: 'fix the bug' }), 'utf-8').toString('base64')
      expect(arg).toContain(expectedB64)
      expect(arg.endsWith('\nExecute task using agent \'coder\'')).toBe(true)
    })

    it('uses provided content as prompt body when given', async () => {
      const client = setup.mountClient('sid-sub')
      await setup.service.sendSubagentMessage('sid-sub', 'coder', 't', 'do this please')
      const arg = client.prompt.mock.calls[0][0] as string
      expect(arg.endsWith('\ndo this please')).toBe(true)
    })

    // Fix-1：subagent 路径同样消费 modifiedContent——改写后的正文拼在 marker 之后
    it('sends hook-modified body with marker prefix when hook returns modifiedContent', async () => {
      const client = setup.mountClient('sid-sub')
      setup.service.setSendMessageHook(async () => ({
        blocked: false,
        modifiedContent: 'rewritten body',
      }))
      await setup.service.sendSubagentMessage('sid-sub', 'coder', 't', 'raw body')
      const arg = client.prompt.mock.calls[0][0] as string
      expect(arg.startsWith('<!-- xyz-agent-force-subagent:')).toBe(true)
      expect(arg.endsWith('\nrewritten body')).toBe(true)
    })

    it('hook audits the prompt text (not the marker) and blocks send', async () => {
      const client = setup.mountClient('sid-sub')
      let seenContent = ''
      setup.service.setSendMessageHook(async (_sid, content) => {
        seenContent = content
        return { blocked: true, reason: 'blocked' }
      })
      await setup.service.sendSubagentMessage('sid-sub', 'coder', 't', 'raw-user-input')
      // hook 收到的是用户原文，不含 marker
      expect(seenContent).toBe('raw-user-input')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ message: 'blocked' })
    })
  })

  describe('abort / steer / followUp', () => {
    it('abort calls client.abort', async () => {
      const client = setup.mountClient('sid-a')
      await setup.service.abort('sid-a')
      expect(client.abort).toHaveBeenCalledTimes(1)
    })

    // [HISTORICAL] abort 必须广播 message.complete{stopReason:'aborted'} 终态。
    // handoff 2026-07-04 P2：pi 卡死（静默不退出）时不发 agent_end，若 abort 只调
    // client.abort() 不广播终态，前端 isStreaming 永不复位（违反规则 #3）。
    // session-message-handler 的 message.status reply 走 pending 通道，不触发
    // chat store 收口逻辑——必须走流式 message.complete 广播。
    it('abort broadcasts message.complete with stopReason aborted', async () => {
      setup.mountClient('sid-a')
      await setup.service.abort('sid-a')
      const complete = findBroadcast(setup, 'message.complete')
      expect(complete?.payload).toMatchObject({ sessionId: 'sid-a', stopReason: 'aborted' })
    })

    it('abort broadcasts message.error when client.abort fails', async () => {
      const client = setup.mountClient('sid-a')
      client.abort.mockRejectedValueOnce(new Error('pi gone'))
      // abort 失败不 rethrow（已广播 message.error 终态，与 sendPrompt 错误路径对称）
      await setup.service.abort('sid-a')
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-a' })
      expect(String(err?.payload?.message)).toContain('pi gone')
    })

    it('abort throws when session has no client', async () => {
      await expect(setup.service.abort('missing')).rejects.toThrow('Session missing not found')
    })

    it('steerMessage calls client.steer with content', async () => {
      const client = setup.mountClient('sid-s')
      await setup.service.steerMessage('sid-s', 'steer me')
      expect(client.steer).toHaveBeenCalledWith('steer me')
    })

    it('steerMessage throws when session not active', async () => {
      await expect(setup.service.steerMessage('missing', 'x')).rejects.toThrow('not active')
    })

    it('followUpMessage calls client.followUp with content', async () => {
      const client = setup.mountClient('sid-f')
      await setup.service.followUpMessage('sid-f', 'follow')
      expect(client.followUp).toHaveBeenCalledWith('follow')
    })

    it('followUpMessage throws when session not active', async () => {
      await expect(setup.service.followUpMessage('missing', 'x')).rejects.toThrow('not active')
    })
  })

  describe('compact', () => {
    it('M4 事件驱动：零 compaction 广播 + client.compact 调用', async () => {
      const client = setup.mountClient('sid-c')
      await setup.service.compact('sid-c')
      expect(client.compact).toHaveBeenCalledTimes(1)
      // 零 compaction 广播（compacting/compacted/summary 由 interpreter 从 pi 事件唯一编排）
      const types = [
        ...vi.mocked(setup.broker.broadcast).mock.calls.map(c => c[0].type),
        ...vi.mocked(setup.messageBus.publish).mock.calls.map(c => c[1].type),
      ]
      const compactionTypes = types.filter(t =>
        ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes(t),
      )
      expect(compactionTypes).toHaveLength(0)
    })

    it('M4 事件驱动：client.compact 失败 → rethrow + 零 compaction 广播（失败提示归 interpreter）', async () => {
      const client = setup.mountClient('sid-c')
      client.compact.mockRejectedValueOnce(new Error('compact fail'))
      await expect(setup.service.compact('sid-c')).rejects.toThrow('compact fail')
      // 零 compaction 广播（pi 手动失败必发 compaction_end{errorMessage}，interpreter 统一编排提示）
      const compacted = findBroadcast(setup, 'session.compacted')
      expect(compacted).toBeUndefined()
    })

    it('throws when session has no client', async () => {
      await expect(setup.service.compact('missing')).rejects.toThrow('Session missing not found')
    })
  })
})

// ───────────────────────────────────────────────────────────────────
// lifecycle 类
// ───────────────────────────────────────────────────────────────────

describe('SessionService · lifecycle', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  describe('create', () => {
    it('builds a managed session: rekeys to pi sessionId, registers summary', async () => {
      const summary = await setup.service.create(tmpdir(), 'my-label')
      // summary.id 来自 mock client 的 get_state
      expect(summary.id).toMatch(/^pi-auto-\d+$/)
      expect(summary.label).toBe('my-label')
      // rekey 被调用（tempId → piSid）
      expect(setup.pm.rekey).toHaveBeenCalledTimes(1)
      expect(vi.mocked(setup.pm.rekey).mock.calls[0][1]).toBe(summary.id)
      // session 进入 sessions Map
      expect(setup.service.getSummary(summary.id)?.label).toBe('my-label')
    })

    it('queries commands and broadcasts session.commands on create', async () => {
      const { id } = await setup.seedSession({ commands: [{ name: 'xyz-navigate', source: 'extension' }] })
      // commands 广播给前端
      const cmds = findBroadcast(setup, 'session.commands')
      expect(cmds?.payload).toMatchObject({ sessionId: id })
    })

    it('broadcasts session.commands 含 sourceInfo 透传（W2）', async () => {
      const { id } = await setup.seedSession({
        commands: [
          {
            name: 'fix',
            source: 'skill',
            sourceInfo: { path: '/proj/skills/fix/SKILL.md', source: 'skill', scope: 'project' },
          },
        ],
      })
      const cmds = findBroadcast(setup, 'session.commands')
      // sourceInfo 从 pi get_commands 透传到 session.commands 广播 payload
      expect(cmds?.payload.commands[0]).toMatchObject({
        name: 'fix',
        source: 'skill',
        sourceInfo: { path: '/proj/skills/fix/SKILL.md', source: 'skill', scope: 'project' },
      })
      expect(id).toBeDefined()
    })

    it('throws when no default model configured', async () => {
      mocks.defaultModel.value = null
      await expect(setup.service.create(tmpdir())).rejects.toThrow('No model configured')
    })

    it('throws and destroys session when pi returns no sessionId', async () => {
      // W2 收口后 create 用 client.getState()，返回空对象 → 无 sessionId → 抛错
      const stateless = makeMockClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
      })
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(stateless as unknown as IPiEngine)
      await expect(setup.service.create(tmpdir())).rejects.toThrow('did not return a session ID')
      expect(setup.pm.destroySession).toHaveBeenCalledTimes(1)
    })

    it('calls refreshAll after create', async () => {
      await setup.service.create(tmpdir())
      expect(mocks.refreshAllMock).toHaveBeenCalledTimes(1)
    })

    // INV-7: create 收到不存在的 cwd → 降级 homedir（与 restoreSession fallback 对称）
    it('falls back to homedir when requested cwd does not exist (INV-7)', async () => {
      const nonexistentCwd = '/tmp/xyz-agent-test-cwd-nonexistent-' + Date.now()
      const summary = await setup.service.create(nonexistentCwd, 'label')
      // createSession 收到 homedir 而非不存在的路径（existsSync 真实，路径保证不存在）
      expect(setup.pm.createSession).toHaveBeenCalledWith(
        expect.any(String),
        homedir(),
        expect.any(Object),
      )
      // 返回的 summary.cwd 也是 homedir（前端据此比对发现 fallback 并 toast）
      expect(summary.cwd).toBe(homedir())
      // workspaceService.record 记录的是 fallback 后的 homedir
      expect(vi.mocked(setup.pm.createSession).mock.calls[0][1]).not.toContain('nonexistent')
    })
  })

  describe('delete', () => {
    it('detaches, destroys process, removes from map (active session)', async () => {
      const { id } = await setup.seedSession()
      await setup.service.delete(id)
      expect(setup.pm.destroySession).toHaveBeenCalledWith(id)
      expect(setup.service.getSummary(id)).toBeUndefined()
      expect(mocks.refreshAllMock).toHaveBeenCalled()
    })

    it('trashes the session file when it exists on disk (non-active scanned)', async () => {
      // 用真实临时文件让 existsSync 返回 true
      const dir = mkdtempSync(join(tmpdir(), 'del-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        mockScannedSessions.push({
          id: 'scan-del', filePath, cwd: dir, name: null,
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        await setup.service.delete('scan-del')
        expect(mocks.trashMock).toHaveBeenCalledWith(filePath)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('throws when session neither active nor scanned', async () => {
      await expect(setup.service.delete('ghost')).rejects.toThrow('Session ghost not found')
    })
  })

  describe('renameSession', () => {
    it('persists new name for active session via pi-config-bridge', async () => {
      const { id } = await setup.seedSession({ sessionFile: '/fake/x.jsonl' })
      await setup.service.renameSession(id, 'new name')
      expect(mocks.persistSessionNameMock).toHaveBeenCalledWith('/fake/x.jsonl', 'new name', id, expect.any(String))
      expect(mocks.refreshAllMock).toHaveBeenCalled()
      expect(setup.service.getSummary(id)?.label).toBe('new name')
    })

    it('persists name via scanned file when session is not active', async () => {
      mockScannedSessions.push({
        id: 'scan-ren', filePath: '/fake/scan-ren.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      await setup.service.renameSession('scan-ren', 'renamed')
      expect(mocks.persistSessionNameMock).toHaveBeenCalledWith('/fake/scan-ren.jsonl', 'renamed', 'scan-ren', tmpdir())
    })
  })

  describe('restoreSession', () => {
    it('reuses scanned sessionId and sends switch_session with file path', async () => {
      // B7: restoreSession 直读 JSONL 文件（stripSessionEnd 已删），需真实文件
      const dir = mkdtempSync(join(tmpdir(), 'restore-'))
      const filePath = join(dir, 'persist-1.jsonl')
      writeFileSync(filePath, JSON.stringify({ type: 'session_info', name: 'old' }))
      try {
        mockScannedSessions.push({
          id: 'persist-1', filePath, cwd: dir, name: 'old',
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        const client = makeMockClient()
        vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
        const summary = await setup.service.restoreSession('persist-1')
        expect(summary.id).toBe('persist-1')
        // restoreSession 读原文件 → 写 tmpFile → switchSession(tmpFile)
        expect(client.switchSession).toHaveBeenCalledWith(expect.stringContaining('xyz-session-persist-1'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('throws when persisted session not found', async () => {
      await expect(setup.service.restoreSession('nope')).rejects.toThrow('Persisted session nope not found')
    })

    it('throws when no default model configured', async () => {
      mockScannedSessions.push({
        id: 'persist-2', filePath: '/fake/p2.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      mocks.defaultModel.value = null
      await expect(setup.service.restoreSession('persist-2')).rejects.toThrow('No model configured')
    })

    it('destroys created session when switch_session fails', async () => {
      // B7: restoreSession 直读 JSONL 文件，需真实文件
      const dir = mkdtempSync(join(tmpdir(), 'restore-fail-'))
      const filePath = join(dir, 'persist-3.jsonl')
      writeFileSync(filePath, JSON.stringify({ type: 'session_info' }))
      try {
        mockScannedSessions.push({
          id: 'persist-3', filePath, cwd: dir, name: null,
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        const client = makeMockClient({
          // W2 收口后 restoreSession 用 client.switchSession，失败时抛错触发清理
          switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockRejectedValue(new Error('switch failed')),
        })
        vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
        await expect(setup.service.restoreSession('persist-3')).rejects.toThrow('switch failed')
        expect(setup.pm.destroySession).toHaveBeenCalledWith('persist-3')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

// ───────────────────────────────────────────────────────────────────
// Facade 类
// ───────────────────────────────────────────────────────────────────

describe('SessionService · Facade', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  describe('switchModel（session 级状态单一 owner：RPC + 缓存 + 广播）', () => {
    it('calls client.setModel and updates cached modelId', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.setModel).mockClear()
      const returned = await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')
      expect(returned).toBe(id)
      expect(client.setModel).toHaveBeenCalledWith('anthropic', 'claude-x')
      expect(setup.service.getSummary(id)?.modelId).toBe('anthropic/claude-x')
    })

    it('throws when session not in map (W1/L7: fail-fast，不再静默成功)', async () => {
      await expect(setup.service.switchModel('ghost', 'p' as ProviderId, 'm')).rejects.toThrow('session not active')
    })

    it('切换后广播 session.state_changed（含按新 contextWindow 重算用量）', async () => {
      const { id, client } = await setup.seedSession()
      // 注入 resolver：anthropic/claude-x contextWindow=200000
      setup.service.setModelContextWindowResolver((_p, _m) => 200000)
      // 预置 inputTokens 缓存（模拟 onContextUpdate 已回写）
      setup.service.setInputTokens(id, 12000)
      vi.mocked(client.setModel).mockClear()
      vi.mocked(setup.broker.broadcast).mockClear()
      vi.mocked(setup.messageBus.publish).mockClear()
      // get_state 返回 thinkingLevel（broadcastSessionState 查 pi get_state）
      // W2 收口后用 client.getState()，返回归一后的 state 对象
      vi.mocked(client.getState).mockResolvedValueOnce({ thinkingLevel: 'high' })

      await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')

      const stateChanged = findBroadcast(setup, 'session.state_changed')
      expect(stateChanged).toBeDefined()
      expect(stateChanged!.payload).toMatchObject({
        sessionId: id,
        modelId: 'anthropic/claude-x',
        thinkingLevel: 'high',
        inputTokens: 12000,
        contextLimit: 200000,
        usagePercent: 6, // Math.round(12000 / 200000 * 100)
      })
    })

    it('未注入 resolver 时 contextLimit=0 usagePercent=0，仍广播 state_changed', async () => {
      const { id } = await setup.seedSession()
      // 不注入 resolver
      setup.service.setInputTokens(id, 5000)

      await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')

      const stateChanged = findBroadcast(setup, 'session.state_changed')
      expect(stateChanged).toBeDefined()
      expect(stateChanged!.payload).toMatchObject({
        contextLimit: 0,
        usagePercent: 0,
        inputTokens: 5000,
      })
    })

    it('get_state 失败时不阻塞，thinkingLevel 回退缓存值', async () => {
      const { id, client } = await setup.seedSession()
      setup.service.setModelContextWindowResolver(() => 100000)
      setup.service.setThinkingLevelCache(id, 'medium')
      // W2 收口后 broadcastSessionState 用 client.getState()，失败时 thinkingLevel 回退缓存值
      vi.mocked(client.getState).mockRejectedValueOnce(new Error('get_state boom'))

      await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')

      const stateChanged = findBroadcast(setup, 'session.state_changed')
      expect(stateChanged).toBeDefined()
      expect(stateChanged!.payload).toMatchObject({ thinkingLevel: 'medium' })
    })
  })

  describe('setThinkingLevel', () => {
    it('updates cache and calls client.setThinkingLevel', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.setThinkingLevel).mockClear()
      await setup.service.setThinkingLevel(id, 'high')
      expect(client.setThinkingLevel).toHaveBeenCalledWith('high')
      expect(setup.service.getSummary(id)?.thinkingLevel).toBe('high')
    })
  })

  describe('setInputTokens 回写缓存（onContextUpdate 打通用例）', () => {
    it('U-setInput-1：setInputTokens 写入后 getInputTokens 读回正确值', async () => {
      const { id } = await setup.seedSession()
      setup.service.setInputTokens(id, 12345)
      expect(setup.service.getInputTokens(id)).toBe(12345)
    })

    it('U-setInput-2：setInputTokens 对不存在的 session 不抛错（静默忽略）', () => {
      expect(() => setup.service.setInputTokens('nonexistent', 100)).not.toThrow()
      expect(setup.service.getInputTokens('nonexistent')).toBe(0)
    })
  })

  describe('applyContextUpdate（session 级状态单一 owner：回写缓存 + 算用量 + 广播）', () => {
    it('回写 inputTokens 缓存 + 广播 context.update（含按 contextWindow 重算的 usagePercent）', async () => {
      const { id } = await setup.seedSession()
      setup.service.setModelContextWindowResolver(() => 100000)
      // modelId 初始为 default 'test-provider/test-model'，resolver 按 provider/model 查 contextWindow
      vi.mocked(setup.broker.broadcast).mockClear()
      vi.mocked(setup.messageBus.publish).mockClear()

      setup.service.applyContextUpdate(id, 25000)

      expect(setup.service.getInputTokens(id)).toBe(25000)
      const ctxUpdate = findBroadcast(setup, 'context.update')
      expect(ctxUpdate).toBeDefined()
      expect(ctxUpdate!.payload).toMatchObject({
        sessionId: id,
        inputTokens: 25000,
        contextLimit: 100000,
        usagePercent: 25, // Math.round(25000 / 100000 * 100)
      })
    })

    it('inputTokens 为 0 时不回写不广播（agent_end 前的空 usage）', async () => {
      const { id } = await setup.seedSession()
      setup.service.setModelContextWindowResolver(() => 100000)
      vi.mocked(setup.broker.broadcast).mockClear()

      setup.service.applyContextUpdate(id, 0)

      expect(setup.service.getInputTokens(id)).toBe(0) // 未回写
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('session 不存在时不广播', async () => {
      setup.service.setModelContextWindowResolver(() => 100000)
      expect(() => setup.service.applyContextUpdate('ghost', 1000)).not.toThrow()
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('未注入 resolver 时 contextLimit=0 usagePercent=0', async () => {
      const { id } = await setup.seedSession()

      setup.service.applyContextUpdate(id, 5000)

      const ctxUpdate = findBroadcast(setup, 'context.update')
      expect(ctxUpdate).toBeDefined()
      expect(ctxUpdate!.payload).toMatchObject({ contextLimit: 0, usagePercent: 0, inputTokens: 5000 })
    })
  })

  describe('getUsagePercent', () => {
    it('按缓存 inputTokens + 当前 modelId contextWindow 算百分比', async () => {
      const { id } = await setup.seedSession()
      setup.service.setModelContextWindowResolver(() => 200000)
      setup.service.setInputTokens(id, 100000)

      expect(setup.service.getUsagePercent(id)).toBe(50) // 100000/200000*100
    })

    it('usagePercent 上限 100（inputTokens 超过 contextWindow）', async () => {
      const { id } = await setup.seedSession()
      setup.service.setModelContextWindowResolver(() => 100000)
      setup.service.setInputTokens(id, 150000)

      expect(setup.service.getUsagePercent(id)).toBe(100) // Math.min(150, 100)
    })

    it('未注入 resolver 返回 0', async () => {
      const { id } = await setup.seedSession()
      setup.service.setInputTokens(id, 99999)
      expect(setup.service.getUsagePercent(id)).toBe(0)
    })

    it('session 不存在返回 0', () => {
      expect(setup.service.getUsagePercent('ghost')).toBe(0)
    })
  })

  describe('setThinkingLevelCache 回写缓存（thinking_level_changed 打通用例）', () => {
    it('U-setThinking-1：setThinkingLevelCache 写入后 getSummary().thinkingLevel 读回正确值', async () => {
      const { id } = await setup.seedSession()
      setup.service.setThinkingLevelCache(id, 'high')
      expect(setup.service.getSummary(id)?.thinkingLevel).toBe('high')
    })

    it('U-setThinking-2：setThinkingLevelCache 传 undefined 时不覆盖已有值', async () => {
      const { id } = await setup.seedSession()
      setup.service.setThinkingLevelCache(id, 'high')
      setup.service.setThinkingLevelCache(id, undefined)
      expect(setup.service.getSummary(id)?.thinkingLevel).toBe('high')
    })

    it('U-setThinking-2b：setThinkingLevelCache 对不存在的 session 不抛错', () => {
      expect(() => setup.service.setThinkingLevelCache('ghost', 'high')).not.toThrow()
    })
  })

  describe('inputTokens 缓存（W3：经 applyContextUpdate + handleTurnEndSideEffects 迁移）', () => {
    // W3：attachUsageListener 已删除，inputTokens/tokenCount 回写经中间事件链路：
    //   - applyContextUpdate(sid, inputTokens, totalTokens)：写 inputTokens + tokenCount
    //   - handleTurnEndSideEffects(sid)：复位 isGenerating（agent_end 副作用）
    it('agent_end usage 经 applyContextUpdate 回写 inputTokens + tokenCount', async () => {
      const { id } = await setup.seedSession()
      // 模拟 EventInterpreter onContextUpdate 回调（agent_end usage）
      setup.service.applyContextUpdate(id, 15000, 20000)
      expect(setup.service.getInputTokens(id)).toBe(15000)
      expect(setup.service.getSummary(id)?.tokenCount).toBe(20000)
    })

    it('agent_end 无 usage（inputTokens=0）时 applyContextUpdate 早退，保持原值', async () => {
      const { id } = await setup.seedSession()
      // inputTokens=0 守卫，整个方法早退（不回写不广播）
      setup.service.applyContextUpdate(id, 0, 0)
      expect(setup.service.getInputTokens(id)).toBe(0)
    })

    it('handleTurnEndSideEffects 复位 isGenerating（agent_end 迁移）', async () => {
      const { id } = await setup.seedSession()
      await setup.service.sendMessage(id, 'hi') // 标记 generating
      expect(setup.service.getSummary(id)?.status).toBe('active')
      setup.service.handleTurnEndSideEffects(id)
      expect(setup.service.getSummary(id)?.status).toBe('idle')
    })

    it('getInputTokens 对未知 session 返回 0', () => {
      expect(setup.service.getInputTokens('ghost')).toBe(0)
    })
  })

  describe('fetchAndBroadcastContext（session 恢复后推送用量）', () => {
    it('contextUsage.tokens 有值 → 广播 context.update（含 inputTokens/contextLimit/usagePercent）', async () => {
      const client = setup.mountClient('sid-ctx')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: 69000, contextWindow: 512000, percent: 13.5 },
      })

      await setup.service.fetchAndBroadcastContext('sid-ctx')

      const msg = findBroadcast(setup, 'context.update')
      expect(msg).toBeDefined()
      expect(msg!.payload).toMatchObject({
        sessionId: 'sid-ctx',
        inputTokens: 69000,
        contextLimit: 512000,
        usagePercent: 14, // Math.round(13.5)
      })
    })

    it('contextUsage.tokens=null（compaction 后未跑新 turn）→ 不广播', async () => {
      const client = setup.mountClient('sid-null')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: null, contextWindow: 512000, percent: null },
      })

      await setup.service.fetchAndBroadcastContext('sid-null')

      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('contextUsage 缺失 → 不广播', async () => {
      const client = setup.mountClient('sid-no-ctx')
      client.getSessionStats.mockResolvedValueOnce({})

      await setup.service.fetchAndBroadcastContext('sid-no-ctx')

      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('session 不存在（client 未挂载）→ no-op 不抛错', async () => {
      await expect(setup.service.fetchAndBroadcastContext('ghost-session')).resolves.toBeUndefined()
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('getSessionStats 抛错 → 不广播，不抛错（fire-and-forget）', async () => {
      const client = setup.mountClient('sid-err')
      client.getSessionStats.mockRejectedValueOnce(new Error('pi rpc timeout'))

      await expect(setup.service.fetchAndBroadcastContext('sid-err')).resolves.toBeUndefined()
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })
  })

  describe('fetchContext（RPC handler session.getContext 调用，返回 payload）', () => {
    it('contextUsage.tokens 有值 → 返回 {inputTokens, contextLimit, usagePercent}', async () => {
      const client = setup.mountClient('sid-fc')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: 1630000, contextWindow: 2000000, percent: 81.5 },
      })

      const payload = await setup.service.fetchContext('sid-fc')
      expect(payload).toEqual({
        inputTokens: 1630000,
        contextLimit: 2000000,
        usagePercent: 82, // Math.round(81.5)
      })
    })

    it('contextUsage.tokens=null → 返回 null（不广播、handler reply 空对象）', async () => {
      const client = setup.mountClient('sid-fc-null')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: null, contextWindow: 512000, percent: null },
      })

      expect(await setup.service.fetchContext('sid-fc-null')).toBeNull()
    })

    it('session 未激活（client 未挂载）→ 抛错（handler 调方 catch）', async () => {
      await expect(setup.service.fetchContext('ghost')).rejects.toThrow('not active')
    })
  })

  describe('hasActiveSession / getRpcClient', () => {
    it('hasActiveSession delegates to pm.hasClient', () => {
      setup.mountClient('sid-h')
      expect(setup.service.hasActiveSession('sid-h')).toBe(true)
      expect(setup.service.hasActiveSession('missing')).toBe(false)
    })

    it('getRpcClient returns the underlying client', () => {
      const client = setup.mountClient('sid-g')
      expect(setup.service.getRpcClient('sid-g')).toBe(client)
      expect(setup.service.getRpcClient('missing')).toBeUndefined()
    })
  })

  describe('getSummary', () => {
    it('returns undefined for unknown session', () => {
      expect(setup.service.getSummary('ghost')).toBeUndefined()
    })

    it('returns summary for active session', async () => {
      const { id } = await setup.seedSession({ label: 'sum' })
      expect(setup.service.getSummary(id)?.label).toBe('sum')
    })
  })

  describe('ensureActive', () => {
    it('returns existing client without restoring', async () => {
      const client = setup.mountClient('sid-e')
      const got = await setup.service.ensureActive('sid-e')
      expect(got).toBe(client)
    })

    it('restores session when client missing and returns new client', async () => {
      mockScannedSessions.push({
        id: 'persist-ens', filePath: '/fake/ens.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const client = makeMockClient()
      // mockResolvedValueOnce 会绕过 createSession 默认实现（后者负责写 clientMap），
      // 因此手动把 client 关联进 clientMap，让 ensureActive 末尾的 getClient 能取到。
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
      setup.clientMap.set('persist-ens', client)
      const got = await setup.service.ensureActive('persist-ens')
      expect(got).toBe(client)
    })

    it('throws when session is already being restored (dedup guard)', async () => {
      // 让 restoreSession 挂起，模拟并发 restore。不能 mountClient，否则 ensureActive
      // 走 fast path（直接返回现有 client），不会进入 restoring 分支。
      let resolveRestore!: (v: SessionSummary) => void
      const pending = new Promise<SessionSummary>(r => { resolveRestore = r })
      const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockReturnValueOnce(pending)

      const first = setup.service.ensureActive('dedup-sid')
      // 第一个已进入 restoring，第二个应被拒绝
      await expect(setup.service.ensureActive('dedup-sid')).rejects.toThrow('already being restored')
      resolveRestore({} as SessionSummary)
      // 第一个最终因 getClient 无 client 而 reject（符合无进程的真实场景）
      await expect(first).rejects.toThrow('client not available')
      restoreSpy.mockRestore()
    })
  })

  describe('getHistory', () => {
    it('rebuilds history via entry-tree-builder when getEntries returns entries', async () => {
      const fakeEntries = [{ type: 'message', id: 'e1', message: { role: 'user', content: 'hi' } }]
      const client = setup.mountClient('sid-hist')
      client.getEntries.mockResolvedValueOnce({ data: { entries: fakeEntries, leafId: 'e1' } })
      mocks.rebuildHistoryFromEntriesMock.mockReturnValueOnce({ messages: ['rebuilt' as unknown as Message], clientUuidMap: new Map() })
      const result = await setup.service.getHistory('sid-hist')
      // rebuildHistoryFromEntries 收到原始 entries（getEntries 路径，取代旧 get_messages + convertPiHistory）
      expect(mocks.rebuildHistoryFromEntriesMock).toHaveBeenCalledWith(fakeEntries, null)
      // getEntries 路径返回 { messages, truncated: false }（全量不截断）
      expect(result).toEqual({ messages: ['rebuilt'], truncated: false })
    })

    it('falls back to file read when getEntries returns empty and session is idle', async () => {
      const { id } = await setup.seedSession()
      const client = setup.clientMap.get(id)!
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: null } })
      // idle session getEntries 空 → fallback 走 getHistoryTailFromFile（尾读，返回 {messages, truncated}）
      mocks.getHistoryTailFromFileMock.mockResolvedValueOnce({ messages: [{ role: 'user', content: 'f' } as unknown as Message], truncated: false })
      const result = await setup.service.getHistory(id)
      expect(mocks.getHistoryTailFromFileMock).toHaveBeenCalledWith(id, expect.anything())
      expect(result.messages.length).toBe(1)
    })

    it('returns empty array when getEntries empty and session is generating', async () => {
      const { id, client } = await setup.seedSession()
      // 进入 generating：发一条消息
      await setup.service.sendMessage(id, 'x')
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: null } })
      const result = await setup.service.getHistory(id)
      // generating session getEntries 空 → 直接返回空（不走 fallback 尾读）
      expect(result).toEqual({ messages: [], truncated: false })
      expect(mocks.getHistoryTailFromFileMock).not.toHaveBeenCalled()
    })

    it('falls back to file read when getEntries throws', async () => {
      const { id, client } = await setup.seedSession()
      client.getEntries.mockRejectedValueOnce(new Error('rpc boom'))
      mocks.getHistoryTailFromFileMock.mockResolvedValueOnce({ messages: [], truncated: false })
      await setup.service.getHistory(id)
      expect(mocks.getHistoryTailFromFileMock).toHaveBeenCalledWith(id, expect.anything())
    })

    it('reads from file directly when no active client', async () => {
      mocks.getHistoryTailFromFileMock.mockResolvedValueOnce({ messages: [], truncated: false })
      await setup.service.getHistory('no-client')
      expect(mocks.getHistoryTailFromFileMock).toHaveBeenCalledWith('no-client', expect.anything())
    })
  })

  describe('listPersistedSessions', () => {
    it('groups persisted sessions by cwd', () => {
      mockScannedSessions.push(
        { id: 'a', filePath: '/fake/a.jsonl', cwd: '/proj', name: null, lastModified: 1, timestamp: '', size: 0, outcome: null },
        { id: 'b', filePath: '/fake/b.jsonl', cwd: '/proj', name: null, lastModified: 2, timestamp: '', size: 0, outcome: null },
        { id: 'c', filePath: '/fake/c.jsonl', cwd: '/other', name: null, lastModified: 3, timestamp: '', size: 0, outcome: null },
      )
      const groups = setup.service.listPersistedSessions() as SessionGroup[]
      const projGroup = groups.find(g => g.cwd === '/proj')
      expect(projGroup?.sessions.map(s => s.id).sort()).toEqual(['a', 'b'])
      expect(groups.find(g => g.cwd === '/other')?.sessions.length).toBe(1)
    })

    it('includes active sessions and excludes their duplicate file entries', async () => {
      const { id } = await setup.seedSession({ sessionFile: '/fake/dup.jsonl', cwd: tmpdir() })
      mockScannedSessions.push({
        id, filePath: '/fake/dup.jsonl', cwd: tmpdir(), name: null,
        lastModified: 1, timestamp: '', size: 0, outcome: null,
      })
      const groups = setup.service.listPersistedSessions()
      const allIds = groups.flatMap(g => g.sessions.map(s => s.id))
      // 活跃 session 出现一次，持久化副本被过滤
      expect(allIds.filter(x => x === id).length).toBe(1)
    })

    it('excludes hidden sessions (公共 session 不进 sidebar 列表)', async () => {
      const cwd = tmpdir()
      // 普通session：可见
      const { id: visibleId } = await setup.seedSession({ cwd, label: 'visible' })
      // 隐藏 session（公共 session）：应被过滤
      const { id: hiddenId } = await setup.seedSession({ cwd, label: 'public', hidden: true })

      const groups = setup.service.listPersistedSessions()
      const allIds = groups.flatMap(g => g.sessions.map(s => s.id))
      expect(allIds).toContain(visibleId)
      expect(allIds).not.toContain(hiddenId)
    })
  })

  describe('workflowAction + subagentAction（扩展 slash command 转发）', () => {
    it('workflowAction 转发 /workflows <action> <runId> 到 pi prompt', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.prompt).mockClear()
      await setup.service.workflowAction(id, 'abort', 'wf-run-1')
      expect(client.prompt).toHaveBeenCalledWith('/workflows abort wf-run-1')
    })

    it('workflowAction session 不活跃 → throw', async () => {
      await expect(setup.service.workflowAction('ghost', 'abort', 'wf-x')).rejects.toThrow('not active')
    })

    it('subagentAction 转发 /subagents <action> <subagentId> 到 pi prompt', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.prompt).mockClear()
      await setup.service.subagentAction(id, 'cancel', 'bg-abc-1-123')
      expect(client.prompt).toHaveBeenCalledWith('/subagents cancel bg-abc-1-123')
    })

    it('subagentAction session 不活跃 → throw', async () => {
      await expect(setup.service.subagentAction('ghost', 'cancel', 'bg-x')).rejects.toThrow('not active')
    })
  })

  describe('setSendMessageHook', () => {
    it('stores the hook (subsequent sendMessage uses it)', async () => {
      const client = setup.mountClient('sid-hook')
      const hook = vi.fn(async () => ({ blocked: false }))
      setup.service.setSendMessageHook(hook)
      await setup.service.sendMessage('sid-hook', 'x')
      expect(hook).toHaveBeenCalledWith('sid-hook', 'x')
    })
  })

  describe('destroyAll', () => {
    it('detaches, calls pm.destroyAll, clears map', async () => {
      const { id: id1 } = await setup.seedSession({ label: 's1' })
      const { id: id2 } = await setup.seedSession({ label: 's2' })
      await setup.service.destroyAll()
      expect(setup.pm.destroyAll).toHaveBeenCalledTimes(1)
      expect(setup.service.getSummary(id1)).toBeUndefined()
      expect(setup.service.getSummary(id2)).toBeUndefined()
    })
  })
})

// ───────────────────────────────────────────────────────────────────
// onSessionExit 回调（构造函数注册）
// ───────────────────────────────────────────────────────────────────

describe('SessionService · onSessionExit callback', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  it('constructor registers a callback on pm.onSessionExit', () => {
    expect(setup.pm.onSessionExit).toHaveBeenCalledTimes(1)
    expect(typeof vi.mocked(setup.pm.onSessionExit).mock.calls[0][0]).toBe('function')
  })

  it('on exit: removes session, broadcasts list + session.exited', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 1)
    // session 已移除
    expect(setup.service.getSummary(id)).toBeUndefined()
    // 广播 config.sessions（刷新列表，D1 重命名 session.list → config.sessions）
    const listMsg = findBroadcast(setup, 'config.sessions')
    expect(listMsg).toBeDefined()
    // 广播 session.exited（含 exit code），不再用 message.error（消除双广播 + 语义分离）
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg?.payload).toMatchObject({ sessionId: id, code: 1 })
    expect(String(exitedMsg?.payload.reason)).toContain('code: 1')
    // 不应再广播 message.error（session.exited 取代了它）
    const errMsg = findBroadcast(setup, 'message.error')
    expect(errMsg).toBeUndefined()
  })

  it('on exit: session.exited reason includes stderr when provided', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 1, 'Error: Failed to load extension "bad-ext"')
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg?.payload).toMatchObject({ sessionId: id, code: 1 })
    // reason 含 stderr 内容（诊断价值）
    expect(String(exitedMsg?.payload.reason)).toContain('Failed to load extension')
  })

  it('on exit: session.exited reason is concise when stderr is empty', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 0, '')
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg?.payload).toMatchObject({ sessionId: id, code: 0 })
    expect(String(exitedMsg?.payload.reason)).toBe('Session process exited (code: 0)')
  })

  it('on exit: adapter.detach is invoked (W3: usage listener removed, EventAdapter sole listener)', async () => {
    // 用可观测的 adapter 工厂捕获 detach
    const detachSpy = vi.fn()
    const attachSpy = vi.fn()
    const localSetup = createSetup()
    // 替换 adapterFactory：直接 new 一个带 spy 的 service
    const localService = new SessionService(
      localSetup.pm,
      localSetup.broker,
      () => ({ attach: attachSpy, detach: detachSpy }),
      '/tmp',
      localSetup.extensionService,
      new PiConfigStore(),
      new PiSessionStore(),
      localSetup.gitInfoReader,
      { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as unknown as ConstructorParameters<typeof SessionService>[8],
    )
    const piSid = 'pi-detach-1'
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()，返回归一后的 state 对象
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
      }),
    })
    vi.mocked(localSetup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    localSetup.clientMap.set(piSid, client)
    await localService.create(tmpdir(), 'l')
    expect(attachSpy).toHaveBeenCalledTimes(1)
    localSetup.triggerExit(piSid, 0)
    expect(detachSpy).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the exited session is unknown', async () => {
    setup.triggerExit('ghost', 0)
    // 不应该广播 session.exited（只有已知 session 才广播）
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg).toBeUndefined()
  })
})

// ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写迁移的安全守卫回归 ──
// 背景：write-session-image / migrate-session-image / write-segments-metadata 三个 IPC handler
// 从 main 迁到 runtime session-service（WS：session.writeImage/migrateImage/writeSegments）时，
// 原 Electron 测试（apps/electron/main/test/privileged-handlers.test.ts，-476 行）未随迁，
// 安全守卫（20MB 上限 / mimeType image/* / name sanitize 防目录穿越 / fromPath 白名单 /
// segments.json 原子写 + 损坏恢复）失去唯一回归保护。以下用例按 runtime 真实 API 签名
// （service 直接调用，非 IPC handler 形态）移植，断言强度与原用例一致（TC3 零削弱）。
//
// 真实文件 I/O：writeImage/migrateImage/writeSegmentsMetadata 写真实 attachments/tmpdir 文件，
// 测试读回校验后清理。不 mock node:fs/os/path——这些模块 mock 会破坏同文件其他用例。
// dataDir 由 vitest globalSetup 的 XYZ_AGENT_DATA_DIR 指向 tmp 目录，不会污染用户数据。
describe('SessionService · 业务持久化写安全守卫（W2 ipc-converge-a3 移植）', () => {
  let service: SessionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = createSetup().service
  })

  const writtenPaths: string[] = []
  afterEach(() => {
    for (const p of writtenPaths.splice(0)) {
      try { rmSync(p) } catch { /* 忽略清理失败 */ }
    }
  })

  describe('writeImage（原 write-session-image IPC handler）', () => {
    it('W3TC3: panel 态（sessionId 非空）→ 写 attachments/<sessionId>/ 返回 {path,fileName,displayName,id,persisted:true}', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
      const result = await service.writeImage('sess-panel-1', bytes.toString('base64'), 'image/png', 'shot.png')
      writtenPaths.push(result.path)
      // path 在 <dataDir>/attachments/sess-panel-1/ 下
      const expectedDir = getAttachmentsDir('sess-panel-1')
      expect(result.path.startsWith(expectedDir)).toBe(true)
      // 文件真实写入 + 内容 round-trip
      expect(existsSync(result.path)).toBe(true)
      expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
      // fileName 是 uuid-shot.png 格式（含 uuid 前缀）
      expect(result.fileName).toMatch(/^[0-9a-f-]+-shot\.png$/)
      // displayName 用 sanitized basename（无 uuid 前缀），用户传 'shot.png' → 'shot.png'
      expect(result.displayName).toBe('shot.png')
      // id 是 uuid 格式
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      // M1：sessionId 非空 → 落 attachments → persisted=true（不需迁移）
      expect(result.persisted).toBe(true)
    })

    it('W3TC4: landing 降级（sessionId 为空）→ 写 tmpdir 返回 {path,fileName,displayName,id,persisted:false}', async () => {
      const bytes = Buffer.from([0x01])
      const result = await service.writeImage('', bytes.toString('base64'), 'image/png', 'x.png')
      writtenPaths.push(result.path)
      // path 在 tmpdir 下（降级路径）
      expect(result.path.startsWith(tmpdir())).toBe(true)
      expect(existsSync(result.path)).toBe(true)
      // id 是 uuid 格式
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      // M1：sessionId 空 → 落 tmpdir → persisted=false（session 创建后需迁移）
      expect(result.persisted).toBe(false)
    })

    it('W3TC5: 非 image/* mimeType → throw「mimeType must start with image/」（ERR1）', async () => {
      await expect(service.writeImage('s1', 'x', 'text/plain', 'x')).rejects.toThrow('mimeType must start with image/')
    })

    it('W3TC6: 超过 20MB → throw「图片过大...20MB」（ERR2 ATTACH_TOO_LARGE）不写文件', async () => {
      const targetBytes = 21 * 1024 * 1024
      const base64Len = Math.ceil((targetBytes * 4) / 3)
      await expect(service.writeImage('s1', 'A'.repeat(base64Len), 'image/png', 'big.png')).rejects.toThrow(/图片过大.*20MB/)
    })

    it('W3TC7: name 含路径分隔符 → sanitize 剥离，path 不逃逸 attachments 目录', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', '../../etc/passwd.png')
      writtenPaths.push(result.path)
      // path 不含穿越片段
      expect(result.path).not.toContain('etc/passwd')
      // path 仍在 attachments/s1 下
      const expectedDir = getAttachmentsDir('s1')
      expect(result.path.startsWith(expectedDir)).toBe(true)
      expect(existsSync(result.path)).toBe(true)
    })

    it('W3TC8: 19MB（上限内）→ 正常写入不 throw', async () => {
      // 用 19MB（上限 20MB 内，留余量避开 base64 padding 估算误差）验证大图正常落地。
      const bytes = Buffer.alloc(19 * 1024 * 1024, 0x01)
      const result = await service.writeImage('s1', bytes.toString('base64'), 'image/png', 'big.png')
      writtenPaths.push(result.path)
      expect(existsSync(result.path)).toBe(true)
    })

    it('mimeType=image/jpeg → ext=jpg', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/jpeg', 'pic')
      writtenPaths.push(result.path)
      expect(result.fileName.endsWith('.jpg')).toBe(true)
      expect(result.displayName.endsWith('.jpg')).toBe(true)
    })

    it('拖拽/+菜单（name 非空）→ displayName 用原 basename（sanitized + .ext）', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', 'photo.png')
      writtenPaths.push(result.path)
      // displayName 用 sanitized basename，无 uuid 前缀
      expect(result.displayName).toBe('photo.png')
      // fileName 含 uuid 前缀
      expect(result.fileName).toMatch(/^[0-9a-f-]+-photo\.png$/)
    })

    it('粘贴截图（name 为空，sanitized 退化 image）→ displayName 形如 截图-YYYYMMDD-HHMM.png', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', '')
      writtenPaths.push(result.path)
      // fileName 仍是 uuid-image.png 形式（uuid 前缀 + 占位 basename）
      expect(result.fileName).toMatch(/^[0-9a-f-]+-image\.png$/)
      // displayName 走截图-时间戳 分支（正则校验，不硬编码时间）
      expect(result.displayName).toMatch(/^截图-\d{8}-\d{4}\.png$/)
    })

    it('写入失败 → throw「write-session-image failed」+ console.error（超长文件名触发 ENAMETOOLONG）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(
        service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', 'a'.repeat(5000)),
      ).rejects.toThrow('write-session-image failed')
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  describe('migrateImage（原 migrate-session-image IPC handler）', () => {
    // 真实文件 I/O：migrate 把 tmpdir 文件 move 到 attachments 目录。
    it('happy path: landing 写 tmpdir 后 migrate 到 attachments/<sessionId>/，原 tmpdir 文件已 move', async () => {
      // 1. landing 态先写 tmpdir（sessionId 为空）
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const writeResult = await service.writeImage('', bytes.toString('base64'), 'image/png', 'shot.png')
      writtenPaths.push(writeResult.path)
      const tmpPath = writeResult.path
      expect(existsSync(tmpPath)).toBe(true)
      // 2. session 创建后 migrate 到真实 sessionId
      const migrateResult = await service.migrateImage(tmpPath, 'sess-real-1', writeResult.fileName)
      writtenPaths.push(migrateResult.path)
      // 新 path 在 attachments 目录下
      const expectedDir = getAttachmentsDir('sess-real-1')
      expect(migrateResult.path.startsWith(expectedDir)).toBe(true)
      expect(migrateResult.path.endsWith(writeResult.fileName)).toBe(true)
      // 新文件存在 + 内容 round-trip
      expect(existsSync(migrateResult.path)).toBe(true)
      expect(Array.from(readFileSync(migrateResult.path))).toEqual(Array.from(bytes))
      // 原 tmpdir 文件已被 move（不存在）—— rename 是 move 不是 copy
      expect(existsSync(tmpPath)).toBe(false)
    })

    it('fromPath 不存在 → reject（throw），可被 catch 降级', async () => {
      const ghostPath = join(tmpdir(), 'definitely-not-exist-' + Date.now() + '.png')
      expect(existsSync(ghostPath)).toBe(false)
      await expect(service.migrateImage(ghostPath, 'sess-1', 'x.png')).rejects.toThrow(/source file not found/)
    })

    it('sessionId 为空 → throw requires non-empty sessionId', async () => {
      // 先写一个 tmpdir 文件让 fromPath 真实存在，验证空 sessionId 早于 fs 检查就 throw
      const writeResult = await service.writeImage('', Buffer.from([0x01]).toString('base64'), 'image/png', 'x.png')
      writtenPaths.push(writeResult.path)
      await expect(service.migrateImage(writeResult.path, '', writeResult.fileName)).rejects.toThrow(
        'migrate-session-image requires non-empty sessionId',
      )
    })

    it('B1: fromPath 在白名单外（home 目录）→ throw，不 move 文件（防任意文件移动）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // 在 home 下造一个文件，尝试迁移（不应被允许——home 既非 tmpdir 也非 attachments）
      const evilFile = join(homedir(), '.xyz-agent-test-evil-' + Date.now() + '.txt')
      writeFileSync(evilFile, 'secret')
      writtenPaths.push(evilFile)
      expect(existsSync(evilFile)).toBe(true)
      await expect(service.migrateImage(evilFile, 'sess-b1', 'leaked.txt')).rejects.toThrow('migrate-session-image failed')
      // 原文件仍在原位（未被 move）
      expect(existsSync(evilFile)).toBe(true)
      // 目标 attachments 目录下没有 leaked.txt
      expect(existsSync(join(getAttachmentsDir('sess-b1'), 'leaked.txt'))).toBe(false)
      errSpy.mockRestore()
    })

    it('B1: fileName 含路径分隔符 → sanitize 剥离，newPath 落在 attachments/<sid>/ 下不穿越', async () => {
      // 先在 tmpdir 造一个 fromPath（合法来源）
      const bytes = Buffer.from([0x01, 0x02])
      const fromPath = join(tmpdir(), 'xyz-test-migrate-' + Date.now() + '.png')
      writeFileSync(fromPath, bytes)
      writtenPaths.push(fromPath)
      // fileName 含穿越片段
      const result = await service.migrateImage(fromPath, 'sess-sanitize', '../../../etc/foo.png')
      writtenPaths.push(result.path)
      // newPath 落在 attachments/sess-sanitize/ 下（starts with 守门，穿越后不会满足）
      const expectedDir = getAttachmentsDir('sess-sanitize')
      expect(result.path.startsWith(expectedDir)).toBe(true)
      // 路径分隔符被剥离——结果路径相对 expectedDir 只剩一个扁平文件名（不含任何 / 或 \ 段）
      const rel = relative(expectedDir, result.path)
      expect(rel).not.toMatch(/[\\/]/)
      // 文件已 move 到 newPath，内容 round-trip
      expect(existsSync(result.path)).toBe(true)
      expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
      expect(existsSync(fromPath)).toBe(false)
    })

    it('B1: sessionId 含 ../ → throw（getAttachmentsDir 校验防路径穿越）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // 在 tmpdir 造合法来源文件（绕过 fromPath 白名单，专门测 sessionId 校验）
      const fromPath = join(tmpdir(), 'xyz-test-migrate-sid-' + Date.now() + '.png')
      writeFileSync(fromPath, Buffer.from([0x01]))
      writtenPaths.push(fromPath)
      await expect(service.migrateImage(fromPath, '../etc', 'x.png')).rejects.toThrow('migrate-session-image failed')
      // 原文件未被 move
      expect(existsSync(fromPath)).toBe(true)
      errSpy.mockRestore()
    })
  })

  describe('writeSegmentsMetadata（原 write-segments-metadata IPC handler）', () => {
    // 真实文件 I/O：复用 writeImage 测试的 tmpdir 清理模式（afterEach rmSync）。
    // 每个用例用独立 sessionId 子目录，互不干扰（getAttachmentsDir 按 sessionId 分区）。
    //
    // 注意：read-segments-metadata handler 已删除（W6），原 round-trip 校验改用 readFileSync
    // 直接读 segments.json 验证落地内容（不再经 IPC read）。
    const writtenDirs: string[] = []
    afterEach(() => {
      for (const d of writtenDirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
      }
    })

    /** 构造一条测试用 segments entry（含 text/image/file 段，覆盖实际 user message 形态） */
    function makeEntry(clientUuid: string, timestamp = 1234567890): SegmentsMetadataEntry {
      return {
        clientUuid,
        segments: [
          { type: 'text', text: '看下这张图' },
          {
            type: 'image',
            id: 'img-id-1',
            path: '/tmp/foo.png',
            fileName: 'foo.png',
            displayName: 'foo.png',
          },
          { type: 'file', path: '/repo/src/index.ts', lineRange: [10, 20] },
        ],
        timestamp,
      }
    }

    /** 读 segments.json 并 parse（替代已删的 read-segments-metadata IPC，纯测试辅助） */
    function readSidecar(sessionId: string): SegmentsMetadataFile {
      const raw = readFileSync(join(getAttachmentsDir(sessionId), 'segments.json'), 'utf-8')
      return JSON.parse(raw) as SegmentsMetadataFile
    }

    it('write 单条 → 落地 segments.json 含该条（round-trip 保真）', async () => {
      const sessionId = 'seg-test-write-read-single'
      writtenDirs.push(getAttachmentsDir(sessionId))

      const entry = makeEntry('u-aaa')
      await service.writeSegmentsMetadata(sessionId, entry)

      const file = readSidecar(sessionId)
      expect(file.version).toBe(1)
      expect(file.entries).toHaveLength(1)
      expect(file.entries[0]).toEqual(entry)
    })

    it('write 多条（不同 clientUuid）→ 落地含全部', async () => {
      const sessionId = 'seg-test-write-multi'
      writtenDirs.push(getAttachmentsDir(sessionId))

      await service.writeSegmentsMetadata(sessionId, makeEntry('u-1', 1000))
      await service.writeSegmentsMetadata(sessionId, makeEntry('u-2', 2000))
      await service.writeSegmentsMetadata(sessionId, makeEntry('u-3', 3000))

      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(3)
      expect(file.entries.map((e) => e.clientUuid).sort()).toEqual(['u-1', 'u-2', 'u-3'])
    })

    it('write 同 clientUuid 两次（editAndResend 场景）→ 后者覆盖前者，不重复', async () => {
      const sessionId = 'seg-test-edit-resend'
      writtenDirs.push(getAttachmentsDir(sessionId))

      const v1 = makeEntry('u-overwrite', 1000)
      const v2 = makeEntry('u-overwrite', 9999)
      // 改 v2 的 segments 内容，验证覆盖的是后者而非前者
      v2.segments = [{ type: 'text', text: 'edited' }]
      await service.writeSegmentsMetadata(sessionId, v1)
      await service.writeSegmentsMetadata(sessionId, v2)

      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(1)
      expect(file.entries[0].timestamp).toBe(9999)
      expect(file.entries[0].segments).toEqual([{ type: 'text', text: 'edited' }])
    })

    it('write 时目录不存在 → 自动创建并写入', async () => {
      const sessionId = 'seg-test-mkdir-' + Date.now()
      const dir = getAttachmentsDir(sessionId)
      writtenDirs.push(dir)
      // 目录不存在
      expect(existsSync(dir)).toBe(false)

      await service.writeSegmentsMetadata(sessionId, makeEntry('u-mkdir'))
      // 目录 + segments.json 已创建
      expect(existsSync(dir)).toBe(true)
      expect(existsSync(join(dir, 'segments.json'))).toBe(true)
      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(1)
    })

    it('write 到已损坏的 segments.json → 重置后写入成功（best-effort，不阻断）', async () => {
      const sessionId = 'seg-test-write-corrupted-' + Date.now()
      const dir = getAttachmentsDir(sessionId)
      writtenDirs.push(dir)
      // 先构造损坏文件
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'segments.json'), '{corrupted!!!', 'utf-8')

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // write 不抛（捕获了 parse 错误 → 重置为新文件 → 写入成功）
      await service.writeSegmentsMetadata(sessionId, makeEntry('u-recover'))
      warnSpy.mockRestore()

      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(1)
      expect(file.entries[0].clientUuid).toBe('u-recover')
    })

    it('write 空 sessionId → throw requires non-empty sessionId', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(service.writeSegmentsMetadata('', makeEntry('u-x'))).rejects.toThrow(
        'write-segments-metadata requires non-empty sessionId',
      )
      errSpy.mockRestore()
    })

    it('atomic 写：临时文件 .tmp 写完才 rename（写后 .tmp 不残留）', async () => {
      const sessionId = 'seg-test-atomic-' + Date.now()
      const dir = getAttachmentsDir(sessionId)
      writtenDirs.push(dir)

      await service.writeSegmentsMetadata(sessionId, makeEntry('u-atomic'))
      // segments.json 存在，.tmp 不残留（已 rename 走）
      expect(existsSync(join(dir, 'segments.json'))).toBe(true)
      expect(existsSync(join(dir, 'segments.json.tmp'))).toBe(false)
    })
  })
})
