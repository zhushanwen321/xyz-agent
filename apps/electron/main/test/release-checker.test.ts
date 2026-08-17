/**
 * W2 TDD 测试：ReleaseChecker（自动升级检测后端）。
 *
 * 覆盖场景 W2TC1-6：
 *   W2TC1 happy path：/releases/latest 返回 v0.9.0 → 返回非 null，version 正确，sha256 提取
 *   W2TC2 三重 prerelease 过滤：prerelease=true / draft=true / tag=v0.9.0-rc1 → null
 *   W2TC3 版本比较：同版本 / 更老版本 → null
 *   W2TC4 asset 平台分流：4 平台产物 + blockmap 干扰，断言各平台 downloadUrl
 *   W2TC5 缓存：连续两次非 force 第二次不 fetch；force 强制刷新
 *   W2TC6 失败降级：fetch 抛错 / 403 / 404 / AbortError → null 不抛
 *
 * Mock 策略：替换 globalThis.fetch，参考 health-checker-http.test.ts 的 mock 模式。
 * 每个 it 用 mockImplementationOnce 或重置 fetch 模拟独立响应。
 *
 * 运行：cd apps/electron/main && npx vitest run test/release-checker.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReleaseChecker } from '../release-checker.js'

/** 构造一个完整的 GitHubRelease JSON（含 4 平台 + blockmap 干扰资产） */
function makeReleaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.9.0',
    prerelease: false,
    draft: false,
    body: '## What changed\n- new feature',
    published_at: '2025-12-01T00:00:00Z',
    html_url: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
    assets: [
      {
        name: 'TaiJi-mac-arm64.zip',
        browser_download_url: 'https://example.com/mac-arm64.zip',
        size: 1000,
        // 合法 64 位 hex（全 a 便于断言）
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        name: 'TaiJi-setup-x64.exe',
        browser_download_url: 'https://example.com/setup-x64.exe',
        size: 2000,
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      {
        name: 'TaiJi-x86_64.AppImage',
        browser_download_url: 'https://example.com/x86_64.AppImage',
        size: 3000,
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      {
        name: 'TaiJi-amd64.deb',
        browser_download_url: 'https://example.com/amd64.deb',
        size: 4000,
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      },
      // 干扰：blockmap 不应被选中（digest 用 sha512 以验证不会被误当 sha256）
      {
        name: 'TaiJi-mac-arm64.zip.blockmap',
        browser_download_url: 'https://example.com/mac-arm64.zip.blockmap',
        size: 10,
        digest: 'sha512:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
    ],
    ...overrides,
  }
}

/** 用给定 JSON 构造一个 200 Response */
function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('W2: ReleaseChecker 自动升级检测', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ── W2TC1：happy path ──────────────────────────────────────────
  it('W2TC1: /releases/latest 返回 v0.9.0（current=0.8.14）→ 返回非 null，version/sha256 正确', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(makeReleaseJson())) as unknown as typeof globalThis.fetch
    globalThis.fetch = fetchSpy

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.9.0')
    expect(result!.tagName).toBe('v0.9.0')
    expect(result!.releaseNotes).toContain('new feature')
    expect(result!.publishedAt).toBe('2025-12-01T00:00:00Z')
    expect(result!.htmlUrl).toContain('v0.9.0')
    // sha256 从 digest strip 'sha256:' 前缀（必须 64 位 hex 才被接受）
    expect(result!.assets.macArm64Zip?.sha256).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    expect(result!.assets.winX64Exe?.sha256).toBe(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
  })

  // ── W2TC2：三重 prerelease 过滤 ───────────────────────────────
  it('W2TC2a: prerelease=true → 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(makeReleaseJson({ prerelease: true })),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC2b: draft=true → 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(makeReleaseJson({ draft: true })),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC2c: tag=v0.9.0-rc1（非严格 3 位）→ 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(makeReleaseJson({ tag_name: 'v0.9.0-rc1' })),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  // ── W2TC3：版本比较 ───────────────────────────────────────────
  it('W2TC3a: latest == current（同为 0.8.14）→ 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(makeReleaseJson({ tag_name: 'v0.8.14' })),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC3b: latest 比 current 更老（0.8.13 < 0.8.14）→ 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' })),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  // ── W2TC4：asset 平台分流 ─────────────────────────────────────
  it('W2TC4: assets 含 4 平台 + blockmap 干扰 → 各平台 downloadUrl 正确，blockmap 不被选', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(makeReleaseJson())) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.assets.macArm64Zip?.downloadUrl).toBe('https://example.com/mac-arm64.zip')
    expect(result!.assets.winX64Exe?.downloadUrl).toBe('https://example.com/setup-x64.exe')
    expect(result!.assets.linuxX64AppImage?.downloadUrl).toBe('https://example.com/x86_64.AppImage')
    expect(result!.assets.linuxX64Deb?.downloadUrl).toBe('https://example.com/amd64.deb')
    // size 透传
    expect(result!.assets.macArm64Zip?.size).toBe(1000)
    // blockmap 不应出现在任何分流字段（不存在该字段）
    const allUrls = [
      result!.assets.macArm64Zip?.downloadUrl,
      result!.assets.winX64Exe?.downloadUrl,
      result!.assets.linuxX64AppImage?.downloadUrl,
      result!.assets.linuxX64Deb?.downloadUrl,
    ]
    expect(allUrls).not.toContain('https://example.com/mac-arm64.zip.blockmap')
  })

  // ── W2TC5：缓存 ───────────────────────────────────────────────
  it('W2TC5a: 连续两次非 force → fetch 第二次不调用（缓存命中）', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(makeReleaseJson())) as unknown as typeof globalThis.fetch
    globalThis.fetch = fetchSpy

    const checker = new ReleaseChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    const r2 = await checker.checkForLatestRelease('0.8.14')

    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r2).toEqual(r1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('W2TC5b: force=true → 绕过缓存重新 fetch', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(makeReleaseJson())) as unknown as typeof globalThis.fetch
    globalThis.fetch = fetchSpy

    const checker = new ReleaseChecker()
    await checker.checkForLatestRelease('0.8.14')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await checker.checkForLatestRelease('0.8.14', { force: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // ── W2TC6：失败降级 ───────────────────────────────────────────
  it('W2TC6a: fetch 抛错 → 返回 null 不抛', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error')
    }) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6b: 返回 403 → 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 403 }),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6c: 返回 404 → 返回 null', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not found', { status: 404 }),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6d: AbortError（超时）→ 返回 null 不抛', async () => {
    globalThis.fetch = vi.fn(async () => {
      // 模拟 AbortController.abort() 触发的 DOMException
      const err = new DOMException('The operation was aborted', 'AbortError')
      throw err
    }) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6e: 失败不缓存（下次仍重新 fetch）', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn(async () => {
      callCount++
      if (callCount === 1) return new Response('error', { status: 500 })
      return jsonResponse(makeReleaseJson())
    }) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).toBeNull()

    const r2 = await checker.checkForLatestRelease('0.8.14')
    expect(r2).not.toBeNull()
    expect(callCount).toBe(2) // 失败未被缓存，第二次仍发起 fetch
  })

  // ── W2TC7：extractSha256 严格校验（防御 sha512 / 非法格式污染）────────
  it('W2TC7: 非 sha256 格式的 digest（sha512 / 短 hex / 垃圾）→ sha256 字段为 undefined', async () => {
    const sha512Hex = 'e'.repeat(128) // sha512 是 128 位 hex
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        makeReleaseJson({
          assets: [
            {
              name: 'TaiJi-mac-arm64.zip',
              browser_download_url: 'https://example.com/mac.zip',
              size: 1000,
              // sha512 前缀 → 必须拒绝，不能原样返回
              digest: `sha512:${sha512Hex}`,
            },
            {
              name: 'TaiJi-setup-x64.exe',
              browser_download_url: 'https://example.com/exe',
              size: 2000,
              // sha256 前缀但 hex 长度不对（6 位）→ 拒绝
              digest: 'sha256:abc123',
            },
            {
              name: 'TaiJi-x86_64.AppImage',
              browser_download_url: 'https://example.com/appimage',
              size: 3000,
              // 无前缀、纯 64 位 hex → 接受
              digest: 'f'.repeat(64),
            },
            {
              name: 'TaiJi-amd64.deb',
              browser_download_url: 'https://example.com/deb',
              size: 4000,
              // 无前缀、垃圾数据 → 拒绝
              digest: 'not-a-hex-string',
            },
          ],
        }),
      ),
    ) as typeof globalThis.fetch

    const checker = new ReleaseChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    // sha512 前缀：禁止原样返回（修复前的 bug 会返回 'sha512:...'）
    expect(result!.assets.macArm64Zip?.sha256).toBeUndefined()
    // sha256 前缀但 hex 长度不对：拒绝
    expect(result!.assets.winX64Exe?.sha256).toBeUndefined()
    // 无前缀、纯 64 位 hex：接受
    expect(result!.assets.linuxX64AppImage?.sha256).toBe('f'.repeat(64))
    // 垃圾数据：拒绝
    expect(result!.assets.linuxX64Deb?.sha256).toBeUndefined()
  })

  // ── W2TC2d：prerelease-test skill 的 beta release 不触发升级提示 ───
  //
  // **API 行为假设**：GitHub `/releases/latest` 端点天然排除 prerelease（GitHub 官方语义）。
  // 三重防御是 defense-in-depth：即使 API 行为变化（如未来某天 /releases/latest 返回 prerelease），
  // 防御层 b（prerelease 字段）+ c（tag 正则）仍会拦截。本测试覆盖 b+c 层对真实 beta/dev/rc 格式的拦截。
  describe('W2TC2d: prerelease-test skill 的 beta release 不触发升级提示', () => {
    it('beta release（v0.8.15-beta + prerelease=true）→ 返回 null', async () => {
      // 真实 beta release 完整模拟：prerelease-test.sh 生成 v0.8.15-beta 格式 tag（含 '-'），
      // release.yml 的 `prerelease: ${{ contains(github.ref, '-') }}` 据此把 tag 标为 prerelease=true。
      // 防御层 b（prerelease 字段）最先拦截；即便 b 失效，层 c 的 STRICT_VERSION_RE 也会拒绝 '0.8.15-beta'。
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-beta', prerelease: true })),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('dev npm prerelease（v0.8.15-dev.0 + prerelease=true）→ 返回 null', async () => {
      // npm-prerelease skill 用 -dev.N 后缀（如 0.8.15-dev.0）。npm prerelease 正常不发 GitHub Release，
      // 但万一某天有人手动 tag 了，防御层 b（prerelease 字段）拦截；层 c 的正则也会拒绝（'dev.0' 非纯数字）。
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-dev.0', prerelease: true })),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('rc 格式（v0.8.15-rc.1，带点号）→ 返回 null', async () => {
      // rc release 常见格式 v0.8.15-rc.1（带点号）。此处 prerelease 未设（默认 false）以独立验证层 c：
      // STRICT_VERSION_RE（/^\d+\.\d+\.\d+}$/）必须拒绝 '0.8.15-rc.1'（含 '-rc.1' 后缀）。
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-rc.1' })),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('alpha 格式（v0.8.15-alpha.2）→ 返回 null', async () => {
      // alpha prerelease 格式 v0.8.15-alpha.2。prerelease 未设（默认 false）以独立验证层 c：
      // STRICT_VERSION_RE 拒绝 '0.8.15-alpha.2'（含 '-alpha.2' 后缀，非纯 3 位数字）。
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-alpha.2' })),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('反向：纯数字 stable（v0.8.15 + prerelease=false）→ 返回非 null（防御不过严）', async () => {
      // 反向用例：确保三重防御不会误伤正常 stable 版本。v0.8.15 strip 'v' 后为 '0.8.15'，
      // 通过 STRICT_VERSION_RE；prerelease=false/draft=false 字段校验通过；0.8.15 > 0.8.14 版本比较通过。
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15', prerelease: false })),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).not.toBeNull()
      expect(result!.version).toBe('0.8.15')
    })
  })

  // ── W2TC8：win 产物名后缀匹配（M7-01 P0 回归防护）────────────────
  //
  // electron-builder.yml nsis artifactName 必须产出 TaiJi-<version>-setup-<arch>.exe
  // （setup 在 version 之后），与 ASSET_PATTERNS.winX64Exe 的 '-setup-x64.exe' 后缀匹配。
  // 曾出现 setup/version 对调（TaiJi-setup-<version>-<arch>.exe）导致 win 自动升级
  // 检测永远匹配不到 asset（实际产物恒带 ${version}，fixture 用不带版本号的形态掩盖了）。
  describe('W2TC8: win asset 后缀匹配（带版本号形态）', () => {
    it('TaiJi-<version>-setup-x64.exe（正确形态）→ winX64Exe 匹配', async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(
          makeReleaseJson({
            assets: [
              {
                name: 'TaiJi-0.8.44-setup-x64.exe',
                browser_download_url: 'https://example.com/TaiJi-0.8.44-setup-x64.exe',
                size: 2000,
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
          }),
        ),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).not.toBeNull()
      expect(result!.assets.winX64Exe?.downloadUrl).toBe(
        'https://example.com/TaiJi-0.8.44-setup-x64.exe',
      )
    })

    it('TaiJi-setup-<version>-x64.exe（setup/version 对调的错误形态）→ winX64Exe 不匹配', async () => {
      // 锁死修复：对调形态必须匹配不到，否则回归时 win 自动升级静默失效
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(
          makeReleaseJson({
            assets: [
              {
                name: 'TaiJi-setup-0.8.44-x64.exe',
                browser_download_url: 'https://example.com/TaiJi-setup-0.8.44-x64.exe',
                size: 2000,
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
          }),
        ),
      ) as typeof globalThis.fetch

      const checker = new ReleaseChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).not.toBeNull()
      expect(result!.assets.winX64Exe).toBeUndefined()
    })
  })
})
