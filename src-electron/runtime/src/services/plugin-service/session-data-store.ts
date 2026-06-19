/**
 * SessionData 内存缓存 + 持久化编排
 *
 * 封装 sessionData 的三张 Map（cache / dirty / size）、
 * 定时 flush、磁盘恢复、clear 等生命周期。
 *
 * 消费者（PluginService、session-data-api、plugin-rpc-setup）
 * 通过此类的公共方法操作 sessionData，不再直接持有散落的 Map。
 */

import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { loadSessionData, deleteSessionData } from './plugin-storage.js'
import { flushSessionData, flushSessionDataForSession, startFlushTimer, stopFlushTimer } from './session-data-flush.js'
import { toErrorMessage } from '../../utils/errors.js'

export class SessionDataStore {
  /** 内存缓存，sessionId → key → value */
  private readonly cache = new Map<string, Map<string, unknown>>()

  /** dirty 跟踪，sessionId → 已修改但未 flush 的 key 集合 */
  private readonly dirty = new Map<string, Set<string>>()

  /** size 跟踪，sessionId → 当前字节数 */
  private readonly size = new Map<string, number>()

  /** 定时 flush 计时器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null

  /** 配置根目录（session-data 持久化用），由组合根注入，不再直连 infra。 */
  private readonly configDir: string

  /** @param configDir xyz-agent 配置根（~/.xyz-agent/），session-data 持久化目录的父。 */
  constructor(configDir: string) {
    this.configDir = configDir
  }

  // ── Cache 暴露（供 session-data-api RPC 直接操作） ──────────
  // NOTE: 返回可变 Map 引用供 session-data-api 直接操作（set/delete）。
  // 生命周期管理（flush/clear/restore）通过本类方法控制。
  // 如需加校验拦截（如 size 上限），需将操作收拢到 mutation 方法中。

  getCache(): Map<string, Map<string, unknown>> {
    return this.cache
  }

  getDirty(): Map<string, Set<string>> {
    return this.dirty
  }

  getSizeTracker(): Map<string, number> {
    return this.size
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 启动定时 flush（每 5s） */
  startFlushTimer(): void {
    this.flushTimer = startFlushTimer(this.dirty, this.cache, this.configDir)
  }

  /** 停止定时 flush */
  stopFlushTimer(): void {
    this.flushTimer = stopFlushTimer(this.flushTimer)
  }

  /** Test helper: check if flush timer is active */
  isFlushTimerRunning(): boolean {
    return this.flushTimer !== null
  }

  /** 将所有 dirty 数据批量 flush */
  async flushAll(): Promise<void> {
    await flushSessionData(this.dirty, this.cache, this.configDir)
  }

  /** flush 指定 session 的 dirty 数据 */
  async flushSession(sessionId: string): Promise<void> {
    await flushSessionDataForSession(sessionId, this.dirty, this.cache, this.configDir)
  }

  /** 从磁盘恢复所有 sessionData（initialize 时调用） */
  async restoreFromDisk(): Promise<void> {
    try {
      const sessionDataDir = join(this.configDir, 'session-data')
      const files = await readdir(sessionDataDir)
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '')
          const data = await loadSessionData(this.configDir, sessionId)
          if (data.size > 0) {
            this.cache.set(sessionId, data)
            // Restore size tracker so capacity checks account for persisted data
            let totalBytes = 0
            for (const v of data.values()) {
              totalBytes += JSON.stringify(v).length
            }
            this.size.set(sessionId, totalBytes)
          }
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- sessionData restore: directory may not exist initially
    } catch {
      // Directory doesn't exist yet, that's fine
    }
  }

  /** 清理指定 session 的内存缓存 + 磁盘文件 */
  clearSession(sessionId: string): void {
    this.cache.delete(sessionId)
    this.dirty.delete(sessionId)
    this.size.delete(sessionId)

    // Also delete from disk
    void deleteSessionData(this.configDir, sessionId).catch((e) => {
      console.warn(`[session-data-store] failed to delete session data file for ${sessionId}:`, toErrorMessage(e))
    })
  }
}
