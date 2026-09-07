/**
 * u5-checker 验收测试：release-checker 两处 fetch 点接入 upgradeFetch。
 *
 * 覆盖验收条款（docs/design/update-network-resilience.impl-plan.md §2 u5 行）：
 * ① 两处 fetch 点均经 upgradeFetch（mock 断言调用次数与 proxyUrl 参数）
 * ② 「代理失败→直连重试一次」通道维度编排保留在 checker（第一次带 proxyUrl 失败后
 *    第二次不带；引擎维度降级在 upgradeFetch 内部发生，checker 不感知——D10）
 * ③ manifest fallback 路径同源接入（digest 缺失时 manifest 也经 upgradeFetch，
 *    且拥有同款「代理→直连」编排）
 * ④ 错误语义落位：CurlFetchError（双引擎均失败）归网络错误桶触发直连降级；
 *    403/429 RateLimited 语义错误直通不降级（退避窗口生效）
 *
 * Mock 策略：vi.mock upgrade-fetch 模块（importOriginal 保留真实类型/类导出，
 * 仅替换 upgradeFetch 函数），checker 行为完全由 mock 驱动——不真实联网、不
 * spawn curl。checker 与真实 upgradeFetch 的集成（undici 引擎 + dispatcher
 * 透传）由既有 test/release-checker*.test.ts 经 globalThis.fetch mock 覆盖。
 *
 * 运行：cd apps/electron/main && npx vitest run test/release-checker-upgrade-fetch.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as proxyConfig from '../update/proxy-config.js'

vi.mock('../update/upgrade-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update/upgrade-fetch.js')>()
  // 仅替换 upgradeFetch 入口；CurlFetchError 等类型/类导出保持真实实现
  return { ...actual, upgradeFetch: vi.fn() }
})

import { ReleaseChecker, ReleaseRateLimitedError } from '../release-checker.js'
import { upgradeFetch, CurlFetchError } from '../update/upgrade-fetch.js'
import type { UpgradeFetchResult } from '../update/upgrade-fetch.js'

const upgradeFetchMock = vi.mocked(upgradeFetch)

/** 测试用代理 URL（与既有 release-checker 测试同值） */
const PROXY_URL = 'http://192.168.1.202:7890'

/** manifest 中登记的合法 sha256（64 位 hex，全 a 便于断言） */
const MANIFEST_SHA = 'a'.repeat(64)

// ─── 测试工具 ─────────────────────────────────────────────────────

/** 构造 upgradeFetch 成功返回（GET bodyText 形态）。 */
function okResult(bodyText: string, init: Partial<UpgradeFetchResult> = {}): UpgradeFetchResult {
  return { ok: true, status: 200, headers: {}, bodyText, usedEngine: 'undici', ...init }
}

/** 构造 upgradeFetch HTTP 错误返回（不抛、resolve ok:false——引擎语义）。 */
function httpErrorResult(status: number): UpgradeFetchResult {
  return { ok: false, status, headers: {}, bodyText: '', usedEngine: 'undici' }
}

/** 构造 curl 引擎 exit 22（-f）形态的 CurlFetchError——携带 httpStatusCode = 服务器已响应（D8）。 */
function curlHttpStatusError(status: number): CurlFetchError {
  return new CurlFetchError({
    kind: 'http-error',
    exitCode: 22,
    stderr: `curl: (22) The requested URL returned error: ${status}`,
    httpStatusCode: status,
  })
}

/** 构造完整 GitHubRelease JSON（3 平台 asset 全带合法 digest，不触发 manifest） */
function makeReleaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.9.0',
    prerelease: false,
    draft: false,
    body: '## What changed',
    published_at: '2025-12-01T00:00:00Z',
    html_url: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
    assets: [
      {
        name: 'TaiJi-mac-arm64.dmg',
        browser_download_url: 'https://example.com/mac-arm64.dmg',
        size: 1000,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      {
        name: 'TaiJi-setup-x64.exe',
        browser_download_url: 'https://example.com/setup-x64.exe',
        size: 2000,
        digest: `sha256:${'b'.repeat(64)}`,
      },
      {
        name: 'TaiJi-x86_64.AppImage',
        browser_download_url: 'https://example.com/x86_64.AppImage',
        size: 3000,
        digest: `sha256:${'c'.repeat(64)}`,
      },
    ],
    ...overrides,
  }
}

/** 构造 digest 缺失的 release JSON（触发 manifest fallback） */
function makeDigestMissingReleaseJson(): Record<string, unknown> {
  return makeReleaseJson({
    assets: [
      {
        name: 'TaiJi-mac-arm64.dmg',
        browser_download_url: 'https://example.com/mac-arm64.dmg',
        size: 1000,
        // 无 digest → doFetchManifestSha256 被触发
      },
    ],
  })
}

/** 构造 manifest.json body（CI generate-manifest.sh 产物形态） */
function makeManifestBody(): string {
  return JSON.stringify({
    version: '0.9.0',
    releasedAt: '2025-12-01T00:00:00Z',
    assets: { 'TaiJi-mac-arm64.dmg': { sha256: MANIFEST_SHA, size: 1000 } },
  })
}

/** mock 代理配置为 manual + PROXY_URL（通道维度走代理） */
function mockProxyEnabled(): void {
  vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
    mode: 'manual',
    httpsProxy: PROXY_URL,
  })
  vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(PROXY_URL)
}

/** 第 i 次（0 基）upgradeFetch 调用的 URL 参数 */
function callUrl(i: number): string {
  return upgradeFetchMock.mock.calls[i][0]
}

/** 第 i 次（0 基）upgradeFetch 调用的 opts 参数 */
function callOpts(i: number): Record<string, unknown> {
  return (upgradeFetchMock.mock.calls[i][1] ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  upgradeFetchMock.mockReset()
  // 默认 disabled（与既有测试一致，防真实 proxy-config.json 干扰）
  vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
  vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── 验收①：latest 检测路径经 upgradeFetch ─────────────────────────

describe('u5: latest 检测路径经 upgradeFetch', () => {
  it('直连成功 → upgradeFetch 调用一次，URL/headers/timeoutMs/proxyUrl 参数正确', async () => {
    upgradeFetchMock.mockResolvedValueOnce(okResult(JSON.stringify(makeReleaseJson())))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.9.0')
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
    // URL 是 GitHub /releases/latest API 端点
    expect(callUrl(0)).toBe(
      'https://api.github.com/repos/zhushanwen321/xyz-agent/releases/latest',
    )
    // 参数对齐：GitHub 请求头 + 既有 10s 超时 + 直连（无 proxyUrl）
    expect(callOpts(0).headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xyz-agent-updater',
    })
    expect(callOpts(0).timeoutMs).toBe(10_000)
    expect(callOpts(0).proxyUrl).toBeUndefined()
  })

  it('body 从 result.bodyText 解析（JSON.parse 语义）且成功结果被缓存（二次查询零调用）', async () => {
    upgradeFetchMock.mockResolvedValueOnce(okResult(JSON.stringify(makeReleaseJson())))

    const checker = new ReleaseChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    const r2 = await checker.checkForLatestRelease('0.8.14')

    expect(r1).not.toBeNull()
    expect(r2).toEqual(r1)
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 404 → null，不触发直连降级（服务器已响应语义保持）', async () => {
    mockProxyEnabled()
    upgradeFetchMock.mockResolvedValueOnce(httpErrorResult(404))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── 验收②：通道维度「代理→直连」编排保留（D10） ────────────────────

describe('u5: 代理失败→直连重试一次（编排保留在 checker）', () => {
  it('第一次带 proxyUrl 网络失败 → 第二次不带 proxyUrl 直连重试成功', async () => {
    mockProxyEnabled()
    upgradeFetchMock
      .mockRejectedValueOnce(new Error('fetch failed')) // 第一步：代理 + 网络错误
      .mockResolvedValueOnce(okResult(JSON.stringify(makeReleaseJson()))) // 第二步：直连

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.9.0')
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    // 关键断言：通道维度编排——第一步带 proxyUrl，第二步不带（引擎维度在 upgradeFetch 内部）
    expect(callOpts(0).proxyUrl).toBe(PROXY_URL)
    expect(callOpts(1).proxyUrl).toBeUndefined()
  })

  it('代理 + 直连均网络失败 → 返回 null（两次调用）', async () => {
    mockProxyEnabled()
    upgradeFetchMock.mockRejectedValue(new Error('fetch failed'))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
  })

  it('无代理时网络失败 → 单次调用即返回 null（无第二步直连）', async () => {
    upgradeFetchMock.mockRejectedValue(new Error('fetch failed'))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── 验收④-a：CurlFetchError 错误落位（用导出类型构造，不猜字符串） ──

describe('u5: CurlFetchError 归网络错误桶（触发直连降级，不触发退避）', () => {
  it('upgradeFetch 抛 CurlFetchError（双引擎均失败）→ 视为网络错误降级直连', async () => {
    mockProxyEnabled()
    const curlError = new CurlFetchError({
      kind: 'connection-failed',
      exitCode: 7,
      stderr: 'curl: (7) Failed to connect',
      undiciError: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    upgradeFetchMock
      .mockRejectedValueOnce(curlError) // 第一步：代理 + 引擎双失败
      .mockResolvedValueOnce(okResult(JSON.stringify(makeReleaseJson()))) // 第二步：直连

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    expect(callOpts(0).proxyUrl).toBe(PROXY_URL)
    expect(callOpts(1).proxyUrl).toBeUndefined()
  })

  it('CurlFetchError 不触发限流退避（getRateLimitedUntil 保持 0）', async () => {
    upgradeFetchMock.mockRejectedValueOnce(
      new CurlFetchError({ kind: 'timeout', exitCode: 28, stderr: 'curl: (28) timeout' }),
    )

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
    expect(checker.getRateLimitedUntil()).toBe(0)
  })
})

// ─── 验收④-b：403/429 RateLimited 语义直通不降级 ────────────────────

describe('u5: 403/429 RateLimited 直通不降级（退避窗口生效）', () => {
  it.each([403, 429])('HTTP %i → null、单次调用（不降级直连）且退避窗口内置零联网', async (status) => {
    mockProxyEnabled()
    upgradeFetchMock.mockResolvedValueOnce(httpErrorResult(status))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).toBeNull()
    // 关键断言：RateLimited 是服务器明确响应，直通不触发第二步直连降级
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
    expect(callOpts(0).proxyUrl).toBe(PROXY_URL)
    // 退避窗口（2h）已记录
    expect(checker.getRateLimitedUntil()).toBeGreaterThan(Date.now())
    // 窗口内 force 查询也短路（零联网）
    const inWindow = await checker.checkForLatestRelease('0.8.14', { force: true })
    expect(inWindow).toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── 验收④-c：D8 curl 引擎 HTTP 状态交互规则（两引擎语义等价） ──────

describe('u5 D8: curl 引擎 HTTP 状态交互规则', () => {
  it.each([403, 429])(
    'latest 路径 CurlFetchError httpStatusCode=%i → 重建 ReleaseRateLimitedError：null、单次调用、退避生效',
    async (status) => {
      mockProxyEnabled()
      upgradeFetchMock.mockRejectedValueOnce(curlHttpStatusError(status))

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      // curl 引擎 403/429 与 undici 引擎同语义：限流信号直通（RM2.3 退避两引擎等价）
      expect(result).toBeNull()
      // 关键断言：服务器已响应 → 不触发「代理→直连」通道重试（单次调用）
      expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
      expect(callOpts(0).proxyUrl).toBe(PROXY_URL)
      // 退避窗口生效：checker 内部只有 ReleaseRateLimitedError 的 catch 分支会置
      // rateLimitedUntil——该断言即证明 curl 形态被重建为 ReleaseRateLimitedError
      expect(checker.getRateLimitedUntil()).toBeGreaterThan(Date.now())
      // 窗口内 force 查询也短路（零联网）
      const inWindow = await checker.checkForLatestRelease('0.8.14', { force: true })
      expect(inWindow).toBeNull()
      expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
      // ReleaseRateLimitedError 导出形态回归锚点（重建用的是同一导出类）
      expect(new ReleaseRateLimitedError()).toBeInstanceOf(ReleaseRateLimitedError)
      expect(new ReleaseRateLimitedError().name).toBe('ReleaseRateLimitedError')
    },
  )

  it('latest 路径 CurlFetchError httpStatusCode=404 → null、单次调用（服务器已响应不触发直连重试）、不触发退避', async () => {
    mockProxyEnabled()
    upgradeFetchMock.mockRejectedValueOnce(curlHttpStatusError(404))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    // 404 按 undici 引擎「非 2xx → null」语义收口
    expect(result).toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
    expect(checker.getRateLimitedUntil()).toBe(0)
  })

  it('manifest 路径 CurlFetchError httpStatusCode=404 → null 收口不触发直连重试（单次 manifest 调用）', async () => {
    mockProxyEnabled()
    upgradeFetchMock
      .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson()))) // latest：代理成功
      .mockRejectedValueOnce(curlHttpStatusError(404)) // manifest：curl 引擎 404 上抛

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    // manifest 404 → null（sha256 留 undefined，不阻塞 release 组装）；
    // 关键断言：总计 2 次调用（latest 1 + manifest 1）——服务器已响应不触发直连重试
    expect(result).not.toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    expect(callUrl(1)).toContain('manifest.json')
    expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
    expect(checker.getRateLimitedUntil()).toBe(0)
  })

  it.each([403, 429])(
    'manifest 路径 CurlFetchError httpStatusCode=%i → 重建 RateLimited：不直连重试、记退避、sha256 留 undefined',
    async (status) => {
      mockProxyEnabled()
      upgradeFetchMock
        .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson()))) // latest：代理成功
        .mockRejectedValueOnce(curlHttpStatusError(status)) // manifest：curl 引擎 403/429 上抛

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      // manifest 单次调用（无第二步直连）；退避窗口记录；release 组装不被阻塞
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
      expect(callUrl(1)).toContain('manifest.json')
      expect(checker.getRateLimitedUntil()).toBeGreaterThan(Date.now())
      expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
      expect(result!.assets.macArm64Dmg?.name).toBe('TaiJi-mac-arm64.dmg')
    },
  )
})

// ─── 验收④-d（R2）：直连重试第二步限流识别 + manifest 两引擎对偶 ────

describe('u5 R2: 直连重试第二步不吞 ReleaseRateLimitedError + manifest 两引擎对偶', () => {
  it.each([
    ['undici 形态（ok:false resolve）', (status: number) => Promise.resolve(httpErrorResult(status))],
    ['curl 形态（exit 22 rejection）', (status: number) => Promise.reject(curlHttpStatusError(status))],
  ])(
    'latest 第一步网络失败 + 第二步直连 429（%s）→ 记退避（不被裸 catch 吞）',
    async (_label, secondStep) => {
      mockProxyEnabled()
      upgradeFetchMock
        .mockRejectedValueOnce(new Error('fetch failed')) // 第一步：代理 + 网络错误
        .mockImplementationOnce(() => secondStep(429)) // 第二步：直连 + 限流

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      // 两步都走完：第一步带代理、第二步直连
      expect(result).toBeNull()
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
      expect(callOpts(1).proxyUrl).toBeUndefined()
      // 关键断言：第二步撞 429 记退避（修复前被裸 catch 吞、rateLimitedUntil 保持 0）
      expect(checker.getRateLimitedUntil()).toBeGreaterThan(Date.now())
      // 窗口内 force 查询短路（零联网）
      const inWindow = await checker.checkForLatestRelease('0.8.14', { force: true })
      expect(inWindow).toBeNull()
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    ['undici 形态（ok:false resolve）', (status: number) => Promise.resolve(httpErrorResult(status))],
    ['curl 形态（exit 22 rejection）', (status: number) => Promise.reject(curlHttpStatusError(status))],
  ])(
    'manifest 第一步网络失败 + 第二步直连 429（%s）→ 记退避 + sha256 留 undefined',
    async (_label, secondStep) => {
      mockProxyEnabled()
      upgradeFetchMock
        .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson()))) // latest：代理成功
        .mockRejectedValueOnce(new Error('fetch failed')) // manifest 第一步：代理 + 网络错误
        .mockImplementationOnce(() => secondStep(429)) // manifest 第二步：直连 + 限流

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      // manifest 两步都走完（latest 1 + manifest 2 = 总 3 次），release 组装不被阻塞
      expect(result).not.toBeNull()
      expect(upgradeFetchMock).toHaveBeenCalledTimes(3)
      expect(callUrl(2)).toContain('manifest.json')
      expect(callOpts(2).proxyUrl).toBeUndefined()
      expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
      // 关键断言：第二步撞 429 就地记退避（修复前被裸 catch 吞）
      expect(checker.getRateLimitedUntil()).toBeGreaterThan(Date.now())
    },
  )

  it.each([403, 429])(
    'manifest undici 引擎 HTTP %i（第一步直接 resolve）→ 记退避，与 curl 引擎同形态同退避（两引擎对偶）',
    async (status) => {
      mockProxyEnabled()
      upgradeFetchMock
        .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson()))) // latest：代理成功
        .mockResolvedValueOnce(httpErrorResult(status)) // manifest：undici 403/429

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      // 服务器已响应 → 不触发直连重试（manifest 单次调用）
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
      expect(callUrl(1)).toContain('manifest.json')
      // 与 curl 引擎对偶：同记 2h 退避（修复前 undici 侧 !ok 一律 null 不退避 = 两引擎漂移）
      expect(checker.getRateLimitedUntil()).toBeGreaterThan(Date.now())
      expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
      expect(result!.assets.macArm64Dmg?.name).toBe('TaiJi-mac-arm64.dmg')
    },
  )
})

// ─── 验收③：manifest fallback 路径同源接入 ─────────────────────────

describe('u5: manifest fallback 同源经 upgradeFetch', () => {
  it('digest 缺失 → manifest 也经 upgradeFetch，且 sha256 取自 manifest', async () => {
    mockProxyEnabled()
    upgradeFetchMock
      .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson())))
      .mockResolvedValueOnce(okResult(makeManifestBody()))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    // 第一次：latest API；第二次：manifest.json（同源双引擎 + 同款参数语义）
    expect(callUrl(0)).toContain('api.github.com/repos/zhushanwen321/xyz-agent/releases/latest')
    expect(callUrl(1)).toBe(
      'https://github.com/zhushanwen321/xyz-agent/releases/latest/download/manifest.json',
    )
    expect(callOpts(1).proxyUrl).toBe(PROXY_URL)
    expect(callOpts(1).timeoutMs).toBe(10_000)
    // sha256 fallback 生效：digest 缺失 → manifest 提供
    expect(result!.assets.macArm64Dmg?.sha256).toBe(MANIFEST_SHA)
  })

  it('manifest 代理网络失败 → 直连重试成功（拥有同款通道维度编排）', async () => {
    mockProxyEnabled()
    upgradeFetchMock
      .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson()))) // latest：代理成功
      .mockRejectedValueOnce(new Error('fetch failed')) // manifest 第一步：代理失败
      .mockResolvedValueOnce(okResult(makeManifestBody())) // manifest 第二步：直连成功

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(3)
    // latest 一次（代理）+ manifest 两次（代理失败 → 直连）
    expect(callUrl(0)).toContain('releases/latest')
    expect(callUrl(1)).toContain('manifest.json')
    expect(callOpts(1).proxyUrl).toBe(PROXY_URL)
    expect(callUrl(2)).toContain('manifest.json')
    expect(callOpts(2).proxyUrl).toBeUndefined()
    expect(result!.assets.macArm64Dmg?.sha256).toBe(MANIFEST_SHA)
  })

  it('manifest 双通道均失败 → sha256 留 undefined（不阻塞 release 组装）', async () => {
    upgradeFetchMock
      .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson())))
      .mockRejectedValue(new Error('fetch failed'))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    // 无代理 → manifest 单次直连失败即止
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
    expect(result!.assets.macArm64Dmg?.name).toBe('TaiJi-mac-arm64.dmg')
  })

  it('manifest HTTP 404 → null 不降级（服务器已响应，重试无意义）', async () => {
    upgradeFetchMock
      .mockResolvedValueOnce(okResult(JSON.stringify(makeDigestMissingReleaseJson())))
      .mockResolvedValueOnce(httpErrorResult(404))

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
  })
})
