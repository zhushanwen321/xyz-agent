import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

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

// Mock config-store — only toolPermissions remains; getDefaultModel moved to pi-config-bridge
vi.mock('../src/config-store.js', () => ({
  loadToolPermissions: () => ({ autoApprove: [], deny: [] }),
  saveToolPermissions: vi.fn(),
  getDefaultTemperature: () => undefined,
}))

// Mock pi-config-bridge — the central config module
const mockSkillPaths: string[] = []
vi.mock('../src/pi-config-bridge.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
  getSkillPaths: () => mockSkillPaths,
  getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
  readModels: () => ({ providers: {} }),
  readSettings: () => ({}),
  scanPiSessions: () => mockScannedSessions,
}))

// Mock fs.existsSync to control path validation
const existingPaths = new Set<string>()
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

// Mock session-scanner to control scanned sessions
const mockScannedSessions: Array<{
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
}> = []
vi.mock('../src/session-scanner.js', () => ({
  scanSessions: () => mockScannedSessions,
  deleteSessionFile: vi.fn(),
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
vi.mock('../src/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
    attach = vi.fn()
    detach = vi.fn()
    setNavigateResolver = vi.fn()
    clearNavigateResolver = vi.fn()
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
  const { ProcessManager } = await import('../src/process-manager.js')
  const { SessionService } = await import('../src/services/session-service.js')
  const pm = new ProcessManager()
  const noopBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
  const adapterFactory = () => ({ attach: vi.fn(), detach: vi.fn(), setNavigateResolver: vi.fn(), clearNavigateResolver: vi.fn() })
  return new SessionService(pm, noopBroker as never, adapterFactory, '/tmp')
}

// ── Tests ──────────────────────────────────────────────────────────

describe('skillPaths passing chain', () => {
  beforeEach(() => {
    resetMocks()
  })

  it('RpcClient passes --skill args for each skillPath', async () => {
    const { RpcClient } = await import('../src/rpc-client.js')

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
    const { RpcClient } = await import('../src/rpc-client.js')

    const client = new RpcClient({ cwd: '/project', skillPaths: [] })

    try { await client.start() } catch { /* expected */ }

    expect(spawnArgsCapture.length).toBe(1)
    const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
    expect(skillArgs).toEqual([])
  })

  it('RpcClient omits --skill when skillPaths is undefined', async () => {
    const { RpcClient } = await import('../src/rpc-client.js')

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
