/**
 * QuotaCache — 额度查询缓存持久化层。
 *
 * 职责：
 * - 读写 `<dataDir>/quota-cache.json`（原子写：.tmp → rename）
 * - 失败不删除旧缓存（只 log）
 * - 缓存永不主动删除（只有用户手动清除数据目录时才丢失）
 *
 * 架构约定 #2：路径用 getDataDir() 动态推导。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'

const CACHE_FILENAME = 'quota-cache.json'

export interface QuotaCacheEntry {
  data: NormalizedQuotaRow
  lastFetchAt: number
}

export interface QuotaCacheFile {
  /** providerId → 缓存条目 */
  providers: Record<string, QuotaCacheEntry>
}

export class QuotaCache {
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, CACHE_FILENAME)
  }

  /** 读取缓存（文件不存在返回空对象）。 */
  read(): QuotaCacheFile {
    try {
      if (!existsSync(this.filePath)) return { providers: {} }
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as QuotaCacheFile
      if (!parsed || typeof parsed !== 'object' || !parsed.providers) {
        return { providers: {} }
      }
      return parsed
    } catch {
      return { providers: {} }
    }
  }

  /** 读取单个 provider 的缓存。 */
  getEntry(providerId: string): QuotaCacheEntry | null {
    const cache = this.read()
    return cache.providers[providerId] ?? null
  }

  /**
   * 更新单个 provider 的缓存（原子写）。
   * 读取现有缓存 → 合并 → .tmp → rename。
   */
  update(providerId: string, data: NormalizedQuotaRow): void {
    try {
      const cache = this.read()
      cache.providers[providerId] = {
        data,
        lastFetchAt: Date.now(),
      }

      // 确保目录存在
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      // 原子写：先写 .tmp，再 rename
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf-8')
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      // 失败不删除旧缓存，只 log
      console.warn('[quota-cache] failed to write cache:', err)
      // 清理可能残留的 .tmp 文件
      try {
        const tmpPath = `${this.filePath}.tmp`
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch { /* ignore cleanup error */ }
    }
  }
}
