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
 *   5. 按平台分流 asset（固定名匹配）
 *   6. sha256 从 asset.digest strip 'sha256:' 前缀
 *
 * [HISTORICAL] 不变量：
 * - 失败一律 catch 返回 null，不缓存失败（下次仍会重新尝试）
 * - sha256 来源是 GitHub asset.digest（服务端算好），不读 manifest.json
 * - digest 缺失时 sha256 留 undefined（由调用方决定降级策略）
 *
 * 依赖方向：release-checker → @xyz-agent/shared + compare-versions + 全局 fetch
 */
import { compare } from 'compare-versions'
import type { LatestReleaseInfo, ReleaseAsset } from '@xyz-agent/shared'
import type { IReleaseChecker } from './interfaces.js'

/** GitHub /releases/latest API 端点 */
const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/zhushanwen321/xyz-agent/releases/latest'

/** 请求头：Accept（指定 GitHub JSON 媒体类型）+ X-GitHub-Api-Version */
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const

/** fetch 超时（AbortController） */
const FETCH_TIMEOUT_MS = 10_000

/** 缓存有效期（1h） */
const CACHE_TTL_MS = 60 * 60 * 1000

/** 纯 3 位版本号校验（strip 前导 v 后）——拒绝 rc/beta 等后缀 */
const STRICT_VERSION_RE = /^\d+\.\d+\.\d+$/

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

// ── 固定 asset 文件名（与 CI 产物命名对齐）─────────────────────────

const ASSET_NAME = {
  macArm64Zip: 'xyz-agent-mac-arm64.zip',
  winX64Exe: 'xyz-agent-setup-x64.exe',
  linuxX64AppImage: 'xyz-agent-x86_64.AppImage',
  linuxX64Deb: 'xyz-agent-amd64.deb',
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
    const info = this.buildLatestReleaseInfo(release, strippedVersion, tagName)
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
   */
  private async fetchGitHubLatestRelease(): Promise<GitHubRelease | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
        headers: GITHUB_HEADERS,
        signal: controller.signal,
      })
      if (!response.ok) return null
      const data = (await response.json()) as GitHubRelease
      return data
    } catch {
      // 网络/超时/解析错误等，一律降级为 null
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 把 GitHubRelease 转成 LatestReleaseInfo（按平台分流 asset）。
   *
   * @returns 解析后的 info；release 字段缺失严重时返回 null
   */
  private buildLatestReleaseInfo(
    release: GitHubRelease,
    version: string,
    tagName: string,
  ): LatestReleaseInfo | null {
    const assets = release.assets ?? []
    const macArm64Zip = pickAsset(assets, ASSET_NAME.macArm64Zip)
    const winX64Exe = pickAsset(assets, ASSET_NAME.winX64Exe)
    const linuxX64AppImage = pickAsset(assets, ASSET_NAME.linuxX64AppImage)
    const linuxX64Deb = pickAsset(assets, ASSET_NAME.linuxX64Deb)

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
}

/**
 * 按文件名从 asset 列表中挑选单个资产，转成 ReleaseAsset（含 sha256 提取）。
 * 找不到返回 undefined。
 */
function pickAsset(assets: GitHubAsset[], name: string): ReleaseAsset | undefined {
  const found = assets.find((a) => a.name === name)
  if (!found) return undefined
  return {
    name: found.name,
    downloadUrl: found.browser_download_url,
    size: found.size,
    sha256: extractSha256(found.digest),
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
