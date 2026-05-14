import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillInfo } from '@xyz-agent/shared'

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
    .filter(([event]: [string]) => event === 'exit')
    .map(([, handler]: [string, Function]) => handler)[0]
    if (exitHandler) exitHandler(0)
  })
  return fakeProc
  },
}))

// Mock config-store to control loadSkills / getDefaultModel / buildProviderEnv
const mockSkills: SkillInfo[] = []
vi.mock('../src/config-store.js', () => ({
  loadSkills: (_cwd: string) => mockSkills,
  getDefaultModel: () => 'test/provider-model',
  buildProviderEnv: () => ({} as Record<string, string>),
}))

// Mock fs.existsSync to control path validation
const existingPaths = new Set<string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existingPaths.has(p),
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

// Mock node:os — keep all real exports, override homedir
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
  ...actual,
  homedir: () => '/mock/home',
  }
})

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
  const { SessionPool } = await import('../src/session-pool.js')

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

  // Only skillDirA and skillDirB exist on filesystem
  existingPaths.add(skillDirA)
  existingPaths.add(skillDirB)
  // skillDirC exists but skill is disabled — should be filtered by enabled check
  existingPaths.add(skillDirC)
  // /nonexistent doesn't exist — should be filtered by existsSync

  const pool = new SessionPool()
  // getSkillPaths is private, but it's called inside createSession → pm.createSession
  // We test via the side effect: create() spawns a process with correct --skill args
  try {
    await pool.create('/project')
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
  const { SessionPool } = await import('../src/session-pool.js')

  // No skills configured
  const pool = new SessionPool()
  try {
    await pool.create('/empty-project')
  } catch {
    // expected
  }

  expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
  const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
  expect(skillArgs).toEqual([])
  })

  it('skills with empty sourcePath are skipped', async () => {
  const { SessionPool } = await import('../src/session-pool.js')

  mockSkills.push(
  { id: 'x', name: 'X', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: undefined },
  { id: 'y', name: 'Y', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: '' },
  )

  const pool = new SessionPool()
  try {
  await pool.create('/project')
  } catch {
  // expected
  }

  expect(spawnArgsCapture.length).toBeGreaterThanOrEqual(1)
  const skillArgs = extractSkillArgs(spawnArgsCapture[0].args)
  expect(skillArgs).toEqual([])
  })

  it('restoreSession passes skillPaths to spawned process', async () => {
  const { SessionPool } = await import('../src/session-pool.js')

  const skillDirA = '/project/.agents/skills/skill-a'
  const skillFileA = `${skillDirA}/SKILL.md`

  mockSkills.push(
  { id: 'a', name: 'A', description: '', enabled: true, source: 'pi', triggers: [], sourcePath: skillFileA },
  )
  existingPaths.add(skillDirA)

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

  const pool = new SessionPool()
  try {
  await pool.restoreSession('existing-session-id')
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
