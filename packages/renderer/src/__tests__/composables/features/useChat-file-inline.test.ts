/**
 * useChat send file inline 透传集成测试（w5 W5TC5-9, W5TC14-15）。
 *
 * 覆盖：
 * - W5TC5-9 extractFileContexts（空/正常/超限不进Map/超行截断/部分失败）
 * - W5TC14-15 useChat.send 集成（正常/降级）
 *
 * mock 策略：复用 useChat-send-images.test.ts 范式（vi.hoisted apiMock + i18n mock）。
 * 额外 mock fileApi.read 控制 file.read IPC 返回值。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/features/useChat-file-inline.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, Segment } from '@xyz-agent/shared'
import { INLINE_TEXT_MAX_LINES } from '@xyz-agent/shared'

// ── api mock（chatApi + fileApi）──
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
    // fileApi.read mock
    fileRead: vi.fn(() => Promise.resolve({ content: '', truncated: false })),
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
  file: {
    read: apiMock.fileRead,
  },
  session: {},
}))

// ── settingsStore mock ──
const settingsState = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; models: Array<{ id: string; input?: Array<'text' | 'image'> }> }>,
  system: {} as Record<string, unknown>,
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ providers: settingsState.providers, system: settingsState.system }),
}))

// ── i18n mock ──
vi.mock('@/i18n', () => ({
  default: {
    global: {
      t: (key: string) => key,
    },
  },
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState, extractFileContexts } from '@/composables/features/useChat'
import { useToast } from '@/composables/useToast'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  settingsState.providers = []
  settingsState.system = {}
  const { toasts } = useToast()
  toasts.value = []
})

// ── W5TC5-9: extractFileContexts ─────────────────────────────────

describe('extractFileContexts（W5TC5-9）', () => {
  it('W5TC5 无 file segment → 空 Map，readFile 不被调用', async () => {
    const readFile = vi.fn()
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    const result = await extractFileContexts(segments, readFile)
    expect(result.size).toBe(0)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('W5TC6 小文本文件 → 读取内容进 Map，truncated=false', async () => {
    const content = 'const x = 1'
    const readFile = vi.fn().mockResolvedValue({ content, sizeBytes: 1024 })
    const segments: Segment[] = [{ type: 'file', path: '/src/index.ts' }]
    const result = await extractFileContexts(segments, readFile)
    expect(result.size).toBe(1)
    const ctx = result.get('/src/index.ts')!
    expect(ctx.path).toBe('/src/index.ts')
    expect(ctx.content).toBe(content)
    expect(ctx.truncated).toBe(false)
    expect(ctx.sizeBytes).toBe(1024)
  })

  it('W5TC7 超 50KB 文件 → shouldInlineFile 返回 false，不进 Map', async () => {
    const content = 'x'.repeat(60 * 1024)
    const readFile = vi.fn().mockResolvedValue({ content, sizeBytes: 60 * 1024 })
    const segments: Segment[] = [{ type: 'file', path: '/src/big.ts' }]
    const result = await extractFileContexts(segments, readFile)
    expect(result.size).toBe(0)
    expect(result.has('/src/big.ts')).toBe(false)
  })

  it('W5TC8 超 500 行 → 截断到 INLINE_TEXT_MAX_LINES 行，truncated=true', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const readFile = vi.fn().mockResolvedValue({ content, sizeBytes: 30 * 1024 })
    const segments: Segment[] = [{ type: 'file', path: '/src/long.ts' }]
    const result = await extractFileContexts(segments, readFile)
    const ctx = result.get('/src/long.ts')!
    expect(ctx.truncated).toBe(true)
    const resultLines = ctx.content.split('\n')
    expect(resultLines.length).toBe(INLINE_TEXT_MAX_LINES)
    expect(resultLines[0]).toBe('line 1')
    expect(resultLines[INLINE_TEXT_MAX_LINES - 1]).toBe(`line ${INLINE_TEXT_MAX_LINES}`)
  })

  it('W5TC9 readFile 失败 → console.warn 跳过，不阻断其他文件', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readFile = vi.fn()
      .mockResolvedValueOnce({ content: 'ok', sizeBytes: 100 })
      .mockRejectedValueOnce(new Error('ENOENT'))
    const segments: Segment[] = [
      { type: 'file', path: '/src/a.ts' },
      { type: 'file', path: '/src/b.ts' },
    ]
    const result = await extractFileContexts(segments, readFile)
    expect(result.size).toBe(1)
    expect(result.has('/src/a.ts')).toBe(true)
    expect(result.has('/src/b.ts')).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('/src/b.ts')
    warnSpy.mockRestore()
  })

  it('非白名单扩展名 readFile 仍被调用（先读后判断）', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'binary', sizeBytes: 1024 })
    const segments: Segment[] = [{ type: 'file', path: '/img/photo.png' }]
    const result = await extractFileContexts(segments, readFile)
    expect(result.size).toBe(0)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('file segment 有 lineRange → FileContext 保留 lineRange', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'code', sizeBytes: 100 })
    const segments: Segment[] = [{ type: 'file', path: '/src/index.ts', lineRange: [10, 20] }]
    const result = await extractFileContexts(segments, readFile)
    const ctx = result.get('/src/index.ts')!
    expect(ctx.lineRange).toEqual([10, 20])
  })
})

// ── W5TC14-15: useChat.send 集成 ─────────────────────────────────

describe('useChat.send file inline 透传（W5TC14-15）', () => {
  it('W5TC14 含 file segment → chatApi.send content 含 <file> 标签', async () => {
    // mock fileApi.read 返回小 .ts 文件
    apiMock.fileRead.mockResolvedValue({ content: 'const x = 1', truncated: false })

    const { send } = useChat()
    await send('s-file', [
      { type: 'file', path: '/src/index.ts' },
      { type: 'text', text: 'review this' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('s-file')
    // content 应含 <file> 标签（非原 path）
    expect(call[1]).toContain('<file path="/src/index.ts">')
    expect(call[1]).toContain('const x = 1')
    expect(call[1]).toContain('</file>')
    expect(call[1]).toContain('review this')
    // 第三参数 undefined（无 image）
    expect(call[2]).toBeUndefined()
  })

  it('W5TC15 file.read 失败 → 降级为原 path 输出', async () => {
    // mock fileApi.read reject
    apiMock.fileRead.mockRejectedValue(new Error('ENOENT'))

    const { send } = useChat()
    await send('s-file-fail', [
      { type: 'file', path: '/src/missing.ts' },
      { type: 'text', text: 'review' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('s-file-fail')
    // 降级：原 path 输出（无 <file> 标签）
    expect(call[1]).toContain('/src/missing.ts')
    expect(call[1]).not.toContain('<file')
    expect(call[1]).toContain('review')
  })

  it('无 file segment → 行为不变（fileApi.read 不被调用）', async () => {
    const { send } = useChat()
    await send('s-no-file', [{ type: 'text', text: 'hi' }])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[1]).toBe('hi')
    // fileApi.read 不被调用（无 file segment）
    expect(apiMock.fileRead).not.toHaveBeenCalled()
  })
})

// 引用 useChatStore 避免 ts unused
void useChatStore
