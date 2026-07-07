/**
 * useRecents composable 单测（T1.8/T1.9/T1.16/T1.17/T1.18）。
 *
 * 覆盖 5 条 test-matrix：
 * - T1.8  recents 库空（首用）：localStorage 无 key → read() 返 []
 * - T1.9  reload 后持久化：write(entry) → 新实例 read() 含该 entry（断言 storage key）
 * - T1.16 (MR-3.1) JSON.parse 失败降级：脏数据 → read() 返 []（不崩溃）
 * - T1.17 (MR-3.3) 配额满内存态保留：localStorage.setItem 抛 QuotaExceededError → write() 不抛
 * - T1.18 (MR-3.4) FIFO 淘汰 + 同 key 更新 + 计数器兜底（AC-3.2/3.5/3.6）
 *
 * 环境：vitest happy-dom（localStorage 可用）。每测前 localStorage.clear() 防污染。
 * 禁止 node:test。运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/useRecents.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useRecents } from '@/composables/features/useRecents'
import { RECENTS_STORAGE_KEY, type RecentEntry, type SearchType } from '@/lib/search-types'

/** 构造 RecentEntry helper（timestamp 默认 0，write 内部会用计数器兜底重算） */
function mk(type: SearchType, key: string, title: string, sub: string): RecentEntry {
  return { type, key, timestamp: 0, title, sub }
}

beforeEach(() => {
  // 每测前清空 localStorage，避免测试间污染（read 写入会跨测残留）
  localStorage.clear()
})

describe('useRecents T1.8 首用空库', () => {
  it('localStorage 无 key → read() 返 []（AC-3.3 不崩溃）', () => {
    const { read } = useRecents()
    // 首用：localStorage 无 xyz-agent:search-recents
    expect(localStorage.getItem(RECENTS_STORAGE_KEY)).toBeNull()
    expect(read()).toEqual([])
  })
})

describe('useRecents T1.9 reload 持久化', () => {
  it('write(entry) 后新 useRecents 实例 read() 含该 entry（断言 storage key）', () => {
    const { write } = useRecents()
    write(mk('file', 'file:a.ts', 'a.ts', 'p'))

    // 断言持久化到约定的 key（MR-3.2）
    expect(localStorage.getItem(RECENTS_STORAGE_KEY)).not.toBeNull()

    // 新实例（模拟 reload：新 useRecents 调用从 localStorage 重读）
    const { read } = useRecents()
    const recents = read()
    const entry = recents.find((e) => e.key === 'file:a.ts')
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('file')
    expect(entry?.title).toBe('a.ts')
    expect(entry?.sub).toBe('p')
    // 计数器兜底：写入后 timestamp 必 > 入参 0
    expect(entry?.timestamp).toBeGreaterThan(0)
  })
})

describe('useRecents T1.16 (MR-3.1) 脏数据降级', () => {
  it('localStorage 存非法 JSON → read() 返 []（降级不崩溃）', () => {
    // 手动注入脏数据
    localStorage.setItem(RECENTS_STORAGE_KEY, '{bad json')
    const { read } = useRecents()
    // JSON.parse 抛错被 catch → 返 []，不向上传播
    expect(read()).toEqual([])
  })
})

describe('useRecents T1.17 (MR-3.3) 配额满不阻断', () => {
  it('localStorage.setItem 抛 QuotaExceededError → write() 不抛 + 返回 false（catch 内存态保留）', () => {
    // mock localStorage 实例：任何 setItem 都抛配额满
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    const { write } = useRecents()
    // 配额满被 catch，不抛（语义：本次会话不阻断流程）+ 返回 false 通知调用方持久化失败
    const ok = write(mk('file', 'file:a.ts', 'a.ts', 'p'))
    expect(ok).toBe(false)

    spy.mockRestore()
  })
})

describe('useRecents T1.18 (MR-3.4) FIFO / 同 key / 计数器', () => {
  it('AC-3.2 FIFO：同 type 写 6 个不同 key → read() 该 type 只返 5 项（最旧淘汰）', () => {
    const { write, read } = useRecents()
    // 连续写 6 个 file key（key:file:f1..f6）
    for (let i = 1; i <= 6; i++) {
      write(mk('file', `file:f${i}.ts`, `f${i}.ts`, 'p'))
    }
    const recents = read()
    // FIFO：每类上限 RECENTS_PER_TYPE=5，最旧的 f1 被淘汰
    expect(recents).toHaveLength(5)
    const keys = recents.map((e) => e.key)
    expect(keys).not.toContain('file:f1.ts')
    expect(keys).toContain('file:f2.ts')
    expect(keys).toContain('file:f6.ts')
  })

  it('AC-3.5 同 key 更新：同 key 二次 write → read() 该 type 只 1 项（不新增，更新 timestamp）', () => {
    const { write, read } = useRecents()
    write(mk('file', 'file:a', 'a.ts', 'p1'))
    write(mk('file', 'file:a', 'a.ts', 'p2')) // 同 key，sub 变化

    const recents = read()
    // 同 key 幂等：只 1 项，不新增（核心 AC-3.5 断言）
    expect(recents).toHaveLength(1)
    expect(recents[0].key).toBe('file:a')
    // 更新生效：sub 为最新值
    expect(recents[0].sub).toBe('p2')
    // 计数器兜底已应用：write 把入参 timestamp:0 重算为 maxTs+1=1（> 入参 0）。
    // 注意：counter 从 withoutDup（已剔除旧 dup）重算，故同 key 重写 timestamp 复位为 1（verbatim 行为）。
    expect(recents[0].timestamp).toBe(1)
  })

  it('AC-3.6 计数器兜底：连续写多 entry（入参 timestamp:0）→ read() 后 timestamp 单调递增（非同毫秒撞）', () => {
    const { write, read } = useRecents()
    // 全部入参 timestamp:0（mk 默认），模拟同毫秒连续 write
    write(mk('file', 'file:a', 'a.ts', 'p'))
    write(mk('file', 'file:b', 'b.ts', 'p'))
    write(mk('file', 'file:c', 'c.ts', 'p'))

    const recents = read()
    // 计数器兜底：每个 entry 的 timestamp 都被重算为 Math.max(stored)+1，互不相同
    const timestamps = recents.map((e) => e.timestamp)
    expect(new Set(timestamps).size).toBe(timestamps.length) // 无重复
    // 严格单调递增（按写入顺序 a<b<c）
    const aTs = recents.find((e) => e.key === 'file:a')!.timestamp
    const bTs = recents.find((e) => e.key === 'file:b')!.timestamp
    const cTs = recents.find((e) => e.key === 'file:c')!.timestamp
    expect(aTs).toBeLessThan(bTs)
    expect(bTs).toBeLessThan(cTs)
  })
})
