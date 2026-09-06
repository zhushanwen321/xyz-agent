/**
 * ExtensionMessageHandler 分发路由特征锚定测试（复杂度债务偿还 W1 回归保护）。
 *
 * 背景：handleExtensionMessage 从 ~13 分支 switch 重构为表驱动分发（routes map + case 体
 * 提取为私有 helper）。本文件锁定此前无测试覆盖的分支：extension.ui_response 全部四路
 * （bridge 短路 / 超时迟到短路 / 无活跃 client / 正常转发）、extension.list/recommended
 * service 缺席空 reply、toggle 领域错误透传、installDir/setAutoUpgrade 校验分支。
 * getPendingRequests 已有独立测试文件（test/extension-message-handler.test.ts），不重复。
 *
 * 运行：cd packages/runtime && npx vitest run test/extension-message-handler-dispatch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ExtensionMessageHandler } from '../src/transport/extension-message-handler.js'
import { ExtensionInstallError } from '../src/services/extension-service.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

interface HandlerOpts {
  extensionService?: Record<string, ReturnType<typeof vi.fn>> | undefined
  getRpcClient?: ReturnType<typeof vi.fn> | undefined
}

function makeHandler(opts: HandlerOpts = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const extensionTimeoutMgr = {
    isBridgeRequest: vi.fn().mockReturnValue(false),
    removeBridgeRequest: vi.fn(),
    isTimedOut: vi.fn().mockReturnValue(false),
    clearTimedOut: vi.fn(),
    clearTimeout: vi.fn(),
    removePendingRequest: vi.fn(),
    getPendingRequests: vi.fn().mockReturnValue([]),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService: { getRpcClient: opts.getRpcClient ?? vi.fn().mockReturnValue(undefined) },
    extensionService: opts.extensionService,
    extensionTimeoutMgr,
    broadcast: vi.fn(),
    nextPushId: vi.fn().mockReturnValue('push-1'),
  }
  const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
  return { ctx, cap, handler, extensionTimeoutMgr }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('ExtensionMessageHandler 分发路由（W1 表驱动重构回归锚定）', () => {
  describe('extension.ui_response 四路（超时/桥接/无 client/正常转发）', () => {
    it('bridge 请求（select marker 通道）→ 移除桥接记录，不转发 pi、不 reply、不报错', async () => {
      const { ctx, cap, handler, extensionTimeoutMgr } = makeHandler({ getRpcClient: vi.fn().mockReturnValue({ sendExtensionUiResponse: vi.fn() }) })
      extensionTimeoutMgr.isBridgeRequest.mockReturnValue(true)
      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r1', method: 'select', result: 'a' }), WS)
      expect(extensionTimeoutMgr.removeBridgeRequest).toHaveBeenCalledWith('r1')
      expect(extensionTimeoutMgr.removePendingRequest).toHaveBeenCalledWith('s1', 'r1')
      // 不向 pi 转发、不 reply、不 sendError
      expect(ctx.sessionService.getRpcClient).not.toHaveBeenCalled()
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors).toHaveLength(0)
    })

    it('超时后迟到响应 → 清理 timedOut/pending，不向 pi 二次响应（P2-6 双响应拦截）', async () => {
      const client = { sendExtensionUiResponse: vi.fn() }
      const { ctx, cap, handler, extensionTimeoutMgr } = makeHandler({ getRpcClient: vi.fn().mockReturnValue(client) })
      extensionTimeoutMgr.isTimedOut.mockReturnValue(true)
      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r1', method: 'confirm', result: true }), WS)
      expect(extensionTimeoutMgr.clearTimedOut).toHaveBeenCalledWith('r1')
      expect(extensionTimeoutMgr.clearTimeout).toHaveBeenCalledWith('r1')
      expect(extensionTimeoutMgr.removePendingRequest).toHaveBeenCalledWith('s1', 'r1')
      // 关键：不向 pi 再发（runtime 超时已发过默认响应）
      expect(client.sendExtensionUiResponse).not.toHaveBeenCalled()
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors).toHaveLength(0)
    })

    it('无活跃 client → 清理 pending + sendError(handler_error, "No active session for extension response: s1")', async () => {
      const { ctx, cap, handler, extensionTimeoutMgr } = makeHandler({ getRpcClient: vi.fn().mockReturnValue(undefined) })
      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r1', method: 'confirm', result: true }), WS)
      expect(extensionTimeoutMgr.clearTimeout).toHaveBeenCalledWith('r1')
      expect(extensionTimeoutMgr.removePendingRequest).toHaveBeenCalledWith('s1', 'r1')
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'handler_error',
        message: 'No active session for extension response: s1',
        details: { sessionId: 's1' },
      })
    })

    it('正常路径 → client.sendExtensionUiResponse(requestId, result, method) + 清理 pending；result undefined 时第二参为 null（?? null）', async () => {
      const client = { sendExtensionUiResponse: vi.fn() }
      const { ctx, cap, handler, extensionTimeoutMgr } = makeHandler({ getRpcClient: vi.fn().mockReturnValue(client) })
      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r1', method: 'confirm', result: true }), WS)
      expect(client.sendExtensionUiResponse).toHaveBeenCalledWith('r1', true, 'confirm')
      expect(extensionTimeoutMgr.clearTimeout).toHaveBeenCalledWith('r1')
      expect(extensionTimeoutMgr.removePendingRequest).toHaveBeenCalledWith('s1', 'r1')
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors).toHaveLength(0)

      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r2', method: 'select' }), WS)
      expect(client.sendExtensionUiResponse).toHaveBeenCalledWith('r2', null, 'select')
    })
  })

  describe('extension.list / extension.recommended 的 service 缺席空 reply（区别于 requireExt 报错路径）', () => {
    it('extension.list：service 未注入 → reply config.extensions { extensions: [] }（不报错）', async () => {
      const { cap, handler } = makeHandler({ extensionService: undefined })
      await handler.handleExtensionMessage(msg('extension.list', {}), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'config.extensions', payload: { extensions: [] } })
      expect(cap.errors).toHaveLength(0)
    })

    it('extension.list：service 注入 → reply scanExtensions() 结果', async () => {
      const scanExtensions = vi.fn().mockResolvedValue([{ id: 'e1' }])
      const { cap, handler } = makeHandler({ extensionService: { scanExtensions } })
      await handler.handleExtensionMessage(msg('extension.list', {}), WS)
      expect(cap.replies[0]).toMatchObject({ type: 'config.extensions', payload: { extensions: [{ id: 'e1' }] } })
    })

    it('extension.recommended：service 未注入 → reply { recommended: [] }（不报错）', async () => {
      const { cap, handler } = makeHandler({ extensionService: undefined })
      await handler.handleExtensionMessage(msg('extension.recommended', {}), WS)
      expect(cap.replies[0]).toMatchObject({ type: 'extension.recommended', payload: { recommended: [] } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('extension.toggle 错误透传', () => {
    it('领域错误 ExtensionInstallError → 透传 code + hint 进 details（如 infrastructure_cannot_disable）', async () => {
      const err = new ExtensionInstallError('infrastructure_cannot_disable', 'infra extension cannot be disabled', 'disable it in infrastructure group settings')
      const toggleExtension = vi.fn().mockRejectedValue(err)
      const { cap, handler } = makeHandler({ extensionService: { toggleExtension, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.toggle', { name: 'system-prompt', enabled: false }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'infrastructure_cannot_disable',
        message: 'infra extension cannot be disabled',
        details: { hint: 'disable it in infrastructure group settings' },
      })
    })

    it('非领域错误 → fallback toggle_failed + toErrorMessage 文案，无 details', async () => {
      const toggleExtension = vi.fn().mockRejectedValue(new Error('fs exploded'))
      const { cap, handler } = makeHandler({ extensionService: { toggleExtension, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.toggle', { name: 'x', enabled: true }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'toggle_failed', message: 'fs exploded' })
      expect(cap.errors[0].details).toBeUndefined()
    })
  })

  it('extension.installDir 空 path → sendError(invalid_payload, 文案逐字锚定)，不调 installLocalDirectory', async () => {
    const installLocalDirectory = vi.fn()
    const { cap, handler } = makeHandler({ extensionService: { installLocalDirectory } })
    await handler.handleExtensionMessage(msg('extension.installDir', { path: '' }), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'invalid_payload',
      message: 'extension.installDir requires a non-empty "path" string',
    })
    expect(installLocalDirectory).not.toHaveBeenCalled()
  })

  describe('extension.setAutoUpgrade 校验与错误分支', () => {
    it('autoUpgrade 非布尔 → sendError(invalid_payload, 文案逐字锚定)，不调 setAutoUpgrade', async () => {
      const setAutoUpgrade = vi.fn()
      const { cap, handler } = makeHandler({ extensionService: { setAutoUpgrade, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.setAutoUpgrade', { name: 'x', autoUpgrade: 'yes' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'invalid_payload',
        message: 'extension.setAutoUpgrade requires "autoUpgrade" to be a boolean',
      })
      expect(setAutoUpgrade).not.toHaveBeenCalled()
    })

    it('service reject → sendError(set_auto_upgrade_failed) + toErrorMessage 文案', async () => {
      const setAutoUpgrade = vi.fn().mockRejectedValue(new Error('disk full'))
      const { cap, handler } = makeHandler({ extensionService: { setAutoUpgrade, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.setAutoUpgrade', { name: 'x', autoUpgrade: true }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'set_auto_upgrade_failed', message: 'disk full' })
    })
  })

  it('未知 type → 查表落空：不发任何消息、不抛错（同原 switch 无 default 行为）', async () => {
    const { cap, handler } = makeHandler()
    await expect(handler.handleExtensionMessage(msg('extension.nonexistent', {}), WS)).resolves.toBeUndefined()
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(0)
  })
})

