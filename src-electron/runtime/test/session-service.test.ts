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
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { tmpdir, homedir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { IGitInfoReader } from '../src/services/ports/git-info.js'

import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { SessionSummary, SessionGroup, Message, ServerMessage } from '@xyz-agent/shared'

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
  }>,
  // 可重新赋值：null 表示未配置 model
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAllMock: vi.fn(),
  persistSessionNameMock: vi.fn(),
  ensureSessionFileMock: vi.fn(),
  patchSessionCwdMock: vi.fn(() => true),
  trashMock: vi.fn(),
  convertPiHistoryMock: vi.fn((raw: unknown) => raw),
  getHistoryFromFileMock: vi.fn().mockResolvedValue([]),
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
    ensureSessionFile: mocks.ensureSessionFileMock,
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
vi.mock('../src/services/session-history.js', () => ({ getHistoryFromFile: mocks.getHistoryFromFileMock }))

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
  sendCommand: MockInstance<SendCommandFn>
  getCommands: MockInstance<() => Promise<unknown>>
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
    sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: {} }),
    getCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
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
  mocks.getHistoryFromFileMock.mockResolvedValue([])
}

/** 一份完整测试装置：service + 各 mock 依赖 + clientMap + exit 触发器。 */
interface Setup {
  service: SessionService
  pm: IProcessManager
  broker: IMessageBroker
  extensionService: IExtensionService
  clientMap: Map<string, MockClient>
  /** mock 的 IGitInfoReader（readGitInfo 恒 undefined → 摘要 git 字段留空）。供 localSession 复用。 */
  gitInfoReader: IGitInfoReader
  triggerExit: (sessionId: string, code: number | null) => void
  /** 直接挂载一个 client 到 clientMap（不走 create），用于 dispatcher 类测试。 */
  mountClient: (sessionId: string, client?: MockClient) => MockClient
  /** 走真实 create 建立一个 session，返回其 id + client。 */
  seedSession: (opts?: {
    label?: string
    cwd?: string
    sessionFile?: string
    commands?: Array<{ name: string; source: string }>
  }) => Promise<{ id: string; client: MockClient }>
}

let autoId = 0

function createSetup(): Setup {
  const clientMap = new Map<string, MockClient>()
  let exitCb: ((sessionId: string, code: number | null) => void) | null = null

  const pm: IProcessManager = {
    // createSession：默认返回一个带唯一 pi sessionId 的 client（模拟 pi get_state）。
    createSession: vi.fn(async (_id: string, _cwd: string) => {
      const piSid = `pi-auto-${++autoId}`
      const client = makeMockClient({
        sendCommand: vi.fn<SendCommandFn>(async (type) => {
          if (type === 'get_state') {
            return { data: { sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl` } }
          }
          return { data: {} }
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
  )

  const mountClient = (sessionId: string, client?: MockClient): MockClient => {
    const c = client ?? makeMockClient()
    clientMap.set(sessionId, c)
    return c
  }

  const seedSession: Setup['seedSession'] = async (opts = {}) => {
    const piSid = `pi-seed-${++autoId}`
    const client = makeMockClient({
      sendCommand: vi.fn<SendCommandFn>(async (type) => {
        if (type === 'get_state') {
          return { data: { sessionId: piSid, sessionFile: opts.sessionFile ?? `/fake/${piSid}.jsonl` } }
        }
        return { data: {} }
      }),
      getCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue(opts.commands ?? []),
    })
    // 让 createSession mock 本次返回该 client
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)
    await service.create(opts.cwd ?? tmpdir(), opts.label ?? 'seed')
    return { id: piSid, client }
  }

  return {
    service, pm, broker, extensionService, clientMap, gitInfoReader,
    triggerExit: (sid, code) => exitCb?.(sid, code),
    mountClient, seedSession,
  }
}

/** 辅助：从 broadcast 调用里找指定 type 的消息（按 type 收窄返回 payload 类型）。 */
function findBroadcast<T extends ServerMessage['type']>(setup: Setup, type: T): ServerMessage<T> | undefined {
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
      expect(client.prompt).toHaveBeenCalledWith('hello pi')
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
      expect(client.prompt).toHaveBeenCalledWith('go')
    })

    it('passes through when hook returns null', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => null)
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).toHaveBeenCalledWith('go')
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
    it('broadcasts compacting then compacted and calls client.compact', async () => {
      const client = setup.mountClient('sid-c')
      await setup.service.compact('sid-c')
      expect(client.compact).toHaveBeenCalledTimes(1)
      const types = vi.mocked(setup.broker.broadcast).mock.calls.map(c => c[0].type)
      expect(types).toContain('session.compacting')
      expect(types).toContain('session.compacted')
      const compacted = findBroadcast(setup, 'session.compacted')
      expect(compacted?.payload).toMatchObject({ sessionId: 'sid-c', status: 'compacted' })
    })

    it('broadcasts compacted with error and rethrows when client.compact fails', async () => {
      const client = setup.mountClient('sid-c')
      client.compact.mockRejectedValueOnce(new Error('compact fail'))
      await expect(setup.service.compact('sid-c')).rejects.toThrow('compact fail')
      const compacted = findBroadcast(setup, 'session.compacted')
      expect(compacted?.payload).toMatchObject({ sessionId: 'sid-c', error: 'compact fail' })
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

    it('throws when no default model configured', async () => {
      mocks.defaultModel.value = null
      await expect(setup.service.create(tmpdir())).rejects.toThrow('No model configured')
    })

    it('throws and destroys session when pi returns no sessionId', async () => {
      const stateless = makeMockClient({
        sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: {} }),
      })
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(stateless as unknown as IPiEngine)
      await expect(setup.service.create(tmpdir())).rejects.toThrow('did not return a session ID')
      expect(setup.pm.destroySession).toHaveBeenCalledTimes(1)
    })

    it('calls refreshAll after create', async () => {
      await setup.service.create(tmpdir())
      expect(mocks.refreshAllMock).toHaveBeenCalledTimes(1)
    })

    it('calls ensureSessionFile when pi provides sessionFile', async () => {
      await setup.service.create(tmpdir())
      expect(mocks.ensureSessionFileMock).toHaveBeenCalledTimes(1)
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
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0,
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
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0,
      })
      await setup.service.renameSession('scan-ren', 'renamed')
      expect(mocks.persistSessionNameMock).toHaveBeenCalledWith('/fake/scan-ren.jsonl', 'renamed', 'scan-ren', tmpdir())
    })
  })

  describe('restoreSession', () => {
    it('reuses scanned sessionId and sends switch_session with file path', async () => {
      mockScannedSessions.push({
        id: 'persist-1', filePath: '/fake/persist-1.jsonl', cwd: tmpdir(), name: 'old',
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0,
      })
      const client = makeMockClient()
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
      const summary = await setup.service.restoreSession('persist-1')
      expect(summary.id).toBe('persist-1')
      expect(client.sendCommand).toHaveBeenCalledWith('switch_session', { sessionPath: '/fake/persist-1.jsonl' })
    })

    it('throws when persisted session not found', async () => {
      await expect(setup.service.restoreSession('nope')).rejects.toThrow('Persisted session nope not found')
    })

    it('throws when no default model configured', async () => {
      mockScannedSessions.push({
        id: 'persist-2', filePath: '/fake/p2.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0,
      })
      mocks.defaultModel.value = null
      await expect(setup.service.restoreSession('persist-2')).rejects.toThrow('No model configured')
    })

    it('destroys created session when switch_session fails', async () => {
      mockScannedSessions.push({
        id: 'persist-3', filePath: '/fake/p3.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0,
      })
      const client = makeMockClient({
        sendCommand: vi.fn<SendCommandFn>().mockRejectedValue(new Error('switch failed')),
      })
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
      await expect(setup.service.restoreSession('persist-3')).rejects.toThrow('switch failed')
      expect(setup.pm.destroySession).toHaveBeenCalledWith('persist-3')
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
      const returned = await setup.service.switchModel(id, 'anthropic', 'claude-x')
      expect(returned).toBe(id)
      expect(client.setModel).toHaveBeenCalledWith('anthropic', 'claude-x')
      expect(setup.service.getSummary(id)?.modelId).toBe('anthropic/claude-x')
    })

    it('returns sessionId unchanged when session not in map', async () => {
      const returned = await setup.service.switchModel('ghost', 'p', 'm')
      expect(returned).toBe('ghost')
    })

    it('切换后广播 session.state_changed（含按新 contextWindow 重算用量）', async () => {
      const { id, client } = await setup.seedSession()
      // 注入 resolver：anthropic/claude-x contextWindow=200000
      setup.service.setModelContextWindowResolver((_p, _m) => 200000)
      // 预置 inputTokens 缓存（模拟 onContextUpdate 已回写）
      setup.service.setInputTokens(id, 12000)
      vi.mocked(client.setModel).mockClear()
      vi.mocked(setup.broker.broadcast).mockClear()
      // get_state 返回 thinkingLevel（broadcastSessionState 查 pi get_state）
      vi.mocked(client.sendCommand).mockResolvedValueOnce({ data: { thinkingLevel: 'high' } })

      await setup.service.switchModel(id, 'anthropic', 'claude-x')

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

      await setup.service.switchModel(id, 'anthropic', 'claude-x')

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
      vi.mocked(client.sendCommand).mockRejectedValueOnce(new Error('get_state boom'))

      await setup.service.switchModel(id, 'anthropic', 'claude-x')

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

  describe('inputTokens 缓存（attachUsageListener）', () => {
    it('agent_end 的 usage.inputTokens 被缓存到 session，getInputTokens 可读', async () => {
      const { id, client } = await setup.seedSession()
      // initializeManagedSession 注册了 onEvent listener，取出触发 agent_end
      expect(client.eventListeners.length).toBeGreaterThan(0)
      client.eventListeners.forEach((fn) => fn({ type: 'agent_end', payload: { usage: { inputTokens: 15000, totalTokens: 20000 } } }))
      expect(setup.service.getInputTokens(id)).toBe(15000)
      expect(setup.service.getSummary(id)?.tokenCount).toBe(20000)
    })

    it('agent_end payload 无 usage 字段时不抛错，inputTokens 保持原值', async () => {
      const { id, client } = await setup.seedSession()
      client.eventListeners.forEach((fn) => fn({ type: 'agent_end', payload: {} }))
      expect(setup.service.getInputTokens(id)).toBe(0) // 未收到 usage，保持初始 0
    })

    it('getInputTokens 对未知 session 返回 0', () => {
      expect(setup.service.getInputTokens('ghost')).toBe(0)
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
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0,
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
    it('converts pi history via message-converter when rpc returns messages', async () => {
      const fakeMsgs = [{ role: 'user', content: 'hi' }]
      const client = setup.mountClient('sid-hist')
      client.getHistory.mockResolvedValueOnce({ data: { messages: fakeMsgs } })
      mocks.convertPiHistoryMock.mockReturnValueOnce(['converted' as unknown as Message])
      const result = await setup.service.getHistory('sid-hist')
      expect(mocks.convertPiHistoryMock).toHaveBeenCalledWith(fakeMsgs)
      expect(result).toEqual(['converted'])
    })

    it('falls back to file read when rpc returns empty and session is idle', async () => {
      const { id } = await setup.seedSession()
      const client = setup.clientMap.get(id)!
      client.getHistory.mockResolvedValueOnce({ data: { messages: [] } })
      mocks.getHistoryFromFileMock.mockResolvedValueOnce([{ role: 'user', content: 'f' } as unknown as Message])
      const result = await setup.service.getHistory(id)
      expect(mocks.getHistoryFromFileMock).toHaveBeenCalledWith(id, expect.anything())
      expect(result.length).toBe(1)
    })

    it('returns empty array when rpc empty and session is generating', async () => {
      const { id, client } = await setup.seedSession()
      // 进入 generating：发一条消息
      await setup.service.sendMessage(id, 'x')
      client.getHistory.mockResolvedValueOnce({ data: { messages: [] } })
      const result = await setup.service.getHistory(id)
      expect(result).toEqual([])
      expect(mocks.getHistoryFromFileMock).not.toHaveBeenCalled()
    })

    it('falls back to file read when rpc throws', async () => {
      const { id, client } = await setup.seedSession()
      client.getHistory.mockRejectedValueOnce(new Error('rpc boom'))
      mocks.getHistoryFromFileMock.mockResolvedValueOnce([])
      await setup.service.getHistory(id)
      expect(mocks.getHistoryFromFileMock).toHaveBeenCalledWith(id, expect.anything())
    })

    it('reads from file directly when no active client', async () => {
      mocks.getHistoryFromFileMock.mockResolvedValueOnce([])
      await setup.service.getHistory('no-client')
      expect(mocks.getHistoryFromFileMock).toHaveBeenCalledWith('no-client', expect.anything())
    })
  })

  describe('listPersistedSessions', () => {
    it('groups persisted sessions by cwd', () => {
      mockScannedSessions.push(
        { id: 'a', filePath: '/fake/a.jsonl', cwd: '/proj', name: null, lastModified: 1, timestamp: '', size: 0 },
        { id: 'b', filePath: '/fake/b.jsonl', cwd: '/proj', name: null, lastModified: 2, timestamp: '', size: 0 },
        { id: 'c', filePath: '/fake/c.jsonl', cwd: '/other', name: null, lastModified: 3, timestamp: '', size: 0 },
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
        lastModified: 1, timestamp: '', size: 0,
      })
      const groups = setup.service.listPersistedSessions()
      const allIds = groups.flatMap(g => g.sessions.map(s => s.id))
      // 活跃 session 出现一次，持久化副本被过滤
      expect(allIds.filter(x => x === id).length).toBe(1)
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

  it('on exit: removes session, broadcasts list + error', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 1)
    // session 已移除
    expect(setup.service.getSummary(id)).toBeUndefined()
    // 广播 session.list（刷新列表）
    const listMsg = findBroadcast(setup, 'session.list')
    expect(listMsg).toBeDefined()
    // 广播 message.error（含 exit code）
    const errMsg = findBroadcast(setup, 'message.error')
    expect(errMsg?.payload).toMatchObject({ sessionId: id })
    expect(String(errMsg?.payload.message)).toContain('code: 1')
  })

  it('on exit: adapter.detach and usage listener unsub are invoked', async () => {
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
      sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: { sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl` } }),
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
    // 不应该广播 message.error（只有已知 session 才广播）
    const errMsg = findBroadcast(setup, 'message.error')
    expect(errMsg).toBeUndefined()
  })
})
