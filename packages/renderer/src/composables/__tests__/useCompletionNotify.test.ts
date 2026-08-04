import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { handleCompletion, __resetDebounceForTest } from '../useCompletionNotify'
import * as sound from '../useCompletionSound'
import * as markers from '../useSessionMarkers'
import { useBackgroundWork } from '../features/useBackgroundWork'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@xyz-agent/core'

vi.mock('../useCompletionSound', () => ({
  // playSuccess/playError 现在是 async + 接受可选声音名参数
  playSuccess: vi.fn<(name?: string) => Promise<void>>().mockResolvedValue(undefined),
  playError: vi.fn<(name?: string) => Promise<void>>().mockResolvedValue(undefined),
}))

vi.mock('../useSessionMarkers', () => ({
  markUnread: vi.fn(),
}))

// useBackgroundWork 默认 mock：hasBackgroundWork 返回 false。
// 既有 10 个用例默认假设无 background work（非 background 场景），保持行为不变。
// TC6/TC7/TC8 用 vi.mocked(useBackgroundWork).mockReturnValue 覆盖返回值。
vi.mock('../features/useBackgroundWork', () => ({
  useBackgroundWork: vi.fn(() => ({ hasBackgroundWork: () => false })),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  vi.clearAllMocks()
  // 重置 useBackgroundWork mock 到默认实现（hasBackgroundWork=false），
  // 避免上一个用例的 mockReturnValue 污染下一个用例。
  vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => false })
  __resetDebounceForTest()
  // 默认设置 completionSound = true
  const settingsStore = getSettingsStore()
  settingsStore.system.value = { ...settingsStore.system.value, completionSound: true }
  // 默认 document.visibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('useCompletionNotify', () => {
  it('后台完成 stopReason=stop → playSuccess + markUnread', () => {
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('后台完成 stopReason=error → playError + markUnread', () => {
    handleCompletion('s1', 'error', 'other-sid')
    expect(sound.playError).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('后台完成 stopReason=aborted → 不响 + 不标记未读', () => {
    handleCompletion('s1', 'aborted', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('前台完成（focused + visible）→ 不响', () => {
    handleCompletion('s1', 'stop', 's1')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('前台但页面不可见 → 仍然触发', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    handleCompletion('s1', 'stop', 's1')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('1s 防抖：连续 2 个完成只响一次', () => {
    handleCompletion('s1', 'stop', 'other-sid')
    handleCompletion('s2', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    // 但 markUnread 每次都调（未读不受防抖影响）
    expect(markers.markUnread).toHaveBeenCalledTimes(2)
  })

  it('completionSound=false → 不响但仍然标记未读', () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = { ...settingsStore.system.value, completionSound: false }
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('设置 successSound 时透传给 playSuccess', () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = { ...settingsStore.system.value, successSound: 'Hero' }
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledWith('Hero')
  })

  it('设置 errorSound 时透传给 playError', () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = { ...settingsStore.system.value, errorSound: 'Sosumi' }
    handleCompletion('s1', 'error', 'other-sid')
    expect(sound.playError).toHaveBeenCalledWith('Sosumi')
  })

  it('未设置声音名时传 undefined（playSuccess 内部 fallback 到平台默认）', () => {
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledWith(undefined)
  })

  // ── background work 守卫（CW wave completion-sound-bg-guard）──

  it('TC6: background work 仍在跑 → 跳过提示音 + 不标记未读（守卫命中）', () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => true })
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('TC7: background 全 done → 正常触发提示音 + 标记未读（守卫放行）', () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => false })
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('TC8: aborted + background 仍在跑 → 仍跳过（aborted 守卫先短路，与 background 守卫并列都不触发）', () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => true })
    handleCompletion('s1', 'aborted', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('TC9: background error 态完成 → 守卫放行后走 error 路径（playError）', () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => false })
    handleCompletion('s1', 'error', 'other-sid')
    expect(sound.playError).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })
})
