/**
 * useAppUpdate 可见性守卫单测（perf W05 Q1-6）。
 *
 * 覆盖（fake timers + document.hidden mock）：
 * - hidden 期间周期定时器照常触发，但不联网检测（checkForUpdate 零调用，连 hidden 多周期均不发）
 * - 恢复可见（visibilitychange → visible）：跳过被立即补查（force=true），不等下一个 20min
 * - 补查后周期检测继续（runAutoCheck 重排下一次定时器）
 * - 状态守卫优先于 visibility 补查：升级流程态（downloaded）hidden 期间跳过不标记，恢复可见不补查
 * - onScopeDispose：scope 卸载后 visibilitychange 不再触发检测
 * - 补查 await 窗口 dispose：runAutoCheck await 恢复后不排新周期 timer（W05 review）
 *
 * Mock 策略对齐 useAppUpdate.test.ts（vi.mock @/lib/ipc + markdown，effectScope 包 useAppUpdate）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.visibility.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

const hoisted = vi.hoisted(() => {
  return {
    checkForUpdate: vi.fn<(opts?: { force?: boolean }) => Promise<LatestReleaseInfo | null>>(),
    updateDownload: vi.fn<(release: LatestReleaseInfo) => Promise<{ downloaded: boolean }>>(),
    updateInstall: vi.fn<() => Promise<{ triggerRestart: boolean }>>(),
    getPreloaded: vi.fn<() => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
    getPendingUpdate: vi.fn<() => Promise<LatestReleaseInfo | null>>(),
    openUpdateFallbackUrl: vi.fn<(url: string) => Promise<void>>(),
    onUpdateProgress: vi.fn(() => () => {}),
    onUpdateError: vi.fn(() => () => {}),
    renderMarkdown: vi.fn<(md: string) => Promise<string>>(),
  }
})

vi.mock('@/lib/ipc', () => ({
  checkForUpdate: hoisted.checkForUpdate,
  updateDownload: hoisted.updateDownload,
  updateInstall: hoisted.updateInstall,
  getPreloaded: hoisted.getPreloaded,
  getPendingUpdate: hoisted.getPendingUpdate,
  openUpdateFallbackUrl: hoisted.openUpdateFallbackUrl,
  onUpdateProgress: hoisted.onUpdateProgress,
  onUpdateError: hoisted.onUpdateError,
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoisted.renderMarkdown,
}))

import { useAppUpdate, _resetForTest } from '@/composables/features/settings/useAppUpdate'

/** mock document.hidden / visibilityState */
function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 在 effectScope 内运行 useAppUpdate + initAutoCheck（onScopeDispose 需活跃 scope） */
function setupWithAutoCheck(): { result: ReturnType<typeof useAppUpdate>; stop: () => void } {
  const scope = effectScope()
  let result: ReturnType<typeof useAppUpdate> | undefined
  scope.run(() => {
    result = useAppUpdate()
    result.initAutoCheck()
  })
  return { result: result!, stop: () => scope.stop() }
}

beforeEach(() => {
  _resetForTest()
  vi.useFakeTimers()
  vi.stubGlobal('__APP_VERSION__', '0.0.0')
  setHidden(false)
  hoisted.checkForUpdate.mockReset().mockResolvedValue(null)
  hoisted.updateDownload.mockReset().mockResolvedValue({ downloaded: true })
  hoisted.updateInstall.mockReset().mockResolvedValue({ triggerRestart: true })
  hoisted.getPreloaded.mockReset().mockResolvedValue(null)
  hoisted.getPendingUpdate.mockReset().mockResolvedValue(null)
  hoisted.openUpdateFallbackUrl.mockReset()
  hoisted.onUpdateProgress.mockClear()
  hoisted.onUpdateError.mockClear()
  hoisted.renderMarkdown.mockReset().mockResolvedValue('<h2>notes</h2>')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAppUpdate 可见性守卫（Q1-6）', () => {
  it('hidden 期间周期触发不联网检测：30s 首次 + 20min 周期均跳过 checkForUpdate', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()

    // 30s 首次触发 → hidden 跳过
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    // 连 hidden 多个 20min 周期均不发联网请求
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('恢复可见立即补查（force=true），不等下一个 20min 周期', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()

    await vi.advanceTimersByTimeAsync(30_000) // hidden 跳过，标记 skippedWhileHidden
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    // 补查同步发起，立即断言可见
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(hoisted.checkForUpdate).toHaveBeenLastCalledWith({ force: true })
    stop()
  })

  it('补查后周期检测继续（下一个 20min 周期正常触发）', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()

    await vi.advanceTimersByTimeAsync(30_000)
    setHidden(false)
    fireVisibilityChange()
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    // 补查的 runAutoCheck 重排了周期定时器：20min 后再次检测
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })

  it('恢复可见无跳过记录时不补查（正常周期内的 visibilitychange 是 no-op）', async () => {
    const { stop } = setupWithAutoCheck()

    // 可见期间正常 30s 首次检测（无跳过记录）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    // 失焦又恢复（hidden 期间无周期触发 → 无跳过记录）
    setHidden(true)
    fireVisibilityChange()
    setHidden(false)
    fireVisibilityChange()
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1) // 不补查
    stop()
  })

  it('状态守卫优先：downloaded 态 hidden 期间跳过不标记，恢复可见不补查', async () => {
    setHidden(true)
    const { result, stop } = setupWithAutoCheck()
    // 置为升级流程态：canCheck=false，visibility 守卫不应置补查标记
    result.state.state = 'downloaded'

    await vi.advanceTimersByTimeAsync(30_000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled() // 不补查（升级流程不被打断）
    stop()
  })

  it('onScopeDispose 卸载 listener：dispose 后 visibilitychange 不再触发检测', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()

    await vi.advanceTimersByTimeAsync(30_000)
    stop() // 触发 onScopeDispose → 清 timer + 移除 listener

    setHidden(false)
    fireVisibilityChange()
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()
  })

  it('补查 await 期间 dispose：await 恢复后不排新周期 timer（卸载后 20min 不联网，W05 review）', async () => {
    // 让 checkForUpdate 挂起，制造 runAutoCheck 的 await 窗口（此窗口无 pending timer）
    let resolveCheck!: (v: LatestReleaseInfo | null) => void
    hoisted.checkForUpdate.mockImplementation(
      () =>
        new Promise<LatestReleaseInfo | null>((res) => {
          resolveCheck = res
        }),
    )

    setHidden(true)
    const { stop } = setupWithAutoCheck()
    await vi.advanceTimersByTimeAsync(30_000) // hidden 跳过，标记 skippedWhileHidden
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange() // 补查发起：runAutoCheck 进入 await checkForUpdate（挂起中）
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    stop() // await 挂起期间 dispose（clearAutoCheckTimer 无 pending timer 可清）
    resolveCheck(null) // await 恢复：disposed 已置位 → 不排下一周期 timer
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // 无新周期 timer 排上：推进 20min 不再联网
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1) // 仍只有补查那一次
  })
})
