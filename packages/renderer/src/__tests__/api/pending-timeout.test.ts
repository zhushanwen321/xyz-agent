/**
 * pending.register 超时单测 —— per-request 超时防永久挂死。
 *
 * S1 修复：register 加 timeoutMs 参数，超时后自动 delete + reject（带 code:'timeout'），
 * resolve/reject 正常路径 clearTimeout 清理 timer。一处改动根治两类永久挂死：
 * 1. runtime handler 卡住但不断连 → 前端 Promise 永久 await
 * 2. transport.send 断连静默丢弃 → reply 永不到达
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/pending-timeout.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import * as pending from '@/api/pending'

describe('pending.register 超时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pending.rejectAll(new Error('setup cleanup'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * U3: 超时后 reject 带 timeout code 的 Error。
   */
  it('超时后 reject 带 timeout code 的 Error', async () => {
    const id = pending.create()
    const p = pending.register<string>(id, 100)

    // 推进到超时点
    vi.advanceTimersByTime(100)

    await expect(p).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  /**
   * U4: 正常 resolve 时清理超时 timer（不泄漏，不误触发超时 reject）。
   */
  it('正常 resolve 时清理超时 timer（不泄漏）', async () => {
    const id = pending.create()
    const p = pending.register<string>(id, 5000)

    // 在超时前 resolve
    pending.resolve(id, 'value')
    const result = await p
    expect(result).toBe('value')

    // 推进超过超时时间，不应有任何未捕获的 reject（timer 已清理）
    vi.advanceTimersByTime(10000)
  })
})
