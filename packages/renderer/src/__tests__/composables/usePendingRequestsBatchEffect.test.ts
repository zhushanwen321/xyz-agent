/**
 * bindPendingRequestsBatchEffect 集成测试（P3 D3）。
 *
 * 覆盖：
 * - TC3: 收到 batch 后逐条写入 store（按 sessionId 分流）
 * - TC4: 重复 requestId 不重复写入 store（requestId dedup，FR2）
 * - TC5: 空 requests 数组 no-op
 * - TC6: batch 含异常条目跳过不入 store（ES3）
 *
 * mock 策略：mock @/api/domains/extension 的 onPendingRequestsBatch 捕获 handler（emit 触发），
 * mapPendingToUIRequest 用真实实现（pure function）。store 用真实 pinia（setActivePinia）。
 * effect 必须在 effectScope 内运行（onScopeDispose）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/usePendingRequestsBatchEffect.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { PendingUiRequest } from '@xyz-agent/shared'
import { mapPendingToUIRequest } from '@/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'

// ── mock extension api：用 vi.hoisted 持有可变 handler 槽（vi.mock 工厂被提升，需 hoisted 持有引用）──
const { batchHandlerSlot } = vi.hoisted(() => ({ batchHandlerSlot: { current: null as ((requests: PendingUiRequest[]) => void) | null } }))
vi.mock('@/api/domains/extension', async () => {
  const actual = await vi.importActual<typeof import('@/api/domains/extension')>('@/api/domains/extension')
  return {
    ...actual,
    onPendingRequestsBatch: (handler: (requests: PendingUiRequest[]) => void) => {
      batchHandlerSlot.current = handler
      return () => { batchHandlerSlot.current = null }
    },
  }
})

// emit helper：触发捕获的 batchHandler
function emitBatch(requests: PendingUiRequest[]): void {
  if (!batchHandlerSlot.current) throw new Error('batchHandler 未注册（effect 未绑定）')
  batchHandlerSlot.current(requests)
}

// 构造 PendingUiRequest
function mkReq(sid: string, requestId: string, payload: Record<string, unknown> = {}): PendingUiRequest {
  return { requestId, sessionId: sid, method: 'select', payload, receivedAt: 1 }
}

// 顶层 import（避免 scope.run 内 await import 跨异步边界丢失 effect scope 关联）
import { bindPendingRequestsBatchEffect } from '@/composables/effects/usePendingRequestsBatchEffect'

describe('bindPendingRequestsBatchEffect（P3 D3 pending batch 全局订阅）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    batchHandlerSlot.current = null
  })

  it('TC3: 收到 batch 后逐条写入 store（按 sessionId 分流）', () => {
    const scope = effectScope()
    scope.run(() => {
      bindPendingRequestsBatchEffect()
    })
    const store = useExtensionUIStore()

    emitBatch([
      mkReq('s1', 'r1', { title: 'A' }),
      mkReq('s2', 'r2', { title: 'B' }),
    ])

    // 两 session 分区各含 1 条
    expect(store.getRequestsBySession('s1')).toHaveLength(1)
    expect(store.getRequestsBySession('s2')).toHaveLength(1)
    expect(store.getRequestsBySession('s1')[0].requestId).toBe('r1')
    expect(store.getRequestsBySession('s2')[0].requestId).toBe('r2')
    // payload 解包到顶层（title 字段）
    expect(store.getRequestsBySession('s1')[0].title).toBe('A')

    scope.stop()
  })

  it('TC4: 重复 requestId 不重复写入 store（requestId dedup，FR2）', () => {
    const scope = effectScope()
    scope.run(() => {
      bindPendingRequestsBatchEffect()
    })
    const store = useExtensionUIStore()

    // 同一 requestId 推送两次（模拟 P2 回放 + initial state 补发边角）
    emitBatch([mkReq('s1', 'r1', { title: 'A' })])
    emitBatch([mkReq('s1', 'r1', { title: 'A' })])

    // store.addRequest dedup：仅 1 条
    expect(store.getRequestsBySession('s1')).toHaveLength(1)

    scope.stop()
  })

  it('TC5: 空 requests 数组 no-op（不抛错，store 状态不变）', () => {
    const scope = effectScope()
    scope.run(() => {
      bindPendingRequestsBatchEffect()
    })
    const store = useExtensionUIStore()

    expect(() => emitBatch([])).not.toThrow()
    // store 无条目
    expect(store.getRequestsBySession('s1')).toHaveLength(0)

    scope.stop()
  })

  it('TC6: batch 含异常条目（缺 method）跳过不入 store（ES3）', () => {
    const scope = effectScope()
    scope.run(() => {
      bindPendingRequestsBatchEffect()
    })
    const store = useExtensionUIStore()

    // 正常条目 + 异常条目（缺 method）
    emitBatch([
      mkReq('s1', 'r1', { title: 'A' }),
      { requestId: 'r2', sessionId: 's2', method: 123 as unknown as string, payload: {}, receivedAt: 1 },
    ])

    // 仅正常条目入 store（s1/r1），异常条目（s2/r2）跳过
    expect(store.getRequestsBySession('s1')).toHaveLength(1)
    expect(store.getRequestsBySession('s2')).toHaveLength(0)

    scope.stop()
  })

  it('TC3b: 多次 emit batch 累积写入 store（订阅持续生效）', () => {
    const scope = effectScope()
    scope.run(() => {
      bindPendingRequestsBatchEffect()
    })
    const store = useExtensionUIStore()

    // 多次 emit 不同 requestId（订阅持续生效，非一次性）
    emitBatch([mkReq('s1', 'r1', { title: 'A' })])
    emitBatch([mkReq('s1', 'r2', { title: 'B' })])
    emitBatch([mkReq('s2', 'r3', { title: 'C' })])

    expect(store.getRequestsBySession('s1')).toHaveLength(2)
    expect(store.getRequestsBySession('s2')).toHaveLength(1)

    scope.stop()
  })

  it('TC3c: scope.stop() 后退订（batchHandler 置 null）', () => {
    const scope = effectScope()
    scope.run(() => {
      bindPendingRequestsBatchEffect()
    })
    // 订阅已注册
    expect(batchHandlerSlot.current).not.toBeNull()

    // stop 触发 onScopeDispose(unsub)，batchHandler 置 null
    scope.stop()
    expect(batchHandlerSlot.current).toBeNull()
  })

  it('TC6b: mapPendingToUIRequest pure function 仍可独立调用（未被 mock 影响）', () => {
    // importActual 保留真实实现，验证 pure helper 可独立用
    const mapped = mapPendingToUIRequest(mkReq('s1', 'r1', { title: 'X' }))
    expect(mapped).toBeDefined()
    expect(mapped!.title).toBe('X')
  })
})
