import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillInfo } from '@xyz-agent/shared'
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

// Mock config-store for getDefaultModel / buildProviderEnv
vi.mock('../src/config-store.js', () => ({
  getDefaultModel: () => 'test/provider-model',
  buildProviderEnv: () => ({} as Record<string, string>),
}))

// Mock skill-store for loadSkills
const mockSkills: SkillInfo[] = []
vi.mock('../src/skill-store.js', () => ({
  loadSkills: (_cwd: string) => mockSkills,
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

// Mock session-label-store
vi.mock('../src/session-label-store.js', () => ({
  saveLabel: vi.fn(),
  removeLabel: vi.fn(),
  migrateLabelsIfNeeded: vi.fn(),
}))

// Mock agent-store
vi.mock('../src/agent-store.js', () => ({
  loadAgents: vi.fn().mockReturnValue([]),
  saveAgents: vi.fn(),
}))

// Mock model-db
vi.mock('../src/model-db.js', () => ({
  lookupPiProvider: vi.fn().mockReturnValue(undefined),
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
  mockSkills.length = 0
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
  const adapterFactory = () => ({ attach: vi.fn(), detach: vi.fn() })
  return new SessionService(pm, noopBroker as never, adapterFactory, '/tmp')
}

// ── Tests ──────────────────────────────────────────────────────────

describe('skillPaths passing chain', () => {
  beforeEach(() => {
  resetMocks()
  })

  it('RpcClient passes --skill args for each skillPath', async () => {
  // Import after mocks are set up
  const { RpcClient } = await import('../src/rpc-client.js')

  const client = new RpcClient({
    cwd: '/project',
    skillPaths: ['/skills/skill-a', '/skills/skill-b'],
  })

  // start() will call spawn; it will reject due to immediate exit, catch is ok
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

  it('getSkillPaths collects enabled skill dirs, skips non-existent paths', async () => {
  const service = await createSessionService()

  // Set up mock skills: 3 enabled, 1 disabled, 1 non-existent path
  const skillDirA = '/project/.agents/skills/skill-a'
  const skillDirB = '/project/.agents/skills/skill-b'
  const skillDirC = '/project/.agents/skills/skill-c'
  const skillFileA = `${skillDirA}/SKILL.md`
  const skillFileB = `${skillDirB}/SKILL.md`
  const skillFileC = `${skillDirC}/SKILL.md`

  mockSkills.push(
  { id: 'a', name: 'A', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: skillFileA },
  { id: 'b', name: 'B', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: skillFileB },
  { id: 'c', name: 'C', description: '', enabled: false, source: 'pi', triggers: [], sourcePath: skillFileC },
  { id: 'd', name: 'D', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: '/nonexistent/skill-d/SKILL.md' },
  )

  // Only skillDirA and skillDirB exist on filesystem (dir + SKILL.md)
  existingPaths.add(path.normalize(skillDirA))
  existingPaths.add(path.normalize(skillFileA))
  existingPaths.add(path.normalize(skillDirB))
  existingPaths.add(path.normalize(skillFileB))
  // skillDirC exists but skill is disabled — should be filtered by enabled check
  existingPaths.add(path.normalize(skillDirC))
  existingPaths.add(path.normalize(skillFileC))
  // /nonexistent doesn't exist — should be filtered by existsSync

  // getSkillPaths is called inside create() → pm.createSession
  try {
    await service.create('/project')
  } catch {
    // create() calls get_state which fails since our mock proc exits immediately
    // but the spawn call has already happened by then
  }

  // Verify spawn was called with --skill args for A and B only
  expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
  const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
  expect(skillArgs).toEqual([skillDirA, skillDirB])
  })

  it('no --skill args when no enabled skills exist', async () => {
  const service = await createSessionService()

  // No skills configured
  try {
    await service.create('/empty-project')
  } catch {
    // expected
  }

  expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
  const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
  expect(skillArgs).toEqual([])
  })

  it('skills with empty sourcePath are skipped', async () => {
  const service = await createSessionService()

  mockSkills.push(
  { id: 'x', name: 'X', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: undefined },
  { id: 'y', name: 'Y', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: '' },
  )

  try {
  await service.create('/project')
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
  const skillFileA = `${skillDirA}/SKILL.md`

  mockSkills.push(
  { id: 'a', name: 'A', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: skillFileA },
  )
  existingPaths.add(path.normalize(skillDirA))
  existingPaths.add(path.normalize(skillFileA))

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
  // but the spawn call has already happened
  }

  // restoreSession should have spawned with skill args
  expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
  const lastSpawn = spawnArgsCapture[spawnArgsCapture.length - 1]
  const skillArgs = extractSkillArgs(lastSpawn.args)
  expect(skillArgs).toEqual([skillDirA])
  })
})
