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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

/**
 * LatestReleaseInfo 测试 fixture。
 *
 * [SECURITY] 必须通过 validateRelease 校验（update:perform handler 在 performUpdate
 * 前会校验 payload）：
 * - version 严格 3 段数字
 * - downloadUrl 必须是 GitHub 域名（github.com / objects.githubusercontent.com）的 https
 * - sha256 若存在必须是 64 位 hex（这里用全 'a'）
 */
const FIXTURE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## changes',
  publishedAt: '2025-12-01T00:00:00Z',
  htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
  assets: {
    macArm64Zip: {
      name: 'TaiJi-mac-arm64.zip',
      downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/TaiJi-mac-arm64.zip',
      size: 1000,
      sha256: 'a'.repeat(64),
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
    // update:error 事件携带 stage + message + errorCode + suggestion。
    // UpdateError('download failed', 'downloading') 未传 errorCode，toUserFriendly() 走
    // fallback：code 缺省 'UPDATE_INTEGRITY_FAILED'、message 用传入的 'download failed'、
    // stage 用 this.stage、suggestion 用默认 '请重试或联系技术支持'（见 types.ts:143-148）。
    expect(sendSpy).toHaveBeenCalledWith('update:error', {
      stage: 'downloading',
      message: 'download failed',
      errorCode: 'UPDATE_INTEGRITY_FAILED',
      suggestion: '请重试或联系技术支持',
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
    // errorCode 命中 UPDATE_ERROR_MESSAGES 映射表，toUserFriendly() 返回标准化的本地化
    // message '当前平台不支持自动更新'（types.ts:86-90），而非构造时传入的英文。
    await expect(handler({}, { release: FIXTURE })).rejects.toThrow(/当前平台不支持自动更新/)
    expect(sendSpy).toHaveBeenCalledWith('update:error', {
      stage: 'replacing',
      message: '当前平台不支持自动更新',
      errorCode: 'UPDATE_UNSUPPORTED_PLATFORM',
      suggestion: '请手动下载最新版本',
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

// ── W4: update:getLaunchResult handler（A2/A3）───────────────────
describe('A2-launch-result-handler-vitest', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  function registerWithGetLaunchResult(getLaunchResult: () => Promise<{ status: string; version: string } | null>) {
    registerUpdateHandlers({
      getMainWindow: () => mockMainWindow as never,
      releaseChecker: { checkForLatestRelease: vi.fn() } as never,
      getLaunchResult,
    } as never)
  }

  it('A2-launch-result-handler-vitest: getLaunchResult handler 返回缓存值 + consumed 一次性', async () => {
    // 模拟 main.ts 的 consumed 一次性缓存
    let cache: { status: string; version: string } | null = { status: 'done', version: '0.9.9' }
    const getLaunchResult = async () => {
      const result = cache
      cache = null
      return result
    }
    registerWithGetLaunchResult(getLaunchResult)

    const handler = handlers.get('update:getLaunchResult')!
    expect(handler).toBeDefined()

    // 首次调用：返回缓存值
    const first = await handler()
    expect(first).toEqual({ status: 'done', version: '0.9.9' })

    // 第二次调用：consumed 一次性，返回 null
    const second = await handler()
    expect(second).toBeNull()
  })

  it('A3-main-cache-vitest: getLaunchResult 回调返回 cleanupCompletedUpdate 的缓存值', async () => {
    // 模拟 cleanupCompletedUpdate 返回 rolled-back 状态
    const getLaunchResult = async () => ({ status: 'rolled-back', version: '0.9.7' })
    registerWithGetLaunchResult(getLaunchResult)

    const handler = handlers.get('update:getLaunchResult')!
    const result = await handler()
    expect(result).toEqual({ status: 'rolled-back', version: '0.9.7' })
  })
})

// ════════════════════════════════════════════════════════════════
// u3a：resolveByVersion（批次 3 信任锚 RC1：四分支 + 60s 节流）
// 真实 resolver 逻辑单测（DI mock 的 handler 编排测试在
// update-handlers-orchestration.test.ts）。节流是模块级状态，
// 各用例用 fake timers 的 now 递增错开，避免互相污染。
// ════════════════════════════════════════════════════════════════
import { resolveByVersion } from '../update/orchestrator.js'

describe('u3a: resolveByVersion（版本解析四分支 + 60s 节流）', () => {
  /** 递增的 fake 时钟基点（各用例间隔 > 节流窗口 60s + 用例内最大 61s×2 推进，隔离模块级节流状态） */
  const BASE = 1_700_000_000_000
  const STEP = 200_000
  let seq = 0

  /** 构造 checker 桩：非强制 / 强制调用分别返回指定值（undefined 视为 null） */
  function makeChecker(nonForce: LatestReleaseInfo | null, force: LatestReleaseInfo | null) {
    return {
      checkForLatestRelease: vi.fn(
        async (_v: string, opts?: { force?: boolean }) =>
          (opts?.force ? force : nonForce) ?? null,
      ),
    } as unknown as IReleaseChecker
  }

  /** 与 FIXTURE 同构、版本号为 0.9.1 的「更新 latest」（供 STALE 分支用） */
  /** 与 FIXTURE 同构、版本号 0.9.0 的「权威 latest」（供 STALE 分支：请求 0.9.1 被拒） */
  const LATEST_0_9_0: LatestReleaseInfo = { ...FIXTURE, version: '0.9.0' }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('③ 版本格式非法 → 直接拒绝，不打 checker（含非 string 类型防御）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(null, null)

    await expect(
      resolveByVersion('abc', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)
    // 拒绝即节流：后续断言前推进 61s 离开节流窗口
    vi.setSystemTime(Date.now() + 61_000)
    await expect(
      resolveByVersion('1.2', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)
    vi.setSystemTime(Date.now() + 61_000)
    // typeof 守卫：IPC 数字被正则隐式串化绕过（123 → '123'）必须被拒
    await expect(
      resolveByVersion(123 as unknown as string, { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)
    // 拒绝发生在任何 checker 调用之前（零 API 消耗）
    expect(checker.checkForLatestRelease).not.toHaveBeenCalled()
  })

  it('④ STALE/解析失败后 60s 内：合法请求也被直接拒绝（不触发 force check），窗口外恢复', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(null, null)
    // 前置：制造一次拒绝（格式非法，now = 本用例起点）
    await expect(
      resolveByVersion('bad', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)

    // 窗口内：合法版本 + 缓存命中的 checker 也被节流拒绝
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/throttled/)
    // 节流拒绝发生在 checker 之前（不触发 force check → 无 API 放大）
    expect(checker.checkForLatestRelease).not.toHaveBeenCalled()

    // 窗口外（61s 后）：恢复解析能力（缓存命中分支）
    vi.setSystemTime(Date.now() + 61_000)
    checker.checkForLatestRelease = vi.fn(async () => FIXTURE) as never
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).resolves.toBe(FIXTURE)
  })

  it('① 缓存命中且版本一致 → 用缓存 release，不触发 force check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(FIXTURE, FIXTURE)
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).resolves.toBe(FIXTURE)
    // 只调了非强制（缓存优先）一次；force 分支未进入（单参调用，无第二参）
    expect(checker.checkForLatestRelease).toHaveBeenCalledTimes(1)
    expect(checker.checkForLatestRelease).toHaveBeenCalledWith('0.8.14')
  })

  it('② 缓存不一致 → force check；latest ≠ 请求版本 → UPDATE_STALE_RELEASE + 记节流', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    // 缓存给 0.9.0，请求 0.9.1 → 不一致；force 也返回 0.9.0（权威 latest 未到 0.9.1）
    const checker = makeChecker(FIXTURE, LATEST_0_9_0)
    const err = await resolveByVersion('0.9.1', {
      currentVersion: '0.8.14',
      releaseChecker: checker,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(UpdateError)
    expect((err as UpdateError).errorCode).toBe('UPDATE_STALE_RELEASE')
    // force check 真的发生了（权威确认，而非直接用缓存拒绝）
    expect(checker.checkForLatestRelease).toHaveBeenCalledTimes(2)
    expect(checker.checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: true })

    // STALE 拒绝后节流生效：窗口内的后续请求直接拒绝
    await expect(
      resolveByVersion('0.9.1', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/throttled/)
  })

  it('② check 失败（网络）→ 抛 UPDATE_NETWORK_FAILED，绝不回退缓存外/renderer 数据；且网络失败不节流', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    // 缓存 miss + force 均失败（网络断，既不能确认也不能证伪）
    const downChecker = makeChecker(null, null)
    const err = await resolveByVersion('0.9.0', {
      currentVersion: '0.8.14',
      releaseChecker: downChecker,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(UpdateError)
    expect((err as UpdateError).errorCode).toBe('UPDATE_NETWORK_FAILED')

    // 网络失败不触发节流：立即重试（网络恢复，缓存命中）即成功
    const recovered = makeChecker(FIXTURE, FIXTURE)
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: recovered }),
    ).resolves.toBe(FIXTURE)
  })

  it('② 缓存 miss → force check 命中请求版本 → 用权威结果', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(null, FIXTURE)
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).resolves.toBe(FIXTURE)
    // 非 force miss（null）后走了 force
    expect(checker.checkForLatestRelease).toHaveBeenCalledTimes(2)
    expect(checker.checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: true })
  })
})
