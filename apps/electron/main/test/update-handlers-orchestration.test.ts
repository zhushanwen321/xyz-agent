/**
 * update-handlers 编排逻辑测试（S#7 / S#8 / S#9 / S#11）。
 *
 * 覆盖 update-handlers.ts 中此前无回归防护的 4 块逻辑：
 *   S#7  preloadUpdateSilently + update:check 编排（写 pending 标志 + 条件触发后台预下载）：
 *        - preDownload=true → downloadUpdate 被异步触发 + pending 标志已写
 *        - preDownload=false → downloadUpdate 不被触发
 *        - preDownloading=true → 不重复下载（互斥）
 *   S#8  update:perform 快路径（readPreloadedUpdate 命中 → 跳过 performUpdate 直接 installUpdate）：
 *        - readPreloadedUpdate 返回有效路径 → installUpdate 被调、performUpdate 不被调
 *        - readPreloadedUpdate 返回 null → 降级走 performUpdate
 *   S#9  update:getPending / update:getSettings / update:setSettings：
 *        - getSettings 返回默认值、setSettings 写入后 getSettings 读回
 *        - setSettings 传非 boolean preDownload 抛 'Invalid settings'
 *        - getPending 透传 readPendingUpdate
 *   S#11 handler 全部经 deps.updateOrchestrator.* 调用（DI 契约含 downloadUpdate/installUpdate），
 *        测试用 mock DI 接口替换快路径/预下载能力——本文件即验证此可测性。
 *
 * Mock 策略：
 *   - electron：ipcMain.handle 捕获 handler；app.getVersion/quit 占位
 *   - update-settings / pending-update / preloaded-update：vi.mock 全量桩（消除 constants.ts
 *     顶层 path 预绑定对 XYZ_AGENT_DATA_DIR 时序的依赖；本文件不读真实 fs，纯 mock 交互断言）
 *   - proxy-config：保留真实模块（testProxy/getProxyConfig 不在本批用例；setProxyConfig 校验
 *     用例属旧文件）。本文件不触发代理 IPC，故不 mock，避免影响类型解析。
 *   - DI orchestrator：每个用例注入完整的 mock IUpdateOrchestrator（performUpdate/downloadUpdate/installUpdate）
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-handlers-orchestration.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LatestReleaseInfo, UpdateSettings } from '@xyz-agent/shared'

// ── 捕获注册的 handler（key=channel, value=handler fn）──────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>()

// ── electron mock：ipcMain.handle 捕获 + app 占位 ──────────────────
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  app: {
    getVersion: vi.fn(() => '0.8.14'),
    quit: vi.fn(),
  },
}))

// ── FS 依赖模块全量 mock（消除 constants 顶层 path 预绑定）──────────
const settingsMocks = vi.hoisted(() => ({
  getUpdateSettings: vi.fn<() => UpdateSettings>(),
  setUpdateSettings: vi.fn<(settings: UpdateSettings) => void>(),
}))
vi.mock('../update/update-settings.js', () => ({
  getUpdateSettings: settingsMocks.getUpdateSettings,
  setUpdateSettings: settingsMocks.setUpdateSettings,
  DEFAULT_UPDATE_SETTINGS: { preDownload: false } satisfies UpdateSettings,
}))

const pendingMocks = vi.hoisted(() => ({
  writePendingUpdate: vi.fn<(release: LatestReleaseInfo) => void>(),
  readPendingUpdate: vi.fn<(currentVersion: string) => LatestReleaseInfo | null>(),
}))
vi.mock('../update/pending-update.js', () => ({
  writePendingUpdate: pendingMocks.writePendingUpdate,
  readPendingUpdate: pendingMocks.readPendingUpdate,
  clearPendingUpdate: vi.fn(),
}))

const preloadedMocks = vi.hoisted(() => ({
  writePreloadedUpdate: vi.fn<(release: LatestReleaseInfo, filePath: string) => void>(),
  readPreloadedUpdate: vi.fn<(release: LatestReleaseInfo) => Promise<string | null>>(),
  clearPreloadedUpdate: vi.fn<() => void>(),
}))
vi.mock('../update/preloaded-update.js', () => ({
  writePreloadedUpdate: preloadedMocks.writePreloadedUpdate,
  readPreloadedUpdate: preloadedMocks.readPreloadedUpdate,
  clearPreloadedUpdate: preloadedMocks.clearPreloadedUpdate,
}))

// 桩 main window + webContents.send（验证 update:progress / update:error 事件推送）
const sendSpy = vi.fn()
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: sendSpy },
}

import { registerUpdateHandlers } from '../gateway/update-handlers.js'
import type { IReleaseChecker } from '../interfaces.js'

/**
 * LatestReleaseInfo fixture：必须通过 validateRelease 校验（update:perform 在执行前校验）。
 * - version 严格 3 段数字
 * - downloadUrl 为 GitHub 域 https
 * - sha256 64 位 hex
 */
const FIXTURE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## changes',
  publishedAt: '2025-12-01T00:00:00Z',
  htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
  assets: {
    macArm64Zip: {
      name: 'xyz-agent-mac-arm64.zip',
      downloadUrl:
        'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-mac-arm64.zip',
      size: 1000,
      sha256: 'a'.repeat(64),
    },
  },
}

import type { Mock } from 'vitest'

/** mock IUpdateOrchestrator（保留 .mock 断言能力；每方法为 Mock 而非具体函数） */
interface MockOrchestrator {
  performUpdate: Mock<
    (release: LatestReleaseInfo, opts: { onProgress: (stage: string, percent: number) => void }) =>
      Promise<{ triggerRestart: boolean }>
  >
  downloadUpdate: Mock<(release: LatestReleaseInfo, onProgress?: (percent: number) => void) =>
    Promise<{ filePath: string }>>
  installUpdate: Mock<
    (
      release: LatestReleaseInfo,
      filePath: string,
      onProgress?: (stage: string, percent: number) => void,
    ) => Promise<{ triggerRestart: boolean }>
  >
}

/**
 * 构造完整 mock IUpdateOrchestrator（performUpdate/downloadUpdate/installUpdate 全桩）。
 * overrides 逐字段替换，保留其余字段的默认 mock（.mock 断言仍可用）。
 */
function mockOrchestrator(overrides: Partial<MockOrchestrator> = {}): MockOrchestrator {
  return {
    performUpdate: vi.fn(async () => ({ triggerRestart: false })),
    downloadUpdate: vi.fn(async () => ({ filePath: '/tmp/preloaded.zip' })),
    installUpdate: vi.fn(async () => ({ triggerRestart: false })),
    ...overrides,
  }
}

/** 捕获 setTimeout（update:perform triggerRestart 后用 setTimeout 调 app.quit） */
let capturedQuitTimer: { delay: number } | null = null

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  sendSpy.mockClear()
  mockMainWindow.isDestroyed.mockReturnValue(false)
  capturedQuitTimer = null
  // 拦截 setTimeout 仅捕获 quit 定时器（delay），其余放行避免影响 vi 内部定时器
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
    // update:perform 成功路径用 setTimeout(cb, 500) 安排 quit；捕获此定时器
    capturedQuitTimer = { delay: delay ?? 0 }
    // 不实际执行 cb（避免触发 app.quit mock 的副作用），返回占位 handle
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout)
})

// ── S#9：update:getPending / update:getSettings / update:setSettings ──
describe('S#9 update-handlers: settings & pending IPC', () => {
  beforeEach(() => {
    registerUpdateHandlers({} as never)
  })

  it('update:getSettings → 透传 getUpdateSettings() 返回值', async () => {
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })

    const handler = handlers.get('update:getSettings')!
    const result = await handler({}, {})

    expect(settingsMocks.getUpdateSettings).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ preDownload: true })
  })

  it('update:setSettings 合法 boolean → 调 setUpdateSettings 且返回 {success:true}', async () => {
    const handler = handlers.get('update:setSettings')!
    const result = await handler({}, { preDownload: true })

    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
    expect(result).toEqual({ success: true })
  })

  it('update:setSettings → getSettings 读回：写入后 SSOT 模块被调相同对象（write-then-read 编排）', async () => {
    // 仿真「写入后读回」的 IPC 编排：先 getSettings 返回 false，setSettings(true)，
    // 再把 getSettings mock 切到 true 模拟「写入后读回」，验证 getSettings 透传新值
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: false })
    const setHandler = handlers.get('update:setSettings')!
    const getHandler = handlers.get('update:getSettings')!

    // 写入前读 → false
    const before = (await getHandler({}, {})) as UpdateSettings
    expect(before).toMatchObject({ preDownload: false })
    // 写入 true
    await setHandler({}, { preDownload: true })
    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
    // 模拟 SSOT 落盘后读回 true
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const after = (await getHandler({}, {})) as UpdateSettings
    expect(after).toEqual({ preDownload: true })
  })

  it('update:setSettings preDownload 非 boolean → 抛 Invalid settings', async () => {
    const handler = handlers.get('update:setSettings')!
    // preDownload 传字符串（handler 层唯一输入校验分支）
    await expect(handler({}, { preDownload: 'yes' as unknown as boolean })).rejects.toThrow(
      /Invalid settings/,
    )
    // 校验失败不应落盘
    expect(settingsMocks.setUpdateSettings).not.toHaveBeenCalled()
  })

  it('update:getPending → 透传 readPendingUpdate(currentVersion)', async () => {
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    const handler = handlers.get('update:getPending')!

    const result = await handler({}, {})

    // readPendingUpdate 收到 app.getVersion() = '0.8.14'
    expect(pendingMocks.readPendingUpdate).toHaveBeenCalledTimes(1)
    expect(pendingMocks.readPendingUpdate).toHaveBeenCalledWith('0.8.14')
    expect(result).toEqual(FIXTURE)
  })

  it('update:getPending readPendingUpdate 返回 null → handler 返回 null（无新版/已升级）', async () => {
    pendingMocks.readPendingUpdate.mockReturnValue(null)
    const handler = handlers.get('update:getPending')!

    const result = await handler({}, {})
    expect(result).toBeNull()
  })
})

// ── S#7：preloadUpdateSilently + update:check 编排 ──────────────────
describe('S#7 update-handlers: preload orchestration in update:check', () => {
  /**
   * 注册 handler：注入 mockChecker（返回 FIXTURE）+ orchestrator。
   * preDownload 默认 false，由调用方经 settingsMocks 控制开关。
   */
  function register(orch: MockOrchestrator): void {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    const mockChecker: IReleaseChecker = { checkForLatestRelease }
    registerUpdateHandlers({
      releaseChecker: mockChecker,
      updateOrchestrator: orch,
      getMainWindow: () => mockMainWindow as never,
    } as never)
  }

  it('preDownload=true → check 后：pending 标志已写 + downloadUpdate 异步触发 + 写 preloaded 元信息', async () => {
    const orch = mockOrchestrator()
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    register(orch)

    const handler = handlers.get('update:check')!
    const result = await handler({}, { force: true })

    // 返回 fixture
    expect(result).toEqual(FIXTURE)
    // 功能 1：pending 标志已写
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledTimes(1)
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledWith(FIXTURE)

    // 预下载开关开 → 后台 downloadUpdate 异步触发（不阻塞 check 响应）。
    // 预下载是 fire-and-forget promise，需 await 一轮微任务让 preloadUpdateSilently 跑完。
    await vi.waitFor(() => {
      expect(orch.downloadUpdate).toHaveBeenCalledTimes(1)
    })
    expect(orch.downloadUpdate).toHaveBeenCalledWith(FIXTURE)
    // 下载成功 → 写 preloaded-update.json（供 update:perform 快路径命中）
    expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalledTimes(1)
    const [releaseArg, filePathArg] = preloadedMocks.writePreloadedUpdate.mock.calls[0]
    expect(releaseArg).toBe(FIXTURE)
    expect(filePathArg).toBe('/tmp/preloaded.zip')
    // 快路径不调 installUpdate（预下载只下载不替换）
    expect(orch.installUpdate).not.toHaveBeenCalled()
    expect(orch.performUpdate).not.toHaveBeenCalled()
  })

  it('preDownload=false → check 后写 pending 标志，但 downloadUpdate 不被触发', async () => {
    const orch = mockOrchestrator()
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: false })
    register(orch)

    const handler = handlers.get('update:check')!
    await handler({}, {})

    // 功能 1 的 pending 标志照写（与预下载开关无关）
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledTimes(1)
    // 预下载开关关 → 不触发后台下载
    expect(orch.downloadUpdate).not.toHaveBeenCalled()
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
  })

  it('updateOrchestrator 未注入（dev/check-only）→ 跳过预下载，不抛错', async () => {
    // S#11：preDownload 编排引用 deps.updateOrchestrator，未注入时安全跳过（perform 会另行报错）
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    registerUpdateHandlers({
      releaseChecker: { checkForLatestRelease } as never,
    } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})

    expect(result).toEqual(FIXTURE)
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledTimes(1)
    // 无 orchestrator → 不触发预下载（不抛 TypeError）
    await Promise.resolve() // 让微任务跑一轮
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
  })

  it('preDownloading=true（已在预下载）→ 不重复触发 downloadUpdate（互斥）', async () => {
    // 用 gate 让首次 downloadUpdate 挂起（preDownloading 标志持续为 true）
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        await gate // 阻塞直到 releaseGate
        return { filePath: '/tmp/preloaded.zip' }
      }),
    })
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    register(orch)

    const handler = handlers.get('update:check')!

    // 第一次 check：触发预下载，downloadUpdate 挂起在 gate 上（preDownloading=true）
    await handler({}, {})
    await vi.waitFor(() => expect(orch.downloadUpdate).toHaveBeenCalledTimes(1))

    // 第二次 check：preDownloading 仍为 true（首次未完成）→ 不重复触发 downloadUpdate
    await handler({}, {})
    // 仍是 1 次（互斥生效）
    expect(orch.downloadUpdate).toHaveBeenCalledTimes(1)

    // 释放首次预下载，让其正常结束（finally 重置 preDownloading），避免污染后续用例
    releaseGate()
    await vi.waitFor(() => expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalled())
  })

  it('preDownload=true 但 downloadUpdate 抛错 → 静默 warn，不 reject check 响应', async () => {
    // 预下载失败应静默放弃（功能 2 决策），不抛给 check 调用方
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    register(orch)

    const handler = handlers.get('update:check')!
    // check 响应正常返回 fixture（预下载失败不影响 check 结果）
    const result = await handler({}, {})
    expect(result).toEqual(FIXTURE)

    // 预下载失败 → warn + 不写 preloaded 元信息
    await vi.waitFor(() => expect(orch.downloadUpdate).toHaveBeenCalledTimes(1))
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ── S#8：update:perform 快路径 ─────────────────────────────────────
describe('S#8 update-handlers: update:perform fast path', () => {
  beforeEach(() => {
    // 快路径用例默认 readPreloadedUpdate 返回 null（由具体用例覆盖为命中）
    preloadedMocks.readPreloadedUpdate.mockResolvedValue(null)
  })

  function register(orch: MockOrchestrator): void {
    registerUpdateHandlers({
      updateOrchestrator: orch,
      getMainWindow: () => mockMainWindow as never,
    } as never)
  }

  it('readPreloadedUpdate 命中有效路径 → 走快路径：installUpdate 被调、performUpdate 不被调', async () => {
    // S#11：快路径经 deps.updateOrchestrator.installUpdate 调用（DI 契约）
    preloadedMocks.readPreloadedUpdate.mockResolvedValue('/tmp/preloaded.zip')
    const orch = mockOrchestrator({
      installUpdate: vi.fn(async () => ({ triggerRestart: true })),
    })
    register(orch)

    const handler = handlers.get('update:perform')!
    const result = await handler({}, { release: FIXTURE })

    // 快路径：installUpdate 被调，收到 release + preloadedFile
    expect(orch.installUpdate).toHaveBeenCalledTimes(1)
    const [releaseArg, filePathArg] = orch.installUpdate.mock.calls[0]
    expect(releaseArg).toBe(FIXTURE)
    expect(filePathArg).toBe('/tmp/preloaded.zip')
    // 快路径不调 performUpdate（跳过下载）
    expect(orch.performUpdate).not.toHaveBeenCalled()
    expect(orch.downloadUpdate).not.toHaveBeenCalled()
    // triggerRestart=true → 安排延迟 quit
    expect(result).toEqual({ triggerRestart: true })
    expect(capturedQuitTimer).not.toBeNull()
    expect(capturedQuitTimer!.delay).toBe(500)
  })

  it('readPreloadedUpdate 返回 null → 降级走 performUpdate（完整下载+安装）', async () => {
    preloadedMocks.readPreloadedUpdate.mockResolvedValue(null)
    const orch = mockOrchestrator({
      performUpdate: vi.fn(async () => ({ triggerRestart: false })),
    })
    register(orch)

    const handler = handlers.get('update:perform')!
    const result = await handler({}, { release: FIXTURE })

    // 降级：performUpdate 被调
    expect(orch.performUpdate).toHaveBeenCalledTimes(1)
    expect(orch.performUpdate).toHaveBeenCalledWith(FIXTURE, expect.any(Object))
    // 降级路径不直接调 installUpdate/downloadUpdate（由 performUpdate 内部组合）
    expect(orch.installUpdate).not.toHaveBeenCalled()
    expect(orch.downloadUpdate).not.toHaveBeenCalled()
    expect(result).toEqual({ triggerRestart: false })
  })

  it('快路径 installUpdate 抛错 → clearPreloadedUpdate 被调（避免重试死循环，MUST-FIX#3 回归防护）', async () => {
    preloadedMocks.readPreloadedUpdate.mockResolvedValue('/tmp/preloaded.zip')
    const orch = mockOrchestrator({
      installUpdate: vi.fn(async () => {
        throw new Error('spawn failed')
      }),
    })
    register(orch)

    const handler = handlers.get('update:perform')!
    // installUpdate 抛错 → handler reject
    await expect(handler({}, { release: FIXTURE })).rejects.toThrow(/spawn failed/)

    // 快路径失败 → 清 preloaded 标志（MUST-FIX#3：下次重试强制走完整重下）
    expect(preloadedMocks.clearPreloadedUpdate).toHaveBeenCalledTimes(1)
    // performUpdate 不应被调（快路径已选定）
    expect(orch.performUpdate).not.toHaveBeenCalled()
  })

  it('降级路径 performUpdate 抛错 → 不清 preloaded 标志（仅快路径失败才清）', async () => {
    preloadedMocks.readPreloadedUpdate.mockResolvedValue(null)
    const orch = mockOrchestrator({
      performUpdate: vi.fn(async () => {
        throw new Error('download failed')
      }),
    })
    register(orch)

    const handler = handlers.get('update:perform')!
    await expect(handler({}, { release: FIXTURE })).rejects.toThrow(/download failed/)

    // 降级路径（usedFastPath=false）→ 不清 preloaded 标志
    expect(preloadedMocks.clearPreloadedUpdate).not.toHaveBeenCalled()
  })
})
