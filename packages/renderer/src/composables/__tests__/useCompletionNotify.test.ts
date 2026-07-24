import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { handleCompletion, __resetDebounceForTest } from '../useCompletionNotify'
import * as sound from '../useCompletionSound'
import * as markers from '../useSessionMarkers'
import { useSettingsStore } from '@/stores/settings'

vi.mock('../useCompletionSound', () => ({
  playSuccess: vi.fn(),
  playError: vi.fn(),
}))

vi.mock('../useSessionMarkers', () => ({
  markUnread: vi.fn(),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  __resetDebounceForTest()
  // 默认设置 completionSound = true
  const settingsStore = useSettingsStore()
  settingsStore.system = { ...settingsStore.system, completionSound: true }
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
    const settingsStore = useSettingsStore()
    settingsStore.system = { ...settingsStore.system, completionSound: false }
    handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })
})
