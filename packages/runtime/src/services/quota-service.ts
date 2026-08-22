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
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md §2.2.3
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedQuotaRow, ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchFailureReason } from '@xyz-agent/shared'
import { matchQuotaPreset } from '@xyz-agent/shared'
import { QUOTA_FETCHERS } from './quota-providers/index.js'
import { QuotaCache } from './quota-cache.js'
import { getApiKeyForProvider, getProviderConfig } from '../infra/pi/pi-provider-store.js'
import { logger } from '../infra/logger.js'
import { getDataDir } from '@xyz-agent/shared/paths'
import type { XyzProviderStore, ProviderExtras } from './provider-extras-store.js'
import type { Credential } from './auth/auth-storage.js'
import type { ConfigProviderConfig } from './ports/config.js'

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
  /**
   * 最近一次查询失败原因（A2-4）。查询失败（data=null 失败态）或内存中记录着上次
   * 失败（getCached，供 UI 失败态 + 「查看上次成功数据」入口）时出现；成功后清除。
   * 展示语义（§3.4）：失败时 UI 整体替换为失败态，旧缓存数据保留内存不展示。
   */
  reason?: QuotaFetchFailureReason
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
  /**
   * providers.json 存储（A1-5 写侧切换）：quota 配置持久化落 config/providers.json，
   * 不再经 upsertProvider 写 pi models.json（寄生字段禁复活）。
   * 未注入时 configure 的持久化失败返回（宁失败不写错位）。
   */
  providerExtrasStore?: XyzProviderStore
  /**
   * provider 聚合层存在性判定（catalog ∪ custom）：quota 绑定不再依赖 models.json
   * 条目存在（场景 E：oauth-only catalog provider 在 models.json 无条目），改为查
   * provider 聚合。默认回退 models.json 条目判定（保守，向后兼容未注入场景）。
   */
  providerExists?: (providerId: string) => boolean
  /**
   * auth.json 凭证读取通道（A2-2）：api-key 形态的第二优先级来源
   * （credential(api_key).key）与 oauth 形态的唯一来源（credential(oauth).access）。
   * 生产注入 AuthService.getCredential（直读不缓存——pi 侧 refresh 写回后必须能立即
   * 读到新值，D6）。未注入时跳过 auth.json 来源（保守，向后兼容）。
   */
  getAuthCredential?: (providerId: string) => Promise<Credential | undefined>
  /**
   * models.json 单 provider 条目读取通道（round 1 review arch-boundary S2 port 化）：
   * providerExists 默认回退与 readQuotaFallback 的 legacy quota 兜底经此读，
   * 消除新增代码路径的 services → infra 直连。生产注入 configStore.getProviderConfig
   * （PiConfigStore 委托同一 infra 函数，读同一文件同一解析，行为等价）。
   * 未注入时回退 infra 模块函数（保持既有单测的模块 mock 体系与未注入行为不变）。
   */
  getProviderConfig?: (providerId: string) => ConfigProviderConfig | undefined
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
  /** providers.json 存储（quota 配置持久化落点，A1-5 写侧切换） */
  private extrasStore: XyzProviderStore | undefined
  /** provider 聚合层存在性判定 */
  private providerExists: (providerId: string) => boolean
  /** auth.json 凭证读取通道（A2-2，生产注入 AuthService.getCredential） */
  private getAuthCredential: ((providerId: string) => Promise<Credential | undefined>) | undefined
  /** models.json 单条目读取通道（arch-boundary S2 port 化，生产注入 configStore.getProviderConfig） */
  private getProviderConfigOpt: ((providerId: string) => ConfigProviderConfig | undefined) | undefined
  /** providerId → 最近一次查询失败原因（A2-4：getCached 透传；成功清除；不落盘） */
  private lastFailure: Map<string, QuotaFetchFailureReason> = new Map()

  constructor(options: QuotaServiceOptions | string = {}) {
    // 兼容旧签名：直接传 dataDir 字符串
    const opts: QuotaServiceOptions = typeof options === 'string' ? {} : options
    const dir = typeof options === 'string' ? options : (opts.dataDir ?? getDataDir())
    this.cache = new QuotaCache(dir)
    this.secretsDir = join(dir, 'secrets')
    this.getProviderInfo = opts.getProviderInfo ?? (() => undefined)
    this.extrasStore = opts.providerExtrasStore
    this.getProviderConfigOpt = opts.getProviderConfig
    this.providerExists = opts.providerExists
      // 保守默认：维持旧限制语义（models.json 有条目才可配置），生产恒注入聚合判定
      ?? ((providerId) => this.readProviderConfig(providerId) !== undefined)
    this.getAuthCredential = opts.getAuthCredential
  }

  /**
   * models.json 单条目读取（注入通道优先，未注入回退 infra 模块函数——同一文件同一
   * 解析，行为等价；回退仅为兼容既有未注入单测的模块 mock 体系）。
   */
  private readProviderConfig(providerId: string): ConfigProviderConfig | undefined {
    return this.getProviderConfigOpt
      ? this.getProviderConfigOpt(providerId)
      : getProviderConfig(providerId) as unknown as ConfigProviderConfig | undefined
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
   * [A2-4] 携带内存中最近一次失败 reason（无失败记录时无 reason 字段）：缓存数据
   * 保留供「查看上次成功数据」入口（lastFetchAt 标注），失败态渲染归 Phase B。
   */
  getCached(providerId: string): QuotaFetchResult {
    const entry = this.cache.getEntry(providerId)
    const reason = this.lastFailure.get(providerId)
    const base = entry
      ? { data: entry.data, lastFetchAt: entry.lastFetchAt }
      : { data: null, lastFetchAt: null }
    return reason !== undefined ? { ...base, reason } : base
  }

  /**
   * 配置 provider 额度查询（Settings UI 调用）。
   * - 持久化 fetcher/enabled/cookieSet/apiKeySet 到 config/providers.json（A1-5 写侧切换）
   * - cookie 写入 secrets 目录（cookie 类 provider）
   * - apiKey 写入 secrets 目录（api-key 类 provider，可选；不填 = 复用 provider.apiKey）
   *
   * @param fetcher - 用户手动选择的 fetcher id（可选）。未传时保留既有 fetcher 不变。
   * @param apiKey - Coding Plan 专属 API Key（可选，api-key 类）。空字符串 = 清除专属 key，复用 provider.apiKey。
   */
  async configure(
    providerId: string,
    enabled: boolean,
    cookie?: string,
    fetcher?: string,
    apiKey?: string,
  ): Promise<QuotaConfigureResult> {
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

    // 持久化 quota 配置到 config/providers.json（fetcher/enabled/cookieSet/apiKeySet）
    const persistOk = await this.persistQuotaConfig(
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
   * 持久化 quota 配置到 config/providers.json（A1-5 写侧切换，经 XyzProviderStore.modify
   * RMW——只覆写 quota 字段，同 provider 其他扩展数据不动）。
   *
   * 校验：provider 必须存在于聚合层（catalog 或 custom，providerExists 注入判定）——
   * quota 绑定不再依赖 models.json 条目存在（场景 E：oauth-only catalog provider）。
   *
   * 既有值继承（A1-3 读源切换）：quota 既有值经 readQuotaFallback 双读——providers.json
   * 条目优先，无条目时回退 models.json 旧 quota（迁移失败窗口兼容——迁移成功后
   * models.json 已剥离，该回退恒 miss）。
   */
  private async persistQuotaConfig(
    providerId: string,
    enabled: boolean,
    fetcher: string | undefined,
    cookieSet: boolean | undefined,
    apiKeySet: boolean | undefined,
  ): Promise<boolean> {
    if (!this.providerExists(providerId)) {
      logger.warn('[quota] provider not found in aggregated provider list, cannot persist quota', { providerId })
      return false
    }
    if (!this.extrasStore) {
      logger.warn('[quota] provider extras store not configured, cannot persist quota', { providerId })
      return false
    }
    const legacyQuota = this.readQuotaFallback(providerId)
    try {
      await this.extrasStore.modify(providerId, current => ({
        ...current,
        quota: {
          fetcher: fetcher ?? current?.quota?.fetcher ?? legacyQuota?.fetcher,
          enabled,
          // 保留既有 cookieSet，除非本次明确写入新 cookie
          cookieSet: cookieSet ?? current?.quota?.cookieSet ?? legacyQuota?.cookieSet,
          // 保留既有 apiKeySet，除非本次明确传入新值（含空字符串清除）
          apiKeySet: apiKeySet ?? current?.quota?.apiKeySet ?? legacyQuota?.apiKeySet,
        },
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[quota] failed to persist quota config to providers.json', { providerId, error: msg })
      return false
    }
  }

  /**
   * quota 既有值双读回退（A1-3 读源切换）：providers.json 条目（经 XyzProviderStore 同步
   * 读）优先，无条目时回退 models.json 旧寄生 quota。providers.json 有条目时与 modify
   * 回调的 current.quota 同值（兜底链中 current 优先，此处值仅补充无条目场景）。
   */
  private readQuotaFallback(providerId: string): NonNullable<ProviderExtras['quota']> | undefined {
    const fromStore = this.extrasStore?.getExtrasSync(providerId)
    if (fromStore !== undefined) return fromStore.quota
    return this.readProviderConfig(providerId)?.quota
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

    const resolved = await this.resolveCredential(providerId, fetcher.auth)
    if (!resolved) {
      // 凭证缺失（fetcher.auth 数组序全形态都未解析到凭证），返回缓存（不发请求）
      return this.getCached(providerId)
    }

    try {
      const outcome = await fetcher.fetchQuota(resolved.credential, resolved.kind)

      if (outcome.ok) {
        // 成功：更新缓存，清除失败标记
        this.lastFailure.delete(providerId)
        this.cache.update(providerId, outcome.data)
        return { data: outcome.data, lastFetchAt: Date.now() }
      }

      // 查询失败（ok:false，reason 可区分）：返回失败态——data 置 null
      // 不再降级展示旧缓存（§3.4 失败态语义：旧缓存保留内存，可经 getCached 查看并
      // 标注 lastFetchAt）；401 恢复指引文案归 Phase B（i18n key 已就绪）。
      logger.warn('[quota] fetch failed', { providerId, reason: outcome.reason })
      return this.fetchFailed(providerId, outcome.reason)
    } catch (err) {
      // 异常防御（fetcher 契约不 throw，此处兜底逃逸异常）：按 network 失败态处理 + log
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[quota] fetch threw', { providerId, error: msg })
      return this.fetchFailed(providerId, 'network')
    }
  }

  /** 失败态构造（A2-4）：记录失败原因；lastFetchAt 标注上次成功时间（§3.4 旧缓存标注语义）。 */
  private fetchFailed(providerId: string, reason: QuotaFetchFailureReason): QuotaFetchResult {
    this.lastFailure.set(providerId, reason)
    const lastSuccessAt = this.cache.getEntry(providerId)?.lastFetchAt ?? null
    return { data: null, lastFetchAt: lastSuccessAt, reason }
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
   * 按 fetcher.auth 能力声明数组序解析凭证（A2-2 三形态解析链）。
   * 首个解析到凭证的形态即生效，并以该形态作为 kind 传给 fetchQuota（凭证语义可区分）。
   * 全形态 miss → null（调用方不发请求，返回缓存）。
   */
  private async resolveCredential(
    providerId: string,
    auth: readonly QuotaAuthKind[],
  ): Promise<{ credential: string; kind: QuotaAuthKind } | null> {
    for (const kind of auth) {
      const credential = await this.getCredential(providerId, kind)
      if (credential) return { credential, kind }
    }
    return null
  }

  /**
   * 获取凭证（单形态，来源链固定）。
   * - api-key：secrets 专属额度 key → auth.json `credential(api_key).key`（经注入的
   *   AuthService.getCredential 通道）→ models.json `providers[id].apiKey`（§3.5 终态链）
   * - oauth：auth.json `credential(oauth).access`（直读现值，不自行 refresh——D6）
   * - cookie：secrets cookie 文件
   *
   * 支持自定义 API Key 是为了适配 router/反代场景：provider 的 baseUrl 指向本地 router，
   * 但 provider.apiKey 是 router 的 key，而 Coding Plan 平台（如 bigmodel.cn）需要平台专属 key。
   * 用户可为 Coding Plan 单独配置一个 API Key，不填则默认用上方的 provider API Key。
   */
  private async getCredential(providerId: string, kind: QuotaAuthKind): Promise<string | null> {
    if (kind === 'api-key') {
      // 优先读 Coding Plan 专属 API Key（secrets 目录）
      const quotaKey = this.readSecret(this.getApiKeyPath(providerId))
      if (quotaKey) return quotaKey
      // auth.json api_key（catalog provider 凭证的目标位置，M5-01——修复场景 A 断点的关键来源）
      const authCred = await this.readAuthCredential(providerId)
      if (authCred?.type === 'api_key' && authCred.key) return authCred.key
      // fallback：复用 provider 的 API Key（models.json）
      const providerKey = getApiKeyForProvider(providerId)
      return providerKey ?? null
    }

    if (kind === 'oauth') {
      const authCred = await this.readAuthCredential(providerId)
      return authCred?.type === 'oauth' && authCred.access ? authCred.access : null
    }

    // cookie 类型：从 secrets 目录读取
    return this.readSecret(this.getCookiePath(providerId))
  }

  /** auth.json 凭证读取（未注入通道 / 读取异常 → undefined，不阻断后续来源链）。 */
  private async readAuthCredential(providerId: string): Promise<Credential | undefined> {
    if (!this.getAuthCredential) return undefined
    try {
      return await this.getAuthCredential(providerId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota] failed to read auth.json credential', { providerId, error: msg })
      return undefined
    }
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
