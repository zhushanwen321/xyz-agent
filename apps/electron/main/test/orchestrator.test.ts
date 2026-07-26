/**
 * W3 TDD 测试：orchestrator（升级流程编排器）。
 *
 * 覆盖场景 W3TC8-9：
 *   W3TC8 mac 完整流程：downloadAsset mock → prepareUpdate mock 返回 detached-script
 *         → triggerRestart=true + onProgress 推 downloading/verifying/replacing
 *   W3TC9 linux deb：prepareUpdate mock 抛 UpdateUnsupportedError → orchestrator 透传
 *
 * Mock 策略：vi.hoisted + vi.mock download-asset / platform-updater / electron。
 *   - downloadAsset 返回固定 filePath，不真下载
 *   - createPlatformUpdater 返回桩 PlatformUpdater，控制 prepareUpdate 返回值/抛错
 *   - electron app 仅占位（orchestrator 本身不直接用 app）
 *   - process.platform 经 Object.defineProperty 桩为 darwin/linux
 *
 * 运行：cd apps/electron/main && npx vitest run test/orchestrator.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LatestReleaseInfo } from '@xyz-agent/shared'
import type { UpdateScriptRef } from '../update/types.js'

// ── 必须在 import constants（间接被 orchestrator import）前设 ──────
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-orch-'))
process.env.XYZ_AGENT_DATA_DIR = TMP_DATA_DIR

// ── vi.hoisted：稳定的 mock 引用 ──────────────────────────────────
const downloadMocks = vi.hoisted(() => ({
  downloadAsset: vi.fn(),
}))
const platformMocks = vi.hoisted(() => ({
  createPlatformUpdater: vi.fn(),
}))
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('../update/download-asset.js', () => ({
  downloadAsset: downloadMocks.downloadAsset,
}))
vi.mock('../update/platform-updater.js', () => ({
  createPlatformUpdater: platformMocks.createPlatformUpdater,
}))
vi.mock('node:child_process', () => ({
  spawn: childProcessMocks.spawn,
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.8.14' },
}))

// 动态 import：env + mock 已就绪
async function loadModule() {
  return await import('../update/orchestrator.js')
}

/** LatestReleaseInfo fixture（mac + deb 都覆盖） */
const MAC_RELEASE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '',
  publishedAt: '',
  htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
  assets: {
    macArm64Zip: { name: 'mac.zip', downloadUrl: 'https://x/mac.zip', size: 1000, sha256: 'a'.repeat(64) },
    linuxX64AppImage: { name: 'app.AppImage', downloadUrl: 'https://x/app', size: 3000 },
  },
}

describe('W3: orchestrator (W3TC8-9)', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    vi.clearAllMocks()
    // spawn 桩：返回带 unref 的假 ChildProcess（win installer 路径会真 spawn）
    childProcessMocks.spawn.mockReturnValue({ unref: vi.fn() })
    await loadModule()
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  // ── W3TC8：mac 完整流程 ────────────────────────────────────────
  it('W3TC8: mac detached-script 流程 → triggerRestart=true + onProgress 全 stage 推送', async () => {
    setPlatform('darwin')
    // downloadAsset 桩：返回固定 filePath
    downloadMocks.downloadAsset.mockImplementation(async (_asset, onProgress) => {
      onProgress?.(50)
      onProgress?.(100)
      return { filePath: '/tmp/downloaded.zip' }
    })
    // platform-updater 桩：返回 detached-script
    const detachedRef: UpdateScriptRef = { kind: 'detached-script', scriptPath: '/tmp/updater.sh' }
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn(() => detachedRef),
    })

    const { performUpdate } = await loadModule()
    const onProgress = vi.fn()
    const result = await performUpdate(MAC_RELEASE, { onProgress })

    // detached-script → triggerRestart=true（mac/linux 已在 prepareUpdate 内 spawn）
    expect(result).toEqual({ triggerRestart: true })
    // downloadAsset 被调，传入了 mac asset
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
    const downloadArg = downloadMocks.downloadAsset.mock.calls[0][0]
    expect(downloadArg.name).toBe('mac.zip')
    // onProgress 全 stage 推送：downloading（含 downloadAsset 推的 50/100）+ verifying + replacing
    const stages = onProgress.mock.calls.map((c) => c[0])
    expect(stages).toContain('downloading')
    expect(stages).toContain('verifying')
    expect(stages).toContain('replacing')
    // verifying 推 100
    expect(onProgress).toHaveBeenCalledWith('verifying', 100)
    // update-result.json status='replacing' 已写
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'update-result.json'))).toBe(true)
  })

  // ── W3TC8b：win spawn-installer 流程 ───────────────────────────
  it('W3TC8b: win spawn-installer 流程 → orchestrator spawn installer + triggerRestart=true', async () => {
    setPlatform('win32')
    // 改 WIN_RELEASE：需要 win asset
    const winRelease: LatestReleaseInfo = {
      ...MAC_RELEASE,
      assets: {
        winX64Exe: { name: 'setup.exe', downloadUrl: 'https://x/setup.exe', size: 2000 },
      },
    }
    downloadMocks.downloadAsset.mockResolvedValue({ filePath: 'C:/tmp/setup.exe' })
    const installerRef: UpdateScriptRef = {
      kind: 'spawn-installer',
      installerPath: 'C:/tmp/setup.exe',
      args: ['/S', '--updated', '/D=C:/app'],
    }
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn(() => installerRef),
    })

    const { performUpdate } = await loadModule()
    const result = await performUpdate(winRelease, { onProgress: vi.fn() })

    expect(result).toEqual({ triggerRestart: true })
    // downloadAsset 传入了 win asset
    const downloadArg = downloadMocks.downloadAsset.mock.calls[0][0]
    expect(downloadArg.name).toBe('setup.exe')
    // orchestrator spawn 了 NSIS installer（detached）
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
    const [exe, args, opts] = childProcessMocks.spawn.mock.calls[0]
    expect(exe).toBe('C:/tmp/setup.exe')
    expect(args).toEqual(['/S', '--updated', '/D=C:/app'])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
  })

  // ── W3TC9：linux deb 抛 UpdateUnsupportedError ─────────────────
  it('W3TC9: prepareUpdate 抛 UpdateUnsupportedError → orchestrator 透传（含 fallbackUrl）', async () => {
    setPlatform('linux')
    downloadMocks.downloadAsset.mockResolvedValue({ filePath: '/tmp/app.AppImage' })
    // platform-updater 桩：prepareUpdate 抛 UpdateUnsupportedError（模拟 deb 包 APPIMAGE 缺失）
    const { UpdateUnsupportedError } = await import('../update/types.js')
    const unsupportedErr = new UpdateUnsupportedError(
      'deb package does not support self-update',
      'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
    )
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn(() => { throw unsupportedErr }),
    })

    const { performUpdate } = await loadModule()
    await expect(
      performUpdate(MAC_RELEASE, { onProgress: vi.fn() }),
    ).rejects.toThrow(/deb package does not support self-update/)

    // 错误对象携带 fallbackUrl
    await expect(
      performUpdate(MAC_RELEASE, { onProgress: vi.fn() }).catch((e) => { throw e }),
    ).rejects.toMatchObject({ fallbackUrl: MAC_RELEASE.htmlUrl })
  })

  // ── W3TC9b：无 platform asset → 抛 UpdateError ─────────────────
  it('W3TC9b: 当前平台无 asset（如 unknown 平台）→ 抛 UpdateError', async () => {
    setPlatform('freebsd')
    const { performUpdate } = await loadModule()
    await expect(
      performUpdate(MAC_RELEASE, { onProgress: vi.fn() }),
    ).rejects.toThrow(/no asset for platform freebsd/)
    // downloadAsset 不应被调
    expect(downloadMocks.downloadAsset).not.toHaveBeenCalled()
  })
})
