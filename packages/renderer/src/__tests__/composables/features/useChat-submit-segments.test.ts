/**
 * useChat submitSegments 统一编排器单测（阶段 3a：renderer composables 层重构）。
 *
 * 覆盖核心交付：submitSegments 是 send / editAndResend 共享的「提取 + 发送」编排器，
 * 消除「editAndResend 绕过 extractImages / size cap / vision toast」的分裂。
 *
 * 关键测试用例：
 * - SS1: send(含 image) → chatApi.send 含 images 参数 + promptText 含 [图片 N] 占位
 * - SS2: editAndResend(含 image) → 委托 submitSegments → extractImages 被调（不再绕过）
 *        → chatApi.send 含 images（修复原 editAndResend 用 chatApi.send(trimmed) 绕过的 bug）
 * - SS3: editAndResend(text-only) → chatApi.send 第三参数 undefined（行为与 send 对齐）
 * - SS4: editAndResend 含图 + vision 降级 → toast 触发（统一通路继承 send 的降级）
 * - SS5: editAndResend 含图 + 累积超 hard 阈值 → images 剥离（统一通路继承 size cap 层 3）
 *
 * mock 策略：复用 useChat-send-images.test.ts / useChat-accumulation.test.ts 范式
 * （vi.hoisted apiMock + vi.mock settingsStore + i18n mock + mock fetch 控制 extractImages / 累积估算）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/features/useChat-submit-segments.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'

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

// ── settingsStore mock：providers（vision 判定）+ system（累积阈值）可控 ──
const settingsState = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; models: Array<{ id: string; input?: Array<'text' | 'image'> }> }>,
  system: {
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

// ── i18n mock：stub 降级文案，让 toast 内容可断言 ──
vi.mock('@/i18n', () => ({
  default: {
    global: {
      t: (key: string, args?: Record<string, unknown>) => {
        if (key === 'panel.visionNotSupportedWarning' && args) {
          return `不支持图片 model=${String(args.modelName)} count=${String(args.count)}`
        }
        if (key === 'panel.accumulationHardWarning' && args) {
          return `accumulation hard size=${String(args.size)}MB`
        }
        return key
      },
    },
  },
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/useChat'
import { useToast } from '@/composables/useToast'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  settingsState.providers = []
  settingsState.system.imageAccumulationWarnMB = undefined
  settingsState.system.imageAccumulationHardMB = undefined
  // 清空全局 toasts（useToast 模块级单例，跨用例共享）
  const { toasts } = useToast()
  toasts.value = []
})

/** mock global.fetch 让 extractImages 成功读图（返回小 PNG bytes）。 */
function mockFetchImageOk(): void {
  const bytes = new Uint8Array([0x89, 0x50])
  vi.spyOn(global, 'fetch', 'get').mockReturnValue(
    vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob([bytes.slice()], { type: 'image/png' })),
    }) as unknown as typeof fetch,
  )
}

// ── SS1: send(含 image) → submitSegments → chatApi.send 含 images ──

describe('submitSegments 统一通路：send', () => {
  it('SS1: send(含 image) → chatApi.send 含 images 数组 + promptText 含 [图片 1] 占位', async () => {
    mockFetchImageOk()
    const { send } = useChat()
    await send('ss-send', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', fileName: 'x-uuid.png', displayName: 'x.png' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-send')
    // promptText 含匿名编号占位（不暴露 fileName/displayName 给 LLM）
    expect(call[1]).toContain('[图片 1]')
    // 第三参数是 images 数组（submitSegments 提取后透传）
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)
    expect(call[2][0].mimeType).toBe('image/png')
  })
})

// ── SS2/SS3: editAndResend 委托 submitSegments（修复绕过 bug）──

describe('submitSegments 统一通路：editAndResend', () => {
  it('SS2: editAndResend(含 image) → 委托 submitSegments → chatApi.send 含 images（不再绕过）', async () => {
    mockFetchImageOk()
    const chat = useChatStore()
    // 先注入原 user message（供 truncateFrom 操作）
    chat.appendUser('ss-edit', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    // 阶段 3a：editAndResend 接收 segments（不再是 text 字符串），保留 image segments
    await editAndResend('ss-edit', userMsg.id, [
      { type: 'text', text: 'edited text' },
      { type: 'image', id: 'img-edit', path: '/tmp/edit.png', fileName: 'edit-uuid.png', displayName: 'edit.png' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-edit')
    // promptText 含编辑后文本 + 匿名编号占位
    expect(call[1]).toContain('edited text')
    expect(call[1]).toContain('[图片 1]')
    // 关键断言：第三参数是 images 数组（原 bug：editAndResend 用 chatApi.send(trimmed) 绕过提取，images 丢失）
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)
    expect(call[2][0].mimeType).toBe('image/png')
  })

  it('SS3: editAndResend(text-only) → chatApi.send 第三参数 undefined（与 send 对齐）', async () => {
    const chat = useChatStore()
    chat.appendUser('ss-edit-text', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit-text').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    await editAndResend('ss-edit-text', userMsg.id, [{ type: 'text', text: 'edited' }])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-edit-text')
    expect(call[1]).toBe('edited')
    // 无图 → 第三参数 undefined（行为不变）
    expect(call[2]).toBeUndefined()
  })
})

// ── SS4/SS5: 统一通路继承 send 的 vision 降级 + size cap ──

describe('submitSegments 统一通路：editAndResend 继承 send 的降级策略', () => {
  it('SS4: editAndResend 含图 + 不支持 vision → toast.warning 触发（统一通路继承 vision 降级）', async () => {
    mockFetchImageOk()
    // providers: 当前模型 input 仅 text（不支持 vision）
    settingsState.providers = [{ id: 'p1', models: [{ id: 'm1', input: ['text'] }] }]
    const { useSessionStore } = await import('@/stores/session')
    const sessionStore = useSessionStore()
    sessionStore.setGroups([
      { id: 'g1', label: 'G', sessions: [{ id: 'ss-edit-vision', label: 's', modelId: 'p1/m1' } as never] },
    ] as never)

    const chat = useChatStore()
    chat.appendUser('ss-edit-vision', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit-vision').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    await editAndResend('ss-edit-vision', userMsg.id, [
      { type: 'image', id: 'img-v', path: '/tmp/v.png', fileName: 'v-uuid.png', displayName: 'v.png' },
    ])

    // vision 降级 toast 触发（原 bug：editAndResend 绕过 submitSegments 时无此降级）
    const { toasts } = useToast()
    const visionToast = toasts.value.find((tt) => tt.type === 'warning' && tt.message.includes('不支持图片'))
    expect(visionToast).toBeTruthy()
    // images 仍透传（vision 降级不剥离）
    const call = apiMock.send.mock.calls[0]!
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)
  })

  it('SS5: editAndResend 含图 + 累积超 hard 阈值 → images 剥离（统一通路继承 size cap 层 3）', async () => {
    settingsState.system.imageAccumulationWarnMB = 10
    settingsState.system.imageAccumulationHardMB = 20

    // 预置历史消息：模拟累积 22MB（超 hard 阈值 20MB）
    const chat = useChatStore()
    chat.setMessages('ss-edit-cap', [
      {
        id: 'hist-1', role: 'user', content: [
          { type: 'image', id: 'img-h1', path: '/big.png', fileName: 'big.png', displayName: 'big.png' },
        ], status: 'complete', timestamp: 0,
      },
    ])

    // mock fetch：累积估算 fetchSize 返 22MB（读历史图），extractImages fetch 返小图（当轮）
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

    chat.appendUser('ss-edit-cap', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit-cap').find((m) => m.role === 'user' && m.id !== 'hist-1')!

    const { editAndResend } = useChat()
    await editAndResend('ss-edit-cap', userMsg.id, [
      { type: 'image', id: 'img-new', path: '/new.png', fileName: 'new.png', displayName: 'new.png' },
    ])

    // send 正常完成
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    // 第三参数 undefined（层 3 剥离 images，统一通路继承 size cap）
    const call = apiMock.send.mock.calls[0]!
    expect(call[2]).toBeUndefined()
    // accumulation hard toast 触发
    const { toasts } = useToast()
    const hardToast = toasts.value.find(
      (tt) => tt.type === 'warning' && tt.message.includes('accumulation hard'),
    )
    expect(hardToast).toBeTruthy()
  })
})

// 引用 useChatStore 避免 ts unused（与 useChat-send-images.test.ts 对齐）
void useChatStore
