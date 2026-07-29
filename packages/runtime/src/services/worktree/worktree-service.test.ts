/**
 * WorktreeService 测试（W2：三态检测 + plain-repo 模式 + listBranches + list）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/worktree-service.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorktreeService, type WorktreeServiceDeps } from './worktree-service.js'
import { TimeoutError } from '../../infra/async-mutex.js'

// ── mock helpers ─────────────────────────────────────────────

/** 创建 mock IGitExecutor。 */
function mockGitExecutor(overrides?: {
  execResults?: Map<string, { stdout: string; stderr: string; exitCode: number }>
}) {
  const defaultResults = new Map<string, { stdout: string; stderr: string; exitCode: number }>([
    ['rev-parse --verify origin/main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ['rev-parse --verify main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ['worktree add', { stdout: '', stderr: '', exitCode: 0 }],
    ['branch --list --format=%(refname:short)', { stdout: 'main\nfeat-x\n', stderr: '', exitCode: 0 }],
    ['branch --list --remotes --format=%(refname:short)', { stdout: 'origin/main\norigin/HEAD\norigin/feat-y\n', stderr: '', exitCode: 0 }],
    ['worktree list --porcelain', {
      stdout: 'worktree /project\nHEAD abc123\nbranch refs/heads/main\n\nworktree /project/feat-x\nHEAD def456\nbranch refs/heads/feat-x\n',
      stderr: '',
      exitCode: 0,
    }],
    ['rev-parse --show-toplevel', { stdout: '/project', stderr: '', exitCode: 0 }],
    ['rev-parse --abbrev-ref origin/HEAD', { stdout: 'origin/main', stderr: '', exitCode: 0 }],
    ['rev-parse --verify refs/heads/main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ['rev-parse --verify refs/heads/master', { stdout: '', stderr: 'not found', exitCode: 128 }],
  ])

  const allResults = new Map([...defaultResults, ...(overrides?.execResults ?? [])])

  return {
    exec: vi.fn(async (_cwd: string, command: string, args?: string[]) => {
      const fullKey = `${command} ${(args ?? []).join(' ')}`.trim()
      // 精确匹配优先
      const exact = allResults.get(fullKey)
      if (exact) return exact
      // 前缀匹配（worktree add 等命令的 args 不固定）
      for (const [key, val] of allResults) {
        if (fullKey.startsWith(key)) return val
      }
      return { stdout: '', stderr: `unknown command: ${fullKey}`, exitCode: 1 }
    }),
  }
}

/** 创建 mock IShellRunner。 */
function mockShellRunner() {
  return {
    execute: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  }
}

/** 创建 mock IGitInfoReader。 */
function mockGitInfoReader(branch?: string) {
  return {
    readGitInfo: vi.fn(() => (branch ? { branch, isWorktree: false } : undefined)),
    pruneStaleCache: vi.fn(),
  }
}

/** 创建 mock IConfigService。 */
function mockConfigService(worktreeRootDir = '/home/user/worktrees') {
  return {
    getWorktreeRootDir: vi.fn(() => worktreeRootDir),
    setWorktreeRootDir: vi.fn(),
    getSetupScript: vi.fn(() => 'custom-hooks/setup-worktree.sh'),
    setSetupScript: vi.fn(),
    getBareSetupScript: vi.fn(() => 'custom-hooks/setup-worktree.sh'),
    setBareSetupScript: vi.fn(),
    getTimeout: vi.fn(() => 60),
    setTimeout: vi.fn(),
    getDefaultBaseBranch: vi.fn(() => 'origin/main'),
    setDefaultBaseBranch: vi.fn(),
    // 其他方法 stub
    listProviders: vi.fn(() => []),
    getDefaultModel: vi.fn(() => null),
    getConfigVersion: vi.fn(() => 0),
    setDefaultModel: vi.fn(),
    setProvider: vi.fn(),
    deleteProvider: vi.fn(),
    getProvider: vi.fn(),
    updateToolPermissions: vi.fn(),
    setSkillDirs: vi.fn(),
    getSkillDirs: vi.fn(() => []),
    setAgentDirs: vi.fn(),
    getAgentDirs: vi.fn(() => []),
    setExtensionDirs: vi.fn(),
    getExtensionDirs: vi.fn(() => []),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    loadSkills: vi.fn(() => []),
    saveSkills: vi.fn(),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    loadAgents: vi.fn(() => []),
    saveAgents: vi.fn(),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    scanSkills: vi.fn(() => []),
    scanAgents: vi.fn(() => []),
    // 迁移源检测 stub（W1，worktree 测试不涉及）
    detectSources: vi.fn(() => []),
    // 迁移 provider 导入 stub（W2，worktree 测试不涉及）
    previewImportProviders: vi.fn(() => ({ error: { code: 'SOURCE_NOT_INSTALLED', message: 'not installed' } })),
    applyImportProviders: vi.fn(() => ({ error: { code: 'PREVIEW_EXPIRED', message: 'expired' } })),
    getPiAgentDir: vi.fn(() => '/home/user/.pi/agent'),
    getConfigDir: vi.fn(() => '/home/user/.xyz-agent'),
    getSystemPromptConfig: vi.fn(() => ({ config: { version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: false, prompt: '' } }, corrupted: false })),
    setSystemPromptConfig: vi.fn(() => ({ ok: true })),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    // Terminal config stubs
    getTerminalConfig: vi.fn(() => ({ config: { version: 1, shell: '/bin/zsh', shellArgs: [], fontSize: 14, fontFamily: 'monospace', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
    setTerminalConfig: vi.fn(() => ({ ok: true })),
  }
}

/** 创建 mock fs。 */
function mockFs(existingPaths = new Set<string>()) {
  return {
    existsSync: vi.fn((p: string) => existingPaths.has(p)),
    statSync: vi.fn((p: string) => {
      if (!existingPaths.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      // 测试中 existingPaths 里的路径默认当目录处理（.bare 等）
      return { isDirectory: () => true, isFile: () => false }
    }),
  }
}

/** 创建完整的 WorktreeServiceDeps。 */
function createDeps(options?: {
  mode?: 'bare-workspace' | 'plain-repo' | 'not-repo'
  existingPaths?: Set<string>
  gitOverrides?: Parameters<typeof mockGitExecutor>[0]
  worktreeRootDir?: string
}) {
  const mode = options?.mode ?? 'bare-workspace'
  const existingPaths = options?.existingPaths ?? new Set<string>()

  // 根据 mode 设置 git mock 结果
  const gitOverrides = options?.gitOverrides ?? {}
  if (mode === 'bare-workspace') {
    // bare-workspace 检测：.bare 存在 → fs.existsSync 返回 true
    // 不需要 rev-parse --show-toplevel（阶段 1 就命中了）
  } else if (mode === 'plain-repo') {
    // plain-repo 检测：.bare 不存在，但 rev-parse --show-toplevel 成功
    gitOverrides.execResults = new Map([
      ['rev-parse --show-toplevel', { stdout: '/home/user/my-repo', stderr: '', exitCode: 0 }],
      ['rev-parse --abbrev-ref origin/HEAD', { stdout: 'origin/main', stderr: '', exitCode: 0 }],
      ['rev-parse --verify refs/heads/main', { stdout: 'abc', stderr: '', exitCode: 0 }],
      ['rev-parse --verify origin/main', { stdout: 'abc', stderr: '', exitCode: 0 }],
      ['rev-parse --verify main', { stdout: 'abc', stderr: '', exitCode: 0 }],
      ...(gitOverrides.execResults ?? new Map()),
    ])
  }

  return {
    gitExecutor: mockGitExecutor(gitOverrides),
    shellRunner: mockShellRunner(),
    gitInfoReader: mockGitInfoReader(),
    configService: mockConfigService(options?.worktreeRootDir),
    fs: mockFs(existingPaths),
  } satisfies WorktreeServiceDeps
}

// ── detect() 测试 ──────────────────────────────────────────

describe('WorktreeService.detect()', () => {
  it('bare-workspace：cwd 在 .bare workspace 下', async () => {
    const deps = createDeps({ existingPaths: new Set(['/project/.bare']) })
    const service = new WorktreeService(deps)

    const result = await service.detect('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
  })

  it('plain-repo：cwd 在普通 git 仓库下', async () => {
    const deps = createDeps({ mode: 'plain-repo' })
    const service = new WorktreeService(deps)

    const result = await service.detect('/home/user/my-repo/src')
    expect(result.mode).toBe('plain-repo')
    expect(result.repoRoot).toBe('/home/user/my-repo')
  })

  it('not-repo：cwd 既不是 bare workspace 也不是 git 仓库', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.detect('/tmp/random')
    expect(result.mode).toBe('not-repo')
  })
})

// ── create() bare-workspace 模式测试 ───────────────────────

describe('WorktreeService.create() bare-workspace', () => {
  it('成功创建 worktree（bare-workspace 模式）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat/new-feature', workspaceHint: '/project' })
    expect(result).toEqual({ cwd: '/project/feat-new-feature', branch: 'feat/new-feature' })
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/project/.bare',
      'worktree',
      ['add', '-b', 'feat/new-feature', '/project/feat-new-feature', 'origin/main'],
    )
  })

  it('worktree 目录已存在时抛 WORKTREE_EXISTS', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/feat-existing']),
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-existing', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS',
    })
  })

  it('非法分支名抛 INVALID_BRANCH', async () => {
    const deps = createDeps()
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: '../evil', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'INVALID_BRANCH' })
  })
})

// ── create() plain-repo 模式测试 ───────────────────────────

describe('WorktreeService.create() plain-repo', () => {
  it('成功创建 worktree（plain-repo 模式，worktreeRootDir 布局）', async () => {
    const deps = createDeps({
      mode: 'plain-repo',
      existingPaths: new Set(), // worktree 目录不存在
      worktreeRootDir: '/home/user/worktrees',
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat/new-feature', workspaceHint: '/home/user/my-repo/src' })
    expect(result.cwd).toBe('/home/user/worktrees/my-repo/feat-new-feature')
    expect(result.branch).toBe('feat/new-feature')
    expect(deps.configService.getWorktreeRootDir).toHaveBeenCalled()
  })

  it('同名 repo 冲突时追加短 hash 后缀', async () => {
    // 工作原理：computePlainRepoWorktreeDir 检查目标是否存在
    // 如果 /home/user/worktrees/my-repo/feat-x 已存在，追加 repo 路径 hash
    const existingPath = '/home/user/worktrees/my-repo/feat-x'
    const deps = createDeps({
      mode: 'plain-repo',
      existingPaths: new Set([existingPath]),
      worktreeRootDir: '/home/user/worktrees',
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat/x', workspaceHint: '/home/user/my-repo/src' })
    // 目标已存在 → 追加 hash 后缀（hash 是 my-repo 路径的 md5 前 6 位）
    expect(result.cwd).toMatch(/^\/home\/user\/worktrees\/my-repo-[a-f0-9]{6}\/feat-x$/)
  })

  it('not-repo 模式抛 NOT_GIT_REPO', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/tmp/random' }),
    ).rejects.toMatchObject({ code: 'NOT_GIT_REPO' })
  })
})

// ── listBranches() 测试 ────────────────────────────────────

describe('WorktreeService.listBranches()', () => {
  it('列出本地和远程分支（bare-workspace 模式）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['branch --list --format=%(refname:short)', { stdout: 'main\nfeat-x\n', stderr: '', exitCode: 0 }],
          ['branch --list --remotes --format=%(refname:short)', {
            stdout: 'origin/main\norigin/HEAD\norigin/feat-y\n',
            stderr: '',
            exitCode: 0,
          }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.listBranches('/project')
    expect(result.local).toEqual(['main', 'feat-x'])
    expect(result.remote).toEqual(['origin/main', 'origin/feat-y'])
    expect(result.defaultBranch).toBeDefined()
  })

  it('plain-repo 模式下用 repoRoot 而非 barePath', async () => {
    const deps = createDeps({ mode: 'plain-repo' })
    const service = new WorktreeService(deps)

    await service.listBranches('/home/user/my-repo/src')
    // 应该用 repoRoot（/home/user/my-repo）而非 barePath
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/home/user/my-repo',
      'branch',
      expect.arrayContaining(['--list']),
    )
  })

  it('not-repo 模式抛 NOT_GIT_REPO', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(service.listBranches('/tmp')).rejects.toMatchObject({ code: 'NOT_GIT_REPO' })
  })

  it('git 命令失败时返回空列表', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['branch --list --format=%(refname:short)', { stdout: '', stderr: 'error', exitCode: 1 }],
          ['branch --list --remotes --format=%(refname:short)', { stdout: '', stderr: 'error', exitCode: 1 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.listBranches('/project')
    expect(result.local).toEqual([])
    expect(result.remote).toEqual([])
  })
})

// ── list() 测试 ────────────────────────────────────────────

describe('WorktreeService.list()', () => {
  it('解析 worktree list --porcelain 输出', async () => {
    const porcelain = [
      'worktree /project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /project/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n')

    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: porcelain, stderr: '', exitCode: 0 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.list('/project')
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      path: '/project',
      branch: 'main',
      HEAD: true,
      bare: false,
    })
    expect(result.items[1]).toMatchObject({
      path: '/project/feat-x',
      branch: 'feat-x',
      HEAD: false,
      bare: false,
    })
  })

  it('bare repo 条目标记 bare=true', async () => {
    const porcelain = [
      'worktree /project/.bare',
      'bare',
      '',
      'worktree /project/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n')

    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: porcelain, stderr: '', exitCode: 0 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.list('/project')
    expect(result.items[0]).toMatchObject({ bare: true, branch: '' })
    expect(result.items[1]).toMatchObject({ bare: false, branch: 'feat-x', HEAD: true })
  })

  it('HEAD 标记匹配 currentCwd 所在 worktree（子目录场景），不依赖输出顺序', async () => {
    // [HISTORICAL] 旧实现标记「第一个非 bare」，但 git worktree list 输出顺序是主 worktree
    // 在前，用户在 feat-x 时 HEAD 被错标到 main。必须按 path 匹配 currentCwd（含子目录）。
    const porcelain = [
      'worktree /project/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /project/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n')

    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: porcelain, stderr: '', exitCode: 0 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    // currentCwd 是 feat-x worktree 的子目录（packages/renderer）
    const result = await service.list('/project/feat-x/packages/renderer')
    expect(result.items[0]).toMatchObject({ path: '/project/main', HEAD: false })
    expect(result.items[1]).toMatchObject({ path: '/project/feat-x', branch: 'feat-x', HEAD: true })
  })

  it('not-repo 模式抛 NOT_GIT_REPO', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(service.list('/tmp')).rejects.toMatchObject({ code: 'NOT_GIT_REPO' })
  })

  it('git 命令失败时抛 GIT_FAILED', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(service.list('/project')).rejects.toMatchObject({ code: 'GIT_FAILED' })
  })
})

// ── setup 脚本测试 ─────────────────────────────────────────

describe('WorktreeService setup 脚本', () => {
  it('setup 脚本存在时执行', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat/test', workspaceHint: '/project' })
    expect(deps.shellRunner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptPath: setupScriptPath,
        args: ['/project/feat-test'],
        cwd: '/project/feat-test',
      }),
    )
  })

  it('setup 脚本不存在时跳过', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']), // setup 脚本不在 existingPaths 中
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat/test', workspaceHint: '/project' })
    expect(deps.shellRunner.execute).not.toHaveBeenCalled()
  })

  it('setup 脚本失败时抛 SETUP_FAILED', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
    })
    deps.shellRunner.execute = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'install failed' }))
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' })
  })
})

// ── P6 D5：worktree in-flight 去重（mutex 串行化）测试 ─────────

/** 简单 delay helper。 */
function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('WorktreeService.create() per-key mutex (P6 D5)', () => {
  it('TC1/AC13: 并发两个 create 同分支同 cwd——第二个等第一个完成后报 WORKTREE_EXISTS', async () => {
    // 用有状态 existsSync：初始目录不存在（让第一个 create 成功创建），创建后变存在（第二个看到已存在）。
    const createdPaths = new Set<string>()
    const existingPaths = new Set<string>(['/project/.bare'])
    const fs = mockFs(existingPaths)
    // 包装 existsSync：第一次查目标目录返回 false（让第一个创建），创建后返回 true（第二个看到已存在）。
    fs.existsSync = vi.fn((p: string) => {
      if (createdPaths.has(p)) return true
      return existingPaths.has(p)
    })
    const gitExecutor = mockGitExecutor()
    // 让 worktree add 有延迟（占用 mutex 一会），确保第二个排队
    gitExecutor.exec = vi.fn(async (cwd: string, command: string, args?: string[]) => {
      if (command === 'worktree' && args?.[0] === 'add') {
        await delayMs(30)
        // 模拟 git 创建了目录
        const newWtPath = args?.[3] ?? ''
        if (newWtPath) createdPaths.add(newWtPath)
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const deps: WorktreeServiceDeps = {
      gitExecutor,
      shellRunner: mockShellRunner(),
      gitInfoReader: mockGitInfoReader(),
      configService: mockConfigService(),
      fs,
    }
    const service = new WorktreeService(deps)

    // 并发同 branch 两次 create
    const p1 = service.create({ branch: 'feat-x', workspaceHint: '/project' })
    const p2 = service.create({ branch: 'feat-x', workspaceHint: '/project' })
    const results = await Promise.allSettled([p1, p2])

    // 第一个成功，第二个报 WORKTREE_EXISTS（串行化后看到目录已存在）
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    if (results[1].status === 'rejected') {
      expect(results[1].reason).toMatchObject({ code: 'WORKTREE_EXISTS' })
    }
  })

  it('TC1b: 并发两个 create 同分支但不同 workspaceHint（同 repo 的子目录 vs 根）——仍按 repoRoot 串行化', async () => {
    // 回归 P6 修复：mutex key 必须用 detection 推导的 repoRoot，而非前端传入的 workspaceHint。
    // 否则同一 repo 的根目录（/project）与子目录（/project/src）会落到不同 key，
    // 绕过串行化导致并发 create 同分支两条都尝试 git worktree add。
    // bare-workspace 检测向上找 .bare：/project 与 /project/src 都收敛到 repoRoot=/project。
    const createdPaths = new Set<string>()
    const existingPaths = new Set<string>(['/project/.bare'])
    const fs = mockFs(existingPaths)
    fs.existsSync = vi.fn((p: string) => {
      if (createdPaths.has(p)) return true
      return existingPaths.has(p)
    })
    const gitExecutor = mockGitExecutor()
    gitExecutor.exec = vi.fn(async (cwd: string, command: string, args?: string[]) => {
      if (command === 'worktree' && args?.[0] === 'add') {
        await delayMs(30)
        const newWtPath = args?.[3] ?? ''
        if (newWtPath) createdPaths.add(newWtPath)
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const deps: WorktreeServiceDeps = {
      gitExecutor,
      shellRunner: mockShellRunner(),
      gitInfoReader: mockGitInfoReader(),
      configService: mockConfigService(),
      fs,
    }
    const service = new WorktreeService(deps)

    // 两次 create 同 branch，workspaceHint 分别为 repo 根与子目录（不同 hint 但同 repo）
    const p1 = service.create({ branch: 'feat-x', workspaceHint: '/project' })
    const p2 = service.create({ branch: 'feat-x', workspaceHint: '/project/src' })
    const results = await Promise.allSettled([p1, p2])

    // 串行化生效：第一个成功，第二个看到分支已存在报 WORKTREE_EXISTS。
    // 若 key 仍用 workspaceHint，两条会并发都成功（bug）——此断言会失败暴露回归。
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const rejectedReason = rejected[0].status === 'rejected' ? rejected[0].reason : null
    expect(rejectedReason).toMatchObject({ code: 'WORKTREE_EXISTS' })
  })

  it('TC2/AC14: 并发两个 create 不同分支互不阻塞', async () => {
    const existingPaths = new Set<string>(['/project/.bare'])
    const fs = mockFs(existingPaths)
    const gitExecutor = mockGitExecutor()
    // worktree add 各延迟 30ms，验证不同分支并发
    gitExecutor.exec = vi.fn(async (cwd: string, command: string, args?: string[]) => {
      if (command === 'worktree' && args?.[0] === 'add') await delayMs(30)
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const deps: WorktreeServiceDeps = {
      gitExecutor,
      shellRunner: mockShellRunner(),
      gitInfoReader: mockGitInfoReader(),
      configService: mockConfigService(),
      fs,
    }
    const service = new WorktreeService(deps)

    const start = Date.now()
    const results = await Promise.allSettled([
      service.create({ branch: 'feat-a', workspaceHint: '/project' }),
      service.create({ branch: 'feat-b', workspaceHint: '/project' }),
    ])
    const elapsed = Date.now() - start

    // 两个都成功
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')
    // 并发：总耗时 < 60ms（串行会 ≈60ms+，两个 30ms 并发应 ≈30ms）
    expect(elapsed).toBeLessThan(55)
  })

  it('TC3/AC15: worktree mutex 排队超时拒绝——create 超时抛 TimeoutError', async () => {
    const existingPaths = new Set<string>(['/project/.bare'])
    const fs = mockFs(existingPaths)
    const gitExecutor = mockGitExecutor()
    // worktree add 延迟 200ms（远超 mutexTimeoutMs=20）
    gitExecutor.exec = vi.fn(async (cwd: string, command: string, args?: string[]) => {
      if (command === 'worktree' && args?.[0] === 'add') await delayMs(200)
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const deps: WorktreeServiceDeps = {
      gitExecutor,
      shellRunner: mockShellRunner(),
      gitInfoReader: mockGitInfoReader(),
      configService: mockConfigService(),
      fs,
      mutexTimeoutMs: 20,
    }
    const service = new WorktreeService(deps)

    // 第一次慢（占用 mutex 200ms），第二次排队 20ms 超时
    const p1 = service.create({ branch: 'feat-slow', workspaceHint: '/project' })
    const p2 = service.create({ branch: 'feat-slow', workspaceHint: '/project' })

    // 第二次 reject TimeoutError
    await expect(p2).rejects.toBeInstanceOf(TimeoutError)
    // 第一次正常完成
    await p1
  })
})
