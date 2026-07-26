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
import { dirname, join } from 'node:path'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import { logger } from '../infra/logger.js'

const CACHE_FILENAME = 'quota-cache.json'
const CACHE_INDENT = 2

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
    } catch (err) {
      // 读取失败不阻断流程（返回空缓存），但必须 log（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota-cache] failed to read cache file', { error: msg })
      return { providers: {} }
    }
  }

  /** 读取单个 provider 的缓存。 */
  getEntry(providerId: string): QuotaCacheEntry | null {
    const cache = this.read()
    return cache.providers[providerId] ?? null
  }

  /**
   * 写入串行化链（基于 Promise 的简单 mutex）。
   *
   * [W6] 不同 providerId 的并发 update 是 read(整文件)→modify(内存合并)→write(rename)，
   * 不串行化会丢数据（A 读 → B 读 → A 写 → B 写覆盖 A）。所有 update 串到同一条链上，
   * 保证「读-改-写」原子性。read 不需要锁（并发读无副作用）。
   */
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * 更新单个 provider 的缓存（原子写 + 串行化）。
   * 读取现有缓存 → 合并 → .tmp → rename。
   */
  update(providerId: string, data: NormalizedQuotaRow): void {
    // doUpdate 是同步方法（内部 try/catch 已吞掉所有错误，不会 throw），
    // 用 Promise.resolve().then(run) 把每次同步调用串到微任务队列，保证「读-改-写」互不交错。
    const run = () => {
      try {
        this.doUpdate(providerId, data)
      } catch (err) {
        // doUpdate 内部已 log 具体写入错误，此处仅防链中断（同步 doUpdate 理论不抛，
        // 但若 throw 需吞掉避免 unhandled rejection 中断 writeChain）
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug('[quota-cache] writeChain caught unexpected error', { providerId, error: msg })
      }
    }
    this.writeChain = this.writeChain.then(run, run)
  }

  /** update 的实际实现（私有）。已串行化，调用方通过 update 入口。 */
  private doUpdate(providerId: string, data: NormalizedQuotaRow): void {
    try {
      const cache = this.read()
      cache.providers[providerId] = {
        data,
        lastFetchAt: Date.now(),
      }

      // [W1] 目录推导用 dirname()，修复 Windows 路径分隔符 bug：
      // 旧 substring(0, lastIndexOf('/')) 在 Windows（\ 分隔）下 lastIndexOf('/') 返回 -1 → 空串 → mkdirSync('') EINVAL
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      // 原子写：先写 .tmp，再 rename
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(cache, null, CACHE_INDENT), 'utf-8')
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      // 失败不删除旧缓存，只 log（架构约定 #4 落盘）
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[quota-cache] failed to write cache', { error: msg })
      // 清理可能残留的 .tmp 文件
      try {
        const tmpPath = `${this.filePath}.tmp`
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch (cleanupErr) {
        // 清理失败不阻断主流程，仅 debug 记录
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        logger.debug('[quota-cache] failed to cleanup tmp file', { error: cleanupMsg })
      }
    }
  }
}
