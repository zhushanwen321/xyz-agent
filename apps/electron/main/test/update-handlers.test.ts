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

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  app: {
    getVersion: vi.fn(() => '0.8.14'),
  },
}))

import { registerUpdateHandlers } from '../gateway/update-handlers.js'
import type { IReleaseChecker } from '../interfaces.js'

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
