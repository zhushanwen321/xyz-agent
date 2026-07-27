import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock window.electronAPI.playSystemSound
const mockPlaySystemSound = vi.fn<(name: string) => Promise<{ audioData?: string; mimeType?: string }>>()
mockPlaySystemSound.mockResolvedValue({}) // mac/linux 默认空对象（main spawn 播）

// Mock HTMLAudioElement.play（win 路径用 new Audio）
const mockAudioPlay = vi.fn().mockResolvedValue(undefined)

// Audio 必须是 constructor（new Audio()）→ vi.fn 包裹普通 function
const mockAudioCtor = vi.fn(function (this: { play: typeof mockAudioPlay }) {
  this.play = mockAudioPlay
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPlaySystemSound.mockResolvedValue({})
  // @ts-expect-error 测试桩：注入 electronAPI
  globalThis.window = globalThis.window || {}
  // @ts-expect-error 测试桩
  globalThis.window.electronAPI = {
    playSystemSound: mockPlaySystemSound,
  }
  // @ts-expect-error 测试桩：mock Audio 为 constructor
  globalThis.Audio = mockAudioCtor as unknown as typeof Audio
})

afterEach(() => {
  vi.restoreAllMocks()
})

// helpers：动态 import 拿最新模块状态
async function loadModule() {
  const mod = await import('../useCompletionSound')
  return { playSuccess: mod.playSuccess, playError: mod.playError, playByName: mod.playByName }
}

describe('useCompletionSound', () => {
  it('playSuccess 调用 electronAPI.playSystemSound', async () => {
    const { playSuccess } = await loadModule()
    await playSuccess()
    expect(mockPlaySystemSound).toHaveBeenCalledTimes(1)
  })

  it('playError 调用 electronAPI.playSystemSound', async () => {
    const { playError } = await loadModule()
    await playError()
    expect(mockPlaySystemSound).toHaveBeenCalledTimes(1)
  })

  it('playByName 传入指定名字时透传给 IPC', async () => {
    const { playByName } = await loadModule()
    await playByName('Hero')
    expect(mockPlaySystemSound).toHaveBeenCalledWith('Hero')
  })

  it('electronAPI 不存在时不抛错（安全降级）', async () => {
    // @ts-expect-error 测试桩：移除 electronAPI
    delete globalThis.window.electronAPI
    const { playSuccess } = await loadModule()
    await expect(playSuccess()).resolves.toBeUndefined()
  })

  it('playSystemSound 抛错时不传播（提示音失败不阻塞对话流）', async () => {
    mockPlaySystemSound.mockRejectedValueOnce(new Error('ipc down'))
    const { playSuccess } = await loadModule()
    await expect(playSuccess()).resolves.toBeUndefined()
  })

  it('win 路径：main 返回 audioData 时 new Audio 播放', async () => {
    mockPlaySystemSound.mockResolvedValueOnce({
      audioData: 'dGVzdA==', // 'test' base64
      mimeType: 'audio/wav',
    })
    const { playByName } = await loadModule()
    await playByName('Windows Notify System Generic')
    expect(mockAudioCtor).toHaveBeenCalledTimes(1)
    // 验证 dataURI 构造正确
    expect(mockAudioCtor).toHaveBeenCalledWith('data:audio/wav;base64,dGVzdA==')
    expect(mockAudioPlay).toHaveBeenCalledTimes(1)
  })

  it('win 路径：Audio.play 被 autoplay 拒绝时不抛错', async () => {
    mockPlaySystemSound.mockResolvedValueOnce({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    mockAudioPlay.mockRejectedValueOnce(new Error('autoplay blocked'))
    const { playByName } = await loadModule()
    await expect(playByName('Windows Notify System Generic')).resolves.toBeUndefined()
  })
})
