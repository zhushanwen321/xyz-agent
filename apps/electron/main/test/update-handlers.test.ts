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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      name: 'xyz-agent-mac-arm64.zip',
      downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-mac-arm64.zip',
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

// ── 代理配置 IPC ───────────────────────────────────────────────
describe('update-handlers: proxy config IPC', () => {
  // [ISOLATION] getProxyConfig 读 getDataDir()/proxy-config.json，而 getDataDir() 默认
  // 指向真实 ~/.xyz-agent。本机 ~/.xyz-agent/proxy-config.json 含 manual 配置，
  // 会导致「文件不存在」的默认值测试失败。把 XYZ_AGENT_DATA_DIR 指向临时目录隔离。
  let prevDataDir: string | undefined
  /** 保存/还原 global fetch（testProxy manual 模式测试 mock 它验证 dispatcher 透传） */
  let originalFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    prevDataDir = process.env.XYZ_AGENT_DATA_DIR
    process.env.XYZ_AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), 'xyz-proxy-test-'))
  })

  afterEach(() => {
    if (prevDataDir === undefined) {
      delete process.env.XYZ_AGENT_DATA_DIR
    } else {
      process.env.XYZ_AGENT_DATA_DIR = prevDataDir
    }
    // 还原 global fetch（testProxy manual 模式测试会 mock 它）
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch
      originalFetch = undefined
    }
  })

  it('update:getProxyConfig 返回默认配置（文件不存在）', async () => {
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:getProxyConfig')!
    const result = await handler({}, {})
    expect(result).toEqual({ mode: 'system' })
  })

  it('update:setProxyConfig 保存配置 + update:getProxyConfig 读取', async () => {
    registerUpdateHandlers({} as never)
    const setHandler = handlers.get('update:setProxyConfig')!
    const getHandler = handlers.get('update:getProxyConfig')!

    // 保存手动配置
    await setHandler({}, {
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    })

    // 读取验证
    const result = await getHandler({}, {})
    expect(result).toEqual({
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    })
  })

  it('update:setProxyConfig 校验无效模式', async () => {
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:setProxyConfig')!
    await expect(handler({}, { mode: 'invalid' })).rejects.toThrow('Invalid proxy mode')
  })

  it('update:setProxyConfig 手动模式缺少 httpProxy 报错', async () => {
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:setProxyConfig')!
    await expect(handler({}, { mode: 'manual' })).rejects.toThrow('HTTP proxy is required in manual mode')
  })

  it('update:setProxyConfig 手动模式无效 URL 报错', async () => {
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:setProxyConfig')!
    await expect(handler({}, {
      mode: 'manual',
      httpProxy: 'not-a-url',
    })).rejects.toThrow('Invalid proxy URL format')
  })

  it('update:testProxy disabled 模式跳过测试并返回 success:false', async () => {
    // [B2] disabled 本就无连接可测，不应误报成功（前端据此显示「代理已禁用，跳过测试」）
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, { mode: 'disabled' })
    expect(result).toEqual({ success: false, message: 'Proxy disabled, skipping test' })
  })

  // [C2/S-3 回归防护] testProxy 必须真正走代理：fetch 收到含 dispatcher 的 options。
  // 旧实现只直连（不传 dispatcher）→ 代理不可用也误报成功。
  it('update:testProxy manual 模式 → fetch 被传含 dispatcher 的 options（真正走代理）', async () => {
    // mock global fetch：返回 ok Response，让 testProxyConnection 走到 fetch 调用。
    // 显式声明 fetch 形参类型，mock.calls 才有正确的元组形状（url, init）。
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    )
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    })

    // fetch 被调用且第 2 参数（RequestInit）含 dispatcher 字段 → C2 修复生效
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    expect(call).toBeDefined()
    const initArg = call![1] as RequestInit & { dispatcher?: unknown } | undefined
    expect(initArg).toBeDefined()
    expect(initArg!.dispatcher).toBeDefined()
    expect(initArg!.dispatcher).not.toBeNull()
    // 走代理成功
    expect(result).toEqual({ success: true })
  })

  it('update:testProxy manual 模式无代理 URL → success:false', async () => {
    registerUpdateHandlers({} as never)
    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, { mode: 'manual' })
    expect(result).toEqual({ success: false, message: 'No proxy URL configured' })
  })
})
