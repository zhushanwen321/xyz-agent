/**
 * W2 TDD 测试：update-handlers IPC（W2TC7）。
 *
 * 验证 'update:check' channel：
 *   - 注册时 ipcMain.handle 捕获 handler
 *   - handler 调 app.getVersion() 拿当前版本
 *   - handler 透传 force 到 releaseChecker.checkForLatestRelease
 *   - 返回 releaseChecker 的结果（LatestReleaseInfo fixture）
 *   - releaseChecker 未注入时返回 null
 *
 * Mock 策略：参考 privileged-handlers.test.ts，vi.mock('electron')：
 *   - ipcMain.handle 捕获 handler 到 Map
 *   - app.getVersion 返回 '0.8.14'
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

// 捕获注册的 handler（key=channel, value=handler fn）
const handlers = new Map<string, (...args: unknown[]) => unknown>()

// 捕获 setTimeout（update:perform triggerRestart 后用 setTimeout 调 app.quit）
let capturedQuitTimer: { callback: () => void; delay: number } | null = null

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

// 桩 main window + webContents.send（验证 update:progress / update:error 事件推送）
const sendSpy = vi.fn()
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: sendSpy },
}

import { registerUpdateHandlers } from '../gateway/update-handlers.js'
import type { IReleaseChecker } from '../interfaces.js'
import type { IUpdateOrchestrator } from '../update/orchestrator.js'
import { UpdateError, UpdateUnsupportedError } from '../update/types.js'

/** LatestReleaseInfo 测试 fixture */
const FIXTURE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## changes',
  publishedAt: '2025-12-01T00:00:00Z',
  htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
  assets: {
    macArm64Zip: {
      name: 'xyz-agent-mac-arm64.zip',
      downloadUrl: 'https://example.com/mac.zip',
      size: 1000,
      sha256: 'abc123',
    },
  },
}

describe('W2: update-handlers IPC (W2TC7)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('W2TC7a: 调 handler({}, { force: true }) → checkForLatestRelease 被调且 force 透传，返回 fixture', async () => {
    const checkForLatestRelease = vi.fn(async (
      _currentVersion: string,
      _opts?: { force?: boolean },
    ): Promise<LatestReleaseInfo | null> => FIXTURE)
    const mockChecker: IReleaseChecker = { checkForLatestRelease }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, { force: true })

    // checkForLatestRelease 被调，app.getVersion() 透传为 '0.8.14'
    expect(checkForLatestRelease).toHaveBeenCalledTimes(1)
    expect(checkForLatestRelease).toHaveBeenCalledWith('0.8.14', { force: true })
    // 返回 fixture
    expect(result).toEqual(FIXTURE)
  })

  it('W2TC7b: 不传 payload → force 默认 undefined', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    const mockChecker: IReleaseChecker = { checkForLatestRelease }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({})

    expect(checkForLatestRelease).toHaveBeenCalledWith('0.8.14', { force: undefined })
    expect(result).toEqual(FIXTURE)
  })

  it('W2TC7c: checkForLatestRelease 返回 null → handler 返回 null', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => null)
    const mockChecker: IReleaseChecker = { checkForLatestRelease }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})
    expect(result).toBeNull()
  })

  it('W2TC7d: releaseChecker=undefined（未注入）→ handler 返回 null，不调 checkForLatestRelease', async () => {
    registerUpdateHandlers({} as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, { force: true })
    expect(result).toBeNull()
  })

  it('W2TC7e: checkForLatestRelease 抛错 → handler 兜底返回 null 不 reject', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => {
      throw new Error('checker crash')
    })
    const mockChecker: IReleaseChecker = { checkForLatestRelease }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})
    expect(result).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ── W3：update:perform（W3TC10）──────────────────────────────────
describe('W3: update-handlers IPC update:perform (W3TC10)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    sendSpy.mockClear()
    mockMainWindow.isDestroyed.mockReturnValue(false)
    capturedQuitTimer = null
  })

  /** 注册 handler 时注入 updateOrchestrator + getMainWindow */
  function registerWithOrchestrator(orchestrator: IUpdateOrchestrator): void {
    // 拦截 setTimeout 捕获 quit 定时器
    const realSetTimeout = setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
      capturedQuitTimer = { callback: cb, delay: delay ?? 0 }
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout)
    void realSetTimeout // 引用避免 lint unused

    registerUpdateHandlers({
      updateOrchestrator: orchestrator,
      getMainWindow: () => mockMainWindow as never,
    } as never)
  }

  it('W3TC10a: performUpdate 成功 triggerRestart=true → 推 update:progress + 延迟 quit', async () => {
    const performUpdate = vi.fn(async (
      _release: LatestReleaseInfo,
      opts: { onProgress: (stage: string, percent: number) => void },
    ) => {
      // 模拟 orchestrator 推进度
      opts.onProgress('downloading', 50)
      opts.onProgress('verifying', 100)
      return { triggerRestart: true }
    })
    registerWithOrchestrator({ performUpdate } as never)

    const handler = handlers.get('update:perform')!
    const result = await handler({}, { release: FIXTURE })

    // 返回 triggerRestart
    expect(result).toEqual({ triggerRestart: true })
    // update:progress 事件已推送（downloading 50 + verifying 100）
    expect(sendSpy).toHaveBeenCalledWith('update:progress', { stage: 'downloading', percent: 50 })
    expect(sendSpy).toHaveBeenCalledWith('update:progress', { stage: 'verifying', percent: 100 })
    // triggerRestart=true → 安排了延迟 500ms 的 quit
    expect(capturedQuitTimer).not.toBeNull()
    expect(capturedQuitTimer!.delay).toBe(500)
  })

  it('W3TC10b: performUpdate 抛 UpdateError → 推 update:error 事件 + reject', async () => {
    const performUpdate = vi.fn(async () => {
      throw new UpdateError('download failed', 'downloading')
    })
    registerWithOrchestrator({ performUpdate } as never)

    const handler = handlers.get('update:perform')!
    await expect(handler({}, { release: FIXTURE })).rejects.toThrow(/download failed/)
    // update:error 事件携带 stage + message
    expect(sendSpy).toHaveBeenCalledWith('update:error', {
      stage: 'downloading',
      message: 'download failed',
      errorCode: undefined,
    })
    // 失败时不安排 quit
    expect(capturedQuitTimer).toBeNull()
  })

  it('W3TC10c: performUpdate 抛 UpdateUnsupportedError → errorCode=UPDATE_UNSUPPORTED_PLATFORM', async () => {
    const performUpdate = vi.fn(async () => {
      throw new UpdateUnsupportedError('deb not supported', FIXTURE.htmlUrl)
    })
    registerWithOrchestrator({ performUpdate } as never)

    const handler = handlers.get('update:perform')!
    await expect(handler({}, { release: FIXTURE })).rejects.toThrow(/deb not supported/)
    expect(sendSpy).toHaveBeenCalledWith('update:error', {
      stage: 'replacing',
      message: 'deb not supported',
      errorCode: 'UPDATE_UNSUPPORTED_PLATFORM',
    })
  })

  it('W3TC10d: updateOrchestrator 未注入 → 抛 updateOrchestrator not configured', async () => {
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:perform')!
    await expect(handler({}, { release: FIXTURE })).rejects.toThrow(/updateOrchestrator not configured/)
  })

  it('W3TC10e: 主窗口已销毁 → 不推送事件（isDestroyed 守卫）', async () => {
    const performUpdate = vi.fn(async (
      _release: LatestReleaseInfo,
      opts: { onProgress: (stage: string, percent: number) => void },
    ) => {
      opts.onProgress('downloading', 10)
      return { triggerRestart: true }
    })
    mockMainWindow.isDestroyed.mockReturnValue(true)
    registerWithOrchestrator({ performUpdate } as never)

    const handler = handlers.get('update:perform')!
    await handler({}, { release: FIXTURE })

    // 窗口已销毁 → send 不应被调
    expect(sendSpy).not.toHaveBeenCalled()
  })
})
