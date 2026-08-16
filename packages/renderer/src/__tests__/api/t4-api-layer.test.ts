/**
 * worktree / workspace / settings 域 T4 新增 API 单测。
 *
 * 覆盖：
 * - worktreeApi.listBranches：发 worktree.listBranches，payload {cwd}，解包 reply
 * - worktreeApi.list：发 worktree.list，payload {cwd}，解包 reply
 * - workspace.detect：发 workspace.detect，payload {cwd}，返三态
 * - workspace.detectBare：映射到 detect，提取 isBare/wsRoot/barePath
 * - settings.setWorktreeRootDir：发 config.setWorktreeRootDir，payload {dir}
 * - settings.getWorktreeRootDir：发 config.getWorktreeRootDir，空 payload
 * - settings.setSetupScript：发 config.setSetupScript，payload {script}
 * - settings.getSetupScript：发 config.getSetupScript，空 payload
 *
 * mock 策略：vi.mock('@/api/transport') 捕获 send + vi.mock('@/api/pending') 控制 create/register。
 *
 * 运行：npx vitest run src/__tests__/api/t4-api-layer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 捕获 transport.send 的调用（返回 true = 消息已送出；request.command 对 send false
// 会走 fast-fail reject，mock 须符合 transport.send 的真实 boolean 契约）
const sendMock = vi.fn((): boolean => true)
vi.mock('@/api/transport', () => ({
  send: (...args: unknown[]) => sendMock(...args),
}))

// mock pending：register 返回可控 Promise，create 返回固定 id
const registerMock = vi.fn()
vi.mock('@/api/pending', () => ({
  create: () => 'test-id',
  register: (id: string) => registerMock(id),
  reject: vi.fn(),
}))

import { worktreeApi } from '@/api/domains/worktree'
import { detect, detectBare } from '@/api/domains/workspace'
import {
  setWorktreeRootDir,
  getWorktreeRootDir,
  setSetupScript,
  getSetupScript,
} from '@/api/domains/settings'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── worktree 域 ──

describe('worktreeApi.listBranches', () => {
  it('发 worktree.listBranches，payload {cwd}，reply 含 local/remote/defaultBranch', async () => {
    const reply = { local: ['main', 'feat-a'], remote: ['origin/main', 'origin/dev'], defaultBranch: 'main' }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await worktreeApi.listBranches('/some/workspace')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('worktree.listBranches')
    expect(msg.id).toBe('test-id')
    expect(msg.payload).toEqual({ cwd: '/some/workspace' })
    expect(result).toEqual(reply)
    expect(result.local).toContain('main')
    expect(result.defaultBranch).toBe('main')
  })
})

describe('worktreeApi.list', () => {
  it('发 worktree.list，payload {cwd}，reply 含 items 数组', async () => {
    const reply = {
      items: [
        { path: '/ws/main', branch: 'main', HEAD: true, bare: false },
        { path: '/ws/feat-a', branch: 'feat-a', HEAD: false, bare: false },
      ],
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await worktreeApi.list('/some/workspace')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('worktree.list')
    expect(msg.payload).toEqual({ cwd: '/some/workspace' })
    expect(result).toEqual(reply)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]!.HEAD).toBe(true)
  })
})

// ── workspace 域 ──

describe('workspace.detect', () => {
  it('发 workspace.detect，payload {cwd}，返三态 bare-workspace', async () => {
    const reply = {
      mode: 'bare-workspace' as const,
      wsRoot: '/some/workspace',
      barePath: '/some/workspace/.bare',
      repoRoot: '/some/workspace/feat-x',
      defaultBranch: 'main',
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await detect('/some/workspace/feat-x')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('workspace.detect')
    expect(msg.payload).toEqual({ cwd: '/some/workspace/feat-x' })
    expect(result).toEqual(reply)
    expect(result.mode).toBe('bare-workspace')
  })

  it('返三态 plain-repo', async () => {
    const reply = {
      mode: 'plain-repo' as const,
      wsRoot: '',
      barePath: '',
      repoRoot: '/home/user/project',
      defaultBranch: 'main',
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await detect('/home/user/project')

    expect(result.mode).toBe('plain-repo')
    expect(result.repoRoot).toBe('/home/user/project')
  })

  it('返三态 not-repo', async () => {
    const reply = {
      mode: 'not-repo' as const,
      wsRoot: '',
      barePath: '',
      repoRoot: '',
      defaultBranch: '',
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await detect('/tmp/empty')

    expect(result.mode).toBe('not-repo')
  })
})

describe('workspace.detectBare (向后兼容)', () => {
  it('映射到 workspace.detect，bare-workspace → isBare=true', async () => {
    const reply = {
      mode: 'bare-workspace' as const,
      wsRoot: '/some/workspace',
      barePath: '/some/workspace/.bare',
      repoRoot: '/some/workspace/feat-x',
      defaultBranch: 'main',
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await detectBare('/some/workspace/feat-x')

    // 发的是 workspace.detect（不是 workspace.detectBare）
    const msg = sendMock.mock.calls[0]![0] as { type: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('workspace.detect')
    expect(result.isBare).toBe(true)
    expect(result.wsRoot).toBe('/some/workspace')
    expect(result.barePath).toBe('/some/workspace/.bare')
  })

  it('plain-repo → isBare=false', async () => {
    const reply = {
      mode: 'plain-repo' as const,
      wsRoot: '',
      barePath: '',
      repoRoot: '/home/user/project',
      defaultBranch: 'main',
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await detectBare('/home/user/project')

    expect(result.isBare).toBe(false)
  })

  it('not-repo → isBare=false', async () => {
    const reply = {
      mode: 'not-repo' as const,
      wsRoot: '',
      barePath: '',
      repoRoot: '',
      defaultBranch: '',
    }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await detectBare('/tmp/empty')

    expect(result.isBare).toBe(false)
  })
})

// ── settings 域（worktree 配置）──

describe('settings.setWorktreeRootDir', () => {
  it('发 config.setWorktreeRootDir，payload {dir}，reply 含 dir', async () => {
    const reply = { dir: '/custom/worktree/dir' }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await setWorktreeRootDir('/custom/worktree/dir')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('config.setWorktreeRootDir')
    expect(msg.id).toBe('test-id')
    expect(msg.payload).toEqual({ dir: '/custom/worktree/dir' })
    expect(result).toEqual(reply)
  })
})

describe('settings.getWorktreeRootDir', () => {
  it('发 config.getWorktreeRootDir，空 payload，reply 含 dir', async () => {
    const reply = { dir: '/existing/dir' }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await getWorktreeRootDir()

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('config.getWorktreeRootDir')
    expect(msg.payload).toEqual({})
    expect(result).toEqual(reply)
  })
})

describe('settings.setSetupScript', () => {
  it('发 config.setSetupScript，payload {script}，reply 含 script', async () => {
    const reply = { script: 'bash setup.sh' }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await setSetupScript('bash setup.sh')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('config.setSetupScript')
    expect(msg.id).toBe('test-id')
    expect(msg.payload).toEqual({ script: 'bash setup.sh' })
    expect(result).toEqual(reply)
  })
})

describe('settings.getSetupScript', () => {
  it('发 config.getSetupScript，空 payload，reply 含 script', async () => {
    const reply = { script: '' }
    registerMock.mockReturnValueOnce(Promise.resolve(reply))

    const result = await getSetupScript()

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('config.getSetupScript')
    expect(msg.payload).toEqual({})
    expect(result).toEqual(reply)
  })
})
