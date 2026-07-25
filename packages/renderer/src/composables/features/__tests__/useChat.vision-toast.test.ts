/**
 * useChat vision-toast 降级单测（w1-vision-toast W1TC1-TC6）。
 *
 * 覆盖：模型不支持图片输入时，用户可见 toast + per-session-model 去重 + session 隔离。
 *   - W1TC1: images 非空 + 无 vision → warning 调用 1 次，文案含 modelId + count
 *   - W1TC2: 同 session 同 modelId 第二次 send → warning 共 1 次（去重）
 *   - W1TC3: 同 session 切 modelId → warning 共 2 次
 *   - W1TC4: vision 模型 → warning 0 次，send 正常调用
 *   - W1TC5: 无图片 → warning 0 次（不误报）
 *   - W1TC6: 切 session 后同 modelId → warning 共 2 次（session 隔离）
 *
 * mock 策略（对齐 useChat-send-images.test.ts 范式）：
 *   - vi.mock('@/api')：拦截 chatApi.send/streamSubscribe，验证 send 不阻断
 *   - vi.mock('@/stores/settings')：注入 providers 控制 resolveSupportsVision 判定
 *   - useSessionStore / useChatStore / useToast / useSessionScopedState：真实实现
 *     （测 session 隔离需真实分区，不能 mock useSessionScopedState）
 *   - global.fetch：mock 返回 image blob 让 extractImages 成功
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/__tests__/useChat.vision-toast.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'

// ── api mock（chatApi.send/steer/streamSubscribe 等）──
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

// ── settingsStore mock：providers 可控（vision 判定）──
type ProviderStub = { id: string; models: Array<{ id: string; input?: Array<'text' | 'image'> }> }
const settingsState = vi.hoisted(() => ({ providers: [] as ProviderStub[] }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ providers: settingsState.providers }),
}))

// ── i18n mock：测试环境 i18n.global.t 不解析（vue-i18n composition 模式需 setup），
// stub 一个可控 t，让 toast 文案可断言 modelName/count 是否被正确传入。
// 用 [vision] 前缀 + 关键参数拼接，断言时只关心参数是否正确传递（非真实文案）。
vi.mock('@/i18n', () => ({
  default: {
    global: {
      t: (key: string, args?: Record<string, unknown>) => {
        if (key === 'panel.visionNotSupportedWarning' && args) {
          return `[vision] model=${String(args.modelName)} count=${String(args.count)}`
        }
        return key
      },
    },
  },
}))

import { useChat, resetChatModuleState } from '@/composables/features/useChat'
import { useToast } from '@/composables/useToast'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  __clearSessionCleanupRegistryForTest()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  settingsState.providers = []
  // 清空全局 toasts（useToast 模块级单例，跨用例共享）
  useToast().toasts.value = []
})

/** 不支持 vision 的 provider：p1/m1 仅 text */
const NO_VISION_PROVIDERS: ProviderStub[] = [
  { id: 'p1', models: [{ id: 'm1', input: ['text'] }] },
]
/** 支持 vision 的 provider：p2/m2 含 image */
const VISION_PROVIDERS: ProviderStub[] = [
  { id: 'p2', models: [{ id: 'm2', input: ['text', 'image'] }] },
]

/** mock global.fetch 返回图片 blob（extractImages 成功路径）。 */
function mockFetchImageOk(): void {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  vi.spyOn(global, 'fetch', 'get').mockReturnValue(
    vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob([bytes.slice()], { type: 'image/png' })),
    }) as unknown as typeof fetch,
  )
}

/** 注入 session group（单 session，给定 modelId）。 */
async function setSessionModel(sessionId: string, modelId: string): Promise<void> {
  const { useSessionStore } = await import('@/stores/session')
  useSessionStore().setGroups([
    { id: 'g1', label: 'G', sessions: [{ id: sessionId, label: 's', modelId } as never] },
  ] as never)
}

/** 构造含 N 张图的 segments（+ 1 段文本满足 segmentsToPrompt 非空守卫）。 */
function imageSegments(count: number): Array<{ type: 'image'; id: string; path: string; name: string }> {
  return Array.from({ length: count }, (_, i) => ({
    type: 'image' as const,
    id: `img-${i}`,
    path: `/tmp/img-${i}.png`,
    name: `img-${i}.png`,
  }))
}

describe('useChat vision-toast 降级（W1TC1-TC6）', () => {
  it('W1TC1: images 非空 + 无 vision → warning 调用 1 次，文案含 modelId + count', async () => {
    settingsState.providers = NO_VISION_PROVIDERS
    await setSessionModel('s-a', 'p1/m1')
    mockFetchImageOk()

    const { send } = useChat()
    await send('s-a', [...imageSegments(2), { type: 'text', text: 'look' }])

    const { toasts } = useToast()
    const warnings = toasts.value.filter((tt) => tt.type === 'warning')
    expect(warnings).toHaveLength(1)
    // 文案含 modelId + count（mock t 输出 model=/count= 以验证参数传递）
    expect(warnings[0].message).toContain('model=p1/m1')
    expect(warnings[0].message).toContain('count=2')
    // send 不阻断（images 透传）
    expect(apiMock.send).toHaveBeenCalledTimes(1)
  })

  it('W1TC2: 同 session 同 modelId 第二次 send → warning 共 1 次（去重）', async () => {
    settingsState.providers = NO_VISION_PROVIDERS
    await setSessionModel('s-b', 'p1/m1')
    mockFetchImageOk()

    const { send } = useChat()
    // 同 useChat() 实例 + 同 sid + 同 modelId 连发两次。
    // 首次 send 后 isActive=true（pendingSend），需 complete 复位否则第二次 send 转向 steer。
    await send('s-b', [...imageSegments(1), { type: 'text', text: 'one' }])
    if (apiMock.holder.handler) {
      apiMock.holder.handler({ type: 'message.complete', payload: { sessionId: 's-b' } })
    }
    await send('s-b', [...imageSegments(1), { type: 'text', text: 'two' }])

    const { toasts } = useToast()
    const warnings = toasts.value.filter((tt) => tt.type === 'warning')
    // 去重：第二次不重复警告
    expect(warnings).toHaveLength(1)
    // send 均发出（去重不阻断发送）
    expect(apiMock.send).toHaveBeenCalledTimes(2)
  })

  it('W1TC3: 同 session 切 modelId → warning 共 2 次', async () => {
    // 两个不支持 vision 的 model（不同 id）
    settingsState.providers = [
      { id: 'p1', models: [{ id: 'm1', input: ['text'] }, { id: 'm1b', input: ['text'] }] },
    ]
    await setSessionModel('s-c', 'p1/m1')
    mockFetchImageOk()

    const { send } = useChat()
    const { useSessionStore } = await import('@/stores/session')
    const sessionStore = useSessionStore()

    // 第一次 m1 触发警告
    await send('s-c', [...imageSegments(1), { type: 'text', text: 'a' }])
    // 复位 streaming 态（否则第二次 send 转向 steer）
    if (apiMock.holder.handler) {
      apiMock.holder.handler({ type: 'message.complete', payload: { sessionId: 's-c' } })
    }
    // 切到 m1b（仍不支持 vision，但 modelId 变了，应再次警告）
    sessionStore.updateSessionState('s-c', { modelId: 'p1/m1b' })
    await send('s-c', [...imageSegments(1), { type: 'text', text: 'b' }])

    const { toasts } = useToast()
    const warnings = toasts.value.filter((tt) => tt.type === 'warning')
    expect(warnings).toHaveLength(2)
    // 两次文案对应不同 modelId（mock t 输出 model=xxx）
    expect(warnings.some((w) => w.message.includes('model=p1/m1'))).toBe(true)
    expect(warnings.some((w) => w.message.includes('model=p1/m1b'))).toBe(true)
  })

  it('W1TC4: vision 模型 → warning 0 次，send 正常调用', async () => {
    settingsState.providers = VISION_PROVIDERS
    await setSessionModel('s-d', 'p2/m2')
    mockFetchImageOk()

    const { send } = useChat()
    await send('s-d', [...imageSegments(3), { type: 'text', text: 'look' }])

    const { toasts } = useToast()
    const warnings = toasts.value.filter((tt) => tt.type === 'warning')
    // 支持 vision：不触发降级 toast
    expect(warnings).toHaveLength(0)
    // send 正常调用，images 透传
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(3)
  })

  it('W1TC5: 无图片 → warning 0 次（不误报）', async () => {
    settingsState.providers = NO_VISION_PROVIDERS
    await setSessionModel('s-e', 'p1/m1')

    const { send } = useChat()
    await send('s-e', [{ type: 'text', text: 'plain text only' }])

    const { toasts } = useToast()
    const warnings = toasts.value.filter((tt) => tt.type === 'warning')
    // 无图：不触发降级（不误报）
    expect(warnings).toHaveLength(0)
    // send 正常调用
    expect(apiMock.send).toHaveBeenCalledTimes(1)
  })

  it('W1TC6: 切 session 后同 modelId → warning 共 2 次（session 隔离）', async () => {
    settingsState.providers = NO_VISION_PROVIDERS
    // 两个 session，同 modelId（去重表应按 session 分区，互不影响）
    const { useSessionStore } = await import('@/stores/session')
    useSessionStore().setGroups([
      {
        id: 'g1',
        label: 'G',
        sessions: [
          { id: 's-f', label: 'f', modelId: 'p1/m1' } as never,
          { id: 's-g', label: 'g', modelId: 'p1/m1' } as never,
        ],
      },
    ] as never)
    mockFetchImageOk()

    const { send } = useChat()
    // session A 警告一次
    await send('s-f', [...imageSegments(1), { type: 'text', text: 'in f' }])
    // session B 同 modelId：因 session 隔离应再次警告
    await send('s-g', [...imageSegments(1), { type: 'text', text: 'in g' }])

    const { toasts } = useToast()
    const warnings = toasts.value.filter((tt) => tt.type === 'warning')
    // session 隔离：两个 session 各警告一次
    expect(warnings).toHaveLength(2)
  })
})
