import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Web Audio API 用 class 使 new AudioContext() 正常工作
const mockStop = vi.fn()
const mockStart = vi.fn()
const mockConnect = vi.fn()
const mockExponentialRampToValueAtTime = vi.fn()
const mockSetValueAtTime = vi.fn()
const mockResume = vi.fn()
const mockCreateOscillator = vi.fn()
const mockCreateGain = vi.fn()

let audioCtxState = 'running'

class MockAudioContext {
  get state() { return audioCtxState }
  currentTime = 0
  destination = {}
  createOscillator = mockCreateOscillator
  createGain = mockCreateGain
  resume = mockResume
}

mockCreateOscillator.mockImplementation(() => ({
  type: 'sine',
  frequency: {
    value: 0,
    setValueAtTime: mockSetValueAtTime,
    exponentialRampToValueAtTime: mockExponentialRampToValueAtTime,
  },
  connect: mockConnect,
  start: mockStart,
  stop: mockStop,
}))

mockCreateGain.mockImplementation(() => ({
  gain: {
    value: 0,
    setValueAtTime: mockSetValueAtTime,
    exponentialRampToValueAtTime: mockExponentialRampToValueAtTime,
  },
  connect: mockConnect,
}))

// @ts-expect-error mock AudioContext
globalThis.AudioContext = MockAudioContext

let playSuccess: () => void
let playError: () => void

beforeEach(async () => {
  vi.clearAllMocks()
  audioCtxState = 'running'
  // 清除模块缓存以重置 audioCtx singleton
  vi.resetModules()
  const mod = await import('../useCompletionSound')
  playSuccess = mod.playSuccess
  playError = mod.playError
})

describe('useCompletionSound', () => {
  it('playSuccess 调用 createOscillator，频率 523Hz', () => {
    playSuccess()
    expect(mockCreateOscillator).toHaveBeenCalled()
    expect(mockSetValueAtTime).toHaveBeenCalledWith(523, expect.any(Number))
  })

  it('playError 调用 createOscillator，频率 220Hz', () => {
    playError()
    expect(mockCreateOscillator).toHaveBeenCalled()
    expect(mockSetValueAtTime).toHaveBeenCalledWith(220, expect.any(Number))
  })

  it('playError 使用 exponentialRampToValueAtTime 做频率下滑', () => {
    playError()
    expect(mockExponentialRampToValueAtTime).toHaveBeenCalled()
  })

  it('AudioContext suspended 时调用 resume', () => {
    audioCtxState = 'suspended'
    playSuccess()
    expect(mockResume).toHaveBeenCalled()
  })
})
