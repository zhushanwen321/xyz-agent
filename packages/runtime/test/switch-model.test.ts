/**
 * W1 / L7: switchModel 对未激活 session 的处理（fail-fast + 无 client 不假装成功）。
 *
 * 背景：
 * - session 不在 sessions Map 时原实现静默 return sessionId（假装成功），前端无感知。
 * - session 在 Map 但无活跃 pi 进程（client 不存在）时，原实现仍写缓存 + 广播
 *   state_changed，导致前端收到「模型已切」的假信号（实际 pi 进程没切）。
 *
 * 修复：
 * - session 不存在 → throw Error('session not active')（fail-fast，调用方据 .code 引导）。
 * - client 不存在 → 跳过缓存写和广播，return sessionId（不假装成功）。
 *
 * 运行：cd packages/runtime && npx vitest run test/switch-model.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

// pi-provider-store: 控制默认 model 配置（测试主路径需要 model 已配置）
const providerMocks = vi.hoisted(() => ({
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAll: vi.fn(),
}))
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: providerMocks.refreshAll,
    getDefaultModel: () => providerMocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => [] }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/xyz-agent/pi/agent' }
})
vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: vi.fn((raw: unknown) => raw) }))
vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]),
}))

import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

/** 一份最小测试装置：service + 各 mock 依赖。 */
function createService() {
  const clientMap = new Map<string, IPiEngine>()

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn(),
    hasClient: vi.fn((id: string) => clientMap.has(id)),
    rekey: vi.fn(),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
  } as unknown as IProcessManager

  const broker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  const extensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (): IEventAdapter => ({ attach: vi.fn(), detach: vi.fn() })
  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }
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

  return { service, pm, broker, clientMap }
}

function makeClient(): IPiEngine {
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
    sendCommand: vi.fn().mockResolvedValue({ data: {} }),
    switchSession: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({}),
    getCommands: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn(() => () => {}),
    onExit: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPiEngine
}

/** 从 broadcast 调用里找指定 type 的消息。 */
function findBroadcast(broker: IMessageBroker, type: ServerMessage['type']): ServerMessage | undefined {
  for (const call of vi.mocked(broker.broadcast).mock.calls) {
    if (call[0].type === type) return call[0] as ServerMessage
  }
  return undefined
}

describe('W1/L7: switchModel fail-fast & 无 client 不假装成功', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
  })

  it('U2: session 不在 Map → throw Error（不静默返回 sessionId）', async () => {
    const { service } = createService()
    await expect(service.switchModel('nonexistent', 'provider', 'model'))
      .rejects.toThrow('session not active')
  })

  it('U3: session 在 Map 但无 client → 不写缓存、不广播，返回 sessionId', async () => {
    const { service, pm, broker, clientMap } = createService()
    // 1. 建立一个 session（会进 sessions Map 且挂 client）
    const seedState = { sessionId: 's1', sessionFile: '/fake/s1.jsonl' }
    const client = makeClient()
    vi.mocked(client.getState).mockResolvedValue(seedState)
    vi.mocked(pm.createSession).mockResolvedValueOnce(client)
    clientMap.set('s1', client)
    await service.create('/tmp', 'seed')
    expect(service.getSummary('s1')).toBeDefined()

    // 2. 模拟 pi 进程已退出：从 clientMap 移除，getClient 返回 undefined
    clientMap.delete('s1')
    vi.mocked(pm.getClient).mockReturnValue(undefined)
    const beforeModelId = service.getSummary('s1')?.modelId
    expect(beforeModelId).toBeDefined()
    vi.mocked(broker.broadcast).mockClear()

    // 3. switchModel 应 fail-skip：不写缓存、不广播
    const returned = await service.switchModel('s1', 'new', 'model')
    expect(returned).toBe('s1')
    // modelId 未被改写（未假装成功）
    expect(service.getSummary('s1')?.modelId).toBe(beforeModelId)
    // 未广播 session.state_changed（不广播假信号）
    expect(findBroadcast(broker, 'session.state_changed')).toBeUndefined()
  })
})
