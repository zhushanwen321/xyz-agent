/**
 * extension domain API 测试 —— mapPendingToUIRequest + onPendingRequestsBatch（P3 D3）。
 *
 * 覆盖：
 * - TC1: mapPendingToUIRequest payload 解包到顶层（与 getPendingRequests PendingUIRequestResolved 同构）
 * - TC2: onPendingRequestsBatch 订阅 extension.pendingRequestsBatch 全局推送 + 取消
 *
 * mapPendingToUIRequest 是 pure function，直接调（不 mock）。
 * onPendingRequestsBatch 经真实 events 模块（dispatchGlobal 触发，验证 handler 调用 + unsub）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/extension-pending-batch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { PendingUiRequest } from '@xyz-agent/shared'
import {
  mapPendingToUIRequest,
  onPendingRequestsBatch,
} from '@/api/domains/extension'
import * as events from '@/api/events'

describe('mapPendingToUIRequest（P3 D3 pending batch 解包）', () => {
  it('TC1: payload 字段解包到顶层，形状符合 ExtensionUIRequest', () => {
    const req: PendingUiRequest = {
      requestId: 'r1',
      sessionId: 's1',
      method: 'select',
      payload: { title: 'A', askUser: true, askUserQuestions: [{ header: 'q', question: 'q?', options: [] }] },
      receivedAt: 1,
    }
    const mapped = mapPendingToUIRequest(req)
    expect(mapped).toBeDefined()
    // 原始 5 字段保留
    expect(mapped!.requestId).toBe('r1')
    expect(mapped!.sessionId).toBe('s1')
    expect(mapped!.method).toBe('select')
    expect(mapped!.receivedAt).toBe(1)
    // payload 字段解包到顶层
    expect(mapped!.title).toBe('A')
    expect(mapped!.askUser).toBe(true)
    expect(mapped!.askUserQuestions).toEqual([{ header: 'q', question: 'q?', options: [] }])
  })

  it('TC1b: 缺 method 字段的异常条目返回 undefined（类型守卫）', () => {
    const req = {
      requestId: 'r1',
      sessionId: 's1',
      // method 缺失
      payload: {},
      receivedAt: 1,
    } as unknown as PendingUiRequest
    expect(mapPendingToUIRequest(req)).toBeUndefined()
  })

  it('TC1c: requestId 非 string 的异常条目返回 undefined', () => {
    const req = {
      requestId: 123,
      sessionId: 's1',
      method: 'select',
      payload: {},
      receivedAt: 1,
    } as unknown as PendingUiRequest
    expect(mapPendingToUIRequest(req)).toBeUndefined()
  })
})

describe('onPendingRequestsBatch（P3 D3 全局订阅）', () => {
  it('TC2: dispatchGlobal extension.pendingRequestsBatch 触发 handler，收到 requests', () => {
    const handler = vi.fn()
    const unsub = onPendingRequestsBatch(handler)

    const requests: PendingUiRequest[] = [
      { requestId: 'r1', sessionId: 's1', method: 'select', payload: { title: 'A' }, receivedAt: 1 },
    ]
    events.dispatchGlobal({
      type: 'extension.pendingRequestsBatch',
      payload: { requests },
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(requests)

    unsub()
  })

  it('TC2b: unsub 后不再触发 handler', () => {
    const handler = vi.fn()
    const unsub = onPendingRequestsBatch(handler)
    unsub()

    events.dispatchGlobal({
      type: 'extension.pendingRequestsBatch',
      payload: { requests: [] },
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('TC2c: 其他 type 的 dispatchGlobal 不触发 pendingRequestsBatch handler', () => {
    const handler = vi.fn()
    onPendingRequestsBatch(handler)

    events.dispatchGlobal({
      type: 'config.providers',
      payload: { providers: [] },
    })

    expect(handler).not.toHaveBeenCalled()
  })
})
