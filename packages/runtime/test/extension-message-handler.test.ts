/**
 * ExtensionMessageHandler 单测 — 覆盖 CW wave `ui-requests-push-model` T2 的回归保护。
 *
 * 核心断言：`extension.getPendingRequests` handler 改用非破坏只读快照
 * `extensionTimeoutMgr.getPendingRequests`（而非取后即删的 getAndClearPendingRequests），
 * 解决前端两个消费者（Panel + ExtensionUIDialog）并发拉取同一份 pending 缓存时
 * 「先到者清空、后到者拿空」导致 ask-user 切 session 卡死的竞态。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/extension-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ExtensionMessageHandler } from '../src/transport/extension-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

/**
 * 构造带 capture 的 handler。
 * extension.getPendingRequests 这个 case 不依赖 extensionService（无 requireExt 守卫），
 * 故此处 extensionService 设 undefined，验证该路径不需要 service 也能跑通。
 */
function makeHandler(getPendingRequestsImpl: ReturnType<typeof vi.fn>) {
  const cap: Captured = { replies: [], errors: [] }
  const extensionTimeoutMgr = {
    getPendingRequests: getPendingRequestsImpl,
    // 关键 mock：非破坏语义下 handler 不应再调它，断言 0 次调用
    getAndClearPendingRequests: vi.fn(),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService: {},
    extensionService: undefined,
    extensionTimeoutMgr,
    broadcast: vi.fn(),
    nextPushId: vi.fn().mockReturnValue('p1'),
  }
  const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
  return { ctx, cap, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

// 模拟 getPendingRequests 解包后的样本数据（manager 已做 {...r, ...r.payload} 解包，
// renderer 的 ExtensionUIRequest 期望 title/message/options 等在顶层）
const sampleRequests = [
  { requestId: 'r1', sessionId: 's1', method: 'confirm', payload: { title: '确认操作？', confirmed: false }, receivedAt: 1_000, title: '确认操作？', confirmed: false },
  { requestId: 'r2', sessionId: 's1', method: 'ask-user', payload: { title: '选择一项', options: ['A', 'B'] }, receivedAt: 2_000, title: '选择一项', options: ['A', 'B'] },
]

describe('ExtensionMessageHandler — extension.getPendingRequests（非破坏快照）', () => {
  it('调非破坏 getPendingRequests（不清缓存），reply extension.pendingRequests', async () => {
    const getPending = vi.fn().mockReturnValue(sampleRequests)
    const { cap, ctx, handler } = makeHandler(getPending)

    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 's1' }), WS)

    // 非破坏版被调一次，参数为 sessionId
    expect(ctx.extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledTimes(1)
    expect(ctx.extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledWith('s1')
    // 关键回归：破坏版绝不被调用
    expect(ctx.extensionTimeoutMgr.getAndClearPendingRequests).not.toHaveBeenCalled()
    // reply 结构不变：type + { sessionId, requests }
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'extension.pendingRequests' })
    expect(cap.replies[0].payload).toEqual({ sessionId: 's1', requests: sampleRequests })
    expect(cap.errors).toHaveLength(0)
  })

  it('sessionId 缺失 → sendError(invalid_payload)，不调 extensionTimeoutMgr', async () => {
    const getPending = vi.fn()
    const { cap, ctx, handler } = makeHandler(getPending)

    await handler.handleExtensionMessage(msg('extension.getPendingRequests', {}), WS)

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'invalid_payload' })
    // 缺 sessionId 时不得触碰 extensionTimeoutMgr
    expect(ctx.extensionTimeoutMgr.getPendingRequests).not.toHaveBeenCalled()
    expect(ctx.extensionTimeoutMgr.getAndClearPendingRequests).not.toHaveBeenCalled()
    expect(cap.replies).toHaveLength(0)
  })

  it('session 无 pending → getPendingRequests 返回空数组，reply requests: []（非抛错）', async () => {
    const getPending = vi.fn().mockReturnValue([])
    const { cap, ctx, handler } = makeHandler(getPending)

    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 'empty-session' }), WS)

    expect(ctx.extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledWith('empty-session')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'extension.pendingRequests' })
    expect(cap.replies[0].payload).toEqual({ sessionId: 'empty-session', requests: [] })
    expect(cap.errors).toHaveLength(0)
  })

  it('多消费者两次拉取都拿到完整 pending（核心回归：非破坏语义）', async () => {
    // 模拟非破坏快照：两次调用都返回完整列表（非破坏版本身不删缓存）
    const getPending = vi.fn().mockReturnValue(sampleRequests)
    const { cap, ctx, handler } = makeHandler(getPending)

    // 模拟前端两个消费者（Panel + ExtensionUIDialog）各发一个 RPC 连续拉取
    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 's1' }, 'panel-req'), WS)
    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 's1' }, 'dialog-req'), WS)

    // 两次拉取都拿到完整列表（破坏版下第二次会拿到空 → 卡死，这是回归保护点）
    expect(cap.replies).toHaveLength(2)
    expect(cap.replies[0].payload.requests).toHaveLength(2)
    expect(cap.replies[1].payload.requests).toHaveLength(2)
    expect(cap.replies[0].payload.requests).toEqual(sampleRequests)
    expect(cap.replies[1].payload.requests).toEqual(sampleRequests)

    // 非破坏版被调两次，破坏版零次
    expect(ctx.extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledTimes(2)
    expect(ctx.extensionTimeoutMgr.getAndClearPendingRequests).not.toHaveBeenCalled()
    expect(cap.errors).toHaveLength(0)
  })
})
