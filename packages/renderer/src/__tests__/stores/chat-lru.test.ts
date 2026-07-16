/**
 * W3 红灯测试：chat store LRU 驱逐 + subagent 虚拟 key 清理。
 *
 * 对应 FR-1（LRU 驱逐）+ FR-5（驱逐后切回重 hydrate）+ AC-1/2/8/9。
 *
 * LRU 策略（D2/D6/D13）：
 * - 切走 session 时触发 evictIfNeeded
 * - 保留最近 K=8 个 + 当前 panel 绑定的 + streaming 中的
 * - 驱逐用 delete key（与 disposeSession 一致）
 * - subagent:xxx / agentcall:xxx 虚拟 key 同步驱逐（M7 修复）
 * - 驱逐时同步清 hydrated 标记
 * - 驱逐前 double-check streaming 状态（SR8 竞态防护）
 *
 * [红灯说明] LRU 驱逐尚未实现，evictIfNeeded / LRU 相关 API 不存在。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-lru.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore, LRU_MAX_SESSIONS } from '@/stores/chat'
import { _resetLruForTest } from '@/stores/chat-lru'
import type { Message } from '@xyz-agent/shared'

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

describe('W3 chat store LRU 驱逐', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetLruForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('AC-1: 超过 K=8 驱逐最久未访问的', () => {
    it('hydrate 9 个 session 后，最早的被驱逐（messages + hydrated 清）', () => {
      const store = useChatStore()

      // hydrate 9 个 session（超过 K=8），每个间隔 10ms 确保时间戳不同
      for (let i = 0; i < 9; i++) {
        vi.setSystemTime(1000 + i * 10)
        store.hydrate(`s${i}`, [makeMessage(`m${i}`)])
      }

      // 触发驱逐（evictIfNeeded 在 hydrate 或切换时调用）
      store.evictIfNeeded()

      // 最早访问的 s0 应被驱逐
      expect(store.getMessages('s0')).toEqual([])
      expect(store.isHydrated('s0')).toBe(false)

      // 最近的 s1-s8 应保留
      expect(store.getMessages('s8')).toHaveLength(1)
      expect(store.isHydrated('s8')).toBe(true)
    })

    it('Map 中可驱逐的 session 条目数 ≤ 8', () => {
      const store = useChatStore()

      for (let i = 0; i < 15; i++) {
        vi.setSystemTime(1000 + i * 10)
        store.hydrate(`s${i}`, [makeMessage(`m${i}`)])
      }
      store.evictIfNeeded()

      // 统计仍 hydrate 的 session 数（排除 panel/streaming 豁免）
      let hydratedCount = 0
      for (let i = 0; i < 15; i++) {
        if (store.isHydrated(`s${i}`)) hydratedCount++
      }
      expect(hydratedCount).toBeLessThanOrEqual(8)
    })
  })

  describe('AC-1 真 LRU：再访问更新 recency（非 FIFO）', () => {
    it('访问 s0 后再 hydrate 新 session，s0 不被驱逐', () => {
      const store = useChatStore()

      // 先 hydrate 8 个，每个间隔 10ms 确保时间戳不同
      for (let i = 0; i < 8; i++) {
        vi.setSystemTime(1000 + i * 10)
        store.hydrate(`s${i}`, [makeMessage(`m${i}`)])
      }

      // 访问 s0（更新 recency 为最新时间）
      vi.setSystemTime(10000)
      store.touchLru('s0')

      // hydrate 第 9 个
      vi.setSystemTime(10001)
      store.hydrate('s8', [makeMessage('m8')])
      store.evictIfNeeded()

      // s0 因被 touch 过（时间戳最新），不应被驱逐；s1（最久未访问）应被驱逐
      expect(store.isHydrated('s0')).toBe(true)
      expect(store.isHydrated('s1')).toBe(false)
    })
  })

  describe('AC-9: 不驱逐 panel 绑定和 streaming 中的', () => {
    it('streaming 中的 session 不被驱逐', () => {
      const store = useChatStore()

      // hydrate 9 个
      for (let i = 0; i < 9; i++) {
        vi.setSystemTime(1000 + i * 10)
        store.hydrate(`s${i}`, [makeMessage(`m${i}`)])
      }
      // s0 标记为 streaming（addPendingSend → isActive）
      store.addPendingSend('s0')

      store.evictIfNeeded()

      // s0 因 pending/streaming 不被驱逐
      expect(store.isActive('s0')).toBe(true)
      // 注意：streaming 的 session 即使最久未访问也保留
      store.clearPendingSend('s0')
    })
  })

  describe('AC-2: subagent:xxx 虚拟 key 同步清理', () => {
    it('驱逐主 session 时同步清 subagent:xxx 虚拟 key', () => {
      const store = useChatStore()

      // 主 session s0 + 其 subagent 虚拟 key
      store.hydrate('s0', [makeMessage('m0')])
      store.setMessages('subagent:s0:sa1', [makeMessage('sa1')])

      // 驱逐 s0
      store.evictSessionWithVirtual('s0')

      // 主 session + 虚拟 key 都清
      expect(store.getMessages('s0')).toEqual([])
      expect(store.getMessages('subagent:s0:sa1')).toEqual([])
    })

    it('agentcall:xxx 虚拟 key 同步清理', () => {
      const store = useChatStore()

      store.hydrate('s0', [makeMessage('m0')])
      store.setMessages('agentcall:s0:ac1', [makeMessage('ac1')])

      store.evictSessionWithVirtual('s0')

      expect(store.getMessages('s0')).toEqual([])
      expect(store.getMessages('agentcall:s0:ac1')).toEqual([])
    })
  })

  describe('AC-8: 被驱逐的 session 切回后重新 hydrate', () => {
    it('驱逐后 isHydrated=false，切回时重新 hydrate 生效', () => {
      const store = useChatStore()

      store.hydrate('s0', [makeMessage('m0')])
      expect(store.isHydrated('s0')).toBe(true)

      // 驱逐
      store.evictSessionWithVirtual('s0')
      expect(store.isHydrated('s0')).toBe(false)

      // 重新 hydrate（模拟切回时的 getHistory），用自定义 content 匹配 test.json expected
      const reloadedMsg: Message = { id: 'm0-reloaded', role: 'assistant', content: 'm0-reloaded', status: 'complete', timestamp: Date.now() }
      store.hydrate('s0', [reloadedMsg])
      expect(store.isHydrated('s0')).toBe(true)
      expect(store.getMessages('s0')).toHaveLength(1)
      expect(store.getMessages('s0')[0].content).toBe('m0-reloaded')
    })
  })

  describe('LRU 配置常量', () => {
    it('LRU_MAX_SESSIONS 为 8', () => {
      expect(LRU_MAX_SESSIONS).toBe(8)
    })
  })
})
