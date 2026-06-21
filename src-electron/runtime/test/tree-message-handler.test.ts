/**
 * TreeMessageHandler 单测 — 直接注入 mock ctx 覆盖 5 个 switch 分支。
 *
 * 覆盖（report #5）：
 * - tree-data: success / 缺 sessionId / NotFound→auto-restore 成功 / NotFound→auto-restore 失败 / 非NotFound rethrow
 * - tree-navigate: success / 缺 targetEntryId / NotFound 友好错误 / 非NotFound rethrow
 * - tree-fork: success(含 rebind+broadcast) / 缺 entryId / NotFound
 * - tree-capability: success / NotFound→false
 * - tree-clone: success / NotFound
 *
 * session-tree 是 fork pi 的核心动机（leafId 透出），WS 入口风险最高。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/tree-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { TreeMessageHandler } from '../src/transport/tree-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface CapturedReply {
  id: string | undefined
  type: string
  payload: Record<string, unknown>
}

/** 构造 mock ctx + 捕获 reply 调用。treeService/sessionService 方法可按用例 override。 */
function makeHandler(opts: {
  getTree?: ReturnType<typeof vi.fn>
  navigateTree?: ReturnType<typeof vi.fn>
  forkFromEntry?: ReturnType<typeof vi.fn>
  cloneSession?: ReturnType<typeof vi.fn>
  isNavigateCapable?: ReturnType<typeof vi.fn>
  getSummary?: ReturnType<typeof vi.fn>
  restoreSession?: ReturnType<typeof vi.fn>
  rebindAfterFork?: ReturnType<typeof vi.fn>
}) {
  const replies: CapturedReply[] = []
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    treeService: {
      getTree: opts.getTree ?? vi.fn(),
      navigateTree: opts.navigateTree ?? vi.fn(),
      forkFromEntry: opts.forkFromEntry ?? vi.fn(),
      cloneSession: opts.cloneSession ?? vi.fn(),
      isNavigateCapable: opts.isNavigateCapable ?? vi.fn().mockReturnValue(true),
    },
    sessionService: {
      getSummary: opts.getSummary ?? vi.fn().mockReturnValue(undefined),
      restoreSession: opts.restoreSession ?? vi.fn(),
      rebindAfterFork: opts.rebindAfterFork ?? vi.fn(),
    },
    broadcastSessionList: vi.fn(),
  }
  const handler = new TreeMessageHandler(ctx as unknown as ConstructorParameters<typeof TreeMessageHandler>[0])
  return { ctx, replies, handler }
}

function buildMsg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

const NOT_FOUND_ERR = new Error('Session not found')

describe('TreeMessageHandler', () => {
  describe('session.tree-data', () => {
    it('success: 回传 tree 数据', async () => {
      const treeData = { sessionId: 's1', tree: [{ id: 'n1' }], leafId: 'n1', branchCount: 1, navigateCapable: true }
      const { replies, handler } = makeHandler({ getTree: vi.fn().mockResolvedValue(treeData) })
      await handler.handleTreeMessage(buildMsg('session.tree-data', { sessionId: 's1' }), WS)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ id: 'm1', type: 'session.tree-data' })
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', leafId: 'n1', branchCount: 1 })
    })

    it('缺 sessionId: 回 error envelope', async () => {
      const { replies, handler } = makeHandler({})
      await handler.handleTreeMessage(buildMsg('session.tree-data', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'session.tree-data' })
      expect(replies[0].payload).toMatchObject({ success: false, error: 'sessionId required' })
    })

    it('NotFound → auto-restore 成功后回传 tree', async () => {
      const getTree = vi.fn()
        .mockRejectedValueOnce(NOT_FOUND_ERR)
        .mockResolvedValueOnce({ sessionId: 's1', tree: [], leafId: null, branchCount: 0, navigateCapable: false })
      const restoreSession = vi.fn().mockResolvedValue({})
      const { replies, handler } = makeHandler({ getTree, restoreSession })
      await handler.handleTreeMessage(buildMsg('session.tree-data', { sessionId: 's1' }), WS)
      expect(restoreSession).toHaveBeenCalledWith('s1')
      expect(getTree).toHaveBeenCalledTimes(2)
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', branchCount: 0 })
    })

    it('NotFound → auto-restore 也失败: 回降级 error', async () => {
      const getTree = vi.fn().mockRejectedValue(NOT_FOUND_ERR)
      const restoreSession = vi.fn().mockRejectedValue(new Error('restore boom'))
      const { replies, handler } = makeHandler({ getTree, restoreSession })
      await handler.handleTreeMessage(buildMsg('session.tree-data', { sessionId: 's1' }), WS)
      expect(replies[0].payload).toMatchObject({
        sessionId: 's1', tree: [], leafId: null, error: 'Session not available',
      })
    })

    it('非 NotFound 且 summary 存在: rethrow（不降级）', async () => {
      const getTree = vi.fn().mockRejectedValue(new Error('disk corrupted'))
      const { handler } = makeHandler({
        getTree,
        getSummary: vi.fn().mockReturnValue({ id: 's1', label: 'x' }),
      })
      await expect(
        handler.handleTreeMessage(buildMsg('session.tree-data', { sessionId: 's1' }), WS),
      ).rejects.toThrow('disk corrupted')
    })
  })

  describe('session.tree-navigate', () => {
    it('success: 回 navigate-result', async () => {
      const navigateTree = vi.fn().mockResolvedValue({ success: true, newLeafId: 'e2' })
      const { replies, handler } = makeHandler({ navigateTree })
      await handler.handleTreeMessage(
        buildMsg('session.tree-navigate', { sessionId: 's1', targetEntryId: 'e2' }), WS,
      )
      expect(navigateTree).toHaveBeenCalledWith('s1', 'e2')
      expect(replies[0]).toMatchObject({ type: 'session.tree-navigate-result' })
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', success: true, newLeafId: 'e2' })
    })

    it('缺 targetEntryId: 回 error', async () => {
      const { replies, handler } = makeHandler({})
      await handler.handleTreeMessage(
        buildMsg('session.tree-navigate', { sessionId: 's1' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ success: false, error: 'targetEntryId required' })
    })

    it('缺 sessionId: errorType 为 navigate-result', async () => {
      const { replies, handler } = makeHandler({})
      await handler.handleTreeMessage(buildMsg('session.tree-navigate', {}), WS)
      expect(replies[0].type).toBe('session.tree-navigate-result')
      expect(replies[0].payload).toMatchObject({ success: false, error: 'sessionId required' })
    })

    it('NotFound: 回友好错误', async () => {
      const navigateTree = vi.fn().mockRejectedValue(NOT_FOUND_ERR)
      const { replies, handler } = makeHandler({ navigateTree })
      await handler.handleTreeMessage(
        buildMsg('session.tree-navigate', { sessionId: 's1', targetEntryId: 'e2' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ success: false, error: 'Session not active' })
    })

    it('非 NotFound: rethrow', async () => {
      const navigateTree = vi.fn().mockRejectedValue(new Error('unexpected'))
      const { handler } = makeHandler({ navigateTree })
      await expect(
        handler.handleTreeMessage(
          buildMsg('session.tree-navigate', { sessionId: 's1', targetEntryId: 'e2' }), WS,
        ),
      ).rejects.toThrow('unexpected')
    })
  })

  describe('session.tree-fork', () => {
    it('success: rebindAfterFork + broadcastSessionList 被调用', async () => {
      const forkFromEntry = vi.fn().mockResolvedValue({
        success: true, newSessionId: 's2', sessionFile: '/tmp/f.jsonl',
      })
      const getSummary = vi.fn().mockReturnValue({ id: 's1', label: 'orig' })
      const rebindAfterFork = vi.fn().mockResolvedValue(undefined)
      const { ctx, replies, handler } = makeHandler({ forkFromEntry, getSummary, rebindAfterFork })
      await handler.handleTreeMessage(
        buildMsg('session.tree-fork', { sessionId: 's1', entryId: 'e1' }), WS,
      )
      expect(forkFromEntry).toHaveBeenCalledWith('s1', 'e1')
      expect(rebindAfterFork).toHaveBeenCalledWith('s1', 's2', 'orig-fork', '/tmp/f.jsonl')
      expect(ctx.broadcastSessionList).toHaveBeenCalled()
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', success: true, newSessionId: 's2' })
    })

    it('success 但无 newSessionId: 不 rebind/broadcast', async () => {
      const forkFromEntry = vi.fn().mockResolvedValue({ success: false, error: 'no entry' })
      const rebindAfterFork = vi.fn()
      const { ctx, handler } = makeHandler({ forkFromEntry, rebindAfterFork })
      await handler.handleTreeMessage(
        buildMsg('session.tree-fork', { sessionId: 's1', entryId: 'e1' }), WS,
      )
      expect(rebindAfterFork).not.toHaveBeenCalled()
      expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
    })

    it('缺 entryId: 回 error', async () => {
      const { replies, handler } = makeHandler({})
      await handler.handleTreeMessage(
        buildMsg('session.tree-fork', { sessionId: 's1' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ success: false, error: 'entryId required' })
    })

    it('NotFound: 回友好错误', async () => {
      const forkFromEntry = vi.fn().mockRejectedValue(NOT_FOUND_ERR)
      const { replies, handler } = makeHandler({ forkFromEntry })
      await handler.handleTreeMessage(
        buildMsg('session.tree-fork', { sessionId: 's1', entryId: 'e1' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ success: false, error: 'Session not active' })
    })
  })

  describe('session.tree-capability', () => {
    it('success: 回 navigateCapable 布尔', async () => {
      const { replies, handler } = makeHandler({ isNavigateCapable: vi.fn().mockReturnValue(true) })
      await handler.handleTreeMessage(
        buildMsg('session.tree-capability', { sessionId: 's1' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', navigateCapable: true })
    })

    it('NotFound: 回 navigateCapable false', async () => {
      const isNavigateCapable = vi.fn(() => { throw NOT_FOUND_ERR })
      const { replies, handler } = makeHandler({ isNavigateCapable })
      await handler.handleTreeMessage(
        buildMsg('session.tree-capability', { sessionId: 's1' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', navigateCapable: false })
    })
  })

  describe('session.tree-clone', () => {
    it('success: rebindAfterFork + broadcast', async () => {
      const cloneSession = vi.fn().mockResolvedValue({
        success: true, newSessionId: 's3', sessionFile: '/tmp/c.jsonl',
      })
      const getSummary = vi.fn().mockReturnValue({ id: 's1', label: 'orig' })
      const rebindAfterFork = vi.fn().mockResolvedValue(undefined)
      const { ctx, replies, handler } = makeHandler({ cloneSession, getSummary, rebindAfterFork })
      await handler.handleTreeMessage(
        buildMsg('session.tree-clone', { sessionId: 's1' }), WS,
      )
      expect(cloneSession).toHaveBeenCalledWith('s1')
      expect(rebindAfterFork).toHaveBeenCalledWith('s1', 's3', 'orig-clone', '/tmp/c.jsonl')
      expect(ctx.broadcastSessionList).toHaveBeenCalled()
      expect(replies[0].payload).toMatchObject({ sessionId: 's1', success: true, newSessionId: 's3' })
    })

    it('NotFound: 回友好错误', async () => {
      const cloneSession = vi.fn().mockRejectedValue(NOT_FOUND_ERR)
      const { replies, handler } = makeHandler({ cloneSession })
      await handler.handleTreeMessage(
        buildMsg('session.tree-clone', { sessionId: 's1' }), WS,
      )
      expect(replies[0].payload).toMatchObject({ success: false, error: 'Session not active' })
    })
  })
})
