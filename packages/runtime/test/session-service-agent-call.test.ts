/**
 * SessionService.getAgentCallHistory 测试。
 *
 * 验证：agent call JSONL 在 subagents/<encodedCwd>/sessions/ 目录下（不在主 sessions 目录），
 * getAgentCallHistory 通过 findAgentCallFile 在该目录按 sessionId 查找文件。
 *
 * 测试点：
 * - 正常：主 session 有 cwd + subagents 目录有匹配 sessionId 的文件 → 返回转换后消息
 * - 边界 1：主 session 不存在 → 空数组
 * - 边界 2：主 session 无 cwd → 空数组
 * - 边界 3：subagents 目录不存在 → 空数组
 * - 边界 4：目录下无匹配 sessionId 的文件 → 空数组
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@xyz-agent/shared'

// ── vi.hoisted mock 句柄 ──────────────────────────────────────────
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
  getHistoryFromFilePathMock: vi.fn().mockResolvedValue([]),
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
  getHistoryFromFilePath: mocks.getHistoryFromFilePathMock,
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

describe('SessionService.getAgentCallHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockScannedSessions.length = 0
  })

  it('正常：subagents 目录有匹配 sessionId 的文件 → getHistoryFromFilePath 转换返回', async () => {
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
    mocks.readdirSyncMock.mockReturnValue(['2026-07-13T05-41-22-097Z_019f59fe.jsonl', 'other.jsonl'])
    // 第一个文件匹配，第二个不匹配
    mocks.parseSessionHeaderMock
      .mockReturnValueOnce({ id: 'agentcall-001', cwd: '/project', timestamp: '2026-07-13T05:41:22Z' })
      .mockReturnValueOnce({ id: 'wrong-id', cwd: '/other', timestamp: '2026-07-13T06:00:00Z' })
    const fakeMessages: Message[] = [
      { id: 'm1', role: 'user', content: 'hello', status: 'complete', timestamp: 1689222883000 },
    ]
    mocks.getHistoryFromFilePathMock.mockResolvedValue(fakeMessages)

    const service = createService()
    const result = await service.getAgentCallHistory('main-sess-001', 'agentcall-001')

    expect(result).toEqual(fakeMessages)
    // 确认用 subagent session 目录而非 scanSessions
    expect(mocks.getSubagentSessionDirMock).toHaveBeenCalledWith('/project')
    expect(mocks.getHistoryFromFilePathMock).toHaveBeenCalledWith(
      '/mock/subagents/enc/sessions/2026-07-13T05-41-22-097Z_019f59fe.jsonl',
      expect.anything(),
    )
  })

  it('Fail-fast：主 session 不存在 → throw（不静默返回空数组）', async () => {
    const service = createService()
    await expect(service.getAgentCallHistory('nonexistent', 'agentcall-001')).rejects.toThrow(
      '主 session nonexistent 不存在',
    )
    expect(mocks.getSubagentSessionDirMock).not.toHaveBeenCalled()
  })

  it('Fail-fast：主 session 无 cwd → throw', async () => {
    mockScannedSessions.push({
      id: 'main-sess-002',
      filePath: '/mock/sessions/main.jsonl',
      cwd: '',
      name: null,
      lastModified: 0,
      timestamp: '2026-07-13T00:00:00Z',
      size: 0,
    })
    const service = createService()
    await expect(service.getAgentCallHistory('main-sess-002', 'agentcall-001')).rejects.toThrow(
      '无 cwd',
    )
  })

  it('Fail-fast：subagents 目录不存在 → throw', async () => {
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
    await expect(service.getAgentCallHistory('main-sess-003', 'agentcall-001')).rejects.toThrow(
      '未找到 agent call 的 session 文件',
    )
  })

  it('Fail-fast：目录下无匹配 sessionId 的文件 → throw', async () => {
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
    mocks.parseSessionHeaderMock
      .mockReturnValue({ id: 'other-001', cwd: '/p', timestamp: '2026-07-13T00:00:00Z' })

    const service = createService()
    await expect(service.getAgentCallHistory('main-sess-004', 'agentcall-001')).rejects.toThrow(
      '未找到 agent call 的 session 文件',
    )
    expect(mocks.getHistoryFromFilePathMock).not.toHaveBeenCalled()
  })
})
