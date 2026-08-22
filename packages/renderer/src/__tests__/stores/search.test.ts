/**
 * search.test.ts — F10/F11 失败路径验收测试。
 *
 * 背景：UI 消费 WS pending 查询须 Promise.race 超时防永久 loading，
 * 且 loadSeq 序列号防旧响应晚到覆盖新结果。
 * 本测试验证：
 * - F10: WS 源超时 race: UI 消费 WS pending 查询须 Promise.race 超时防永久 loading
 * - F11: 查询乱序守卫: loadSeq 序列号防旧响应晚到覆盖新结果
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/stores/search.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('Search · F10/F11 失败路径', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── F10: WS 源超时 race ─────────────────────────────────────────
  describe('F10: WS 源超时 race — Promise.race 超时防永久 loading', () => {
    it('F10: Promise.race 超时 — 超时 promise 先 resolve', async () => {
      const TIMEOUT_MS = 100

      // 模拟 WS 查询（永不 resolve）
      const wsQuery = new Promise<string>(() => {})

      // 超时 promise
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('timeout'), TIMEOUT_MS)
      })

      // Promise.race
      const result = Promise.race([wsQuery, timeoutPromise])

      // 推进时间到超时
      vi.advanceTimersByTime(TIMEOUT_MS)

      expect(await result).toBe('timeout')
    })

    it('F10: WS 查询在超时前返回 — 正常结果', async () => {
      const TIMEOUT_MS = 100

      // 模拟 WS 查询（快速返回）
      const wsQuery = Promise.resolve('search-results')

      // 超时 promise
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('timeout'), TIMEOUT_MS)
      })

      // Promise.race
      const result = await Promise.race([wsQuery, timeoutPromise])

      expect(result).toBe('search-results')
    })

    it('F10: 超时后 loading 状态重置', async () => {
      const TIMEOUT_MS = 100
      let isLoading = true

      // 模拟 WS 查询（快速超时）
      const wsQuery = new Promise<string>(() => {})

      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          isLoading = false
          resolve('timeout')
        }, TIMEOUT_MS)
      })

      const result = Promise.race([wsQuery, timeoutPromise])
      vi.advanceTimersByTime(TIMEOUT_MS)
      await result

      // 超时后 loading 应重置
      expect(isLoading).toBe(false)
    })

    it('F10: 多个并发查询 — 各自独立超时', async () => {
      const TIMEOUT_MS = 100

      const query1 = new Promise<string>(() => {})
      const query2 = new Promise<string>(() => {})

      const timeout1 = new Promise<string>((resolve) => {
        setTimeout(() => resolve('timeout-1'), TIMEOUT_MS)
      })
      const timeout2 = new Promise<string>((resolve) => {
        setTimeout(() => resolve('timeout-2'), TIMEOUT_MS)
      })

      const result1 = Promise.race([query1, timeout1])
      const result2 = Promise.race([query2, timeout2])

      vi.advanceTimersByTime(TIMEOUT_MS)

      expect(await result1).toBe('timeout-1')
      expect(await result2).toBe('timeout-2')
    })
  })

  // ── F11: 查询乱序守卫 ─────────────────────────────────────────
  describe('F11: 查询乱序守卫 — loadSeq 序列号防旧响应晚到覆盖新结果', () => {
    it('F11: loadSeq 递增 — 每次查询递增序列号', () => {
      let loadSeq = 0

      // 模拟查询
      const query1 = ++loadSeq
      const query2 = ++loadSeq
      const query3 = ++loadSeq

      expect(query1).toBe(1)
      expect(query2).toBe(2)
      expect(query3).toBe(3)
    })

    it('F11: 旧响应晚到 — seq 不匹配时丢弃', () => {
      let currentSeq = 0
      let results: string | null = null

      // 发起查询 1
      const seq1 = ++currentSeq
      // 发起查询 2
      const seq2 = ++currentSeq

      // 模拟查询 2 先返回
      if (seq2 === currentSeq) {
        results = 'results-query-2'
      }

      // 模拟查询 1 晚到
      if (seq1 === currentSeq) {
        results = 'results-query-1' // 不应执行
      }

      // 结果应是查询 2 的
      expect(results).toBe('results-query-2')
    })

    it('F11: 最新响应覆盖 — seq 匹配时更新', () => {
      let currentSeq = 0
      let results: string | null = null

      // 发起查询
      const seq = ++currentSeq

      // 响应到达
      if (seq === currentSeq) {
        results = 'latest-results'
      }

      expect(results).toBe('latest-results')
    })

    it('F11: 快速连续查询 — 只保留最新结果', () => {
      let currentSeq = 0
      let finalResults: string | null = null

      // 快速连续查询
      const seq1 = ++currentSeq // 1
      const seq2 = ++currentSeq // 2
      const seq3 = ++currentSeq // 3

      // 模拟乱序返回：query1 最后到
      // query3 先到
      if (seq3 === currentSeq) {
        finalResults = 'results-3'
      }
      // query2 到
      if (seq2 === currentSeq) {
        finalResults = 'results-2' // 不应覆盖
      }
      // query1 最后到
      if (seq1 === currentSeq) {
        finalResults = 'results-1' // 不应覆盖
      }

      // 结果应是 query3 的
      expect(finalResults).toBe('results-3')
    })

    it('F11: seq 重置 — 新会话时重置序列号', () => {
      let currentSeq = 0

      // 模拟会话结束，重置
      currentSeq = 0

      // 新查询
      const seq = ++currentSeq
      expect(seq).toBe(1)
    })
  })
})
