/**
 * Release 检测器（GitHub /releases/latest）。
 *
 * 对应 slice auto-update-and-install：实现 IReleaseChecker Facade。
 *
 * 职责链：
 *   1. 缓存命中检查（1h，force 可绕过）
 *   2. fetch GitHub /releases/latest（AbortController 10s 超时）
 *   3. 三重 prerelease 防御：
 *      a. API 语义层：/releases/latest 端点天然排除 prerelease（仅最近 stable）
 *      b. release.prerelease / draft 字段校验
 *      c. tag_name strip 前导 v 后正则 /^\d+\.\d+\.\d+$/（拒绝 rc/beta 后缀）
 *   4. compare-versions 比较：latest > current 才继续
 *   5. 按平台分流 asset（后缀 pattern 匹配，兼容带/不带版本号的文件名）
 *   6. sha256 优先取 asset.digest（strip 'sha256:' 前缀）；digest 缺失时 fallback fetch manifest.json
 *
 * [HISTORICAL] 不变量：
 * - 失败一律 catch 返回 null，不缓存失败（下次仍会重新尝试）
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

/** fetch 超时（AbortController） */
const FETCH_TIMEOUT_MS = 10_000

/** 缓存有效期（1h） */
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MS_PER_SECOND = 1000
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

interface CacheEntry {
  info: LatestReleaseInfo
  fetchedAt: number
}

/**
 * Release 检测器实现。
 *
 * 通过 GitHub /releases/latest API 检测最新可用版本，1h 缓存。
 * 单实例由 main.ts 构造并注入到 IpcHandlerDeps.releaseChecker。
 */
export class ReleaseChecker implements IReleaseChecker {
  /** 缓存条目；null 表示无缓存（首次或上次 fetch 失败） */
  private cachedResult: CacheEntry | null = null

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
    // 1. 缓存命中检查（force 可绕过）
    const now = Date.now()
    if (!opts?.force && this.cachedResult) {
      const age = now - this.cachedResult.fetchedAt
      if (age < CACHE_TTL_MS) {
        return this.cachedResult.info
      }
    }

    // 2. fetch + 校验 + 比较 + 分流
    const release = await this.fetchGitHubLatestRelease()
    if (!release) return null

    // 3. 三重 prerelease 防御 b：字段校验
    if (release.prerelease) return null
    if (release.draft) return null

    // 4. strip 前导 v，提取纯版本号
    const tagName = release.tag_name
    const strippedVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName

    // 5. 三重 prerelease 防御 c：严格 3 位版本号校验（拒绝 rc/beta 后缀）
    if (!STRICT_VERSION_RE.test(strippedVersion)) return null

    // 6. 版本比较：latest 必须 > current
    let isNewer: boolean
    try {
      isNewer = compare(strippedVersion, currentVersion, '>') // compare 抛错则视为非新版
    } catch {
      return null
    }
    if (!isNewer) return null

    // 7. 按平台分流 asset，组装 LatestReleaseInfo
    const info = await this.buildLatestReleaseInfo(release, strippedVersion, tagName)
    if (!info) return null

    // 8. 写入缓存（成功才缓存）
    // 注意：fetchedAt 必须在 fetch 完成后重新取 now，否则会比实际获取时间提前最多 10s（fetch timeout）
    this.cachedResult = { info, fetchedAt: Date.now() }
    return info
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
    } catch {
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
      if (!response.ok) return null
      const data = (await response.json()) as GitHubRelease
      return data
    } catch {
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
