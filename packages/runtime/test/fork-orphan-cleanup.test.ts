/**
 * W1 / L5: fork createSession/switchSession/initializeManagedSession 失败后清理孤儿 fork 文件。
 *
 * 背景：forkSession 先 createForkedSessionFile 写出新 JSONL，再 spawn pi 进程切到该文件。
 * 若后续 switchSession 或 initializeManagedSession 失败，原实现只销毁 pi 进程，
 * 不删 fork 文件 → 孤儿文件留在 sessions 目录，污染下次 scanPiSessions 列表。
 *
 * 修复：两个 catch 块各加 unlink(forkedFilePath).catch(() => {})。
 *
 * Mock 策略：createForkedSessionFile / unlink 经 vi.mock 注入 spy；
 * switchSession 或 initializeManagedSession reject 触发 catch 块。
 *
 * 运行：cd packages/runtime && npx vitest run test/fork-orphan-cleanup.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

// node:fs: existsSync 控制 create 路径守卫（fork 用 source.cwd 判断）
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}))

// node:fs/promises: unlink 是本次修复的核心观察对象
const fsPromisesMock = vi.hoisted(() => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('node:fs/promises', () => ({
  unlink: fsPromisesMock.unlink,
}))

// createForkedSessionFile: spy，返回固定 forkedFilePath / forkedId
const forkMock = vi.hoisted(() => ({
  forkedFilePath: '/fake/sessions/forked.jsonl',
  forkedId: 'forked-session-id',
  createForkedSessionFile: vi.fn(async () => ({
    filePath: '/fake/sessions/forked.jsonl',
    sessionId: 'forked-session-id',
  })),
}))
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: forkMock.createForkedSessionFile,
}))

import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@xyz-agent/shared'

function makeClient(overrides: Partial<IPiEngine> = {}): IPiEngine {
  return {
    getState: vi.fn(async () => ({ sessionId: 'pi-x', sessionFile: '/fake/x.jsonl' })),
    switchSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({})),
    setModel: vi.fn(async () => {}),
    getCommands: vi.fn(async () => []),
    getSessionStats: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as IPiEngine
}

interface MakeOpts {
  /** switchSession 抛错（触发第一个 catch 块） */
  switchFails?: boolean
  /** initializeManagedSession 抛错（触发第二个 catch 块） */
  initFails?: boolean
}

function makeLifecycle(opts: MakeOpts = {}) {
  const client = makeClient(
    opts.switchFails
      ? { switchSession: vi.fn(async () => { throw new Error('switch_session failed') }) }
      : {},
  )

  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn(),
    hasClient: vi.fn(),
    rekey: vi.fn(),
  } as unknown as IProcessManager

  const session: IManagedSessionView = {
    id: forkMock.forkedId, cwd: '/repo', label: 'fork', modelId: 'p/m',
    createdAt: 1, lastActiveAt: 1, tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false,
    labelPersisted: false,
  }

  const svc = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    findScannedSession: vi.fn(() => ({
      id: 'src', filePath: '/fake/src.jsonl', cwd: tmpdir(), name: 'src',
      lastModified: 1, timestamp: '', size: 0,
    })),
    initializeManagedSession: opts.initFails
      ? vi.fn(async () => { throw new Error('init failed') })
      : vi.fn(async () => session),
    toSummary: vi.fn((): SessionSummary => ({
      id: session.id, cwd: session.cwd, label: session.label, status: 'idle',
      lastActiveAt: 1, tokenCount: 0, modelId: 'p/m',
    })),
    fetchAndBroadcastContext: vi.fn(async () => {}),
  } as unknown as ISessionServiceInternal

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = { refreshAll: vi.fn() } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService)
  return { lifecycle, pm, svc }
}

describe('W1/L5: forkSession 失败后清理孤儿 fork 文件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.existsSync.mockReturnValue(true)
    forkMock.createForkedSessionFile.mockResolvedValue({
      filePath: forkMock.forkedFilePath,
      sessionId: forkMock.forkedId,
    })
  })

  it('switchSession 失败 → unlink forkedFilePath（清孤儿文件）', async () => {
    const { lifecycle } = makeLifecycle({ switchFails: true })
    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('switch_session failed')

    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(forkMock.forkedFilePath)
  })

  it('initializeManagedSession 失败 → unlink forkedFilePath（清孤儿文件）', async () => {
    const { lifecycle } = makeLifecycle({ initFails: true })
    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('init failed')

    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(forkMock.forkedFilePath)
  })

  it('unlink 自身失败不掩盖原始错误（catch 块静默吞 unlink 错误）', async () => {
    // unlink reject → 应被 .catch(() => {}) 吞掉，原始 init failed 错误仍正确抛出
    fsPromisesMock.unlink.mockRejectedValueOnce(new Error('unlink boom'))
    const { lifecycle } = makeLifecycle({ initFails: true })

    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('init failed')
  })
})
