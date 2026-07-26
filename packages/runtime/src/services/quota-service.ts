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

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedQuotaRow, ProviderQuotaFetcher } from '@xyz-agent/shared'
import { matchQuotaPreset } from '@xyz-agent/shared'
import { QUOTA_FETCHERS } from './quota-providers/index.js'
import { QuotaCache } from './quota-cache.js'
import { getApiKeyForProvider, getProviderConfig, upsertProvider } from '../infra/pi/pi-provider-store.js'
import { logger } from '../infra/logger.js'
import { getDataDir } from '@xyz-agent/shared/paths'

/** 最小查询间隔（毫秒） */
const THROTTLE_MS = 10_000

/** secret 文件权限：仅属主可读写（W4） */
const SECRET_FILE_MODE = 0o600
/** secrets 目录权限：仅属主可读写执行（W4） */
const SECRET_DIR_MODE = 0o700

/** ProviderInfo 的最小子集（matchQuotaPreset 只需 baseUrl/name）。 */
export interface ProviderInfoLike {
  baseUrl?: string
  name?: string
  /** 用户手动指定的 fetcher id（优先于 matchQuotaPreset）。 */
  quota?: {
    fetcher?: string
  }
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
    // [W7] pending key 带 force 维度：refresh（force）和 fetch（normal）互不复用 ——
    // 否则 refresh 命中 fetch 的 pending 会返回非 force 结果（force 语义被吞）。
    // 同 force 维度内仍去重（同 provider 并发 force 或并发 normal 复用）。
    const pendingKey = this.pendingKey(providerId, opts.force)
    const existing = this.pending.get(pendingKey)
    if (existing) return existing

    // throttle：非 force 模式下，10s 内重复 fetch 直接返回缓存
    if (!opts.force) {
      const lastTime = this.lastFetchTime.get(providerId) ?? 0
      const elapsed = Date.now() - lastTime
      if (elapsed < THROTTLE_MS) {
        return this.getCached(providerId)
      }
    }

    const promise = this.doFetch(providerId, opts.force)
    this.pending.set(pendingKey, promise)

    try {
      return await promise
    } finally {
      this.pending.delete(pendingKey)
    }
  }

  /**
   * [W7] 构造 pending Map 的 key，带 force 维度区分 fetch/refresh。
   * `${providerId}:${force?'force':'normal'}` —— 同 force 去重，跨 force 隔离。
   */
  private pendingKey(providerId: string, force: boolean): string {
    return `${providerId}:${force ? 'force' : 'normal'}`
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
   * - 持久化 fetcher/enabled/cookieSet/apiKeySet 到 models.json 的 provider.quota
   * - cookie 写入 secrets 目录（cookie 类 provider）
   * - apiKey 写入 secrets 目录（api-key 类 provider，可选；不填 = 复用 provider.apiKey）
   *
   * @param fetcher - 用户手动选择的 fetcher id（可选）。未传时保留既有 fetcher 不变。
   * @param apiKey - Coding Plan 专属 API Key（可选，api-key 类）。空字符串 = 清除专属 key，复用 provider.apiKey。
   */
  configure(
    providerId: string,
    enabled: boolean,
    cookie?: string,
    fetcher?: string,
    apiKey?: string,
  ): QuotaConfigureResult {
    // 确保 secrets 目录存在
    // [W4] 临时清零 umask 保证 mode 0o700 不被进程 umask 过滤（mkdirSync 的 mode 受 umask 影响）。
    // 文件级 mode 0o600 同理在写入时设置。恢复原 umask 以免影响调用方其他 IO。
    if (!existsSync(this.secretsDir)) {
      const prevUmask = process.umask(0)
      try {
        mkdirSync(this.secretsDir, { recursive: true, mode: SECRET_DIR_MODE })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('[quota] failed to create secrets dir', { providerId, error: msg })
        return { ok: false, error: msg }
      } finally {
        process.umask(prevUmask)
      }
    }

    // cookie 写入 secrets（cookie 类）
    let cookieSet: boolean | undefined
    if (cookie !== undefined) {
      try {
        this.writeSecretFile(this.getCookiePath(providerId), cookie)
        cookieSet = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('[quota] failed to write cookie', { providerId, error: msg })
        return { ok: false, error: msg }
      }
    }

    // Coding Plan 专属 API Key 写入 secrets（api-key 类，可选）
    let apiKeySet: boolean | undefined
    if (apiKey !== undefined) {
      try {
        const keyPath = this.getApiKeyPath(providerId)
        if (apiKey) {
          // 非空 = 写入专属 key
          this.writeSecretFile(keyPath, apiKey)
          apiKeySet = true
        } else {
          // 空字符串 = 清除专属 key，fallback 到 provider.apiKey
          if (existsSync(keyPath)) {
            try {
              unlinkSync(keyPath)
            } catch (cleanupErr) {
              // 清理失败不阻断主流程（下次写入会覆盖）
              const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
              logger.debug('[quota] failed to remove api key file', { providerId, error: cleanupMsg })
            }
          }
          apiKeySet = false
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('[quota] failed to write apiKey', { providerId, error: msg })
        return { ok: false, error: msg }
      }
    }

    // 持久化 quota 配置到 models.json（fetcher/enabled/cookieSet/apiKeySet）
    const persistOk = this.persistQuotaConfig(
      providerId,
      enabled,
      fetcher,
      cookieSet,
      apiKeySet,
    )
    if (!persistOk) {
      return { ok: false, error: 'failed to persist quota config' }
    }
    return { ok: true }
  }

  /**
   * 持久化 quota 配置到 models.json 的 provider.quota。
   * 复用 upsertProvider 的 spread 合并语义：只覆写 quota 字段，其他 provider 字段不动。
   */
  private persistQuotaConfig(
    providerId: string,
    enabled: boolean,
    fetcher: string | undefined,
    cookieSet: boolean | undefined,
    apiKeySet: boolean | undefined,
  ): boolean {
    const existing = getProviderConfig(providerId)
    if (!existing) {
      logger.warn('[quota] provider not found, cannot persist quota', { providerId })
      return false
    }
    const nextFetcher = fetcher ?? existing.quota?.fetcher
    upsertProvider(providerId, {
      ...existing,
      quota: {
        fetcher: nextFetcher,
        enabled,
        // 保留既有 cookieSet，除非本次明确写入新 cookie
        cookieSet: cookieSet ?? existing.quota?.cookieSet,
        // 保留既有 apiKeySet，除非本次明确传入新值（含空字符串清除）
        apiKeySet: apiKeySet ?? existing.quota?.apiKeySet,
      },
    })
    return true
  }

  /**
   * 实际执行查询（内部方法）。
   *
   * [W5] throttle 计时只在非 force 路径更新：refresh（force=true）不应更新 lastFetchTime，
   * 否则 refresh 后 10s 内的 hover fetch 会被错误拦截（refresh 绕过 throttle，但不能「污染」
   * 后续 fetch 的 throttle 判定）。force 调用不重置计时器，保持 fetch 路径的 throttle 语义独立。
   */
  private async doFetch(providerId: string, force: boolean): Promise<QuotaFetchResult> {
    if (!force) {
      this.lastFetchTime.set(providerId, Date.now())
    }

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
   * 不是 fetcher id（'zhipu'/'kimi-coding'）。查找优先级：
   *
   * 1. 用户手动指定的 quota.fetcher（直接按 id 查 QUOTA_FETCHERS）
   * 2. 经 ProviderInfo 的 baseUrl/name 调 matchQuotaPreset 匹配 QUOTA_PRESETS 得到 preset.fetcher
   * 3. fallback：直接按 providerId 查 fetchers（兼容 provider id 恰好等于 fetcher id 的场景）
   */
  private getFetcherForProvider(providerId: string): ProviderQuotaFetcher | null {
    const info = this.getProviderInfo(providerId)

    // 优先级 1：用户手动指定的 fetcher id（不再依赖 baseUrl/name 自动匹配，
    // 适配自建反代、非标准 baseUrl 等自动匹配失败/猜错的场景）
    if (info?.quota?.fetcher) {
      const manual = QUOTA_FETCHERS.get(info.quota.fetcher)
      if (manual) return manual
    }

    // 优先级 2：经 baseUrl/name 匹配 preset
    if (info) {
      const preset = matchQuotaPreset({ baseUrl: info.baseUrl, name: info.name })
      if (preset) {
        return QUOTA_FETCHERS.get(preset.fetcher) ?? null
      }
    }

    // 优先级 3：直接按 providerId 查 fetchers（仅命中 provider id 恰好等于 fetcher id 的场景）
    return QUOTA_FETCHERS.get(providerId) ?? null
  }

  /**
   * 获取凭证。
   * - api-key：优先读 Coding Plan 专属 API Key（secrets 目录），未设置时 fallback 到 provider.apiKey
   * - cookie：从 secrets 目录读取文件
   *
   * 支持自定义 API Key 是为了适配 router/反代场景：provider 的 baseUrl 指向本地 router，
   * 但 provider.apiKey 是 router 的 key，而 Coding Plan 平台（如 bigmodel.cn）需要平台专属 key。
   * 用户可为 Coding Plan 单独配置一个 API Key，不填则默认用上方的 provider API Key。
   */
  private getCredential(providerId: string, authType: 'api-key' | 'cookie'): string | null {
    if (authType === 'api-key') {
      // 优先读 Coding Plan 专属 API Key（secrets 目录）
      const quotaKey = this.readSecret(this.getApiKeyPath(providerId))
      if (quotaKey) return quotaKey
      // fallback：复用 provider 的 API Key
      const providerKey = getApiKeyForProvider(providerId)
      return providerKey ?? null
    }

    // cookie 类型：从 secrets 目录读取
    return this.readSecret(this.getCookiePath(providerId))
  }

  /** 读 secret 文件（去空白），文件不存在/读取失败返回 null */
  private readSecret(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null
      const val = readFileSync(filePath, 'utf-8').trim()
      return val || null
    } catch (err) {
      // 读取失败不阻断流程（返回 null fallback），但必须 log（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota] failed to read secret file', { filePath, error: msg })
      return null
    }
  }

  /**
   * [W4] 写入 secret 文件并设 0o600 权限。
   *
   * cookie/apiKey 是敏感凭证，文件权限应为 0600（仅属主可读写）。
   * writeFileSync 的 mode 选项仅在创建新文件时生效且被 umask 过滤，故临时清零 umask +
   * 用 chmodSync 后置强制设权限（已存在文件覆盖内容后 mode 不变，也需后置设）。
   */
  private writeSecretFile(filePath: string, content: string): void {
    const prevUmask = process.umask(0)
    try {
      writeFileSync(filePath, content, { encoding: 'utf-8', mode: SECRET_FILE_MODE })
      // mode 选项对新文件且 umask=0 时已生效；chmodSync 后置保证已存在文件被覆盖后权限正确
      chmodSync(filePath, SECRET_FILE_MODE)
    } finally {
      process.umask(prevUmask)
    }
  }

  /** cookie 文件路径：`<dataDir>/secrets/<providerId>-cookie.txt` */
  private getCookiePath(providerId: string): string {
    return join(this.secretsDir, `${providerId}-cookie.txt`)
  }

  /** Coding Plan 专属 API Key 文件路径：`<dataDir>/secrets/<providerId>-apikey.txt` */
  private getApiKeyPath(providerId: string): string {
    return join(this.secretsDir, `${providerId}-apikey.txt`)
  }
}
