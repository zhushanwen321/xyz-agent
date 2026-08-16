/**
 * HistoryRebuildCache — session 历史重建缓存 + lastLeafId 记录（wave:perf-w20，D6）。
 *
 * 设计依据：.xyz-harness/2026-08-15-perf/04-history-incremental.md §3.3 D6-1/D6-3。
 *
 * 为什么缓存做在 runtime 而非 renderer：getHistory 只在「无基底路径」被调
 * （首次进入 / LRU 驱逐后重进 / renderer 重载——renderer 消息数组已空），
 * renderer 无 append 入口可用；runtime 是唯一持有「上次重建结果」的层。
 *
 * 生命周期（D6-1）：
 * - 写入：getHistory 每次成功重建后（全量与增量路径都写）
 * - 读取：getHistory 命中时走 getEntries(since=lastLeafId) 增量（空增量 = 缓存新鲜）
 * - 清除：removeSessionEntry（session 删除 + pi 进程退出两条路汇聚点）+ 容量帽 LRU 驱逐
 * - 无持久化：重开 app 后 runtime 内存已空，必然全量重建（纯派生数据，丢弃无一致性风险）
 *
 * pi get_entries(since) 行为（2026-08-16 实测，pi 0.84.0，脚本 /tmp/verify-pi-since.mjs 已验证后删除）：
 * - leafId 随 append 前进；空增量（since=当前 leafId）返回 success + entries:[]
 * - since 指向不存在的 entry → error "Entry not found: <id>"（E 大写 not 小写）
 * - compact 是 append-only（compaction entry append，旧 entry 不删除）→ since 不会因 compact 失效
 */
import type { Message } from '@xyz-agent/shared'

/** 单个 session 的重建缓存条目。 */
export interface HistoryRebuildCacheEntry {
  /** 上次重建时 get_entries 响应的 leafId（增量拉取的 since 基准）。 */
  leafId: string | null
  /** 上次重建的全量消息（增量合并的基底）。 */
  messages: Message[]
  /** 上次重建的 truncated 标志（entry 树重建恒 false，保留字段对齐 getHistory 返回形状）。 */
  truncated: boolean
}

/**
 * 容量帽 = 最近 8 个 session（对齐 renderer LRU_MAX_SESSIONS）。
 * 只有可能被驱逐重进的 session 才值得缓存，超出 renderer LRU 窗口的缓存无消费者。
 */
const HISTORY_CACHE_MAX_SESSIONS = 8

/**
 * per-session 重建缓存（LRU，Map 插入序实现）。
 *
 * LRU 语义：get/set 命中时把 key 移到 Map 尾部（delete + set），超帽驱逐 Map 头部
 * （最久未访问）。与 renderer chat store 的 LRU 窗口对齐——被 renderer 驱逐的 session
 * 下次重进走全量重建，等价于「缓存从未存在」，行为退化为现状。
 */
export class HistoryRebuildCache {
  private readonly entries = new Map<string, HistoryRebuildCacheEntry>()

  constructor(private readonly maxSessions = HISTORY_CACHE_MAX_SESSIONS) {}

  /** 取缓存并刷新 LRU 位置。无缓存返回 undefined。 */
  get(sessionId: string): HistoryRebuildCacheEntry | undefined {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    // LRU touch：移到 Map 尾部（最近使用）
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    return entry
  }

  /** 写入/覆盖缓存条目（超帽驱逐最久未访问的 session 条目）。 */
  set(sessionId: string, entry: HistoryRebuildCacheEntry): void {
    if (this.entries.has(sessionId)) this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** 删除单个 session 的缓存（session 删除 / pi 进程退出清理点）。 */
  delete(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** 当前缓存条目数（测试用）。 */
  get size(): number {
    return this.entries.size
  }
}

/**
 * 增量合并（D6-3）：缓存消息 + 增量消息按 piEntryId 去重合并。
 *
 * - 增量消息的 piEntryId 已在缓存中 → 跳过（不重复；pi 端 slice 已排除 since entry 本身，
 *   正常时序无重复，此去重是 compact/异常时序的防御性兜底）
 * - 新 piEntryId → 追加到尾部
 * - 无 piEntryId 的消息（理论上重建路径全带——entry-tree-builder 全路径传 entryIds；
 *   防御）→ 顺序追加 + debug 日志，保证消息不丢
 *
 * 去重身份是 piEntryId 而非 Message.id：重建消息的 id 是每次随机生成的 UUID
 * （message-converter），按 Message.id 去重恒失效。renderer prependHistoryMut
 * （mutations.ts）是同语义的现成范式，此处是 runtime 侧复用。
 *
 * @returns 新数组（不修改入参），供直接写入缓存与返回
 */
export function mergeIncrementalMessages(cached: Message[], incremental: Message[]): Message[] {
  const seen = new Set<string>()
  for (const m of cached) {
    if (m.piEntryId !== undefined) seen.add(m.piEntryId)
  }
  const merged = [...cached]
  for (const m of incremental) {
    if (m.piEntryId === undefined) {
      // 防御：重建路径理论上全带 piEntryId。无 id 时宁可重复不可丢消息（append + 可见日志）。
      console.debug('[history-rebuild-cache] incremental message without piEntryId, appending defensively')
      merged.push(m)
      continue
    }
    if (seen.has(m.piEntryId)) continue
    seen.add(m.piEntryId)
    merged.push(m)
  }
  return merged
}
