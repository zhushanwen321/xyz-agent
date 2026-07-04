import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

// IGitInfoReader 桩：本测试聚焦 skill 路径解析，不验证 git 摘要字段。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

// ── Mocks ──────────────────────────────────────────────────────────

// Mock child_process.spawn to capture spawn args
const spawnArgsCapture: { args: string[]; cwd: string | undefined }[] = []
vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[], options: { cwd?: string }) => {
    spawnArgsCapture.push({ args: [...args], cwd: options?.cwd })
    const fakeProc = {
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn() },
      kill: vi.fn(),
    }
    // Immediately emit 'exit' with code 0 on next tick to satisfy start() startup check
    process.nextTick(() => {
      const exitHandler = fakeProc.on.mock.calls
        .filter((call: unknown[]) => call[0] === 'exit')
        .map((call: unknown[]) => call[1] as (...args: unknown[]) => void)[0]
      if (exitHandler) exitHandler(0)
    })
    return fakeProc
  },
}))

// Mock pi-config-bridge — the central config module
const mockSkillPaths: string[] = []
const mockScannedSessions: Array<{
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
}> = []
// pi-config-bridge 已拆分：model/settings → pi-provider-store，session 扫描 → session-file-utils，
// 路径 → pi-paths。按实际 import 来源 mock 各符号（其余实现保留原模块）。
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
    getSkillPaths: () => mockSkillPaths,
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
    refreshAll: () => {},
  }
})
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => mockScannedSessions, patchSessionCwd: () => true }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/pi/agent',
  }
})

// Mock fs.existsSync to control path validation
const existingPaths = new Set<string>([path.normalize('/project')])
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existingPaths.has(path.normalize(p)),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now(), size: 0 })),
  unlinkSync: vi.fn(),
}))

// Mock trash
vi.mock('../src/infra/system/trash.js', () => ({
  trash: vi.fn(),
}))

// Mock @xyz-agent/shared barrel — provide constants needed by rpc-client
vi.mock('@xyz-agent/shared', () => ({
  ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'NODE_', 'NVM_', 'XYZ_', 'XDG_', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP'],
}))

// Mock @xyz-agent/shared/paths — getDataDir 被 pi-paths 子路径 import（Node-only，隔离于 barrel）
vi.mock('@xyz-agent/shared/paths', () => ({
  getDataDir: () => '/mock/home/.xyz-agent',
}))

// Mock node:os — keep all real exports, override homedir
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => '/mock/home',
  }
})

// Mock event-adapter for SessionService
vi.mock('../src/infra/pi/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
    attach = vi.fn()
    detach = vi.fn()
  },
}))

// ── Helpers ────────────────────────────────────────────────────────

/** Extract --skill values from spawn args array */
function extractSkillArgs(args: string[]): string[] {
  const skills: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skill' && i + 1 < args.length) {
      skills.push(args[i + 1])
    }
  }
  return skills
}

function resetMocks(): void {
  mockSkillPaths.length = 0
  spawnArgsCapture.length = 0
  existingPaths.clear()
  mockScannedSessions.length = 0
}

/** Create a SessionService with mocked deps */
async function createSessionService() {
  const { ProcessManager } = await import('../src/infra/pi/process-manager.js')
  const { SessionService } = await import('../src/services/session/session-service.js')
  const pm = new ProcessManager('/tmp')
  const noopBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
  return new SessionService(pm, noopBroker as never, () => ({ attach: vi.fn(), detach: vi.fn() }), '/tmp', { getExtensionPaths: vi.fn().mockResolvedValue([]) } as never, new PiConfigStore(), new PiSessionStore(), noopGitInfoReader, {} as never)
}

// ── Tests ──────────────────────────────────────────────────────────

describe('skillPaths passing chain', () => {
  let savedPackaged: string | undefined

  beforeAll(() => {
    savedPackaged = process.env.XYZ_AGENT_PACKAGED
    delete process.env.XYZ_AGENT_PACKAGED
  })

  afterAll(() => {
    if (savedPackaged !== undefined) process.env.XYZ_AGENT_PACKAGED = savedPackaged
  })

  beforeEach(() => {
    resetMocks()
  })

  it('RpcClient passes --skill args for each skillPath', async () => {
    const { RpcClient } = await import('../src/infra/pi/rpc-client.js')

    const client = new RpcClient({
      cwd: '/project',
      skillPaths: ['/skills/skill-a', '/skills/skill-b'],
    })

    try { await client.start() } catch { /* expected: immediate exit */ }

    expect(spawnArgsCapture.length).toBe(1)
    const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
    expect(skillArgs).toEqual(['/skills/skill-a', '/skills/skill-b'])
  })

  it('RpcClient omits --skill when skillPaths is empty', async () => {
    const { RpcClient } = await import('../src/infra/pi/rpc-client.js')

    const client = new RpcClient({ cwd: '/project', skillPaths: [] })

    try { await client.start() } catch { /* expected */ }

    expect(spawnArgsCapture.length).toBe(1)
    const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
    expect(skillArgs).toEqual([])
  })

  it('RpcClient omits --skill when skillPaths is undefined', async () => {
    const { RpcClient } = await import('../src/infra/pi/rpc-client.js')

    const client = new RpcClient({ cwd: '/project' })

    try { await client.start() } catch { /* expected */ }

    expect(spawnArgsCapture.length).toBe(1)
    const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
    expect(skillArgs).toEqual([])
  })

  it('getSkillPaths passes configured skill dirs to spawned process', async () => {
    const service = await createSessionService()

    const skillDirA = '/project/.agents/skills/skill-a'
    const skillDirB = '/project/.agents/skills/skill-b'

    // pi-config-bridge.getSkillPaths() returns these paths directly
    mockSkillPaths.push(skillDirA, skillDirB)

    // These paths must "exist" on filesystem for validation
    existingPaths.add(path.normalize(skillDirA))
    existingPaths.add(path.normalize(skillDirB))

    try {
      await service.create('/project')
    } catch {
      // create() calls get_state which fails since mock proc exits immediately
    }

    expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
    const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
    expect(skillArgs).toEqual([skillDirA, skillDirB])
  })

  it('no --skill args when no skill paths configured', async () => {
    const service = await createSessionService()

    // No skill paths configured
    try {
      await service.create('/empty-project')
    } catch {
      // expected
    }

    expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
    const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
    expect(skillArgs).toEqual([])
  })

  it('restoreSession passes skillPaths to spawned process', async () => {
    const service = await createSessionService()

    const skillDirA = '/project/.agents/skills/skill-a'
    mockSkillPaths.push(skillDirA)
    // 路径必须“存在”于文件系统才能通过 existsSync 过滤
    existingPaths.add(path.normalize(skillDirA))

    // Set up a scanned session for restoreSession to find
    mockScannedSessions.push({
      id: 'existing-session-id',
      filePath: '/mock/home/.xyz-agent/sessions/test.jsonl',
      cwd: '/project',
      timestamp: new Date().toISOString(),
      name: null,
      lastModified: Date.now(),
      size: 100,
    })

    try {
      await service.restoreSession('existing-session-id')
    } catch {
      // restoreSession calls switch_session which fails since mock proc exits
    }

    // restoreSession should have spawned with skill args
    expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
    const lastSpawn = spawnArgsCapture[spawnArgsCapture.length - 1]
    const skillArgs = extractSkillArgs(lastSpawn.args)
    expect(skillArgs).toEqual([skillDirA])
  })
})
