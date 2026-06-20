/**
 * SessionData 内存缓存 + 持久化编排
 *
 * 封装 sessionData 的 per-session KV 缓存、dirty 跟踪、定时 flush、磁盘恢复、
 * clear 等生命周期。底层用 WriteBackCache（与 PluginStorage 同一抽象，P0-1 C6）。
 *
 * 消费者（PluginService、session-data-api、plugin-rpc-setup）通过本类的公共方法
 * 操作 sessionData，不再直接持有散落的 Map。
 *
 * size 口径统一为 Buffer.byteLength（修复原 JSON.stringify().length 的 UTF-16 偏差）。
 */

import { join } from 'node:path'
import { readdirSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { WriteBackCache } from '../../utils/json-store.js'
import { errorWithCode } from '../../utils/errors.js'

// eslint-disable-next-line no-magic-numbers
const MB = 1024 * 1024
// eslint-disable-next-line no-magic-numbers
const DEFAULT_MAX_SESSION_DATA_BYTES = 10 * MB
const FLUSH_DEBOUNCE_MS = 500
/** H1: session-data 持久化子目录名（configDir 下）。提常量消除 4 处魔法串重复。 */
const SESSION_DATA_DIRNAME = 'session-data'

export class SessionDataStore {
  /** write-back 缓存：分区键 = sessionId，内键 = key，值 = unknown */
  private readonly cache: WriteBackCache<string, string, unknown>
  /** 定时 flush 计时器（全量周期 flush，补充 per-write debounce） */
  private flushTimer: ReturnType<typeof setInterval> | null = null
  /** 配置根目录（session-data 持久化用），由组合根注入，不再直连 infra。 */
  private readonly configDir: string

  /**
   * @param configDir xyz-agent 配置根（~/.xyz-agent/），session-data 持久化目录的父。
   * @param maxSizeBytes 单 session 最大字节数，默认 10MB。
   * @param storageFullCode 容量超限时抛出错误的 code（由调用方注入，避免叶子层硬编码 RPC 码）。
   */
  constructor(
    configDir: string,
    maxSizeBytes: number = DEFAULT_MAX_SESSION_DATA_BYTES,
    storageFullCode: number = -32040,
  ) {
    this.configDir = configDir
    this.cache = new WriteBackCache<string, string, unknown>(
      {
        loadPartition: (sessionId) => this.loadPartitionSync(sessionId),
        persistPartition: (sessionId, data) => this.persistPartition(sessionId, data),
      },
      { flushMs: FLUSH_DEBOUNCE_MS },
      // 容量检查：单 session 总量超限抛错（错误码由调用方经 storageFullCode 注入，避免叶子层硬编码 RPC 码）
      (_sessionId, _key, _value, partitionSize) => {
        if (partitionSize > maxSizeBytes) {
          throw errorWithCode(`Session data storage full (${partitionSize} > ${maxSizeBytes} bytes)`, storageFullCode)
        }
      },
    )
  }

  // ── KV 操作（供 session-data-api RPC 调用） ──────────────────

  get(sessionId: string, key: string): unknown | undefined {
    return this.cache.get(sessionId, key)
  }

  set(sessionId: string, key: string, value: unknown): void {
    this.cache.set(sessionId, key, value)
  }

  delete(sessionId: string, key: string): void {
    this.cache.delete(sessionId, key)
  }

  keys(sessionId: string): string[] {
    return this.cache.keys(sessionId)
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 启动定时 flush（每 5s 全量 flush，补充 per-write debounce） */
  startFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      this.cache.flushAll()
    }, 5_000)
  }

  /** 停止定时 flush */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** Test helper: check if flush timer is active */
  isFlushTimerRunning(): boolean {
    return this.flushTimer !== null
  }

  /** 将所有 dirty 数据批量 flush */
  flushAll(): void {
    this.cache.flushAll()
  }

  /** flush 指定 session 的 dirty 数据 */
  flushSession(sessionId: string): void {
    this.cache.flush(sessionId)
  }

  /** 从磁盘恢复所有 sessionData（initialize 时调用） */
  restoreFromDisk(): void {
    try {
      const sessionDataDir = join(this.configDir, SESSION_DATA_DIRNAME)
      if (!existsSync(sessionDataDir)) return
      const files = readdirSync(sessionDataDir)
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '')
          // 触发 WriteBackCache lazy load（loadPartition 会读盘）
          const data = this.cache.keys(sessionId)
          if (data.length === 0) continue
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- sessionData restore: directory may not exist initially
    } catch {
      // Directory doesn't exist yet, that's fine
    }
  }

  /** 清理指定 session 的内存缓存 + 磁盘文件 */
  clearSession(sessionId: string): void {
    this.cache.onExternalChange(sessionId)
    // 同步删除磁盘文件：避免删除后 lazy load 把文件内容又读回内存。
    const filePath = join(this.configDir, SESSION_DATA_DIRNAME, `${sessionId}.json`)
    try {
      rmSync(filePath, { force: true })
    // eslint-disable-next-line taste/no-silent-catch -- clearSession: file may not exist
    } catch {
      // best-effort
    }
  }

  /** 停掉所有定时器（shutdown 用）。 */
  dispose(): void {
    this.stopFlushTimer()
    this.cache.dispose()
  }

  // ── Private（WriteBackCache backing 回调） ──────────────────

  private loadPartitionSync(sessionId: string): Map<string, unknown> {
    const filePath = join(this.configDir, SESSION_DATA_DIRNAME, `${sessionId}.json`)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return new Map(Object.entries(parsed))
    } catch {
      return new Map()
    }
  }

  private persistPartition(sessionId: string, data: Map<string, unknown>): void {
    // sync atomicWrite（与 PluginStorage 一致）。容量检查在 onSet 已拦截，
    // 此处不再重复校验。flush 前会 clearTimeout，同一分区无并发写，固定 .tmp 名安全。
    const dir = join(this.configDir, SESSION_DATA_DIRNAME)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${sessionId}.json`)
    const content = JSON.stringify(Object.fromEntries(data))
    atomicWrite(filePath, content)
  }
}
