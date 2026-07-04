/**
 * RecentWorkspacesStore — 最近工作区持久化 + LRU 淘汰
 *
 * 封装 recent-workspaces.json 的读写，底层用 WriteBackCache 实现 write-back + debounce。
 * 单分区（'global'），内键 = cwd 绝对路径，值 = RecentWorkspaceRecord。
 *
 * 不变量：
 * - INV-1: cwd 非空串守卫（store 层兜底，service 层主守卫）
 * - INV-2: 最多保留 10 条，淘汰 lastUsedAt 最小者
 * - INV-3: 同 cwd 不重复，更新 lastUsedAt
 * - INV-4: 文件损坏返空，不抛
 * - INV-5: 路径从 configDir 动态推导，无硬编码
 */

import { join } from 'node:path'
import { basename } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'
import { WriteBackCache } from '../../utils/json-store.js'
import { atomicWrite } from '../../utils/fs-utils.js'

const MAX_RECORDS = 10
const FLUSH_INTERVAL_MS = 5_000
const FILE_NAME = 'recent-workspaces.json'
const JSON_INDENT = 2

/** 分区键常量：全局唯一分区 */
const PARTITION_KEY = 'global' as const

export class RecentWorkspacesStore {
  private readonly cache: WriteBackCache<typeof PARTITION_KEY, string, RecentWorkspaceRecord>
  private readonly filePath: string
  private flushTimer: ReturnType<typeof setInterval> | null = null

  /**
   * @param configDir xyz-agent 配置根（~/.xyz-agent/），由组合根注入，不硬编码。
   */
  constructor(configDir: string) {
    this.filePath = join(configDir, FILE_NAME)

    this.cache = new WriteBackCache<typeof PARTITION_KEY, string, RecentWorkspaceRecord>(
      {
        loadPartition: () => this.loadFromFile(),
        persistPartition: (_k, data) => this.persistToFile(data),
      },
      { flushMs: 500 },
    )
  }

  /**
   * 记录一次工作区使用。INV-1 兜底：空串静默跳过。
   * INV-3：同 cwd 覆盖更新（WriteBackCache.set 语义）。
   */
  record(cwd: string): void {
    if (!cwd || cwd.trim() === '') return

    this.cache.set(PARTITION_KEY, cwd, {
      cwd,
      lastUsedAt: Date.now(),
      label: basename(cwd),
    })

    // INV-2：超过上限淘汰最旧者
    this.trim()
  }

  /**
   * 返回最近工作区列表，按 lastUsedAt 倒序，≤10 条。
   */
  list(): RecentWorkspaceRecord[] {
    const keys = this.cache.keys(PARTITION_KEY)
    const records: RecentWorkspaceRecord[] = []
    for (const key of keys) {
      const record = this.cache.get(PARTITION_KEY, key)
      if (record) records.push(record)
    }
    // 按 lastUsedAt 倒序
    records.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return records.slice(0, MAX_RECORDS)
  }

  /**
   * 立即持久化所有 dirty 数据（不等 debounce）。shutdown 或测试用。
   */
  flushAll(): void {
    this.cache.flushAll()
  }

  /**
   * 启动定期 flush 计时器（全量周期，补充 per-write debounce）。
   * 由组合根在 initialize 后调用。
   */
  startFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      this.cache.flushAll()
    }, FLUSH_INTERVAL_MS)
  }

  /**
   * 停止定期 flush 计时器。shutdown 用。
   */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  // ── Private（WriteBackCache backing 回调） ──────────────────

  /**
   * 从文件加载分区数据。INV-4：文件损坏返空 Map，不抛。
   */
  private loadFromFile(): Map<string, RecentWorkspaceRecord> {
    try {
      if (!existsSync(this.filePath)) return new Map()
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as RecentWorkspaceRecord[]
      if (!Array.isArray(parsed)) return new Map()
      const map = new Map<string, RecentWorkspaceRecord>()
      for (const record of parsed) {
        if (record && typeof record.cwd === 'string' && record.cwd) {
          map.set(record.cwd, record)
        }
      }
      return map
    } catch {
      // INV-4：文件损坏 / ENOENT 返空
      return new Map()
    }
  }

  /**
   * 持久化分区数据到文件。sync atomicWrite（KB 级，event loop 无感）。
   */
  private persistToFile(data: Map<string, RecentWorkspaceRecord>): void {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const records = Array.from(data.values())
    atomicWrite(this.filePath, JSON.stringify(records, null, JSON_INDENT))
  }

  /**
   * INV-2：超过 MAX_RECORDS 时淘汰 lastUsedAt 最小者。
   * 在每次 record 后调用。
   */
  private trim(): void {
    const keys = this.cache.keys(PARTITION_KEY)
    if (keys.length <= MAX_RECORDS) return

    // 找 lastUsedAt 最小的 key
    let oldestKey = ''
    let oldestTime = Infinity
    for (const key of keys) {
      const record = this.cache.get(PARTITION_KEY, key)
      if (record && record.lastUsedAt < oldestTime) {
        oldestTime = record.lastUsedAt
        oldestKey = key
      }
    }
    if (oldestKey) {
      this.cache.delete(PARTITION_KEY, oldestKey)
    }
  }
}
