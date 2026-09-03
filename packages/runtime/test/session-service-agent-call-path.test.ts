/**
 * SessionService.getAgentCallFilePath 测试。
 *
 * 同 getAgentCallHistory：agent call 是 subagent，经 record.sessionFile 定位（subagentId → record）。
 * 返回路径字符串，找不到 record / 无 sessionFile / 路径穿越 → 空串（展示型功能，不 throw）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-service-agent-call-path.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SubagentRecord } from '@xyz-agent/shared'

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => [], parseSessionHeader: vi.fn() }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/tmp/pi-agent' }
})
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
import type { SessionRecords } from '../src/services/session/session-records.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

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

/** S6 迁移：getSubagents 实现落位 session-records，观察点随迁到 records 实例。 */
function recordsRef(service: SessionService): SessionRecords {
  return (service as unknown as { records: SessionRecords }).records
}

describe('SessionService.getAgentCallFilePath', () => {
  beforeEach(() => vi.clearAllMocks())

  it('record 有 sessionFile（在 piAgentDir 下）→ 返回路径', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([
      { subagentId: 'sa-001', sessionFile: '/tmp/pi-agent/subagents/enc/sa-001.jsonl' } as SubagentRecord,
    ])
    const result = await service.getAgentCallFilePath('main-sess', 'sa-001')
    expect(result).toBe('/tmp/pi-agent/subagents/enc/sa-001.jsonl')
  })

  it('找不到 record → 空串', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([])
    expect(await service.getAgentCallFilePath('main-sess', 'sa-missing')).toBe('')
  })

  it('record 无 sessionFile（null）→ 空串', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([
      { subagentId: 'sa-001', sessionFile: null } as SubagentRecord,
    ])
    expect(await service.getAgentCallFilePath('main-sess', 'sa-001')).toBe('')
  })

  it('sessionFile 路径穿越（不在 piAgentDir 下）→ 空串（isStrictlyUnder 安全校验）', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([
      { subagentId: 'sa-001', sessionFile: '/etc/passwd' } as SubagentRecord,
    ])
    expect(await service.getAgentCallFilePath('main-sess', 'sa-001')).toBe('')
  })
})
