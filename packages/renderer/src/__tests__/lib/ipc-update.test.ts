/**
 * lib/ipc 自动升级方法单测（w4 update-frontend · W4TC11）。
 *
 * 验证两条路径：
 * 1. window.electronAPI 为 undefined（web/mock 环境）：5 方法优雅降级
 *    - checkForUpdate → null
 *    - performUpdate → { triggerRestart: false }
 *    - onUpdateProgress/onUpdateError → no-op（调用返回值不抛错）
 *    - openUpdateFallbackUrl → resolve（不抛错）
 * 2. window.electronAPI 含 5 方法：转发到对应方法 + 透传参数/返回值
 *
 * 关键：ipc.ts 顶层 `const api = window.electronAPI` 在模块加载时捕获，
 * 故每个用例需 vi.resetModules() + 动态 import 以新 module 实例读取新 stub。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/ipc-update.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

/** 测试用 LatestReleaseInfo（performUpdate/openUpdateFallbackUrl 透传） */
const release: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## new',
  publishedAt: '2026-07-01T00:00:00Z',
  htmlUrl: 'https://example.com/release',
  assets: {},
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  // 还原 window.electronAPI（避免污染其他测试）
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('lib/ipc update 方法 · web/mock 降级（electronAPI=undefined）', () => {
  beforeEach(() => {
    // 确保 electronAPI 不存在（web/mock 环境无 preload）
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('checkForUpdate → null', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.checkForUpdate()).resolves.toBeNull()
    await expect(ipc.checkForUpdate({ force: true })).resolves.toBeNull()
  })

  it('performUpdate → { triggerRestart: false }', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.performUpdate(release)).resolves.toEqual({ triggerRestart: false })
  })

  it('onUpdateProgress → 返回 no-op 取消函数', async () => {
    const ipc = await import('@/lib/ipc')
    const off = ipc.onUpdateProgress(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })

  it('onUpdateError → 返回 no-op 取消函数', async () => {
    const ipc = await import('@/lib/ipc')
    const off = ipc.onUpdateError(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })

  it('openUpdateFallbackUrl → resolve（不抛错）', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.openUpdateFallbackUrl('https://example.com')).resolves.toBeUndefined()
  })

  it('updateDownload → { downloaded: false }', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.updateDownload(release)).resolves.toEqual({ downloaded: false })
  })

  it('updateInstall → { triggerRestart: false }', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.updateInstall()).resolves.toEqual({ triggerRestart: false })
  })

  it('getPreloaded → null', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.getPreloaded()).resolves.toBeNull()
  })
})

describe('lib/ipc update 方法 · 转发到 electronAPI', () => {
  it('checkForUpdate 转发 opts 并透传返回值', async () => {
    const spy = vi.fn((opts?: { force?: boolean }) =>
      Promise.resolve(opts?.force ? release : null),
    )
    ;(window as { electronAPI?: unknown }).electronAPI = { checkForUpdate: spy }
    const ipc = await import('@/lib/ipc')

    // force=true → 返回 release
    await expect(ipc.checkForUpdate({ force: true })).resolves.toEqual(release)
    expect(spy).toHaveBeenLastCalledWith({ force: true })

    // 无 force → 返回 null
    await expect(ipc.checkForUpdate()).resolves.toBeNull()
    expect(spy).toHaveBeenLastCalledWith(undefined)
  })

  it('performUpdate 转发 release 并透传返回值', async () => {
    const spy = vi.fn((r: LatestReleaseInfo) =>
      Promise.resolve({ triggerRestart: r.version === '0.9.0' }),
    )
    ;(window as { electronAPI?: unknown }).electronAPI = { performUpdate: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.performUpdate(release)).resolves.toEqual({ triggerRestart: true })
    expect(spy).toHaveBeenCalledWith(release)
  })

  it('onUpdateProgress 转发 callback 并返回其 unsubscribe', async () => {
    const realOff = vi.fn()
    const spy = vi.fn((cb: (p: { stage: 'downloading'; percent: number }) => void) => {
      // 立即触发一次回调验证透传
      cb({ stage: 'downloading', percent: 50 })
      return realOff
    })
    ;(window as { electronAPI?: unknown }).electronAPI = { onUpdateProgress: spy }
    const ipc = await import('@/lib/ipc')

    const received: { stage: string; percent: number }[] = []
    const off = ipc.onUpdateProgress((p) => received.push(p))
    expect(spy).toHaveBeenCalled()
    expect(received).toEqual([{ stage: 'downloading', percent: 50 }])
    // 调返回的取消函数 → 应转发到 realOff
    off()
    expect(realOff).toHaveBeenCalled()
  })

  it('onUpdateError 转发 callback 并返回其 unsubscribe', async () => {
    const realOff = vi.fn()
    const spy = vi.fn(
      (cb: (e: { stage: string; message: string; errorCode?: string }) => void) => {
        cb({ stage: 'downloading', message: 'fail', errorCode: 'X' })
        return realOff
      },
    )
    ;(window as { electronAPI?: unknown }).electronAPI = { onUpdateError: spy }
    const ipc = await import('@/lib/ipc')

    const received: { stage: string; message: string; errorCode?: string }[] = []
    const off = ipc.onUpdateError((e) => received.push(e))
    expect(received).toEqual([{ stage: 'downloading', message: 'fail', errorCode: 'X' }])
    off()
    expect(realOff).toHaveBeenCalled()
  })

  it('openUpdateFallbackUrl 转发 url', async () => {
    const spy = vi.fn((url: string) => Promise.resolve())
    ;(window as { electronAPI?: unknown }).electronAPI = { openUpdateFallbackUrl: spy }
    const ipc = await import('@/lib/ipc')

    await ipc.openUpdateFallbackUrl('https://example.com/x')
    expect(spy).toHaveBeenCalledWith('https://example.com/x')
  })

  it('updateDownload 转发 release 并透传返回值', async () => {
    const spy = vi.fn((r: LatestReleaseInfo) =>
      Promise.resolve({ downloaded: r.version === '0.9.0' }),
    )
    ;(window as { electronAPI?: unknown }).electronAPI = { updateDownload: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.updateDownload(release)).resolves.toEqual({ downloaded: true })
    expect(spy).toHaveBeenCalledWith(release)
  })

  it('updateInstall 转发（无参）并透传返回值', async () => {
    const spy = vi.fn(() => Promise.resolve({ triggerRestart: true }))
    ;(window as { electronAPI?: unknown }).electronAPI = { updateInstall: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.updateInstall()).resolves.toEqual({ triggerRestart: true })
    expect(spy).toHaveBeenCalledWith()
  })

  it('getPreloaded 转发（无参）并透传返回值', async () => {
    const preloaded = { release, filePath: '/tmp/preloaded.zip' }
    const spy = vi.fn(() => Promise.resolve(preloaded))
    ;(window as { electronAPI?: unknown }).electronAPI = { getPreloaded: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.getPreloaded()).resolves.toEqual(preloaded)
    expect(spy).toHaveBeenCalledWith()
  })
})
