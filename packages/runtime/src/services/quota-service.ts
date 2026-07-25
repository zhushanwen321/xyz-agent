/**
 * QuotaService — Coding Plan 额度查询核心服务。
 *
 * 职责：
 * - hover 触发查询（quota.fetch RPC）
 * - 缓存管理（成功更新，失败降级返回旧缓存 + log）
 * - 并发保护（pending Map 复用 Promise）
 * - 最小间隔保护（10s throttle）
 * - 凭证读取（api-key 从 pi-provider-store，cookie 从 secrets 文件）
 *
 * 设计文档：docs/page-design/v3/coding-plan-quota/design.md §2.2.3
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedQuotaRow, ProviderQuotaFetcher } from '@xyz-agent/shared'
import { QUOTA_PRESETS } from '@xyz-agent/shared'
import { QUOTA_FETCHERS } from './quota-providers/index.js'
import { QuotaCache } from './quota-cache.js'
import { getApiKeyForProvider } from '../infra/pi/pi-provider-store.js'
import { getDataDir } from '@xyz-agent/shared/paths'

/** 最小查询间隔（毫秒） */
const THROTTLE_MS = 10_000

export interface QuotaFetchResult {
  data: NormalizedQuotaRow | null
  lastFetchAt: number | null
}

export interface QuotaConfigureResult {
  ok: boolean
  error?: string
}

export class QuotaService {
  private cache: QuotaCache
  /** providerId → pending Promise（并发保护） */
  private pending: Map<string, Promise<QuotaFetchResult>> = new Map()
  /** providerId → 上次查询时间戳（throttle） */
  private lastFetchTime: Map<string, number> = new Map()
  /** cookie 文件目录 */
  private secretsDir: string

  constructor(dataDir?: string) {
    const dir = dataDir ?? getDataDir()
    this.cache = new QuotaCache(dir)
    this.secretsDir = join(dir, 'secrets')
  }

  /**
   * 查询额度（hover 触发）。
   * - 并发保护：同 provider pending 期间复用 Promise
   * - throttle：10s 内重复 fetch 直接返回缓存
   * - 失败降级：返回旧缓存 + log
   */
  async fetch(providerId: string): Promise<QuotaFetchResult> {
    // 并发保护：pending 期间复用 Promise
    const existing = this.pending.get(providerId)
    if (existing) return existing

    // throttle：10s 内重复 fetch 直接返回缓存
    const lastTime = this.lastFetchTime.get(providerId) ?? 0
    const elapsed = Date.now() - lastTime
    if (elapsed < THROTTLE_MS) {
      return this.getCached(providerId)
    }

    const promise = this.doFetch(providerId)
    this.pending.set(providerId, promise)

    try {
      return await promise
    } finally {
      this.pending.delete(providerId)
    }
  }

  /**
   * 读缓存不发起请求（浮层首屏即时填充）。
   */
  getCached(providerId: string): QuotaFetchResult {
    const entry = this.cache.getEntry(providerId)
    if (!entry) return { data: null, lastFetchAt: null }
    return { data: entry.data, lastFetchAt: entry.lastFetchAt }
  }

  /**
   * 配置 provider 额度查询（Settings UI 调用）。
   * - cookie 写入 secrets 目录
   * - enabled 状态存储在 ProviderInfo.quota（由前端 config.setProvider 处理）
   */
  configure(providerId: string, enabled: boolean, cookie?: string): QuotaConfigureResult {
    if (!enabled) return { ok: true }

    // cookie 类 provider 需要写入 secrets 文件
    if (cookie !== undefined) {
      try {
        if (!existsSync(this.secretsDir)) {
          mkdirSync(this.secretsDir, { recursive: true })
        }
        const cookiePath = this.getCookiePath(providerId)
        writeFileSync(cookiePath, cookie, 'utf-8')
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[quota] failed to write cookie:', { providerId, error: msg })
        return { ok: false, error: msg }
      }
    }

    return { ok: true }
  }

  /**
   * 实际执行查询（内部方法）。
   */
  private async doFetch(providerId: string): Promise<QuotaFetchResult> {
    this.lastFetchTime.set(providerId, Date.now())

    const fetcher = this.getFetcherForProvider(providerId)
    if (!fetcher) return this.getCached(providerId)

    const credential = this.getCredential(providerId, fetcher.authType)
    if (!credential) {
      // 凭证缺失，返回缓存（不发请求）
      return this.getCached(providerId)
    }

    try {
      const result = await fetcher.fetchQuota(credential)

      if (result) {
        // 成功：更新缓存
        this.cache.update(providerId, result)
        return { data: result, lastFetchAt: Date.now() }
      }

      // 查询失败（返回 null），降级返回旧缓存
      console.warn('[quota] fetch returned null', { providerId })
      return this.getCached(providerId)
    } catch (err) {
      // 异常降级：返回旧缓存 + log
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[quota] fetch failed', { providerId, error: msg })
      return this.getCached(providerId)
    }
  }

  /**
   * 根据 providerId 查找对应的 fetcher。
   * 先从 QUOTA_PRESETS 找 fetcher id，再从 QUOTA_FETCHERS 取 fetcher。
   */
  private getFetcherForProvider(providerId: string): ProviderQuotaFetcher | null {
    // 从 presets 找 fetcher id（providerId 作为 preset 的 fetcher id 直接匹配）
    // 或者从 preset 的 match 规则匹配
    const preset = QUOTA_PRESETS.find((p) => p.fetcher === providerId)
    if (preset) {
      return QUOTA_FETCHERS.get(preset.fetcher) ?? null
    }

    // fallback：直接从 fetchers 查找
    return QUOTA_FETCHERS.get(providerId) ?? null
  }

  /**
   * 获取凭证。
   * - api-key：从 pi-provider-store 读取
   * - cookie：从 secrets 目录读取文件
   */
  private getCredential(providerId: string, authType: 'api-key' | 'cookie'): string | null {
    if (authType === 'api-key') {
      const key = getApiKeyForProvider(providerId)
      return key ?? null
    }

    // cookie 类型：从 secrets 目录读取
    try {
      const cookiePath = this.getCookiePath(providerId)
      if (!existsSync(cookiePath)) return null
      return readFileSync(cookiePath, 'utf-8').trim()
    } catch {
      return null
    }
  }

  /** cookie 文件路径：`<dataDir>/secrets/<providerId>-cookie.txt` */
  private getCookiePath(providerId: string): string {
    return join(this.secretsDir, `${providerId}-cookie.txt`)
  }
}
