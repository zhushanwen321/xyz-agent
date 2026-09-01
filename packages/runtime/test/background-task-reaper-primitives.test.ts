/**
 * 后台任务收殓器原语与 fs 错误分支测试（test/background-task-reaper.test.ts 的补充面，
 * 覆盖其依赖注入 mock 所绕过的真实实现路径）。
 *
 * 覆盖：
 * - killProcessTree（POSIX）：非法 pid 早退 / 进程组 kill(-pid) 成功早退 / 组长已死降级
 *   单 pid + killDescendantsRecursive 递归（先杀孙辈再杀子辈的顺序断言）/ kill 幂等
 *   已死仅诊断 / pgrep 不可用放弃枚举
 * - killProcessTree（Windows）：taskkill /F /T /PID 参数断言 / taskkill 失败仅诊断不抛
 * - getProcessStartTimeSec：ps 正常解析 lstart → epoch 秒 / 输出不可解析 / spawnSync
 *   抛异常 / result.error / status!==0 / 空 stdout 均返回 undefined（调用方保守跳过契约）
 * - registry/fs 错误分支（经真实入口 reapSessionBackgroundTasks /
 *   reapAllSessionsBackgroundTasks 触发）：读失败按空表继续 / corrupt 隔离 rename 失败
 *   原文件保留原位 / 终态写 tmp 落盘失败条目停留 running / rename 失败且 tmp 清理
 *   双诊断 / ②补杀分支终态写失败 / 触发面 A 目录级异常 / 触发面 B baseDir 读失败
 *   （非 ENOENT warn）/ 单目录扫描异常跳过 / stale reaper.lock 残留非空（ENOTEMPTY）
 *
 * Mock 边界（对齐 test/scan-pi-sessions-cache.test.ts 惯例——ESM 下 vi.spyOn(node:fs)
 * 不可用，node:fs / node:child_process 用 importOriginal 部分 mock，默认全数委托真实
 * 实现，用例内按路径条件注入失败）：process.kill 用 vi.spyOn（对象方法可 spy），
 * process.platform 用 Object.defineProperty 临时改写。
 *
 * 运行：cd packages/runtime && npx vitest run test/background-task-reaper-primitives.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'
import {
  killProcessTree,
  getProcessStartTimeSec,
  reapSessionBackgroundTasks,
  reapAllSessionsBackgroundTasks,
  type BackgroundTaskReapDeps,
  type BackgroundTaskReapResult,
} from '../src/services/session/background-task-reaper.js'

// ── node:child_process 部分 mock：spawnSync 全接管（ps / pgrep / taskkill 均不真跑）──
const childMock = vi.hoisted(() => ({ spawnSync: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: childMock.spawnSync }
})

// ── node:fs 部分 mock：错误分支注入接缝（默认委托真实实现）──
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  actual: null as unknown as typeof import('node:fs'),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMock.actual = actual
  // 工厂内即设默认委托：被测模块图（含 load 期）任何 fs 调用都先拿到真实行为
  fsMock.existsSync.mockImplementation(actual.existsSync)
  fsMock.readFileSync.mockImplementation(actual.readFileSync)
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync)
  fsMock.renameSync.mockImplementation(actual.renameSync)
  fsMock.unlinkSync.mockImplementation(actual.unlinkSync)
  fsMock.readdirSync.mockImplementation(actual.readdirSync)
  return {
    ...actual,
    existsSync: fsMock.existsSync,
    readFileSync: fsMock.readFileSync,
    writeFileSync: fsMock.writeFileSync,
    renameSync: fsMock.renameSync,
    unlinkSync: fsMock.unlinkSync,
    readdirSync: fsMock.readdirSync,
  }
})

const realPlatform = process.platform

/** 本次测试创建的 tmp 目录（afterEach 统一清理）。 */
const tmpAgentDirs: string[] = []

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-task-reaper-primitives-'))
  tmpAgentDirs.push(dir)
  return dir
}

/** fs mock 复位为全数委托真实实现（用例内覆写后的双保险复位）。 */
function delegateFsToReal(): void {
  const a = fsMock.actual
  fsMock.existsSync.mockImplementation(a.existsSync)
  fsMock.readFileSync.mockImplementation(a.readFileSync)
  fsMock.writeFileSync.mockImplementation(a.writeFileSync)
  fsMock.renameSync.mockImplementation(a.renameSync)
  fsMock.unlinkSync.mockImplementation(a.unlinkSync)
  fsMock.readdirSync.mockImplementation(a.readdirSync)
}

beforeEach(() => {
  // mockClear 只清 calls/results 不清 implementation：默认委托不受影响
  vi.clearAllMocks()
  delegateFsToReal()
})

afterEach(() => {
  delegateFsToReal()
  childMock.spawnSync.mockReset()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  for (const dir of tmpAgentDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 临时改写 process.platform（win32 分支在非 Windows 测试机上可达）。 */
function stubProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function errnoLike(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

// ── fixture helper（与 test/background-task-reaper.test.ts 同形，此处独立维护最小面）──

interface DepsFixture {
  alivePids: Set<number>
  startTimes: Map<number, number>
  killCalls: number[]
  deps: BackgroundTaskReapDeps
}

function makeDeps(): DepsFixture {
  const alivePids = new Set<number>()
  const startTimes = new Map<number, number>()
  const killCalls: number[] = []
  return {
    alivePids,
    startTimes,
    killCalls,
    deps: {
      isPidAlive: (pid) => alivePids.has(pid),
      killProcessTree: (pid) => { killCalls.push(pid) },
      getProcessStartTimeSec: (pid) => startTimes.get(pid),
    },
  }
}

function makeEntry(overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: 'bt-1',
    pid: 1111,
    command: 'sleep 300',
    outputFile: '/tmp/bt-out.log',
    startedAt: 1_700_000_000_000,
    state: 'running',
    ownerPiPid: 2222,
    sessionId: 's1',
    ...overrides,
  }
}

function registryPathOf(agentDir: string, sessionId: string): string {
  return join(agentDir, 'base-tool-enhance', sessionId, 'registry.json')
}

function writeRegistryFile(agentDir: string, sessionId: string, entries: unknown[], version = 1): string {
  const p = registryPathOf(agentDir, sessionId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify({ version, entries }, null, 2)}\n`)
  return p
}

function zeroResult(): BackgroundTaskReapResult {
  return { scannedDirs: 0, ownerAliveSkipped: 0, killedOrphans: 0, finalizedOrphans: 0, conservativelySkipped: 0, staleLocksRemoved: 0 }
}

// ── killProcessTree（POSIX 进程组路径）─────────────────────────

describe('killProcessTree · POSIX 路径', () => {
  it.skipIf(process.platform === 'win32')('非法 pid（0 / 负数 / 非整数）直接 return：不发 kill、不 spawn 子进程', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      killProcessTree(0)
      killProcessTree(-5)
      killProcessTree(1.5)
      expect(killSpy).not.toHaveBeenCalled()
      expect(childMock.spawnSync).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('进程组 kill(-pid) 成功 → 发令即返回，不做子孙枚举', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      killProcessTree(4321)
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL')
      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(childMock.spawnSync).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('组长已死（组 kill ESRCH）→ 降级单 pid kill + pgrep 递归子孙（先孙辈子辈顺序）', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid < 0) throw errnoLike('ESRCH', 'process group gone')
      return true
    })
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    // 进程树：4321 → {5100, 5101}；5100 → 5200（孙辈）；其余 pgrep 无子
    childMock.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      const target = args[1]
      if (target === '4321') return { status: 0, stdout: '5100\n5101\n' }
      if (target === '5100') return { status: 0, stdout: '5200\n' }
      return { status: 1, stdout: '' }
    })
    try {
      killProcessTree(4321)
      // kill 调用序列（含失败尝试）：组 kill(-4321) 抛错降级 → 单 kill(4321) →
      // 子孙递归先杀孙辈 5200 再杀子辈 5100（防孙辈 reparent 逃逸枚举的顺序保证）
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321, 5200, 5100, 5101])
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('process group kill missed, falling back to single pid + descendants'),
        expect.any(String),
      )
    } finally {
      killSpy.mockRestore()
      debugSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('单 pid kill 与子孙 kill 均已死（幂等语义）→ 仅诊断不抛；pgrep 输出非 pid 行跳过', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoLike('ESRCH', 'already dead')
    })
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    childMock.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === '4321') return { status: 0, stdout: '5100\nnot-a-pid\n\n' }
      return { status: 1, stdout: '' }
    })
    try {
      expect(() => killProcessTree(4321)).not.toThrow()
      // 非 pid 行（NaN / 空行）被 parseInt guard 跳过，只对 5100 发 kill
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321, 5100])
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('single pid kill missed (already dead?)'), expect.any(String))
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('descendant kill missed (already dead?)'), expect.any(String))
    } finally {
      killSpy.mockRestore()
      debugSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('pgrep 抛异常（不可用）→ 放弃子孙枚举仅诊断', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid < 0) throw errnoLike('ESRCH', 'process group gone')
      return true
    })
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    childMock.spawnSync.mockImplementation(() => {
      throw new Error('pgrep gone')
    })
    try {
      expect(() => killProcessTree(4321)).not.toThrow()
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321])
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('descendant enumeration failed'), expect.any(String))
    } finally {
      killSpy.mockRestore()
      debugSpy.mockRestore()
    }
  })
})

// ── killProcessTree（Windows taskkill 路径）─────────────────────────

describe('killProcessTree · Windows taskkill 路径', () => {
  it('win32 平台 → taskkill /F /T /PID 发令（参数逐项断言）', () => {
    stubProcessPlatform('win32')
    childMock.spawnSync.mockReturnValue({ status: 0, error: undefined, stdout: null, stderr: null })
    killProcessTree(777)
    expect(childMock.spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore', windowsHide: true })
  })

  it('taskkill 失败（进程已死/权限）→ 仅诊断不抛（收殓路径不中断）', () => {
    stubProcessPlatform('win32')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    childMock.spawnSync.mockReturnValue({ status: 128, error: new Error('not found'), stdout: null, stderr: null })
    try {
      expect(() => killProcessTree(777)).not.toThrow()
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('taskkill failed'), expect.any(String))
    } finally {
      debugSpy.mockRestore()
    }
  })
})

// ── getProcessStartTimeSec（ps 探测原语）─────────────────────────

describe('getProcessStartTimeSec · ps 探测（失败一律 undefined → 调用方保守跳过）', () => {
  it('ps 正常：lstart 解析为 epoch 秒（floor），参数带 5s 超时', () => {
    childMock.spawnSync.mockReturnValue({ status: 0, error: undefined, stdout: 'Mon Aug 25 14:23:45 2026\n' })
    const sec = getProcessStartTimeSec(999)
    expect(sec).toBe(Math.floor(Date.parse('Mon Aug 25 14:23:45 2026') / 1000))
    expect(childMock.spawnSync).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '999'], { encoding: 'utf8', timeout: 5_000 })
  })

  it('lstart 输出不可解析（Date.parse NaN）→ undefined', () => {
    childMock.spawnSync.mockReturnValue({ status: 0, error: undefined, stdout: 'garbage output' })
    expect(getProcessStartTimeSec(999)).toBeUndefined()
  })

  it('spawnSync 抛异常 → undefined（catch 兜底）', () => {
    childMock.spawnSync.mockImplementation(() => {
      throw new Error('ps exploded')
    })
    expect(getProcessStartTimeSec(999)).toBeUndefined()
  })

  it('result.error / status!==0 / 空 stdout 三态 → 均为 undefined', () => {
    childMock.spawnSync.mockReturnValueOnce({ status: null, error: new Error('spawn failed'), stdout: '' })
    expect(getProcessStartTimeSec(999)).toBeUndefined()
    childMock.spawnSync.mockReturnValueOnce({ status: 1, error: undefined, stdout: '' })
    expect(getProcessStartTimeSec(999)).toBeUndefined()
    childMock.spawnSync.mockReturnValueOnce({ status: 0, error: undefined, stdout: '' })
    expect(getProcessStartTimeSec(999)).toBeUndefined()
  })
})

// ── registry / fs 错误分支（真实入口 + 条件失败注入）─────────────────────────

describe('registry 读写错误分支（收殓不因 fs 问题崩溃）', () => {
  it('registry 读失败（EACCES）→ 按空表继续 + warn，结果全零', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      const p = writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.readFileSync.mockImplementation((path: unknown, enc?: unknown) => {
        if (path === p) throw errnoLike('EACCES', 'permission denied')
        return fsMock.actual.readFileSync(path as string, enc as 'utf8')
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registry read failed, treating as empty'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('corrupt 隔离 rename 失败（目录只读等）→ 原文件保留原位 + warn，仍按空表继续', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      const p = writeRegistryFile(agentDir, 's1', [makeEntry()])
      writeFileSync(p, '{not valid json', 'utf8')
      fsMock.renameSync.mockImplementation((from: unknown, to: unknown) => {
        if (from === p) throw errnoLike('EACCES', 'read-only file system')
        return fsMock.actual.renameSync(from as string, to as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
      // 隔离失败：现场保留原位（不覆盖、不丢失）
      expect(fsMock.actual.existsSync(p)).toBe(true)
      expect(fsMock.actual.readFileSync(p, 'utf8')).toBe('{not valid json')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry corrupted and quarantine rename failed, continuing with empty table in place'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('终态写 tmp 落盘失败 → 条目停留 running + conservativelySkipped（下个收殓事件重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()]) // 属主死 + 任务死 → ③ 收尾写失败
      fsMock.writeFileSync.mockImplementation((path: unknown, data: unknown) => {
        if (String(path).includes('.tmp_')) throw errnoLike('EACCES', 'disk full')
        return fsMock.actual.writeFileSync(path as string, data as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry orphaned-terminal write failed; entry stays as-is'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('终态写 rename 失败且 tmp 清理也失败 → 双诊断均落日志、写失败仍正确上报', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.renameSync.mockImplementation((from: unknown, to: unknown) => {
        if (String(from).includes('.tmp_')) throw errnoLike('EACCES', 'read-only file system')
        return fsMock.actual.renameSync(from as string, to as string)
      })
      fsMock.unlinkSync.mockImplementation((path: unknown) => {
        if (String(path).includes('.tmp_')) throw errnoLike('EPERM', 'unlink denied')
        return fsMock.actual.unlinkSync(path as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result.conservativelySkipped).toBe(1)
      // tmp 清理失败不掩盖原错误：两条 warn 都在（tmp cleanup + orphaned-terminal write failed）
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registry tmp cleanup failed'), expect.any(String))
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry orphaned-terminal write failed; entry stays as-is'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('②补杀分支终态写失败 → kill 已发令但计数 conservativelySkipped（killedOrphans 守恒）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const fixture = makeDeps()
      fixture.alivePids.add(1111)
      fixture.startTimes.set(1111, 123_456)
      writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })])
      fsMock.writeFileSync.mockImplementation((path: unknown, data: unknown) => {
        if (String(path).includes('.tmp_')) throw errnoLike('EACCES', 'disk full')
        return fsMock.actual.writeFileSync(path as string, data as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', fixture.deps)

      expect(fixture.killCalls).toEqual([1111]) // kill 已发令
      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── 触发面 A/B 目录级错误跳过 ─────────────────────────

describe('目录级错误跳过（warn 后不中断、不外抛）', () => {
  it('触发面 A：registry 探测本身抛错（existsSync 异常）→ 目录级 catch 兜底，结果正常返回', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.existsSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith('registry.json')) throw errnoLike('EACCES', 'stat denied')
        return fsMock.actual.existsSync(path as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session dir reap failed, skipping dir: s1'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('触发面 B：baseDir 读失败（非 ENOENT，如 EACCES）→ warn 放弃本轮、全零结果', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.readdirSync.mockImplementation(() => {
        throw errnoLike('EACCES', 'permission denied')
      })

      const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

      expect(result).toEqual(zeroResult())
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('base dir unreadable, skipping this scan'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('触发面 B：单目录扫描异常 → warn 跳过该目录，不中断其余目录扫描', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      writeRegistryFile(agentDir, 's2', [makeEntry()])
      fsMock.existsSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith('registry.json')) throw errnoLike('EACCES', 'stat denied')
        return fsMock.actual.existsSync(path as string)
      })

      const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

      // 两个目录都已计入扫描且都被跳过（错误容忍：不中断整体）
      expect(result).toEqual({ ...zeroResult(), scannedDirs: 2 })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session dir scan failed, skipping dir: s1'), expect.any(String))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session dir scan failed, skipping dir: s2'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('stale reaper.lock 残留目录非空（ENOTEMPTY）→ warn 留给下次启动，staleLocksRemoved 不计', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      const lockDir = join(agentDir, 'base-tool-enhance', 'reaper.lock')
      mkdirSync(lockDir, { recursive: true })
      writeFileSync(join(lockDir, 'leftover'), 'x', 'utf8')
      const stale = new Date(Date.now() - 60_000)
      utimesSync(lockDir, stale, stale)

      const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

      expect(result.staleLocksRemoved).toBe(0)
      expect(fsMock.actual.existsSync(lockDir)).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('stale reaper.lock removal failed, leaving it for next startup'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
