/**
 * WorktreeMessageHandler 测试（W2：新增消息路由）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/worktree-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorktreeMessageHandler, type WorktreeHandlerContext } from './worktree-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'

// ── mock helpers ─────────────────────────────────────────────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as any
}

function mockContext(overrides?: Partial<WorktreeHandlerContext>): WorktreeHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    worktreeService: {
      create: vi.fn(async () => ({ cwd: '/project/feat-x', branch: 'feat/x' })),
      detect: vi.fn(async () => ({
        mode: 'bare-workspace' as const,
        wsRoot: '/project',
        barePath: '/project/.bare',
        repoRoot: '/project',
        defaultBranch: 'main',
      })),
      listBranches: vi.fn(async () => ({
        local: ['main', 'feat-x'],
        remote: ['origin/main', 'origin/feat-y'],
        defaultBranch: 'main',
      })),
      list: vi.fn(async () => ({
        items: [
          { path: '/project', branch: 'main', HEAD: true, bare: false },
          { path: '/project/feat-x', branch: 'feat-x', HEAD: false, bare: false },
        ],
      })),
    },
    ...overrides,
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── handles 清单 ────────────────────────────────────────────

describe('WorktreeMessageHandler.handles', () => {
  it('认领 worktree.create', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('worktree.create')
  })

  it('认领 worktree.listBranches', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('worktree.listBranches')
  })

  it('认领 worktree.list', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('worktree.list')
  })

  it('认领 workspace.detect', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('workspace.detect')
  })

  it('认领 workspace.detectBare', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('workspace.detectBare')
  })
})

// ── worktree.create ─────────────────────────────────────────

describe('WorktreeMessageHandler worktree.create', () => {
  it('成功时 reply worktree.created', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/x', baseBranch: 'origin/main', workspaceHint: '/project' }),
      ws,
    )

    expect(ctx.worktreeService.create).toHaveBeenCalledWith({
      branch: 'feat/x',
      baseBranch: 'origin/main',
      workspaceHint: '/project',
    })
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
    })
  })

  it('失败时 sendError 透传错误码', async () => {
    const ctx = mockContext()
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('worktree 已存在'), { code: 'WORKTREE_EXISTS', detail: { cwd: '/x', dirName: 'x' } })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'existing' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'WORKTREE_EXISTS',
      'worktree 已存在',
      'msg-1',
      expect.objectContaining({ detail: expect.anything() }),
    )
  })

  it('无 code 的错误归为 worktree_failed', async () => {
    const ctx = mockContext()
    ctx.worktreeService.create = vi.fn(async () => { throw new Error('unexpected') })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/test' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'worktree_failed',
      'unexpected',
      'msg-1',
      undefined,
    )
  })
})

// ── worktree.listBranches ───────────────────────────────────

describe('WorktreeMessageHandler worktree.listBranches', () => {
  it('成功时 reply worktree.branches', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('worktree.listBranches', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.listBranches).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.branches', {
      local: ['main', 'feat-x'],
      remote: ['origin/main', 'origin/feat-y'],
      defaultBranch: 'main',
    })
  })

  it('失败时 sendError', async () => {
    const ctx = mockContext()
    ctx.worktreeService.listBranches = vi.fn(async () => {
      throw Object.assign(new Error('not repo'), { code: 'NOT_GIT_REPO' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('worktree.listBranches', { cwd: '/tmp' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'NOT_GIT_REPO',
      'not repo',
      'msg-1',
      undefined,
    )
  })
})

// ── worktree.list ───────────────────────────────────────────

describe('WorktreeMessageHandler worktree.list', () => {
  it('成功时 reply worktree.list:result', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('worktree.list', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.list).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.list:result', {
      items: [
        { path: '/project', branch: 'main', HEAD: true, bare: false },
        { path: '/project/feat-x', branch: 'feat-x', HEAD: false, bare: false },
      ],
    })
  })
})

// ── workspace.detect / workspace.detectBare ─────────────────

describe('WorktreeMessageHandler workspace.detect', () => {
  it('workspace.detect reply workspace.detected', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('workspace.detect', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.detect).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'workspace.detected', {
      mode: 'bare-workspace',
      wsRoot: '/project',
      barePath: '/project/.bare',
      repoRoot: '/project',
      defaultBranch: 'main',
    })
  })

  it('workspace.detectBare 别名等价于 workspace.detect', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('workspace.detectBare', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.detect).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'workspace.detected', expect.anything())
  })

  it('detect 失败时 sendError', async () => {
    const ctx = mockContext()
    ctx.worktreeService.detect = vi.fn(async () => {
      throw Object.assign(new Error('not repo'), { code: 'NOT_GIT_REPO' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('workspace.detect', { cwd: '/tmp' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'NOT_GIT_REPO',
      'not repo',
      'msg-1',
      undefined,
    )
  })
})
