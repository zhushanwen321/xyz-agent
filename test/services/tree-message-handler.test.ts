/**
 * Tests for TreeMessageHandler fork/clone label naming (AC10).
 *
 * Verifies:
 * - Fork: new session label = originalLabel + '-fork'
 * - Clone: new session label = originalLabel + '-clone'
 */
import { describe, it, expect, vi } from 'vitest'
import { TreeMessageHandler } from '../../src-electron/runtime/src/tree-message-handler.js'
import type { TreeService } from '../../src-electron/runtime/src/services/tree-service.js'
import type { ISessionService } from '../../src-electron/runtime/src/interfaces.js'

function createMocks() {
  const rebindAfterFork = vi.fn().mockResolvedValue(undefined)
  const renameSession = vi.fn().mockResolvedValue(undefined)
  const getSummary = vi.fn().mockReturnValue({ label: 'my-session', id: 'sid-1' })
  const broadcastSessionList = vi.fn()

  const sessionService = {
    rebindAfterFork,
    renameSession,
    getSummary,
    restoreSession: vi.fn(),
  } as unknown as ISessionService

  const forkFromEntry = vi.fn().mockResolvedValue({
    success: true,
    newSessionId: 'new-fork-id',
    sessionFile: '/tmp/fork-session.jsonl',
  })
  const cloneSession = vi.fn().mockResolvedValue({
    success: true,
    newSessionId: 'new-clone-id',
  })

  const treeService = {
    forkFromEntry,
    cloneSession,
    getTree: vi.fn(),
    navigateTree: vi.fn(),
    isNavigateCapable: vi.fn().mockReturnValue(true),
  } as unknown as TreeService

  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const send = (_ws: unknown, msg: { type: string; payload: Record<string, unknown> }) => {
    sent.push(msg)
  }

  const handler = new TreeMessageHandler({
    sessionService,
    treeService,
    send,
    broadcastSessionList,
  })

  return {
    handler,
    sessionService,
    treeService,
    rebindAfterFork,
    renameSession,
    getSummary,
    broadcastSessionList,
    sent,
  }
}

describe('TreeMessageHandler fork/clone label naming (AC10)', () => {
  it('fork: passes originalLabel+"-fork" to rebindAfterFork', async () => {
    const ctx = createMocks()
    const msg = {
      type: 'session.tree-fork' as const,
      id: 'msg-1',
      payload: { sessionId: 'sid-1', entryId: 'entry-5' },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.handler.handleTreeMessage(msg as any, {} as any)

    // forkFromEntry called with correct args
    expect(ctx.treeService.forkFromEntry).toHaveBeenCalledWith('sid-1', 'entry-5', '-fork')

    // rebindAfterFork called with label = 'my-session-fork'
    expect(ctx.rebindAfterFork).toHaveBeenCalledWith(
      'sid-1',
      'new-fork-id',
      'my-session-fork',
      '/tmp/fork-session.jsonl',
    )

    // broadcast called
    expect(ctx.broadcastSessionList).toHaveBeenCalled()
  })

  it('clone: calls renameSession with originalLabel+"-clone"', async () => {
    const ctx = createMocks()
    const msg = {
      type: 'session.tree-clone' as const,
      id: 'msg-2',
      payload: { sessionId: 'sid-1' },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.handler.handleTreeMessage(msg as any, {} as any)

    // cloneSession called with '-clone' suffix
    expect(ctx.treeService.cloneSession).toHaveBeenCalledWith('sid-1', '-clone')

    // renameSession called on the new session with label = 'my-session-clone'
    expect(ctx.renameSession).toHaveBeenCalledWith('new-clone-id', 'my-session-clone')

    // broadcast called
    expect(ctx.broadcastSessionList).toHaveBeenCalled()
  })

  it('fork: uses "session" as fallback label when getSummary returns undefined', async () => {
    const ctx = createMocks()
    ctx.getSummary.mockReturnValue(undefined)

    const msg = {
      type: 'session.tree-fork' as const,
      id: 'msg-3',
      payload: { sessionId: 'sid-1', entryId: 'entry-5' },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.handler.handleTreeMessage(msg as any, {} as any)

    // rebindAfterFork called with fallback label 'session-fork'
    expect(ctx.rebindAfterFork).toHaveBeenCalledWith(
      'sid-1',
      'new-fork-id',
      'session-fork',
      '/tmp/fork-session.jsonl',
    )
  })

  it('clone: uses "session" as fallback label when getSummary returns undefined', async () => {
    const ctx = createMocks()
    ctx.getSummary.mockReturnValue(undefined)

    const msg = {
      type: 'session.tree-clone' as const,
      id: 'msg-4',
      payload: { sessionId: 'sid-1' },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.handler.handleTreeMessage(msg as any, {} as any)

    // renameSession called with fallback label 'session-clone'
    expect(ctx.renameSession).toHaveBeenCalledWith('new-clone-id', 'session-clone')
  })
})
