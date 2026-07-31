/**
 * useCompactQueue 单测（compact-queued-messages W1，TC1-TC8）。
 *
 * 覆盖契约（/tmp/cw-plan-w1.json contracts C1）：
 * - enqueue 追加并返回含 id 条目（TC1）
 * - remove 按 id 精确取消，未知 id no-op（TC2）
 * - flush 空队列 no-op 返回 true（TC3）
 * - flush 调度：首条 send + 其余 steer，send 先于 steer（TC4）
 * - flush 全部成功 → 清空返回 true（TC5）
 * - flush 任一 RPC 失败 → 队列保留返回 false（TC6，E2 restoreQueue 语义）
 * - per-session 隔离（TC7）
 * - session 销毁 cleanup 移除队列分区（TC8）
 *
 * 测试注意（useSessionScopedState 工厂契约）：
 * - 单例经模块级缓存共享，用例间必须 _clearAllForTest() 清分区
 * - 工厂内部 onScopeDispose 需在 active effect scope 内调用（首次创建实例时）
 * - 实例 cleanup 注册在模块级注册表，scope 不 stop 保其常驻（TC8 依赖）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-compact-queue.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；chatApi.send/steer 是本队列唯一依赖的 RPC
const apiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({
  chat: {
    send: apiMock.send,
    steer: apiMock.steer,
  },
  session: {},
}))

let scope: EffectScope

beforeEach(() => {
  vi.clearAllMocks()
  // 首次调用创建单例（active effect scope 内：onScopeDispose 注册实例 cleanup 到模块级
  // 注册表，TC8 的 triggerSessionCleanups 依赖它）。单例跨用例共享，scope 不 stop
  //（stop 会反注册 cleanup，TC8 的 trigger 将无 fn 可调）。
  scope = effectScope()
  scope.run(() => {
    useCompactQueue()
  })
  // 清空所有分区（单例跨用例共享，不 reset 会泄漏到下一用例）
  useCompactQueue()._clearAllForTest()
})

describe('useCompactQueue 队列基础（TC1-TC2）', () => {
  it('TC1: enqueue 追加并返回含 id 条目', () => {
    const queue = useCompactQueue()
    const entry = queue.enqueue('s1', 'hello')

    expect(typeof entry.id).toBe('string')
    expect(entry.id.length).toBeGreaterThan(0)
    expect(entry.text).toBe('hello')
    expect(queue.count('s1')).toBe(1)
  })

  it('TC2: remove 按 id 精确取消，未知 id no-op', () => {
    const queue = useCompactQueue()
    const e1 = queue.enqueue('s1', 'a')
    const e2 = queue.enqueue('s1', 'b')

    queue.remove('s1', e1.id)
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['b'])

    // 未知 id 不抛错，队列不变
    expect(() => queue.remove('s1', 'unknown-id')).not.toThrow()
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['b'])
  })
})

describe('useCompactQueue flush（TC3-TC6）', () => {
  it('TC3: flush 空队列 no-op 返回 true', async () => {
    const queue = useCompactQueue()

    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send).not.toHaveBeenCalled()
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('TC4: flush 调度——首条 send + 其余 steer，顺序正确', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    queue.enqueue('s1', 'm3')

    await expect(queue.flush('s1')).resolves.toBe(true)

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.send).toHaveBeenCalledWith('s1', 'm1')
    expect(apiMock.steer).toHaveBeenCalledTimes(2)
    expect(apiMock.steer).toHaveBeenCalledWith('s1', 'm2')
    expect(apiMock.steer).toHaveBeenCalledWith('s1', 'm3')
    // 调用顺序：send 先于所有 steer
    expect(apiMock.send.mock.invocationCallOrder[0]).toBeLessThan(apiMock.steer.mock.invocationCallOrder[0])
    expect(apiMock.steer.mock.invocationCallOrder[0]).toBeLessThan(apiMock.steer.mock.invocationCallOrder[1])
  })

  it('TC5: flush 全部成功 → 队列清空返回 true，再次 flush 不再调 chatApi', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')

    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(queue.count('s1')).toBe(0)

    // 空队列 flush：仍返回 true 且不再调 chatApi
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('TC6: flush 任一 RPC 失败 → 队列保留返回 false（E2 restoreQueue 语义）', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    apiMock.steer.mockRejectedValueOnce(new Error('rpc fail'))

    await expect(queue.flush('s1')).resolves.toBe(false)
    // 整队保留（已发送的 m1 不计入清除）
    expect(queue.count('s1')).toBe(2)
  })
})

describe('useCompactQueue 隔离与生命周期（TC7-TC8）', () => {
  it('TC7: per-session 隔离——sid A 不影响 sid B', () => {
    const queue = useCompactQueue()
    queue.enqueue('sA', 'x')

    expect(queue.count('sB')).toBe(0)

    queue.enqueue('sB', 'y')
    expect(queue.count('sA')).toBe(1)
    expect(queue.count('sB')).toBe(1)
    expect(queue.hasPending('sB')).toBe(true)
    expect(queue.hasPending('sB-x')).toBe(false)
  })

  it('TC8: session 销毁 cleanup 移除队列分区（deleteSession → triggerSessionCleanups）', () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'x')
    expect(queue.count('s1')).toBe(1)

    // 模拟 useSidebar.deleteSession 编排：triggerSessionCleanups 遍历注册表调实例 cleanup
    triggerSessionCleanups('s1')

    // 分区被移除，下次访问重新 init（空队列）
    expect(queue.count('s1')).toBe(0)
  })
})
