/**
 * useSessionStreamSync wave w1 测试（TC1-TC10）。
 *
 * - TC1-TC4：diffSessionList 纯函数（无 mock）。
 * - TC5-TC10：bindSessionStreamSync 集成（真实 Pinia store + mock useChat，effectScope 包裹）。
 *
 * 运行：cd packages/renderer && npx vitest run composables/effects/__tests__/useSessionStreamSync.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { diffSessionList } from '../useSessionStreamSync'
import type { SessionSummary } from '@xyz-agent/shared'

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string): SessionSummary {
  return { id, label: id, cwd: '/x', status: 'idle' } as SessionSummary
}

describe('diffSessionList', () => {
  it('TC1: 纯新增', () => {
    const result = diffSessionList([mkSession('a'), mkSession('b')], [])
    expect(result).toEqual({ added: ['a', 'b'], removed: [] })
  })
  it('TC2: 纯移除', () => {
    const result = diffSessionList([], [mkSession('a'), mkSession('b')])
    expect(result).toEqual({ added: [], removed: ['a', 'b'] })
  })
  it('TC3: 混合（新增+移除+保留）', () => {
    const result = diffSessionList(
      [mkSession('a'), mkSession('c'), mkSession('d')],
      [mkSession('a'), mkSession('b'), mkSession('e')],
    )
    expect(result.added).toEqual(['c', 'd'])
    expect(result.removed).toEqual(['b', 'e'])
  })
  it('TC4: 双空 list', () => {
    const result = diffSessionList([], [])
    expect(result).toEqual({ added: [], removed: [] })
  })
})

// mock useChat（隔离 streamSubscriptions 模块级 Map + 捕获调用）。
// disposeSessionMock 为模块级共享，便于 TC6/TC9/TC10 断言调用次数/参数。
const disposeSessionMock = vi.fn()
vi.mock('@/composables/features/useChat', () => ({
  ensureStreamSubscription: vi.fn(),
  useChat: () => ({ disposeSession: disposeSessionMock }),
  resetChatModuleState: vi.fn(),
}))

const useChatMock = await import('@/composables/features/useChat')
const ensureStreamSubscriptionMock = useChatMock.ensureStreamSubscription as ReturnType<typeof vi.fn>
const { useSessionStore } = await import('@/stores/session')
const { bindSessionStreamSync } = await import('../useSessionStreamSync')

describe('bindSessionStreamSync', () => {
  let pinia: ReturnType<typeof createPinia>
  let scope: ReturnType<typeof effectScope>
  let sessionStore: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pinia = createPinia()
    setActivePinia(pinia)
    scope = effectScope()
    sessionStore = scope.run(() => {
      const s = useSessionStore()
      bindSessionStreamSync() // 在 scope 内注册 effect
      return s
    })!
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('TC5: list 从空变 [s1,s2]，ensureStreamSubscription 被对每个 added 调用', () => {
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(2)
    // 验证参数含正确 sid（第 0 参数）
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s1')
    expect(ensureStreamSubscriptionMock.mock.calls[1][0]).toBe('s2')
  })

  it('TC6: removed 触发 disposeSession，参数为被移除的 sid', () => {
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    expect(disposeSessionMock).not.toHaveBeenCalled()
    sessionStore.removeFromList('s2')
    expect(disposeSessionMock).toHaveBeenCalledTimes(1)
    expect(disposeSessionMock).toHaveBeenCalledWith('s2')
  })

  it('TC7: flush:sync——appendSession 后不 await 立即已建订阅', () => {
    // 同步 append 后立即断言（证明 flush:'sync'，非异步）
    sessionStore.appendSession(mkSession('s-sync'))
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(1)
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s-sync')
  })

  it('TC8: scope.stop() 后 watch 退订，append 不再触发 ensureStreamSubscription', () => {
    scope.stop()
    vi.clearAllMocks()
    // stop 后再 append（store 已存在，新 scope 已 stop，但 store 调用仍安全）
    sessionStore.appendSession(mkSession('s-after-stop'))
    expect(ensureStreamSubscriptionMock).not.toHaveBeenCalled()
    expect(disposeSessionMock).not.toHaveBeenCalled()
  })

  it('TC9: 异常隔离——单 session ensureStreamSubscription throw 不阻断其余', () => {
    // s1 throw，s2 正常
    ensureStreamSubscriptionMock.mockImplementation((sid: string) => {
      if (sid === 's1') throw new Error('boom-s1')
    })
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    // s2 仍被调用（未因 s1 失败而中断）
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(2)
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s1')
    expect(ensureStreamSubscriptionMock.mock.calls[1][0]).toBe('s2')
    // s1 失败记录 warn，含 sid
    expect(console.warn).toHaveBeenCalled()
    const warnMsg = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)
    expect(warnMsg).toContain('s1')
  })

  it('TC10: watch 最外层兜底——回调内 throw 不冒泡到 appendSession 调用栈', () => {
    // ensureStreamSubscription + disposeSession 都 throw，模拟 watch 回调内遍历抛错
    ensureStreamSubscriptionMock.mockImplementation(() => {
      throw new Error('ensure-boom')
    })
    disposeSessionMock.mockImplementation(() => {
      throw new Error('dispose-boom')
    })
    // try 内调 appendSession——watch 回调内 throw 应被最外层 try-catch 兜住，不冒泡
    expect(() => {
      sessionStore.appendSession(mkSession('s-bubble'))
    }).not.toThrow()
    // 兜底 warn 被调用（内层 ensure warn 或最外层 watch warn）
    expect(console.warn).toHaveBeenCalled()
  })
})
