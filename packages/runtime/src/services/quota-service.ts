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
import { matchQuotaPreset } from '@xyz-agent/shared'
import { QUOTA_FETCHERS } from './quota-providers/index.js'
import { QuotaCache } from './quota-cache.js'
import { getApiKeyForProvider } from '../infra/pi/pi-provider-store.js'
import { logger } from '../infra/logger.js'
import { getDataDir } from '@xyz-agent/shared/paths'

/** 最小查询间隔（毫秒） */
const THROTTLE_MS = 10_000

/** ProviderInfo 的最小子集（matchQuotaPreset 只需 baseUrl/name）。 */
export interface ProviderInfoLike {
  baseUrl?: string
  name?: string
}

/** 从 providerId 解析 ProviderInfo（baseUrl/name）的回调。 */
export type ProviderInfoResolver = (providerId: string) => ProviderInfoLike | undefined

export interface QuotaFetchResult {
  data: NormalizedQuotaRow | null
  lastFetchAt: number | null
}

export interface QuotaConfigureResult {
  ok: boolean
  error?: string
}

export interface QuotaServiceOptions {
  /** 数据目录（默认 getDataDir()）。 */
  dataDir?: string
  /**
   * 从 providerId 解析 ProviderInfo（baseUrl/name），用于 matchQuotaPreset 匹配 fetcher。
   * 默认实现返回 undefined（无法匹配，仅当 providerId 恰好等于 fetcher id 时命中）。
   */
  getProviderInfo?: ProviderInfoResolver
}

export class QuotaService {
  private cache: QuotaCache
  /** providerId → pending Promise（并发保护） */
  private pending: Map<string, Promise<QuotaFetchResult>> = new Map()
  /** providerId → 上次查询时间戳（throttle） */
  private lastFetchTime: Map<string, number> = new Map()
  /** cookie 文件目录 */
  private secretsDir: string
  /** 从 providerId 解析 ProviderInfo 的回调 */
  private getProviderInfo: ProviderInfoResolver

  constructor(options: QuotaServiceOptions | string = {}) {
    // 兼容旧签名：直接传 dataDir 字符串
    const dir = typeof options === 'string' ? options : (options.dataDir ?? getDataDir())
    this.cache = new QuotaCache(dir)
    this.secretsDir = join(dir, 'secrets')
    this.getProviderInfo = typeof options === 'object' && options.getProviderInfo
      ? options.getProviderInfo
      : () => undefined
  }

  /**
   * 查询额度（hover 触发）。
   * - 并发保护：同 provider pending 期间复用 Promise
   * - throttle：10s 内重复 fetch 直接返回缓存
   * - 失败降级：返回旧缓存 + log
   */
  async fetch(providerId: string): Promise<QuotaFetchResult> {
    return this.runFetch(providerId, { force: false })
  }

  /**
   * 强制查询额度（Settings 测试查询按钮）。
   * - 与 fetch 逻辑相同，但**绕过 throttle**（不检查 lastFetchTime）
   * - 仍走 pending 并发保护（避免同 provider 并发请求）
   * - 失败降级：返回旧缓存 + log
   */
  async refresh(providerId: string): Promise<QuotaFetchResult> {
    return this.runFetch(providerId, { force: true })
  }

  /**
   * fetch/refresh 共用实现。
   * @param force - true 时绕过 throttle（refresh 用）；false 时检查 10s 最小间隔（fetch 用）
   */
  private async runFetch(providerId: string, opts: { force: boolean }): Promise<QuotaFetchResult> {
    // 并发保护：pending 期间复用 Promise
    const existing = this.pending.get(providerId)
    if (existing) return existing

    // throttle：非 force 模式下，10s 内重复 fetch 直接返回缓存
    if (!opts.force) {
      const lastTime = this.lastFetchTime.get(providerId) ?? 0
      const elapsed = Date.now() - lastTime
      if (elapsed < THROTTLE_MS) {
        return this.getCached(providerId)
      }
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
        logger.warn('[quota] failed to write cookie', { providerId, error: msg })
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
      logger.warn('[quota] fetch returned null', { providerId })
      return this.getCached(providerId)
    } catch (err) {
      // 异常降级：返回旧缓存 + log
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[quota] fetch failed', { providerId, error: msg })
      return this.getCached(providerId)
    }
  }

  /**
   * 根据 providerId 查找对应的 fetcher。
   *
   * 设计文档 §2.2.3：providerId 是用户在 settings 创建的 provider id（如 'my-zhipu'、'glm'），
   * 不是 fetcher id（'zhipu'/'kimi-coding'）。先用 getProviderInfo 拿到 baseUrl/name，
   * 再调 matchQuotaPreset 匹配 QUOTA_PRESETS 得到 preset.fetcher，最后从 QUOTA_FETCHERS 取 fetcher。
   *
   * fallback：当 getProviderInfo 未注入或返回空时，尝试直接按 providerId 查 fetchers
   * （兼容 provider id 恰好等于 fetcher id 的场景）。
   */
  private getFetcherForProvider(providerId: string): ProviderQuotaFetcher | null {
    // 主路径：经 ProviderInfo 的 baseUrl/name 匹配 preset
    const info = this.getProviderInfo(providerId)
    if (info) {
      const preset = matchQuotaPreset({ baseUrl: info.baseUrl, name: info.name })
      if (preset) {
        return QUOTA_FETCHERS.get(preset.fetcher) ?? null
      }
    }

    // fallback：直接按 providerId 查 fetchers（仅命中 provider id 恰好等于 fetcher id 的场景）
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
