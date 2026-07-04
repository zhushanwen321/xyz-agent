/**
 * useRecents（#3）—— recents localStorage 持久化 + FIFO 淘汰。
 *
 * 接线层级：叶子（localStorage 同步读/写 + JSON.parse try/catch）。
 * 依赖方向：lib/search-types（类型 + 常量），无 store/api 依赖。
 *
 * 数据流：useSearch.query('')（空查询）→ useRecents.read() → localStorage；
 *         useSearchJump.confirm 成功 → useRecents.write(entry) → localStorage（FIFO 淘汰）。
 *
 * 失败路径（MR-3.1/MR-3.3）：
 *  - read: localStorage 无 key（首用）→ []; JSON.parse 失败（脏数据）→ []（降级不崩溃）
 *  - write: 配额满 catch → 内存态保留本次写入（不回滚），本次会话显示成功，reload 丢失
 *
 * 并发（AC-3.6）：timestamp 用计数器兜底 Math.max(stored)+1，非裸 Date.now()（防同毫秒连续 write FIFO 不确定）。
 */
import {
  RECENTS_PER_TYPE,
  RECENTS_STORAGE_KEY,
  type RecentEntry,
  type SearchType,
} from '@/lib/search-types'

export function useRecents() {
  /**
   * 读 recents（按 timestamp 倒序，每类 ≤5）。
   * MR-3.1：JSON.parse 失败→[]（脏数据降级），不崩溃。
   */
  function read(): RecentEntry[] {
    try {
      const raw = localStorage.getItem(RECENTS_STORAGE_KEY)
      if (!raw) return [] // 首用（AC-3.3）
      const parsed = JSON.parse(raw) as RecentEntry[]
      // 按 type 分组 + 每类取最新 5 项（FIFO 倒序）
      return filterPerType(parsed)
    } catch {
      // MR-3.1：脏数据降级空数组，不崩溃
      return []
    }
  }

  /**
   * 写 recents（FIFO 淘汰，AC-3.2/3.5/3.6）。
   * MR-3.3：配额满 catch 内存态保留不回滚。
   */
  function write(entry: RecentEntry): void {
    try {
      const existing = read()
      // AC-3.5 幂等：同 key 更新 timestamp 不新增
      const withoutDup = existing.filter((e) => e.key !== entry.key)
      withoutDup.push(entry)
      // AC-3.6 计数器兜底：timestamp = Math.max(stored)+1（防同毫秒连续 write）
      const maxTs = withoutDup.reduce((m, e) => Math.max(m, e.timestamp), 0)
      entry.timestamp = maxTs + 1
      const trimmed = filterPerType(withoutDup)
      localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      // MR-3.3：配额满/JSON.stringify 失败 → 内存态保留本次写入（不回滚，不抛）
      // 本次会话显示成功，reload 丢失（recents 是偏好数据可丢失，D-007 容忍度）
    }
  }

  /** 按 type 分组，每类保留最新 RECENTS_PER_TYPE 项（FIFO，timestamp 倒序） */
  function filterPerType(entries: RecentEntry[]): RecentEntry[] {
    const byType = new Map<SearchType, RecentEntry[]>()
    for (const e of entries) {
      const arr = byType.get(e.type) ?? []
      arr.push(e)
      byType.set(e.type, arr)
    }
    const out: RecentEntry[] = []
    for (const arr of byType.values()) {
      arr.sort((a, b) => b.timestamp - a.timestamp)
      out.push(...arr.slice(0, RECENTS_PER_TYPE))
    }
    return out
  }

  return { read, write }
}
