/**
 * Release 检测器（GitHub /releases/latest）。
 *
 * 对应 slice auto-update-and-install：实现 IReleaseChecker Facade。
 *
 * 职责链：
 *   1. 缓存命中检查（1h，force 可绕过；批次 4 负缓存：「无新版」也写缓存，TTL 同 1h）
 *   2. fetch GitHub /releases/latest（AbortController 10s 超时）
 *   3. 三重 prerelease 防御：
 *      a. API 语义层：/releases/latest 端点天然排除 prerelease（仅最近 stable）
 *      b. release.prerelease / draft 字段校验
 *      c. tag_name strip 前导 v 后正则 /^\d+\.\d+\.\d+$/（拒绝 rc/beta 后缀）
 *   4. compare-versions 比较：latest > current 才继续
 *   5. 按平台分流 asset（后缀 pattern 匹配，兼容带/不带版本号的文件名）
 *   6. sha256 优先取 asset.digest（strip 'sha256:' 前缀）；digest 缺失时 fallback fetch manifest.json
 *
 * [批次 4 调度与限额（设计 §3.6 RM2）]：
 * - 负缓存（m7）：「无新版」结果（latest ≤ current / prerelease / draft / 版本格式非法）
 *   同样写入缓存（info=null），TTL 同 1h——修掉「每周期必打 API」；网络失败不写缓存
 *   （断网不阻塞下次重试）。
 * - 403/429 可区分：不再并入 null，抛 ReleaseRateLimitedError 并内部记录
 *   rateLimitedUntil = now + 2h——退避窗口内 checkForLatestRelease 直接短路返回 null
 *   （周期/补查/手动全尊重，零联网），renderer 收到 null 即「非侵入静默」，无需感知信号。
 *
 * [HISTORICAL] 不变量：
 * - 失败一律 catch 返回 null，不缓存失败（下次仍会重新尝试）——网络失败仍不缓存；
 *   「无新版」类结果自批次 4 起写入负缓存（见上）
 * - sha256 来源：优先 GitHub asset.digest；digest 缺失（老 release / 某些情况下 undefined）
 *   时 fetch manifest.json（CI generate-manifest.sh 产物）作为 fallback
 * - manifest fallback 仅在至少一个 asset 缺 sha256 时 fetch 一次（lazy），全失败则 sha256 留 undefined
 * - D6：代理优先 + 失败降级直连（mode=manual/system 且解析出代理 URL 时；
 *   fetch 失败用无 dispatcher 直连重试一次；10s 超时各一次，总最坏 20s）
 *
 * 依赖方向：release-checker → @xyz-agent/shared + compare-versions + 全局 fetch + undici ProxyAgent
 */
import { compare } from 'compare-versions'
import { ProxyAgent } from 'undici'
import type { LatestReleaseInfo, ReleaseAsset } from '@xyz-agent/shared'
import type { IReleaseChecker } from './interfaces.js'
import { readProxyConfig, resolveProxyUrl } from './update/proxy-config.js'

/** GitHub /releases/latest API 端点 */
const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/zhushanwen321/xyz-agent/releases/latest'

/** manifest.json 下载直链（CI generate-manifest.sh 产物，含每个 asset 的 sha256） */
const MANIFEST_URL =
  'https://github.com/zhushanwen321/xyz-agent/releases/latest/download/manifest.json'

/**
 * 请求头：Accept（指定 GitHub JSON 媒体类型）+ X-GitHub-Api-Version + User-Agent。
 * GitHub API 要求 User-Agent 非空（否则 403），这里硬编码（不引入 electron 依赖以保持可测性）。
 */
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xyz-agent-updater',
} as const

/** 时长换算（复用于缓存 TTL / 限流退避等时长常量组合） */
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MS_PER_SECOND = 1000

/** fetch 超时（AbortController） */
const FETCH_TIMEOUT_MS = 10_000

/** 403/429 限流退避窗口小时数（RM2.3：跳过后续周期的联网检查，共 2h） */
const RATE_LIMIT_BACKOFF_HOURS = 2
const RATE_LIMIT_BACKOFF_MS =
  RATE_LIMIT_BACKOFF_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

/** HTTP 状态码：GitHub API 限流/配额拒绝（RM2.3 可区分信号） */
const HTTP_STATUS_FORBIDDEN = 403
const HTTP_STATUS_TOO_MANY_REQUESTS = 429

/**
 * GitHub API 限流/拒绝信号（HTTP 403/429）。
 *
 * 与「网络失败」可区分：这是服务器明确响应（降级直连无意义），且需要触发
 * 退避而非普通失败。checkForLatestRelease 捕获后记录 rateLimitedUntil 并
 * 返回 null（接口形状不变，renderer 收到 null 即非侵入静默）。
 */
export class ReleaseRateLimitedError extends Error {
  constructor(message = 'GitHub API rate limited (403/429)') {
    super(message)
    this.name = 'ReleaseRateLimitedError'
  }
}

/** 缓存有效期（1h） */
const CACHE_TTL_MS = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * MS_PER_SECOND

/**
 * 严格版本号校验（strip 前导 v 后）——拒绝 rc/beta 等后缀。
 * 支持 3 段（1.2.3）或 4 段（1.2.3.4，electron-builder 有时输出 4 段 build 号）。
 */
const STRICT_VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

// ── GitHub API 响应类型（仅取关心的字段）─────────────────────────────

interface GitHubAsset {
  /** 文件名（如 'xyz-agent-mac-arm64.zip'） */
  name: string
  /** 下载直链 */
  browser_download_url: string
  /** 文件大小（字节） */
  size: number
  /**
   * GitHub 服务端算好的摘要，期望格式 'sha256:<hex>'。
   * 注意：API 实际可能不返回（需 release assets 启用 digest），
   * 或返回非 sha256 格式（如 'sha512:...'）——后者会被 extractSha256 拒绝为 undefined。
   */
  digest?: string
}

interface GitHubRelease {
  /** 原始 tag（如 'v0.9.0'） */
  tag_name: string
  /** Release body markdown 原文 */
  body?: string
  /** 发布时间 ISO 8601 */
  published_at?: string
  /** release 页面 URL */
  html_url?: string
  /** GitHub prerelease 标记 */
  prerelease?: boolean
  /** GitHub draft 标记（草稿不应作为「latest」） */
  draft?: boolean
  /** 产物资产列表 */
  assets?: GitHubAsset[]
}

// ── asset 文件名 pattern（按平台后缀匹配）──────────────────────────
// release asset 文件名格式：xyz-agent-<version>-<platform-suffix>.<ext>
// 用后缀匹配而非精确文件名，解耦文件名版本号格式与 asset 定位逻辑——
// 兼容带版本号（xyz-agent-0.8.44-mac-arm64.zip）与不带（xyz-agent-mac-arm64.zip）。

const ASSET_PATTERNS = {
  macArm64Zip: (name: string): boolean => name.endsWith('-mac-arm64.zip'),
  winX64Exe: (name: string): boolean => name.endsWith('-setup-x64.exe'),
  linuxX64AppImage: (name: string): boolean => name.endsWith('-x86_64.AppImage'),
  linuxX64Deb: (name: string): boolean => name.endsWith('-amd64.deb'),
} as const

// ── 缓存条目类型 ──────────────────────────────────────────────────

/**
 * 缓存条目（批次 4 负缓存：info=null 表示「已确认无新版」，同样受 TTL 保护）。
 */
interface CacheEntry {
  info: LatestReleaseInfo | null
  fetchedAt: number
}

/**
 * Release 检测器实现。
 *
 * 通过 GitHub /releases/latest API 检测最新可用版本，1h 缓存。
 * 单实例由 main.ts 构造并注入到 IpcHandlerDeps.releaseChecker。
 */
export class ReleaseChecker implements IReleaseChecker {
  /** 缓存条目；null 表示无缓存（首次或上次 fetch 失败）；info=null 为负缓存（已确认无新版） */
  private cachedResult: CacheEntry | null = null

  /** 限流退避截止时刻（epoch ms，0 = 未限流）：窗口内直接短路返回 null，零联网 */
  private rateLimitedUntil = 0

  /**
   * 限流退避截止时刻（IReleaseChecker 可选方法）。
   * update:check handler 据此把「限额退避中的 null」与「确认无新版的 null」区分开，
   * 经 UpdateCheckResult.rateLimited 透传 renderer（RM2.3 信号透传）。
   */
  getRateLimitedUntil(): number {
    return this.rateLimitedUntil
  }

  /**
   * 检测最新可用版本。
   *
   * @param currentVersion 当前版本（如 '0.8.14'）
   * @param opts.force 强制刷新缓存
   */
  async checkForLatestRelease(
    currentVersion: string,
    opts?: { force?: boolean },
  ): Promise<LatestReleaseInfo | null> {
    // 0. 限流退避短路（批次 4 RM2.3）：窗口内周期/补查/手动全部直接返回 null，零联网。
    // renderer 收到 null 即「非侵入静默」，无需感知限流信号。
    if (this.isRateLimited()) return null

    // 1. 缓存命中检查（force 可绕过；负缓存的 info=null 也命中 → 直接返回无新版）
    const cached = this.getCachedResultIfFresh(opts)
    if (cached !== undefined) return cached

    // 2. fetch（限流信号在内部分流：403/429 记退避并返回 null，不降级直连）
    const release = await this.fetchLatestReleaseHandlingRateLimit()
    if (!release) return null

    // 3-6. 三重 prerelease 防御 b/c + 版本比较：判定「无新版」→ 写负缓存（m7）并返回 null
    const strippedVersion = this.resolveNewerVersion(release, currentVersion)
    if (strippedVersion === null) return null

    // 7. 按平台分流 asset，组装 LatestReleaseInfo（解析失败 = GitHub 数据坏，
    //    保守不写负缓存，下次重试）
    const info = await this.buildLatestReleaseInfo(release, strippedVersion, release.tag_name)
    if (!info) return null

    // 8. 写入缓存（成功才写正缓存）
    // 注意：fetchedAt 必须在 fetch 完成后重新取 now，否则会比实际获取时间提前最多 10s（fetch timeout）
    this.cachedResult = { info, fetchedAt: Date.now() }
    return info
  }

  /** 限流退避窗口判定：窗口内直接短路，零联网 */
  private isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil
  }

  /**
   * 缓存命中检查（force 可绕过；负缓存的 info=null 同样命中）。
   *
   * @returns 命中返回缓存 info（null = 负缓存「已确认无新版」）；
   *          未命中（无缓存 / 已过期 / force）返回 undefined
   */
  private getCachedResultIfFresh(opts?: { force?: boolean }): LatestReleaseInfo | null | undefined {
    if (opts?.force) return undefined
    if (!this.cachedResult) return undefined
    const age = Date.now() - this.cachedResult.fetchedAt
    if (age >= CACHE_TTL_MS) return undefined
    return this.cachedResult.info
  }

  /**
   * fetch 最新 release 并分流限流信号（批次 4 RM2.3）。
   * 403/429：记退避窗口（2h）后返回 null；其他错误原样向上抛
   * （网络失败不缓存，下次仍会重新尝试）。
   */
  private async fetchLatestReleaseHandlingRateLimit(): Promise<GitHubRelease | null> {
    try {
      return await this.fetchGitHubLatestRelease()
    } catch (err) {
      if (err instanceof ReleaseRateLimitedError) {
        // 403/429：记退避窗口（2h），窗口内后续调用直接短路零联网
        this.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
        console.warn(
          `[release-checker] rate limited by GitHub, backing off until ${new Date(this.rateLimitedUntil).toISOString()}`,
        )
        return null
      }
      throw err
    }
  }

  /**
   * 「无新版」统一出口（批次 4 m7 负缓存）：写 info=null 缓存并返回 null。
   * prerelease / draft / 版本格式非法 / 不比当前新均经此处收口。
   */
  private writeNegativeCacheAndReturnNull(): null {
    this.cachedResult = { info: null, fetchedAt: Date.now() }
    return null
  }

  /**
   * 三重 prerelease 防御 b/c + 版本比较（步骤 3-6）。
   *
   * @returns strip 前导 v 后的纯版本号；判定「无新版」（prerelease / draft /
   *          版本格式非法 / 不比当前新，compare 抛错同此）时写负缓存并返回 null
   */
  private resolveNewerVersion(release: GitHubRelease, currentVersion: string): string | null {
    // 三重 prerelease 防御 b：字段校验（负缓存：GitHub 侧判定无可用 stable）
    if (release.prerelease) return this.writeNegativeCacheAndReturnNull()
    if (release.draft) return this.writeNegativeCacheAndReturnNull()

    // strip 前导 v，提取纯版本号
    const tagName = release.tag_name
    const strippedVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName

    // 三重 prerelease 防御 c：严格版本号校验（拒绝 rc/beta 后缀；负缓存同上）
    if (!STRICT_VERSION_RE.test(strippedVersion)) return this.writeNegativeCacheAndReturnNull()

    // 版本比较：latest 必须 > current；否则为「无新版」→ 写负缓存（m7）
    let isNewer: boolean
    try {
      isNewer = compare(strippedVersion, currentVersion, '>') // compare 抛错则视为非新版
    } catch {
      return this.writeNegativeCacheAndReturnNull()
    }
    if (!isNewer) return this.writeNegativeCacheAndReturnNull()
    return strippedVersion
  }

  /**
   * fetch GitHub /releases/latest，失败返回 null。
   *
   * 三重 prerelease 防御 a：/releases/latest 端点本身只返回最近 stable，
   * 天然排除 prerelease（GitHub API 文档语义）。
   *
   * D6：代理优先 + 失败降级直连。
   * - mode=manual/system 且解析出代理 URL 时，先用 ProxyAgent 走代理
   * - fetch 失败（网络错误，如 EHOSTUNREACH）且用了代理时，降级直连重试一次
   * - HTTP 错误（404/500）不触发降级（服务器已响应，重试无意义）
   * - 10s 超时各一次（总最坏 20s，EHOSTUNREACH 类快速失败下降级延迟 <2s）
   */
  private async fetchGitHubLatestRelease(): Promise<GitHubRelease | null> {
    // 读代理配置，决定是否走代理
    const proxyConfig = readProxyConfig()
    const proxyUrl = resolveProxyUrl(proxyConfig)
    const useProxy = proxyUrl !== undefined

    try {
      // 第一次尝试：代理优先（若有）
      return await this.doFetchGitHubLatestRelease(useProxy ? proxyUrl : undefined)
    } catch (err) {
      // 限流信号：服务器明确响应，降级直连无意义 → 直接向上传播（触发退避）
      if (err instanceof ReleaseRateLimitedError) throw err
      // 网络错误（EHOSTUNREACH/ECONNREFUSED/超时等）
      if (useProxy) {
        // 降级：用了代理但网络失败时，直连重试一次（无 dispatcher）
        try {
          return await this.doFetchGitHubLatestRelease(undefined)
        } catch {
          // 直连也失败 → 返回 null
          return null
        }
      }
      // 无代理也失败 → 返回 null
      return null
    }
  }

  /**
   * 执行单次 fetch GitHub /releases/latest。
   *
   * @param proxyUrl 代理 URL；undefined 表示直连（无 dispatcher）
   * @returns 解析后的 GitHubRelease；
   *          HTTP 错误（404/500 等）返回 null；网络错误抛出（供降级逻辑捕获）
   * @throws 网络错误（EHOSTUNREACH/ECONNREFUSED/超时等）——调用方据此决定是否降级
   */
  private async doFetchGitHubLatestRelease(proxyUrl?: string): Promise<GitHubRelease | null> {
    let dispatcher: ProxyAgent | undefined
    if (proxyUrl) {
      try {
        dispatcher = new ProxyAgent(proxyUrl)
      } catch {
        // ProxyAgent 构造失败（URL 格式非法等）→ 降级直连
        dispatcher = undefined
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const options: RequestInit = {
        headers: GITHUB_HEADERS,
        signal: controller.signal,
      }
      if (dispatcher) {
        // undici 扩展的 RequestInit 含 dispatcher 字段，经 as RequestInit 适配全局类型
        (options as Record<string, unknown>).dispatcher = dispatcher
      }
      const response = await fetch(GITHUB_LATEST_RELEASE_URL, options)
      if (!response.ok) {
        // 批次 4 RM2.3：403/429 是服务器明确限流/拒绝 → 抛可区分信号（不并入 null，
        // 也不降级直连——重试无意义）；其他 HTTP 错误仍 return null
        if (response.status === HTTP_STATUS_FORBIDDEN || response.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
          throw new ReleaseRateLimitedError()
        }
        return null
      }
      const data = (await response.json()) as GitHubRelease
      return data
    } catch (err) {
      // 限流信号直接向上传播（若被此处包装成普通 Error，退避逻辑将失效）
      if (err instanceof ReleaseRateLimitedError) throw err
      // 网络/超时错误 → 抛出供调用方降级；AbortError（超时）也视为网络错误
      throw new Error('fetch failed')
    } finally {
      clearTimeout(timer)
      // ProxyAgent 持有连接池，显式关闭避免句柄泄漏
      await dispatcher?.close().catch(() => {})
    }
  }

  /**
   * 把 GitHubRelease 转成 LatestReleaseInfo（按平台分流 asset）。
   *
   * sha256 解析策略：先试 asset.digest（GitHub 服务端摘要）；若任一 asset 缺 sha256，
   * fetch manifest.json 一次作为 fallback（lazy，避免每个 asset 都打网络）。
   *
   * @returns 解析后的 info；release 字段缺失严重时返回 null
   */
  private async buildLatestReleaseInfo(
    release: GitHubRelease,
    version: string,
    tagName: string,
  ): Promise<LatestReleaseInfo | null> {
    const assets = release.assets ?? []

    // 判断是否需要 manifest fallback：仅检查我们关心的 4 个目标 asset 的 digest
    // （忽略 blockmap 等干扰资产——它们的 digest 即便非法也不影响升级 sha256）。
    // 任一目标 asset 缺 sha256（digest 缺失或非法）则 fetch manifest 一次（lazy）。
    const isTargetAsset = (name: string): boolean =>
      Object.values(ASSET_PATTERNS).some((match) => match(name))
    const needsManifest = assets.some(
      (a) => isTargetAsset(a.name) && extractSha256(a.digest) === undefined,
    )
    let manifestMap: Map<string, string> | null = null
    if (needsManifest) {
      manifestMap = await this.fetchManifestSha256()
    }

    const macArm64Zip = pickAsset(assets, ASSET_PATTERNS.macArm64Zip, manifestMap)
    const winX64Exe = pickAsset(assets, ASSET_PATTERNS.winX64Exe, manifestMap)
    const linuxX64AppImage = pickAsset(assets, ASSET_PATTERNS.linuxX64AppImage, manifestMap)
    const linuxX64Deb = pickAsset(assets, ASSET_PATTERNS.linuxX64Deb, manifestMap)

    return {
      version,
      tagName,
      releaseNotes: release.body ?? '',
      publishedAt: release.published_at ?? '',
      htmlUrl: release.html_url ?? '',
      assets: {
        macArm64Zip,
        winX64Exe,
        linuxX64AppImage,
        linuxX64Deb,
      },
    }
  }

  /**
   * fetch manifest.json 作为 sha256 fallback。
   *
   * manifest 由 CI generate-manifest.sh 生成，结构：
   *   { version, releasedAt, assets: { "<filename>": { sha256, size } } }
   * 失败（网络/超时/解析/404）一律返回 null（不阻塞，sha256 留 undefined 由调用方降级）。
   *
   * D6：代理优先 + 失败降级直连（与 fetchGitHubLatestRelease 同策略）。
   *
   * @returns Map<filename, sha256hex>；不可用时返回 null
   */
  private async fetchManifestSha256(): Promise<Map<string, string> | null> {
    // 读代理配置（复用缓存层逻辑，与 fetchGitHubLatestRelease 同源）
    const proxyConfig = readProxyConfig()
    const proxyUrl = resolveProxyUrl(proxyConfig)
    const useProxy = proxyUrl !== undefined

    try {
      // 第一次尝试：代理优先
      return await this.doFetchManifestSha256(useProxy ? proxyUrl : undefined)
    } catch {
      // 网络错误
      if (useProxy) {
        // 降级直连重试
        try {
          return await this.doFetchManifestSha256(undefined)
        } catch {
          return null
        }
      }
      return null
    }
  }

  /**
   * 执行单次 fetch manifest.json。
   *
   * @param proxyUrl 代理 URL；undefined 表示直连
   * @returns Map<filename, sha256hex>；
   *          HTTP 错误返回 null；网络错误抛出（供降级逻辑捕获）
   * @throws 网络错误——调用方据此决定是否降级
   */
  private async doFetchManifestSha256(proxyUrl?: string): Promise<Map<string, string> | null> {
    let dispatcher: ProxyAgent | undefined
    if (proxyUrl) {
      try {
        dispatcher = new ProxyAgent(proxyUrl)
      } catch {
        dispatcher = undefined
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const options: RequestInit = { signal: controller.signal }
      if (dispatcher) {
        (options as Record<string, unknown>).dispatcher = dispatcher
      }
      const resp = await fetch(MANIFEST_URL, options)
      if (!resp.ok) return null
      const manifest = (await resp.json()) as {
        assets?: Record<string, { sha256?: unknown }>
      }
      const assetsMap = manifest?.assets
      if (!assetsMap || typeof assetsMap !== 'object') return null
      const map = new Map<string, string>()
      for (const [name, info] of Object.entries(assetsMap)) {
        const sha = info?.sha256
        if (typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha)) {
          map.set(name, sha)
        }
      }
      return map.size > 0 ? map : null
    } catch {
      // 网络错误抛出供调用方降级
      throw new Error('fetch failed')
    } finally {
      clearTimeout(timer)
      await dispatcher?.close().catch(() => {})
    }
  }
}

/**
 * 按 pattern 从 asset 列表中挑选单个资产，转成 ReleaseAsset（含 sha256 提取）。
 * 找不到返回 undefined。
 *
 * @param match 文件名匹配函数（来自 ASSET_PATTERNS，按平台后缀匹配）
 * @param manifestMap manifest.json fallback（asset.digest 缺失时查此 Map），可为 null
 */
function pickAsset(
  assets: GitHubAsset[],
  match: (name: string) => boolean,
  manifestMap: Map<string, string> | null,
): ReleaseAsset | undefined {
  const found = assets.find((a) => match(a.name))
  if (!found) return undefined
  // 优先 asset.digest；缺失或非法时查 manifest fallback
  const sha256 = extractSha256(found.digest) ?? manifestMap?.get(found.name)
  return {
    name: found.name,
    downloadUrl: found.browser_download_url,
    size: found.size,
    sha256,
  }
}

/**
 * 从 GitHub asset.digest（格式 'sha256:<hex>'）提取纯 64 位 hex。
 * 非法格式（如 'sha512:...'、垃圾数据、长度不符）一律返回 undefined，
 * 避免下游把非 sha256 值当 sha256 用导致误判。
 */
function extractSha256(digest?: string): string | undefined {
  if (!digest) return undefined
  const prefix = 'sha256:'
  if (digest.startsWith(prefix)) {
    const hex = digest.slice(prefix.length)
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : undefined
  }
  // 不带前缀：必须本身是 64 位 hex 才算合法 sha256
  return /^[0-9a-f]{64}$/i.test(digest) ? digest : undefined
}
