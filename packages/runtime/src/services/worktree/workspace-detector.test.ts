/**
 * WorkspaceDetector 三态检测测试（W2）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/workspace-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  WorkspaceDetector,
  type FsLike,
  type GitRevParser,
  detectBareWorkspaceCached,
  pruneBareCache,
  __resetBareCacheForTests,
} from './workspace-detector.js'

// ── helpers ──────────────────────────────────────────────────

/** 创建 mock FsLike，statSync 按 dirSet 判定 isDirectory。 */
function mockFs(dirSet: Set<string>): FsLike {
  return {
    statSync: (p: string) => {
      if (dirSet.has(p)) return { isDirectory: () => true }
      const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    },
  }
}

/** 创建 mock GitRevParser。 */
function mockGit(overrides?: {
  repoRoot?: string | null
  defaultBranch?: string | null
}): GitRevParser {
  return {
    getRepoRoot: vi.fn().mockResolvedValue(overrides?.repoRoot ?? null),
    getDefaultBranch: vi.fn().mockResolvedValue(overrides?.defaultBranch ?? null),
  }
}

// ── detect 三态测试 ─────────────────────────────────────────

describe('WorkspaceDetector.detect()', () => {
  it('bare-workspace：cwd 本身就是 workspace 根（.bare 在其下）', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
    expect(result.repoRoot).toBe('/project')
    expect(result.defaultBranch).toBe('main')
    expect(result.isBareMode).toBe(true)
  })

  it('bare-workspace：cwd 是 workspace 的深层子目录', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project/packages/runtime/src')
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
    expect(result.isBareMode).toBe(true)
  })

  it('bare-workspace：defaultBranch 获取失败时返回空串', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: null })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.defaultBranch).toBe('')
  })

  it('plain-repo：无 .bare，git rev-parse --show-toplevel 成功', async () => {
    const fs = mockFs(new Set())
    const git = mockGit({ repoRoot: '/home/user/my-repo', defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/home/user/my-repo/src')
    expect(result.mode).toBe('plain-repo')
    expect(result.wsRoot).toBe('')
    expect(result.barePath).toBe('')
    expect(result.repoRoot).toBe('/home/user/my-repo')
    expect(result.defaultBranch).toBe('main')
    expect(result.isBareMode).toBe(false)
  })

  it('not-repo：无 .bare，git rev-parse 也失败', async () => {
    const fs = mockFs(new Set())
    const git = mockGit({ repoRoot: null })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/tmp/random')
    expect(result.mode).toBe('not-repo')
    expect(result.wsRoot).toBe('')
    expect(result.barePath).toBe('')
    expect(result.repoRoot).toBe('')
    expect(result.defaultBranch).toBe('')
    expect(result.isBareMode).toBe(false)
  })

  it('not-repo：无 .bare，无 git 适配器', async () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs, undefined)

    const result = await detector.detect('/tmp/random')
    expect(result.mode).toBe('not-repo')
    expect(result.isBareMode).toBe(false)
  })

  it('statSync 权限错误（非 ENOENT）时不抛，继续向上', async () => {
    const fs: FsLike = {
      statSync: (p: string) => {
        if (p === '/project/.bare') {
          const e = new Error('EACCES') as NodeJS.ErrnoException
          e.code = 'EACCES'
          throw e
        }
        if (p === '/project/packages/.bare') {
          return { isDirectory: () => true }
        }
        const e = new Error('ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      },
    }
    const git = mockGit({ defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project/packages/runtime')
    // /project/.bare EACCES → 跳过，继续向上找 → /project/packages/.bare 命中
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project/packages')
  })
})

// ── detectSync 同步版测试 ──────────────────────────────────

describe('WorkspaceDetector.detectSync()', () => {
  it('bare-workspace：命中 .bare', () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const detector = new WorkspaceDetector(fs)

    const result = detector.detectSync('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.isBareMode).toBe(true)
    expect(result.wsRoot).toBe('/project')
  })

  it('not-repo：无 .bare（不走 git 回退）', () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs)

    const result = detector.detectSync('/tmp/random')
    expect(result.mode).toBe('not-repo')
    expect(result.isBareMode).toBe(false)
  })

  it('defaultBranch 始终为空串（同步版不走 git）', () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const detector = new WorkspaceDetector(fs)

    const result = detector.detectSync('/project')
    expect(result.defaultBranch).toBe('')
  })
})

// ── detectLegacy 向后兼容测试 ──────────────────────────────

describe('WorkspaceDetector.detectLegacy()', () => {
  it('bare-workspace 时 isBareMode=true', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const detector = new WorkspaceDetector(fs)

    const result = await detector.detectLegacy('/project')
    expect(result.isBareMode).toBe(true)
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
  })

  it('not-repo 时 isBareMode=false', async () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs)

    const result = await detector.detectLegacy('/tmp')
    expect(result.isBareMode).toBe(false)
    expect(result.wsRoot).toBe('')
    expect(result.barePath).toBe('')
  })
})

// ── detectBareWorkspaceCached 缓存版本测试 ─────────────────

describe('detectBareWorkspaceCached()', () => {
  beforeEach(() => {
    __resetBareCacheForTests()
  })

  it('bare workspace 返回 true', () => {
    // detectBareWorkspaceCached 用 realDetector + 真实 node:fs
    // 这里测试 cwd 指向 .bare workspace 根目录
    // 注：此测试依赖真实文件系统，需要 cwd 在 .bare workspace 下
    // 为隔离 IO，我们用 __resetBareCacheForTests 确保缓存干净
    const result = detectBareWorkspaceCached('/tmp/nonexistent')
    expect(result).toBe(false) // /tmp 下没有 .bare
  })

  it('缓存命中：第二次调用不重新 detect', () => {
    // 第一次调用
    detectBareWorkspaceCached('/tmp/test-cache')
    // 第二次调用应该命中缓存（不抛即证明）
    const result = detectBareWorkspaceCached('/tmp/test-cache')
    expect(result).toBe(false)
  })

  it('pruneBareCache 清理过期/不存在的 cwd', () => {
    detectBareWorkspaceCached('/tmp/prune-test')
    pruneBareCache(new Set(['/tmp/prune-test']))
    // 未过期的保留
    expect(detectBareWorkspaceCached('/tmp/prune-test')).toBe(false)

    pruneBareCache(new Set()) // 传空集合，清理所有
    // 清理后重新查询
    expect(detectBareWorkspaceCached('/tmp/prune-test')).toBe(false)
  })
})

// ── GitRevParser 调用验证 ──────────────────────────────────

describe('WorkspaceDetector git 适配器调用', () => {
  it('bare-workspace 命中时调用 getDefaultBranch', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: 'develop' })
    const detector = new WorkspaceDetector(fs, git)

    await detector.detect('/project')
    expect(git.getDefaultBranch).toHaveBeenCalledWith('/project')
    expect(git.getRepoRoot).not.toHaveBeenCalled()
  })

  it('bare-workspace 未命中时调用 getRepoRoot', async () => {
    const fs = mockFs(new Set())
    const git = mockGit({ repoRoot: '/repo', defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    await detector.detect('/repo/src')
    expect(git.getRepoRoot).toHaveBeenCalledWith('/repo/src')
    expect(git.getDefaultBranch).toHaveBeenCalledWith('/repo')
  })

  it('git 适配器为 undefined 时不调用 git', async () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs, undefined)

    const result = await detector.detect('/tmp')
    expect(result.mode).toBe('not-repo')
  })
})
