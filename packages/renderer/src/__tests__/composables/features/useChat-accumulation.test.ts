/**
 * useChat 累积图片 size cap 防护单测（P2-c w4 W4TC1-8）。
 *
 * 覆盖：
 * - W4TC1-4 estimateAccumulatedImageBytes 纯函数：空/累加/部分失败/仅 user
 * - W4TC5-7 useChat.send 集成：层 2 警告/层 3 剥离/正常路径
 * - W4TC8 IMAGE_LIMITS 常量断言
 *
 * mock 策略：
 * - estimateAccumulatedImageBytes 是 useChat 模块导出的纯函数 → mock fetchSize 注入参数
 * - useChat.send 集成：vi.hoisted apiMock 捕获 chatApi（复用 useChat-send-images.test.ts 范式）+
 *   vi.mock settingsStore 注入 imageAccumulationWarnMB/HardMB + mock session.list 注入 modelId
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/features/useChat-accumulation.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message, ServerMessage, Segment } from '@xyz-agent/shared'
import { IMAGE_LIMITS } from '@xyz-agent/shared'

// ── api mock（chatApi.send/steer/streamSubscribe 等，复用 useChat-send-images.test.ts 范式）──
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    steer: apiMock.steer,
    followUp: apiMock.followUp,
  },
  session: {},
}))

// ── settingsStore mock：可注入 imageAccumulationWarnMB/HardMB ──
const settingsState = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; models: Array<{ id: string; input?: Array<'text' | 'image'> }> }>,
  system: {
    locale: 'zh-CN' as const,
    theme: 'dark' as const,
    themePreset: 'cold-blue',
    imageAccumulationWarnMB: undefined as number | undefined,
    imageAccumulationHardMB: undefined as number | undefined,
  },
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    providers: settingsState.providers,
    system: settingsState.system,
  }),
}))

// ── i18n mock ──
vi.mock('@/i18n', () => ({
  default: {
    global: {
      t: (key: string, args?: Record<string, unknown>) => {
        if (key === 'panel.accumulationWarnWarning' && args) {
          return `accumulation warn size=${String(args.size)}MB`
        }
        if (key === 'panel.accumulationHardWarning' && args) {
          return `accumulation hard size=${String(args.size)}MB`
        }
        if (key === 'panel.visionNotSupportedWarning' && args) {
          return `不支持图片 model=${String(args.modelName)} count=${String(args.count)}`
        }
        return key
      },
    },
  },
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState, estimateAccumulatedImageBytes } from '@/composables/features/useChat'
import { useToast } from '@/composables/useToast'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  settingsState.providers = []
  settingsState.system.imageAccumulationWarnMB = undefined
  settingsState.system.imageAccumulationHardMB = undefined
  // 清空全局 toasts
  const { toasts } = useToast()
  toasts.value = []
})

// ── W4TC1-4：estimateAccumulatedImageBytes 纯函数 ──

describe('estimateAccumulatedImageBytes（W4TC1-4）', () => {
  it('W4TC1 无 image segment → totalBytes=0，fetchSize 不调用', async () => {
    const fetchSize = vi.fn<(path: string) => Promise<number>>()
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], status: 'complete', timestamp: 0 },
    ]
    const result = await estimateAccumulatedImageBytes(messages, fetchSize)
    expect(result).toEqual({ totalBytes: 0, counted: 0, failed: 0 })
    expect(fetchSize).not.toHaveBeenCalled()
  })

  it('W4TC2 多图累加正确', async () => {
    const fiveMB = 5 * 1024 * 1024
    const threeMB = 3 * 1024 * 1024
    const fetchSize = vi.fn<(path: string) => Promise<number>>()
      .mockResolvedValueOnce(fiveMB)
      .mockResolvedValueOnce(threeMB)
    const messages: Message[] = [
      {
        id: 'm1', role: 'user', content: [
          { type: 'image', id: 'img-a', path: '/a.png', name: 'a.png' },
          { type: 'image', id: 'img-b', path: '/b.png', name: 'b.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
    ]
    const result = await estimateAccumulatedImageBytes(messages, fetchSize)
    expect(result.totalBytes).toBe(fiveMB + threeMB)
    expect(result.counted).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('W4TC3 部分失败计入 failed 不 throw', async () => {
    const fiveMB = 5 * 1024 * 1024
    const threeMB = 3 * 1024 * 1024
    const fetchSize = vi.fn<(path: string) => Promise<number>>()
      .mockResolvedValueOnce(fiveMB)
      .mockRejectedValueOnce(new Error('403'))
      .mockResolvedValueOnce(threeMB)
    const messages: Message[] = [
      {
        id: 'm1', role: 'user', content: [
          { type: 'image', id: 'img-a', path: '/a.png', name: 'a.png' },
          { type: 'image', id: 'img-b', path: '/b.png', name: 'b.png' },
          { type: 'image', id: 'img-c', path: '/c.png', name: 'c.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
    ]
    const result = await estimateAccumulatedImageBytes(messages, fetchSize)
    expect(result.totalBytes).toBe(fiveMB + threeMB)
    expect(result.counted).toBe(2)
    expect(result.failed).toBe(1)
  })

  it('W4TC4 仅遍历 user message 的 image segment，assistant 不计入', async () => {
    const fetchSize = vi.fn<(path: string) => Promise<number>>()
      .mockResolvedValueOnce(1024)
    const messages: Message[] = [
      {
        id: 'm1', role: 'user', content: [
          { type: 'image', id: 'img-a', path: '/user.png', name: 'user.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
      {
        id: 'm2', role: 'assistant', content: [
          { type: 'image', id: 'img-b', path: '/assistant.png', name: 'assistant.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
    ]
    const result = await estimateAccumulatedImageBytes(messages, fetchSize)
    expect(result.totalBytes).toBe(1024)
    expect(result.counted).toBe(1)
    expect(fetchSize).toHaveBeenCalledTimes(1)
    expect(fetchSize).toHaveBeenCalledWith('/user.png')
  })
})

// ── W4TC8：IMAGE_LIMITS 常量断言 ──

describe('IMAGE_LIMITS 常量（W4TC8）', () => {
  it('W4TC8 ACCUMULATION_WARN_BYTES_DEFAULT === 15MB', () => {
    expect(IMAGE_LIMITS.ACCUMULATION_WARN_BYTES_DEFAULT).toBe(15 * 1024 * 1024)
  })

  it('W4TC8 ACCUMULATION_HARD_BYTES_DEFAULT === 20MB', () => {
    expect(IMAGE_LIMITS.ACCUMULATION_HARD_BYTES_DEFAULT).toBe(20 * 1024 * 1024)
  })
})

// ── W4TC5-7：useChat.send 累积检查集成 ──

describe('useChat.send 累积 size cap（W4TC5-7）', () => {
  it('W4TC5 层 2：累积超 warnThreshold → toast.warning 不阻断 send', async () => {
    // 设置 warn=10MB, hard=20MB（自定义阈值）
    settingsState.system.imageAccumulationWarnMB = 10
    settingsState.system.imageAccumulationHardMB = 20

    // 预置历史消息：模拟累积 16MB
    const chat = useChatStore()
    chat.setMessages('s-accum', [
      {
        id: 'hist-1', role: 'user', content: [
          { type: 'image', id: 'img-h1', path: '/hist.png', name: 'hist.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
    ])

    // mock fetch：累积估算 fetchSize 返 16MB，extractImages fetch 返小图
    const sixteenMB = 16 * 1024 * 1024
    const smallBytes = new Uint8Array([0x89, 0x50])
    let fetchCallCount = 0
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockImplementation((url: string) => {
        fetchCallCount++
        // 第一次调用是 estimateAccumulatedImageBytes 的 fetchSize（读历史图片 size）
        // 后续调用是 extractImages 的 fetch（读当轮图片转 base64）
        if (url.includes('hist.png')) {
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(new Blob([new ArrayBuffer(sixteenMB)])),
          })
        }
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob([smallBytes.slice()], { type: 'image/png' })),
        })
      }) as unknown as typeof fetch,
    )

    const { send } = useChat()
    await send('s-accum', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-new', path: '/new.png', name: 'new.png' },
    ])

    // send 正常完成（不阻断）
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    // 第三参数是 images 数组（层 2 不剥离）
    const call = apiMock.send.mock.calls[0]!
    expect(Array.isArray(call[2])).toBe(true)

    // toast 含 accumulationWarnWarning
    const { toasts } = useToast()
    const warnToast = toasts.value.find(
      (tt) => tt.type === 'warning' && tt.message.includes('accumulation warn'),
    )
    expect(warnToast).toBeTruthy()
  })

  it('W4TC6 层 3：累积超 hardThreshold → images=undefined + toast.warning', async () => {
    settingsState.system.imageAccumulationWarnMB = 10
    settingsState.system.imageAccumulationHardMB = 20

    // 预置历史消息：模拟累积 22MB
    const chat = useChatStore()
    chat.setMessages('s-hard', [
      {
        id: 'hist-1', role: 'user', content: [
          { type: 'image', id: 'img-h1', path: '/big.png', name: 'big.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
    ])

    const twentyTwoMB = 22 * 1024 * 1024
    const smallBytes = new Uint8Array([0x89, 0x50])
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('big.png')) {
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(new Blob([new ArrayBuffer(twentyTwoMB)])),
          })
        }
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob([smallBytes.slice()], { type: 'image/png' })),
        })
      }) as unknown as typeof fetch,
    )

    const { send } = useChat()
    await send('s-hard', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-new', path: '/new.png', name: 'new.png' },
    ])

    // send 正常完成
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    // 第三参数 undefined（层 3 剥离）
    const call = apiMock.send.mock.calls[0]!
    expect(call[2]).toBeUndefined()

    // toast 含 accumulationHardWarning
    const { toasts } = useToast()
    const hardToast = toasts.value.find(
      (tt) => tt.type === 'warning' && tt.message.includes('accumulation hard'),
    )
    expect(hardToast).toBeTruthy()
  })

  it('W4TC7 正常路径：累积在 warn 以下 → 无 accumulation toast', async () => {
    settingsState.system.imageAccumulationWarnMB = 15
    settingsState.system.imageAccumulationHardMB = 20

    // 预置历史消息：模拟累积 5MB
    const chat = useChatStore()
    chat.setMessages('s-ok', [
      {
        id: 'hist-1', role: 'user', content: [
          { type: 'image', id: 'img-h1', path: '/small.png', name: 'small.png' },
        ] as Segment[], status: 'complete', timestamp: 0,
      },
    ])

    const fiveMB = 5 * 1024 * 1024
    const smallBytes = new Uint8Array([0x89, 0x50])
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('small.png')) {
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(new Blob([new ArrayBuffer(fiveMB)])),
          })
        }
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob([smallBytes.slice()], { type: 'image/png' })),
        })
      }) as unknown as typeof fetch,
    )

    const { send } = useChat()
    await send('s-ok', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-new', path: '/new.png', name: 'new.png' },
    ])

    // send 正常完成，images 正常透传
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)

    // 无 accumulation 相关 toast
    const { toasts } = useToast()
    const accumToast = toasts.value.find(
      (tt) => tt.type === 'warning' && tt.message.includes('accumulation'),
    )
    expect(accumToast).toBeUndefined()
  })
})

// 引用 useChatStore 避免 ts unused
void useChatStore
