/**
 * RecentWorkspacesStore — 持久化策略 + LRU 淘汰（#1）。
 *
 * D-005 形态适配最终选定 = 方案 a（code-architecture.md §4）：
 * WriteBackCache<'global', string, RecentWorkspaceRecord> 固定 partition key。
 *
 * 理由：D-005 原意是复用 write-back（dirty + 500ms debounce + atomicWrite）；
 * 写入时机 B 高频写（每发一条消息 record）依赖 debounce 合并。JsonStore 无 write-back，
 * 自造 debounce 违 D-005。
 *
 * LRU 不变式（system-architecture.md §5/§9 INV-1~5）：
 * - INV-1 cwd 空串拒绝：防御性守卫（第二道，主守卫在 WorkspaceService）
 * - INV-2 ≤10：set 后立即 trim（内存）
 * - INV-3 cwd 去重：WriteBackCache IK=cwd 天然去重
 * - INV-4 文件损坏 → 空 Map（backing.loadPartition try/catch）
 * - INV-5 路径：join(configDir, 'recent-workspaces.json')，configDir 由组合根注入 getConfigDir()
 *
 * 数据流（功能 ①/② 写入链路）：
 * WorkspaceService.record → store.record → cache.set('global', cwd, record)
 *   → upsert（IK=cwd 去重）→ trim（>10 淘汰最旧）→ dirty + scheduleFlush(500ms)
 *   → [debounce 到期] → persistPartition → atomicWrite
 *
 * 数据流（功能 ③ 读取链路）：
 * list() → cache.keys('global').map(ik => cache.get('global', ik)) → sort 倒序
 *   读 WriteBackCache 内存视图（非读盘），最新值不受 flush 时机影响（D-005 红队 nit-2 要求）。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { RecentWorkspaceRecord } from '../../../shared/workspace.js'
import { atomicWrite, WriteBackCache } from '../../../_deps.js'

/** 固定 partition key（防魔法串，便于 grep——'global' 字面量只在此常量定义出现一次）。 */
const RECORDS_PARTITION = 'global' as const

/** LRU 上限（INV-2，与既有 MAX_RECENT_WORKSPACES 一致）。 */
const MAX_RECORDS = 10

/**
 * recent-workspaces.json 持久化文件名（configDir 下）。
 * 文件格式：RecentWorkspaceRecord[] JSON 数组（单文件单数组语义）。
 */
const RECENT_WORKSPACES_FILENAME = 'recent-workspaces.json'

export class RecentWorkspacesStore {
  private readonly cache: WriteBackCache<typeof RECORDS_PARTITION, string, RecentWorkspaceRecord>
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly filePath: string

  constructor(configDir: string) {
    this.filePath = join(configDir, RECENT_WORKSPACES_FILENAME)
    this.cache = new WriteBackCache<typeof RECORDS_PARTITION, string, RecentWorkspaceRecord>(
      {
        loadPartition: () => this.loadRecordsSync(),
        persistPartition: (_k, data) => this.persistRecords(data),
      },
      { flushMs: 500 },
    )
  }

  /**
   * 记录一条 cwd 使用（写入时机 A/B 共用）。
   * INV-1 防御性守卫（第二道）：cwd 空串/undefined 静默跳过。
   * INV-3 去重：WriteBackCache IK=cwd 天然 upsert（同 cwd 覆盖刷新 lastUsedAt）。
   * INV-2 trim：set 后立即 trim 到 10（淘汰 lastUsedAt 最小者）。
   */
  record(cwd: string): void {
    if (!cwd) return // INV-1 防御性第二道（主守卫在 WorkspaceService.record）
    const record: RecentWorkspaceRecord = {
      cwd,
      lastUsedAt: Date.now(),
      label: this.basename(cwd), // label 算（零冗余，code-arch §4 决策）
    }
    this.cache.set(RECORDS_PARTITION, cwd, record)
    this.trimToMax()
  }

  /**
   * 列出全部记录（≤10，按 lastUsedAt 倒序）。
   * 读 WriteBackCache 内存视图（非读盘），最新值不受 flush 时机影响。
   * INV-4 降级：首启/损坏 → backing.loadPartition 返空 Map → list 返 []。
   */
  list(): RecentWorkspaceRecord[] {
    const keys = this.cache.keys(RECORDS_PARTITION)
    const records: RecentWorkspaceRecord[] = []
    for (const ik of keys) {
      const r = this.cache.get(RECORDS_PARTITION, ik)
      if (r) records.push(r)
    }
    return records.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** 启动全量周期 flush 兜底（沿用 session-data-store 模式，FLUSH_INTERVAL_MS=5000）。 */
  startFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      this.cache.flushAll()
    }, 5_000)
  }

  /** 停止全量周期 flush。 */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** shutdown 用：同步 flush 全部分区 + 停 timer。 */
  flushAll(): void {
    this.cache.flushAll()
  }

  /** dispose：停所有 timer（不触发 flush）。 */
  dispose(): void {
    this.stopFlushTimer()
    this.cache.dispose()
  }

  // ── Private（WriteBackCache backing 回调 + trim） ──────────────────────

  /**
   * INV-2 trim：内存视图 > MAX_RECORDS 时淘汰 lastUsedAt 最小者。
   * set 后立即 trim（code-arch §4 决策：内存视图始终 ≤10）。
   * trim 不增加 flush 次数（dirty 已标，复用同一 scheduleFlush timer）。
   */
  private trimToMax(): void {
    const keys = this.cache.keys(RECORDS_PARTITION)
    if (keys.length <= MAX_RECORDS) return
    // 找 lastUsedAt 最小者淘汰，循环到 ≤MAX
    while (keys.length > MAX_RECORDS) {
      let oldestIk: string | null = null
      let oldestTs = Number.MAX_SAFE_INTEGER
      for (const ik of keys) {
        const r = this.cache.get(RECORDS_PARTITION, ik)
        if (r && r.lastUsedAt < oldestTs) {
          oldestTs = r.lastUsedAt
          oldestIk = ik
        }
      }
      if (oldestIk === null) break
      this.cache.delete(RECORDS_PARTITION, oldestIk)
      keys.splice(keys.indexOf(oldestIk), 1)
    }
  }

  private basename(cwd: string): string {
    return cwd.split('/').filter(Boolean).pop() ?? cwd
  }

  /**
   * backing.loadPartition：从盘加载（首次访问 lazy）。
   * INV-4：ENOENT/损坏 JSON → 返空 Map（降级，不抛）。
   */
  private loadRecordsSync(): Map<string, RecentWorkspaceRecord> {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as RecentWorkspaceRecord[]
      const map = new Map<string, RecentWorkspaceRecord>()
      for (const r of parsed) {
        if (r && typeof r.cwd === 'string' && r.cwd) {
          map.set(r.cwd, r)
        }
      }
      return map
    } catch {
      return new Map()
    }
  }

  /**
   * backing.persistPartition：atomicWrite 落盘。
   * flush 前已 clearTimeout，同一分区无并发写，固定 .tmp 名安全。
   */
  private persistRecords(data: Map<string, RecentWorkspaceRecord>): void {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const content = JSON.stringify(Array.from(data.values()), null, 2)
    atomicWrite(this.filePath, content)
  }
}
