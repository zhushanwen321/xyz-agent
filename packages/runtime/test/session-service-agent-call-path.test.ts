/**
 * SessionService.getAgentCallFilePath 测试。
 *
 * 与 getAgentCallHistory 对称，但返回绝对路径字符串（找不到返回空串，不 throw——
 * overlay 文件名是展示型功能，找不到不应阻断 UI）。
 *
 * 测试点：
 * - 正常：subagents 目录有匹配 sessionId 的文件 → 返回绝对路径
 * - 边界 1：主 session 不存在 → 空串
 * - 边界 2：subagents 目录不存在 → 空串
 * - 边界 3：目录下无匹配 sessionId 的文件 → 空串
 *
 * 运行：cd packages/runtime && npx vitest run test/session-service-agent-call-path.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  parseSessionHeaderMock: vi.fn(),
  getSubagentSessionDirMock: vi.fn(),
}))

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => mocks.mockScannedSessions,
    parseSessionHeader: mocks.parseSessionHeaderMock,
  }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSubagentSessionDir: mocks.getSubagentSessionDirMock,
  }
})

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSyncMock,
  readdirSync: mocks.readdirSyncMock,
}))

vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: vi.fn(),
    getDefaultModel: () => ({ provider: 'test', modelId: 'test' }),
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})

vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: vi.fn((r) => r) }))

import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

const { mockScannedSessions } = mocks

function createService(): SessionService {
  const pm = {
    getClient: vi.fn(() => null),
    list: vi.fn(() => []),
    createSession: vi.fn(),
    destroySession: vi.fn(),
    hasClient: vi.fn(() => false),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(),
  } as never
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as never
  const adapterFactory = vi.fn(() => ({ attach: vi.fn(), detach: vi.fn() })) as never
  const extensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) } as never
  const gitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as never
  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as never
  return new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService,
  )
}

describe('SessionService.getAgentCallFilePath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockScannedSessions.length = 0
  })

  it('U1: 正常 → 返回匹配文件的绝对路径', async () => {
    mockScannedSessions.push({
      id: 'main-sess-001',
      filePath: '/mock/sessions/main.jsonl',
      cwd: '/project',
      name: null,
      lastModified: 0,
      timestamp: '2026-07-13T00:00:00Z',
      size: 0,
    })
    mocks.getSubagentSessionDirMock.mockReturnValue('/mock/subagents/enc/sessions')
    mocks.existsSyncMock.mockReturnValue(true)
    mocks.readdirSyncMock.mockReturnValue(['2026-07-13T05-41-22-097Z_019f59fe.jsonl'])
    mocks.parseSessionHeaderMock.mockReturnValue({
      id: 'agentcall-001',
      cwd: '/project',
      timestamp: '2026-07-13T05:41:22Z',
    })

    const service = createService()
    const result = await service.getAgentCallFilePath('main-sess-001', 'agentcall-001')

    expect(result).toBe('/mock/subagents/enc/sessions/2026-07-13T05-41-22-097Z_019f59fe.jsonl')
  })

  it('U2: 主 session 不存在 → 空串（不 throw）', async () => {
    const service = createService()
    const result = await service.getAgentCallFilePath('nonexistent', 'agentcall-001')
    expect(result).toBe('')
  })

  it('U3: subagents 目录不存在 → 空串（不 throw）', async () => {
    mockScannedSessions.push({
      id: 'main-sess-003',
      filePath: '/mock/sessions/main.jsonl',
      cwd: '/project',
      name: null,
      lastModified: 0,
      timestamp: '2026-07-13T00:00:00Z',
      size: 0,
    })
    mocks.getSubagentSessionDirMock.mockReturnValue('/mock/subagents/enc/sessions')
    mocks.existsSyncMock.mockReturnValue(false)

    const service = createService()
    const result = await service.getAgentCallFilePath('main-sess-003', 'agentcall-001')
    expect(result).toBe('')
  })

  it('U4: 目录下无匹配 sessionId 的文件 → 空串（不 throw）', async () => {
    mockScannedSessions.push({
      id: 'main-sess-004',
      filePath: '/mock/sessions/main.jsonl',
      cwd: '/project',
      name: null,
      lastModified: 0,
      timestamp: '2026-07-13T00:00:00Z',
      size: 0,
    })
    mocks.getSubagentSessionDirMock.mockReturnValue('/mock/subagents/enc/sessions')
    mocks.existsSyncMock.mockReturnValue(true)
    mocks.readdirSyncMock.mockReturnValue(['a.jsonl', 'b.jsonl'])
    mocks.parseSessionHeaderMock.mockReturnValue({ id: 'other-001', cwd: '/p', timestamp: '2026-07-13T00:00:00Z' })

    const service = createService()
    const result = await service.getAgentCallFilePath('main-sess-004', 'agentcall-001')
    expect(result).toBe('')
  })
})
