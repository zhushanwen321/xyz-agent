/**
 * useToast 自动移除 timer 句柄单测（Q1-8）。
 *
 * 覆盖：
 * 1. remove 提前关闭 toast 时 clearTimeout（fake timers 活跃计数归零，advance 后回调不再触发）
 * 2. 不提前 remove 时 4s 自然移除（行为保持）
 * 3. 多 toast 独立计时，remove 只清对应 timer
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast } from '@/composables/useToast'

describe('useToast timer 句柄清理（Q1-8）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // useToast 是模块级单例状态：触发全部残留 timer 清空 toasts，避免跨用例污染
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('remove 提前关闭 toast 后 timer 已清：advance 4s 回调不再触发', () => {
    const { toasts, error, remove } = useToast()
    error('boom')
    expect(toasts.value).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1) // 自动移除 timer 已挂

    remove(toasts.value[0].id)
    expect(toasts.value).toHaveLength(0)
    // timer 已被 clearTimeout：fake timers 活跃计数归零
    expect(vi.getTimerCount()).toBe(0)

    // advance 超过 4s：回调不再触发，无任何副作用
    vi.advanceTimersByTime(4000)
    expect(toasts.value).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('不提前 remove 时 4s 后自然移除（原行为保持）', () => {
    const { toasts, info } = useToast()
    info('hello')
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(3999)
    expect(toasts.value).toHaveLength(1) // 未到期不移除

    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0) // 到期自然移除
    expect(vi.getTimerCount()).toBe(0) // 句柄自清
  })

  it('多个 toast 独立计时，remove 只清对应 timer', () => {
    const { toasts, error, remove } = useToast()
    error('first')
    error('second')
    expect(vi.getTimerCount()).toBe(2)

    remove(toasts.value[0].id) // 提前关第一个
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].message).toBe('second')
    expect(vi.getTimerCount()).toBe(1) // 第二个的 timer 仍在

    vi.advanceTimersByTime(4000) // 第二个自然到期移除
    expect(toasts.value).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
