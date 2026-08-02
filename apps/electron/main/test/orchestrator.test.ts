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
    // win spawn 延迟 1.5s（给 handler 的 app.quit 留时间避免文件锁冲突），用 fake timers 推进
    vi.useFakeTimers()
    try {
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
      // 推进 1.5s 延迟：触发 spawn NSIS installer（detached）
      await vi.advanceTimersByTimeAsync(1500)
      expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
      const [exe, args, opts] = childProcessMocks.spawn.mock.calls[0]
      expect(exe).toBe('C:/tmp/setup.exe')
      expect(args).toEqual(['/S', '--updated', '/D=C:/app'])
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    } finally {
      vi.useRealTimers()
    }
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

  // ── W3TC10：downloadUpdate 拆分函数 ────────────────────────────
  // downloadUpdate = pickAsset + 写 replacing 标记 + downloadAsset 下载校验。
  // 与 performUpdate 的下载阶段共享 downloading 锁，独立 onProgress（仅下载百分比）。
  it('W3TC10: downloadUpdate → downloadAsset mock 返回 {filePath}，透传给调用方', async () => {
    setPlatform('darwin')
    downloadMocks.downloadAsset.mockResolvedValue({ filePath: '/tmp/x.zip' })

    const { downloadUpdate } = await loadModule()
    const result = await downloadUpdate(MAC_RELEASE)

    // 返回 downloadAsset 桩的 filePath（不触发替换阶段）
    expect(result).toEqual({ filePath: '/tmp/x.zip' })
    // downloadAsset 被调一次，传入了 darwin 平台的 mac asset
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
    const downloadArg = downloadMocks.downloadAsset.mock.calls[0][0]
    expect(downloadArg.name).toBe('mac.zip')
    // downloadUpdate 不再写 replacing 标记（T2：迁移到 installUpdate）。
    // 预下载只下载不替换，写 replacing 会导致 self-healer 误判需要回滚。
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'update-result.json'))).toBe(false)
  })

  it('W3TC10b: downloadUpdate onProgress 透传给 downloadAsset（仅下载百分比）', async () => {
    setPlatform('darwin')
    downloadMocks.downloadAsset.mockImplementation(async (_asset, onProgress) => {
      onProgress?.(25)
      onProgress?.(75)
      return { filePath: '/tmp/x.zip' }
    })

    const { downloadUpdate } = await loadModule()
    const onProgress = vi.fn()
    await downloadUpdate(MAC_RELEASE, onProgress)

    // downloadAsset 收到的 onProgress 就是调用方传的（百分比透传）
    const receivedCb = downloadMocks.downloadAsset.mock.calls[0][1]
    expect(receivedCb).toBe(onProgress)
    // 推送的百分比经透传到达调用方回调
    expect(onProgress).toHaveBeenCalledWith(25)
    expect(onProgress).toHaveBeenCalledWith(75)
  })

  it('W3TC10c: downloadUpdate 重入 → 抛 UpdateError（downloading 锁互斥）', async () => {
    setPlatform('darwin')
    // 用 gate 让第一次 downloadUpdate 挂起（downloading 锁持有中），触发第二次重入
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    downloadMocks.downloadAsset.mockImplementation(async () => {
      await gate // 阻塞直到 releaseGate
      return { filePath: '/tmp/x.zip' }
    })

    const { downloadUpdate } = await loadModule()
    const first = downloadUpdate(MAC_RELEASE)
    // 让事件循环跑一轮确保 first 进入 downloadAsset（拿到锁）
    await Promise.resolve()
    // 第二次重入：downloading 锁持有中 → 抛 UpdateError
    await expect(downloadUpdate(MAC_RELEASE)).rejects.toThrow(/download already in progress/)
    // 释放第一次，让其正常结束（finally 释放锁），避免污染后续用例
    releaseGate()
    await first
  })

  // ── W3TC11：installUpdate 拆分函数 ─────────────────────────────
  // installUpdate = createPlatformUpdater.prepareUpdate + handleScriptRef。
  // 与 performUpdate 的替换阶段共享 updating 锁。
  it('W3TC11: installUpdate detached-script → 返回 {triggerRestart:true} + prepareUpdate 被调', async () => {
    setPlatform('darwin')
    const detachedRef: UpdateScriptRef = { kind: 'detached-script', scriptPath: '/tmp/updater.sh' }
    // 显式参数签名：prepareUpdate(filePath, release)，让 mock.calls 元组有元素可解构
    const prepareUpdate = vi.fn((_filePath: string, _release: LatestReleaseInfo): UpdateScriptRef => detachedRef)
    platformMocks.createPlatformUpdater.mockReturnValue({ prepareUpdate })

    const { installUpdate } = await loadModule()
    const onProgress = vi.fn()
    const result = await installUpdate(MAC_RELEASE, '/tmp/x.zip', onProgress)

    expect(result).toEqual({ triggerRestart: true })
    // createPlatformUpdater 被调
    expect(platformMocks.createPlatformUpdater).toHaveBeenCalledTimes(1)
    // prepareUpdate 收到 downloadUpdate 的 filePath + release
    expect(prepareUpdate).toHaveBeenCalledTimes(1)
    expect(prepareUpdate).toHaveBeenCalledWith('/tmp/x.zip', MAC_RELEASE)
    // onProgress 推 replacing 阶段（0 起、100 完）
    expect(onProgress).toHaveBeenCalledWith('replacing', 0)
    expect(onProgress).toHaveBeenCalledWith('replacing', 100)
    // T2：replacing 标记由 installUpdate 写入（self-healer 检测中断的关键信号）
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'update-result.json'))).toBe(true)
  })

  it('W3TC11b: installUpdate detached-script 在 prepareUpdate 内 spawn（断言 spawn 被调）', async () => {
    setPlatform('darwin')
    // 真实 detached-script 流程：prepareUpdate 内 spawn detached bash（与 mac updater 行为一致）
    // 这里用 mock 的 prepareUpdate 显式调 spawn 模拟 mac updater 的 spawn 行为
    const detachedRef: UpdateScriptRef = { kind: 'detached-script', scriptPath: '/tmp/updater.sh' }
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn((_file, _release) => {
        // 模拟 mac updater.prepareUpdate 内 spawn detached bash 写替换脚本 + 触发执行
        childProcessMocks.spawn('/tmp/updater.sh', ['arg1'], { detached: true, stdio: 'ignore' })
        return detachedRef
      }),
    })

    const { installUpdate } = await loadModule()
    const result = await installUpdate(MAC_RELEASE, '/tmp/x.zip')

    expect(result).toEqual({ triggerRestart: true })
    // prepareUpdate 内 spawn 了 detached bash（orchestrator 透传给 handleScriptRef 不再 spawn）
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
    const [exe, args, opts] = childProcessMocks.spawn.mock.calls[0]
    expect(exe).toBe('/tmp/updater.sh')
    expect(args).toEqual(['arg1'])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
  })
})
