/**
 * Runtime 层 worktree 功能单元测试 —— TDD 红灯阶段。
 *
 * 实现尚未落地，本文件 import 的三个模块路径都还不存在：
 * - services/worktree/workspace-detector.ts (WorkspaceDetector)
 * - infra/shell-runner.ts                    (ShellRunner)
 * - services/worktree/worktree-service.ts    (WorktreeService)
 *
 * 跑 `npx vitest run src/__tests__/worktree-service.test.ts` 应该因 import 解析失败而全红 —— 这是 TDD 正常红灯。
 *
 * 覆盖矩阵：
 *   WorkspaceDetector  WD-1 / WD-2 / WD-3
 *   ShellRunner        SR-1 / SR-2 / SR-3
 *   WorktreeService    WS-1 ~ WS-7
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { join, sep } from 'node:path'

// 实现尚未存在 —— 以下 import 在红灯阶段必然 fail。
import { WorkspaceDetector } from '../services/worktree/workspace-detector.js'
import { ShellRunner } from '../infra/shell-runner.js'
import { ShellRunnerError } from '../services/ports/shell-runner.js'
import { WorktreeService } from '../services/worktree/worktree-service.js'
import type { IGitExecutor } from '../services/ports/git-executor.js'
import type { IGitInfoReader } from '../services/ports/git-info.js'
import type { IShellRunner } from '../services/ports/shell-runner.js'

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造一段假 spawn child（EventEmitter 模拟 stdout/stderr/close）
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: (signal?: string) => void
    killed: boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = (signal?: string) => {
    child.killed = true
    // kill 后由测试侧决定何时发 'close'（模拟超时场景在 close 前 advance timer）
    void signal
  }
  return child
}

// 把 posix 风格 mock 路径转成当前平台绝对路径，避免 macOS/linux 差异影响断言。
function platform(p: string): string {
  return p.split('/').join(sep)
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceDetector
// ─────────────────────────────────────────────────────────────────────────────
describe('WorkspaceDetector', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('WD-1: 从 .bare 的深层子目录向上找到 .bare，返回 isBareMode=true 与正确路径', async () => {
    const wsRoot = platform('/ws')
    const barePath = platform('/ws/.bare')
    const deepCwd = platform('/ws/feat-x/src')

    const statMock = vi.fn((p: string) => {
      // 仅 .bare 目录视为存在
      if (p === barePath) return { isDirectory: () => true }
      const err = new Error('not found') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    vi.doMock('node:fs', () => ({
      statSync: statMock,
      readFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
    }))
    const mod = await import('node:fs')
    vi.resetModules()

    const detector = new WorkspaceDetector(mod as any)
    const result = detector.detect(deepCwd)

    expect(result.isBareMode).toBe(true)
    expect(result.wsRoot).toBe(wsRoot)
    expect(result.barePath).toBe(barePath)
  })

  it('WD-2: 当前 cwd 下无 .bare（普通 git clone），返回 isBareMode=false', async () => {
    const cwd = platform('/home/me/normal-repo/src')

    const statMock = vi.fn(() => {
      const err = new Error('not found') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    vi.doMock('node:fs', () => ({
      statSync: statMock,
      readFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
    }))
    const mod = await import('node:fs')

    const detector = new WorkspaceDetector(mod as any)
    const result = detector.detect(cwd)

    expect(result.isBareMode).toBe(false)
  })

  it('WD-3: currentCwd 就是 workspace 根（.bare 的父目录），正确检测', async () => {
    const wsRoot = platform('/ws')
    const barePath = platform('/ws/.bare')

    const statMock = vi.fn((p: string) => {
      if (p === barePath) return { isDirectory: () => true }
      const err = new Error('not found') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    vi.doMock('node:fs', () => ({
      statSync: statMock,
      readFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
    }))
    const mod = await import('node:fs')

    const detector = new WorkspaceDetector(mod as any)
    const result = detector.detect(wsRoot)

    expect(result.isBareMode).toBe(true)
    expect(result.wsRoot).toBe(wsRoot)
    expect(result.barePath).toBe(barePath)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ShellRunner
// ─────────────────────────────────────────────────────────────────────────────
describe('ShellRunner', () => {
  let spawnMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useRealTimers()
    spawnMock = vi.fn()
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('node:child_process')
  })

  it('SR-1: 正常执行 exitCode=0，onOutput 收到 stdout/stderr 行，返回累积输出', async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake)

    const { spawn } = await import('node:child_process')
    const runner = new ShellRunner({ spawn: spawn as any })

    const onOutput = vi.fn()
    const promise = runner.execute({
      scriptPath: '/hooks/setup.sh',
      args: ['/ws/new'],
      cwd: '/ws/new',
      onOutput,
    })

    // 模拟 stdout/stderr 逐行输出
    fake.stdout.emit('data', Buffer.from('line1\nline2\n'))
    fake.stderr.emit('data', Buffer.from('warn-line\n'))
    fake.emit('close', 0)

    const result = await promise

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('line1')
    expect(result.stdout).toContain('line2')
    expect(result.stderr).toContain('warn-line')
    // onOutput 至少收到 stdout 与 stderr 两种流
    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('line1'), 'stdout')
    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('warn-line'), 'stderr')
  })

  it('SR-2: 脚本不存在（ENOENT）抛 ShellRunnerError(code=not_found)', async () => {
    const fake = makeFakeChild()
    spawnMock.mockImplementation(() => {
      // spawn 立即在下一 tick 触发 error(ENOENT)
      process.nextTick(() => fake.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return fake
    })

    const { spawn } = await import('node:child_process')
    const runner = new ShellRunner({ spawn: spawn as any })

    await expect(
      runner.execute({ scriptPath: '/nope/setup.sh', cwd: '/ws/new' }),
    ).rejects.toMatchObject({ name: 'ShellRunnerError', code: 'not_found' })
  })

  it('SR-3: 超时抛 ShellRunnerError(code=timeout)', async () => {
    vi.useFakeTimers()
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake)

    const { spawn } = await import('node:child_process')
    const runner = new ShellRunner({ spawn: spawn as any })

    const promise = runner.execute({
      scriptPath: '/hooks/slow.sh',
      cwd: '/ws/new',
      timeout: 5000,
    })

    // 推进到超过 timeout
    vi.advanceTimersByTime(6000)
    // 触发进程被 kill 后的 close（timeout 路径在实现里发 SIGTERM）
    fake.emit('close', null)

    await expect(promise).rejects.toMatchObject({ name: 'ShellRunnerError', code: 'timeout' })
  })

  // SR-4: SIGTERM 后未 close → SIGKILL 升级（防孤儿进程）
  it('SR-4: 超时后先 SIGTERM，5s 未 close 则升级 SIGKILL', async () => {
    vi.useFakeTimers()
    const fake = makeFakeChild()
    // 记录收到的 signal 序列（不自动 close，模拟脚本 trap 忽略 SIGTERM）
    const signals: string[] = []
    fake.kill = (signal?: string) => {
      if (signal) signals.push(signal)
      fake.killed = true
      // 不 emit close —— SIGTERM 被忽略，只有 SIGKILL 后才 close（测试手动触发）
    }
    spawnMock.mockReturnValue(fake)

    const { spawn } = await import('node:child_process')
    const runner = new ShellRunner({ spawn: spawn as any })

    const promise = runner.execute({
      scriptPath: '/hooks/zombie.sh',
      cwd: '/ws/new',
      timeout: 5000,
    })

    // 推进超过 timeout（5000）→ SIGTERM + reject + 启动 escalation timer
    vi.advanceTimersByTime(5001)
    await expect(promise).rejects.toMatchObject({ name: 'ShellRunnerError', code: 'timeout' })
    expect(signals).toContain('SIGTERM')
    expect(signals).not.toContain('SIGKILL')

    // 推进 escalation 延迟（5000ms）→ 仍未 close → SIGKILL
    vi.advanceTimersByTime(5000)
    expect(signals).toContain('SIGKILL')

    // SIGKILL 后子进程 close —— 不应再 resolve/reject（promise 已 reject，close handler 早退）
    fake.emit('close', 137)
  })

  // SR-5: 跨 chunk 行缓冲 —— 子进程输出被拆成多个 chunk，onOutput 不应收半行
  it('SR-5: stdout 跨 chunk 的半行应拼接成完整行后再回调 onOutput（不拆半行）', async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake)

    const { spawn } = await import('node:child_process')
    const runner = new ShellRunner({ spawn: spawn as any })

    const onOutput = vi.fn()
    const promise = runner.execute({
      scriptPath: '/hooks/setup.sh',
      cwd: '/ws/new',
      onOutput,
    })

    // 模拟子进程把 'line1partialline2\n' 拆成两个 chunk 送达（典型 spawn chunk 边界）
    fake.stdout.emit('data', Buffer.from('line1partial'))
    fake.stdout.emit('data', Buffer.from('line2\n'))
    fake.emit('close', 0)

    await promise

    // onOutput 应只收到一次完整行，而非两次半行
    const stdoutCalls = onOutput.mock.calls.filter((c: any[]) => c[1] === 'stdout')
    expect(stdoutCalls).toHaveLength(1)
    expect(stdoutCalls[0]).toEqual(['line1partialline2', 'stdout'])
    // 累积 stdout 仍保留完整原始文本（含 \n）
    expect(onOutput).not.toHaveBeenCalledWith('line1partial', 'stdout')
    expect(onOutput).not.toHaveBeenCalledWith('line2', 'stdout')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WorktreeService
// ─────────────────────────────────────────────────────────────────────────────
describe('WorktreeService', () => {
  // 共享 fixture：所有 WS-* 用例的 workspace 形态
  const wsRoot = platform('/ws')
  const barePath = platform('/ws/.bare')
  const setupScriptPath = join(barePath, 'custom-hooks', 'setup-worktree.sh')

  let gitExecutor: { exec: ReturnType<typeof vi.fn> }
  let shellRunner: { execute: ReturnType<typeof vi.fn> }
  let gitInfoReader: { readGitInfo: ReturnType<typeof vi.fn> }
  let existsSyncMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    gitExecutor = { exec: vi.fn() }
    shellRunner = { execute: vi.fn() }
    gitInfoReader = { readGitInfo: vi.fn() }
    existsSyncMock = vi.fn(() => false)

    vi.doMock('node:fs', () => ({
      existsSync: existsSyncMock,
      statSync: vi.fn(),
      readFileSync: vi.fn(),
    }))
  })

  async function makeService(): Promise<WorktreeService> {
    const fs = await import('node:fs')
    return new WorktreeService({
      gitExecutor: gitExecutor as unknown as IGitExecutor,
      shellRunner: shellRunner as unknown as IShellRunner,
      gitInfoReader: gitInfoReader as unknown as IGitInfoReader,
      fs: fs as any,
    })
  }

  // WS-1: 完整成功 —— bare 检测通过 + worktree add exitCode=0 + setup 脚本存在且成功
  it('WS-1: 完整成功流程返回 { cwd, branch }', async () => {
    existsSyncMock.mockImplementation((p: string) => p === setupScriptPath || p === barePath) // .bare + setup 脚本存在；目标目录不存在
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    shellRunner.execute.mockResolvedValue({ exitCode: 0, stdout: 'setup ok', stderr: '' })

    const service = await makeService()
    const result = await service.create({
      branch: 'feat/a',
      baseBranch: 'origin/main',
      workspaceHint: wsRoot,
    })

    expect(result.branch).toBe('feat/a')
    expect(result.cwd).toBe(join(wsRoot, 'feat-a'))
    // git worktree add 被调用过一次，且 -b 新分支
    expect(gitExecutor.exec).toHaveBeenCalledWith(
      barePath,
      'worktree',
      expect.arrayContaining(['add', expect.any(String), '-b', 'feat/a']),
    )
    // setup 脚本被调用，cwd 与 scriptPath 正确
    expect(shellRunner.execute).toHaveBeenCalledWith(
      expect.objectContaining({ scriptPath: setupScriptPath, cwd: join(wsRoot, 'feat-a') }),
    )
  })

  // WS-2: 非 bare repo
  it('WS-2: 非 bare repo 抛 NOT_BARE_REPO', async () => {
    // existsSync 对 .bare 全部返回 false（detector 找不到 .bare）
    existsSyncMock.mockReturnValue(false)

    const service = await makeService()
    await expect(
      service.create({ branch: 'feat/a', workspaceHint: platform('/home/me/plain') }),
    ).rejects.toMatchObject({ code: 'NOT_BARE_REPO' })

    expect(gitExecutor.exec).not.toHaveBeenCalled()
    expect(shellRunner.execute).not.toHaveBeenCalled()
  })

  // WS-3: 目录已存在
  it('WS-3: 目标 worktree 目录已存在抛 WORKTREE_EXISTS（detail 带 cwd + dirName）', async () => {
    // detector 命中 .bare（第一个 existsSync 路径），目标 worktree 目录已存在
    existsSyncMock.mockImplementation((p: string) => {
      if (p === barePath) return true
      if (p === join(wsRoot, 'feat-a')) return true
      return false
    })

    const service = await makeService()
    await expect(
      service.create({ branch: 'feat/a', workspaceHint: wsRoot }),
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS',
      // detail 是对象（非裸 cwd 字符串）：前端可读 dirName 核对是否同分支碰撞
      detail: { cwd: join(wsRoot, 'feat-a'), dirName: 'feat-a' },
    })

    expect(gitExecutor.exec).not.toHaveBeenCalled()
  })

  // WS-4: setup 脚本不存在 → 跳过 setup，仍然成功
  it('WS-4: setup 脚本不存在则跳过 setup，仍返回 { cwd, branch }', async () => {
    existsSyncMock.mockImplementation((p: string) => p === barePath) // 仅 .bare 存在，setup 脚本不存在
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const service = await makeService()
    const result = await service.create({ branch: 'feat/a', workspaceHint: wsRoot })

    expect(result.cwd).toBe(join(wsRoot, 'feat-a'))
    expect(result.branch).toBe('feat/a')
    expect(shellRunner.execute).not.toHaveBeenCalled()
  })

  // WS-5: setup 脚本失败 → 抛 SETUP_FAILED（含 exitCode + stderr）
  it('WS-5: setup 脚本失败抛 SETUP_FAILED 含 exitCode 与 stderr', async () => {
    existsSyncMock.mockImplementation((p: string) => p === setupScriptPath || p === barePath)
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    shellRunner.execute.mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'npm install failed' })

    const service = await makeService()
    await expect(
      service.create({ branch: 'feat/a', workspaceHint: wsRoot }),
    ).rejects.toMatchObject({
      code: 'SETUP_FAILED',
      detail: { exitCode: 2, stderr: 'npm install failed' },
    })
  })

  // WS-6: base=origin/main 且 origin/main ref 存在 → 传给 git worktree add 的是 origin/main
  it('WS-6: base=origin/main ref 存在时，git worktree add 的 base 参数为 origin/main', async () => {
    existsSyncMock.mockImplementation((p: string) => p === barePath)
    // 第一次调用：检查 origin/main ref 是否存在（exitCode=0 表示存在）
    gitExecutor.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
    // 第二次调用：实际的 worktree add
    gitExecutor.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })

    const service = await makeService()
    await service.create({ branch: 'feat/a', baseBranch: 'origin/main', workspaceHint: wsRoot })

    // worktree add 调用的最后一个参数应是 origin/main
    const addCall = gitExecutor.exec.mock.calls.find(
      (c: any[]) => c[1] === 'worktree',
    )
    expect(addCall).toBeDefined()
    expect(addCall![2]).toContain('origin/main')
  })

  // WS-6b: baseBranch='current' → resolveBaseRef 走 gitInfoReader 路径（读当前分支，不 rev-parse）
  it('WS-6b: baseBranch=current → resolveBaseRef 走 gitInfoReader 路径（读当前分支，不 rev-parse）', async () => {
    existsSyncMock.mockImplementation((p: string) => p === barePath)
    // gitInfoReader 返回当前分支 develop（current 路径读这个）
    gitInfoReader.readGitInfo.mockReturnValue({ branch: 'develop', isWorktree: true })
    // worktree add 成功（current 路径只调一次 gitExecutor：无 rev-parse）
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const service = await makeService()
    await service.create({ branch: 'feat/x', baseBranch: 'current', workspaceHint: wsRoot })

    // current 路径不调 rev-parse（gitExecutor 只被 worktree add 调一次）
    const revParseCalls = gitExecutor.exec.mock.calls.filter((c: any[]) => c[1] === 'rev-parse')
    expect(revParseCalls).toHaveLength(0)
    expect(gitExecutor.exec).toHaveBeenCalledTimes(1)

    // worktree add 的 base 参数是 develop（来自 gitInfoReader）
    const addCall = gitExecutor.exec.mock.calls.find((c: any[]) => c[1] === 'worktree')
    expect(addCall).toBeDefined()
    expect(addCall![2]).toContain('develop')
    // 不应误用 origin/main（默认值）
    expect(addCall![2]).not.toContain('origin/main')
  })

  // WS-7: 分支名含 / 时目录名转换（feat/oauth → feat-oauth）
  it('WS-7: 分支名含斜杠时目录名正确转换', async () => {
    existsSyncMock.mockImplementation((p: string) => p === barePath)
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const service = await makeService()
    const result = await service.create({ branch: 'feat/oauth', workspaceHint: wsRoot })

    expect(result.cwd).toBe(join(wsRoot, 'feat-oauth'))
    // git worktree add 用原始分支名（含斜杠）
    const addCall = gitExecutor.exec.mock.calls.find(
      (c: any[]) => c[1] === 'worktree',
    )
    expect(addCall![2]).toContain('-b')
    expect(addCall![2]).toContain('feat/oauth')
  })

  // WS-8: 非法分支名（路径遍历风险）→ 抛 INVALID_BRANCH（runtime 安全边界，不依赖前端校验）
  it('WS-8: 非法分支名抛 INVALID_BRANCH（路径遍历防护）', async () => {
    existsSyncMock.mockImplementation((p: string) => p === barePath)
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const service = await makeService()
    // .. 路径遍历 + 反斜杠（Windows 风险）：runtime 必须独立拦截
    await expect(
      service.create({ branch: '..\\..\\evil', workspaceHint: wsRoot }),
    ).rejects.toMatchObject({ code: 'INVALID_BRANCH' })

    // 校验失败不应触达 git / shell
    expect(gitExecutor.exec).not.toHaveBeenCalled()
    expect(shellRunner.execute).not.toHaveBeenCalled()
  })

  // WS-9: git worktree add 失败（exitCode 非 0）→ 抛 GIT_FAILED + detail（含 exitCode + stderr）
  it('WS-9: git worktree add exitCode 非 0 抛 GIT_FAILED 含 exitCode 与 stderr', async () => {
    existsSyncMock.mockImplementation((p: string) => p === barePath)
    // rev-parse（base 解析）成功；worktree add 失败（exitCode=1 + stderr）
    gitExecutor.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // rev-parse
    gitExecutor.exec.mockResolvedValueOnce({ stdout: '', stderr: 'fatal: not a valid object name', exitCode: 1 }) // worktree add

    const service = await makeService()
    await expect(
      service.create({ branch: 'feat/a', baseBranch: 'origin/main', workspaceHint: wsRoot }),
    ).rejects.toMatchObject({
      code: 'GIT_FAILED',
      detail: { exitCode: 1, stderr: 'fatal: not a valid object name' },
    })

    // add 失败不应继续跑 setup 脚本
    expect(shellRunner.execute).not.toHaveBeenCalled()
  })

  // WS-10: 并发创建同 branch → 第二次 existsSync 命中 WORKTREE_EXISTS（防竞态）
  // 真正的竞态防护是 git worktree add 本身（文件系统原子），此处只测 WorktreeService 层的
  // existsSync 检查行为：模拟两次 create() 之间目标目录被另一个进程创建出来的场景。
  it('WS-10: 并发创建同 branch → 第二次 existsSync 命中 WORKTREE_EXISTS（防竞态）', async () => {
    // existsSync 行为：.bare 永远存在；目标 worktree 目录第一次查 false、第二次查 true
    // （模拟并发：A 进程 create() 前目录不存在，B 进程在 A 的 existsSync 与 git add 之间创建了目录）
    const targetPath = join(wsRoot, 'feat-concurrent')
    existsSyncMock.mockImplementation((p: string) => {
      if (p === barePath) return true
      if (p === targetPath) {
        // 按调用次数返回：第一次 false（允许 A 创建），第二次 true（B 的 existsSync 命中）
        const calls = existsSyncMock.mock.calls.filter((c: any[]) => c[0] === targetPath).length
        return calls > 1
      }
      return false
    })
    // gitExecutor：A 的 rev-parse + add 都成功；B 不会走到 gitExecutor（existsSync 拦截）
    gitExecutor.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const service = await makeService()
    const params = { branch: 'feat-concurrent', baseBranch: 'origin/main' as const, workspaceHint: wsRoot }
    // Promise.all：A 成功，B 在 existsSync 命中后 reject WORKTREE_EXISTS
    const results = await Promise.allSettled([service.create(params), service.create(params)])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const rejectedErr = (rejected[0] as PromiseRejectedResult).reason
    expect(rejectedErr).toMatchObject({ code: 'WORKTREE_EXISTS' })
    expect(rejectedErr.detail).toMatchObject({ dirName: 'feat-concurrent' })
  })
})
