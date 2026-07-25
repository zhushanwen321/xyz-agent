/**
 * useChat send images 提取闭环单测（feature:add-file-picture-attach slice6 TC1-4/7-8/10）。
 *
 * 覆盖：
 * - TC1-4 extractImages：无图→undefined / 成功→images / 部分失败→只取成功 / 全失败→undefined
 * - TC7-8 useChat.send：含图→chatApi.send 带 images 参数 / 无图→第三参数 undefined（既有行为不变）
 * - TC10 vision 降级：不支持 vision + 含图 → console.warn 调用，images 仍透传（不剥离）
 *
 * mock 策略：
 * - extractImages 是 useChat 模块导出的纯函数（依赖 global.fetch）→ vi.spyOn(global,'fetch') mock Response
 * - useChat.send 集成：vi.hoisted apiMock 捕获 chatApi（复用 useChat.test.ts 范式）+
 *   vi.mock settingsStore 注入 providers 控制 vision 判定 + mock session.list 注入 modelId
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/features/useChat-send-images.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, Segment } from '@xyz-agent/shared'

// ── api mock（chatApi.send/steer/streamSubscribe 等，复用 useChat.test.ts 范式）──
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
const settingsState = vi.hoisted(() => ({ providers: [] as Array<{ id: string; models: Array<{ id: string; input?: Array<'text' | 'image'> }> }> }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ providers: settingsState.providers }),
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState, extractImages } from '@/composables/features/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  settingsState.providers = []
})

/** 合成 local-file fetch Response（ok=true，blob 含给定字节）。 */
function mockFetchOk(bytes: Uint8Array, type = 'image/png'): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob([bytes.slice()], { type })),
  }) as unknown as typeof fetch
}

describe('extractImages（slice6 TC1-TC4）', () => {
  it('TC1 无 image segment → 返回 undefined，不调 fetch', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const segments: Segment[] = [{ type: 'text', text: 'hello' }]
    const result = await extractImages(segments)
    expect(result).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('TC2 含 image segment fetch 成功 → 返回 [{data;base64;mimeType}]，URL 含 encodeURIComponent path', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fetchSpy = mockFetchOk(bytes)
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(fetchSpy)

    const segments: Segment[] = [{ type: 'image', id: 'img-1', path: '/tmp/a b.png', name: 'a b.png' }]
    const result = await extractImages(segments)

    expect(result).toHaveLength(1)
    expect(result![0].mimeType).toBe('image/png')
    // base64 of [0x89,0x50,0x4e,0x47]
    expect(result![0].data).toBe(btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)))
    // URL 含 encodeURIComponent（空格编码为 %20）
    expect(fetchSpy).toHaveBeenCalledWith('local-file:///' + encodeURIComponent('/tmp/a b.png'))
  })

  it('TC3 多图 allSettled 部分失败 → 只取成功的，console.warn 跳过失败的，不 throw', async () => {
    const bytes = new Uint8Array([0xff, 0xd8])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          blob: () => Promise.resolve(new Blob([bytes.slice()], { type: 'image/jpeg' })),
        })
        .mockRejectedValueOnce(new Error('403')) as unknown as typeof fetch,
    )

    const segments: Segment[] = [
      { type: 'image', id: 'img-a', path: '/tmp/a.jpg', name: 'a.jpg' },
      { type: 'image', id: 'img-b', path: '/tmp/b.jpg', name: 'b.jpg' },
    ]
    const result = await extractImages(segments)

    expect(result).toHaveLength(1)
    expect(result![0].mimeType).toBe('image/jpeg')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // 路径在 warn 首参（reason 是次参）
    expect(String(warnSpy.mock.calls[0]![0])).toContain('/tmp/b.jpg')
  })

  it('TC4 全部失败 → 返回 undefined，console.warn 每图一次，不 throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockRejectedValue(new Error('403')) as unknown as typeof fetch,
    )

    const segments: Segment[] = [
      { type: 'image', id: 'img-a', path: '/tmp/a.png', name: 'a.png' },
      { type: 'image', id: 'img-b', path: '/tmp/b.png', name: 'b.png' },
    ]
    const result = await extractImages(segments)

    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useChat.send images 透传（slice6 TC7-TC8）', () => {
  it('TC8 无 image → chatApi.send 第三参数 undefined（既有行为不变）', async () => {
    const { send } = useChat()
    await send('s-text', [{ type: 'text', text: 'hi' }])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('s-text')
    expect(call[1]).toBe('hi')
    // 第三参数 undefined（无图行为不变）
    expect(call[2]).toBeUndefined()
  })

  it('TC7 含 image（extractImages 成功）→ chatApi.send 被以 images 数组调用', async () => {
    // mock fetch 让 extractImages 成功读图
    const bytes = new Uint8Array([0x89, 0x50])
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob([bytes.slice()], { type: 'image/png' })),
      }) as unknown as typeof fetch,
    )

    const { send } = useChat()
    await send('s-img', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', name: 'x.png' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('s-img')
    // promptText 含 [图片: x.png] 占位
    expect(call[1]).toContain('[图片: x.png]')
    // 第三参数是 images 数组（长度1）
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)
    expect(call[2][0].mimeType).toBe('image/png')
  })
})

describe('useChat.send vision 降级（slice6 TC10）', () => {
  it('TC10 不支持 vision + 含图 → console.warn 调用，images 仍透传（不剥离）', async () => {
    // providers: 当前模型 input 仅 text（不支持 vision）
    settingsState.providers = [{ id: 'p1', models: [{ id: 'm1', input: ['text'] }] }]
    // session.list 注入 modelId='p1/m1'（send 按 sid 取 modelId）
    const { useSessionStore } = await import('@/stores/session')
    const sessionStore = useSessionStore()
    sessionStore.setGroups([
      { id: 'g1', label: 'G', sessions: [{ id: 's-img', label: 's', modelId: 'p1/m1' } as never] },
    ] as never)

    const bytes = new Uint8Array([0x89, 0x50])
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob([bytes.slice()], { type: 'image/png' })),
      }) as unknown as typeof fetch,
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { send } = useChat()
    await send('s-img', [{ type: 'image', id: 'img-x', path: '/tmp/x.png', name: 'x.png' }])

    // vision 降级 warn 被调用（含「不支持图片」）
    const visionWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes('不支持图片'))
    expect(visionWarn).toBeTruthy()
    // images 仍透传（不剥离）—— chatApi.send 第3参数是非空数组
    const call = apiMock.send.mock.calls[0]!
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)
  })

  it('TC10b 支持 vision + 含图 → 无 vision 降级 warn，images 正常透传', async () => {
    settingsState.providers = [{ id: 'p1', models: [{ id: 'm1', input: ['text', 'image'] }] }]
    const { useSessionStore } = await import('@/stores/session')
    const sessionStore = useSessionStore()
    sessionStore.setGroups([
      { id: 'g1', label: 'G', sessions: [{ id: 's-img2', label: 's', modelId: 'p1/m1' } as never] },
    ] as never)

    const bytes = new Uint8Array([0x89, 0x50])
    vi.spyOn(global, 'fetch', 'get').mockReturnValue(
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob([bytes.slice()], { type: 'image/png' })),
      }) as unknown as typeof fetch,
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { send } = useChat()
    await send('s-img2', [{ type: 'image', id: 'img-y', path: '/tmp/y.png', name: 'y.png' }])

    // 无 vision 降级 warn（extractImages 成功路径也不 warn）
    const visionWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes('不支持图片'))
    expect(visionWarn).toBeUndefined()
    // images 透传
    const call = apiMock.send.mock.calls[0]!
    expect(Array.isArray(call[2])).toBe(true)
    expect(call[2]).toHaveLength(1)
  })
})

// 引用 useChatStore 避免 ts unused（与 useChat.test.ts 对齐）
void useChatStore
