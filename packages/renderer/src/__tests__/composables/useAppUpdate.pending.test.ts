/**
 * useAppUpdate 功能 1 测试：持久化升级提醒标志（常驻提醒）。
 *
 * 覆盖场景：
 * - PENDING-TC1：restorePendingUpdate 从 getPendingUpdate 恢复「可升级」提醒（state='available' + latestRelease + releaseNotes）
 * - PENDING-TC2：getPendingUpdate 返回 null → restorePendingUpdate 不改变 state（保持 idle）
 * - PENDING-TC3：防覆盖守卫——pending 恢复后 checkForUpdate 检测失败不回退 idle（保持 available）
 * - PENDING-TC4：防覆盖守卫——pending 恢复后 checkForUpdate 返回 null 不回退 idle
 * - PENDING-TC5：pending 恢复后 checkForUpdate 确认有新版 → 正常刷新 latestRelease
 * - PENDING-TC6：无 pending 恢复时，checkForUpdate 失败正常回退 idle（守卫不影响正常流程）
 * - PENDING-TC7（I#8）：getPendingUpdate reject（IPC 异常）→ restorePendingUpdate catch 分支：state 保持 idle、不抛错
 * - PENDING-TC8（I#9）：initAutoCheck 完整启动序列——先同步触发 restorePendingUpdate，30s 后触发 checkForUpdate
 *
 * 测试设计：直接调 restorePendingUpdate（绕过 initAutoCheck 的 30s 定时器，避免 fake timer
 * 与 async/await mock promise 的交互复杂度）。restorePendingUpdate 在 useAppUpdate 返回值中暴露
 * 供测试调用，运行时由 initAutoCheck 内部触发。
 *
 * Mock 策略（对齐 useAppUpdate.test.ts）：
 * - vi.mock('@/lib/ipc') 桩 update 相关方法（两阶段 updateDownload/updateInstall +
 *   预下载 getPreloaded + pending getPendingUpdate + checkForUpdate 等）。getPreloaded 默认
 *   null → initAutoCheck 先 restorePreloadedUpdate 无果，再走 restorePendingUpdate 路径
 * - vi.mock('@/composables/logic/markdown') 桩 renderMarkdown 避免 shiki WASM
 * - effectScope 包 useAppUpdate（onScopeDispose 依赖活跃 scope）
 * - _resetForTest 在 beforeEach 重置 module-level 单例 state + pendingRestored flag
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.pending.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

// vi.hoisted：mock factory 内不能引用顶层变量，用 hoisted 拿稳定引用
const hoisted = vi.hoisted(() => {
  let progressCb: ((p: { stage: 'downloading' | 'verifying' | 'replacing'; percent: number }) => void) | null = null
  let errorCb: ((e: { stage: string; message: string; errorCode?: string }) => void) | null = null
  return {
    checkForUpdate: vi.fn<(opts?: { force?: boolean }) => Promise<LatestReleaseInfo | null>>(),
    performUpdate: vi.fn<(release: LatestReleaseInfo) => Promise<{ triggerRestart: boolean }>>(),
    updateDownload: vi.fn<(release: LatestReleaseInfo) => Promise<{ downloaded: boolean }>>(),
    updateInstall: vi.fn<() => Promise<{ triggerRestart: boolean }>>(),
    getPreloaded: vi.fn<() => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
    getPendingUpdate: vi.fn<() => Promise<LatestReleaseInfo | null>>(),
    getUpdateSettings: vi.fn<() => Promise<{ preDownload: boolean; autoUpdate?: boolean }>>(),
    openUpdateFallbackUrl: vi.fn<(url: string) => Promise<void>>(),
    onUpdateProgress: vi.fn((cb: typeof progressCb) => {
      progressCb = cb
      return () => { progressCb = null }
    }),
    onUpdateError: vi.fn((cb: typeof errorCb) => {
      errorCb = cb
      return () => { errorCb = null }
    }),
    renderMarkdown: vi.fn<(md: string) => Promise<string>>(),
  }
})

vi.mock('@/lib/ipc', () => ({
  checkForUpdate: hoisted.checkForUpdate,
  performUpdate: hoisted.performUpdate,
  updateDownload: hoisted.updateDownload,
  updateInstall: hoisted.updateInstall,
  getPreloaded: hoisted.getPreloaded,
  getPendingUpdate: hoisted.getPendingUpdate,
  getUpdateSettings: hoisted.getUpdateSettings,
  openUpdateFallbackUrl: hoisted.openUpdateFallbackUrl,
  onUpdateProgress: hoisted.onUpdateProgress,
  onUpdateError: hoisted.onUpdateError,
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoisted.renderMarkdown,
}))

import { useAppUpdate, _resetForTest } from '@/composables/features/settings/useAppUpdate'

/** 构造测试用 LatestReleaseInfo */
function makeRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## 新特性\n- 支持 foo',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/example/repo/releases/v' + version,
    assets: {},
  }
}

beforeEach(() => {
  _resetForTest()
  hoisted.checkForUpdate.mockReset()
  hoisted.performUpdate.mockReset()
  hoisted.updateDownload.mockReset()
  hoisted.updateInstall.mockReset()
  hoisted.getPreloaded.mockReset()
  hoisted.getPendingUpdate.mockReset()
  // u4a：initAutoCheck 读 autoUpdate 开关（默认 true，存量行为不变）
  hoisted.getUpdateSettings.mockReset().mockResolvedValue({ preDownload: false, autoUpdate: true })
  hoisted.openUpdateFallbackUrl.mockReset()
  hoisted.onUpdateProgress.mockClear()
  hoisted.onUpdateError.mockClear()
  hoisted.renderMarkdown.mockReset()
  hoisted.renderMarkdown.mockResolvedValue('<h2>新特性</h2>')
  // 默认值：getPreloaded null 表示无预下载产物 → initAutoCheck 先 restorePreloadedUpdate
  // 无果后再 restorePendingUpdate（pending 测试的核心路径）
  hoisted.getPreloaded.mockResolvedValue(null)
  hoisted.updateDownload.mockResolvedValue({ downloaded: true })
  hoisted.updateInstall.mockResolvedValue({ triggerRestart: true })
})

/** 在 effectScope 内运行 useAppUpdate，返回 result + scope.stop 清理函数 */
function setupUseAppUpdate(): { result: ReturnType<typeof useAppUpdate>; stop: () => void } {
  const scope = effectScope()
  let result: ReturnType<typeof useAppUpdate> | undefined
  scope.run(() => {
    result = useAppUpdate()
  })
  return { result: result!, stop: () => scope.stop() }
}

describe('useAppUpdate 功能1：持久化升级提醒标志', () => {
  it('PENDING-TC1：restorePendingUpdate 从 getPendingUpdate 恢复「可升级」提醒', async () => {
    hoisted.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()

    await result.restorePendingUpdate()

    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    // releaseNotes 异步渲染，waitFor 等 html 填充
    await vi.waitFor(() => {
      expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })
    expect(hoisted.getPendingUpdate).toHaveBeenCalledOnce()
    stop()
  })

  it('PENDING-TC2：getPendingUpdate 返回 null → 不恢复提醒，state 保持 idle', async () => {
    hoisted.getPendingUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()

    await result.restorePendingUpdate()

    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('PENDING-TC3：防覆盖守卫——pending 恢复后 checkForUpdate 失败不回退 idle', async () => {
    // 1. 恢复 pending
    hoisted.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await result.restorePendingUpdate()
    expect(result.state.state).toBe('available')

    // 2. 模拟 30s 后联网检测失败（网络断开）
    hoisted.checkForUpdate.mockRejectedValue(new Error('network error'))
    await result.checkForUpdate()

    // 防覆盖守卫：pendingRestored=true 时检测失败不回退 idle，保持 available
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('PENDING-TC4：防覆盖守卫——pending 恢复后 checkForUpdate 返回 null 不回退 idle', async () => {
    // 1. 恢复 pending
    hoisted.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await result.restorePendingUpdate()
    expect(result.state.state).toBe('available')

    // 2. 模拟 30s 后联网检测无新版（null）
    hoisted.checkForUpdate.mockResolvedValue(null)
    await result.checkForUpdate()

    // 防覆盖守卫：pendingRestored=true 时无新版不回退 idle（pending 标志证明曾检测到更新）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('PENDING-TC5：pending 恢复后 checkForUpdate 确认有新版 → 正常刷新 latestRelease', async () => {
    // 1. 恢复的 pending 是 v0.9.0
    hoisted.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await result.restorePendingUpdate()
    expect(result.state.latestRelease?.version).toBe('0.9.0')

    // 2. 联网检测到更新的 v0.9.5
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.5'))
    await result.checkForUpdate()

    // 确认有新版 → 正常刷新（latestRelease 更新为 v0.9.5）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.5')
    stop()
  })

  it('PENDING-TC6：无 pending 恢复时，checkForUpdate 失败正常回退 idle（守卫不影响正常流程）', async () => {
    // 无 pending → pendingRestored 保持 false
    hoisted.getPendingUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()
    await result.restorePendingUpdate()
    expect(result.state.state).toBe('idle')

    // 联网检测失败
    hoisted.checkForUpdate.mockRejectedValue(new Error('network error'))
    await result.checkForUpdate()

    // 正常流程（非 pending 恢复）：检测失败 → 回退 idle（守卫只在 pendingRestored 时生效）
    expect(result.state.state).toBe('idle')
    stop()
  })

  it('PENDING-TC7（I#8）：getPendingUpdate reject（IPC 异常）→ restorePendingUpdate catch 分支：state 保持 idle、不抛错', async () => {
    // 模拟 IPC 通道异常（如 preload 桥未就绪 / ipcRenderer.invoke reject）
    hoisted.getPendingUpdate.mockRejectedValue(new Error('ipc fail'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, stop } = setupUseAppUpdate()

    // restorePendingUpdate 是 best-effort：catch 后不 re-throw，state 不变
    await expect(result.restorePendingUpdate()).resolves.toBeUndefined()

    // state 保持初始 idle，latestRelease 未被污染
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    // 失败信息经 console.warn 诊断（不进 errorMessage，避免 idle 态残留）
    expect(warnSpy).toHaveBeenCalledWith(
      '[useAppUpdate] restorePendingUpdate failed:',
      expect.any(Error),
    )
    warnSpy.mockRestore()
    stop()
  })

  it('PENDING-TC8（I#9）：initAutoCheck 完整启动序列——先同步触发 restorePendingUpdate，30s 后触发 checkForUpdate', async () => {
    // AUTO_CHECK_DELAY_MS = 30_000（useAppUpdate.ts 未导出常量，用字面量并注明）
    const AUTO_CHECK_DELAY_MS = 30_000
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // pending 恢复成功（立即触发，不等 30s）
    hoisted.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    // 30s 后联网检测确认有更新版本
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.5'))
    const { result, stop } = setupUseAppUpdate()

    // initAutoCheck 必须在活跃 effect scope 内调（onScopeDispose 注册 timer 清理）
    result.initAutoCheck()

    // 1. 启动序列先触发 restorePreloadedUpdate（getPreloaded），无预下载产物后再
    //    restorePendingUpdate（getPendingUpdate）。两者都是 async，需 flush 微任务
    await vi.waitFor(() => {
      expect(hoisted.getPreloaded).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(hoisted.getPendingUpdate).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(result.state.state).toBe('available')
      expect(result.state.latestRelease?.version).toBe('0.9.0')
    })
    // 此时 30s 定时器尚未到期，checkForUpdate 不应被调
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    // 2. 推进 30s：联网检测被触发（刷新 release info）
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS)
    await vi.waitFor(() => {
      expect(hoisted.checkForUpdate).toHaveBeenCalledOnce()
    })
    // 联网检测确认 v0.9.5 → latestRelease 被刷新
    await vi.waitFor(() => {
      expect(result.state.latestRelease?.version).toBe('0.9.5')
    })
    expect(result.state.state).toBe('available')

    warnSpy.mockRestore()
    vi.useRealTimers()
    stop()
  })

  it('PENDING-TC9（I#9 补充）：initAutoCheck 在 30s 内不触发 checkForUpdate（定时器语义正确，不提前检测）', async () => {
    const AUTO_CHECK_DELAY_MS = 30_000
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()

    result.initAutoCheck()
    await vi.waitFor(() => {
      expect(hoisted.getPendingUpdate).toHaveBeenCalledOnce()
    })

    // 推进 29s（差 1s 到期）→ checkForUpdate 仍不应被调
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS - 1_000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()
    // pending 为 null → state 保持 idle
    expect(result.state.state).toBe('idle')

    // 再推进 1s 达到 30s → checkForUpdate 触发
    vi.advanceTimersByTime(1_000)
    await vi.waitFor(() => {
      expect(hoisted.checkForUpdate).toHaveBeenCalledOnce()
    })

    warnSpy.mockRestore()
    vi.useRealTimers()
    stop()
  })
})
