/**
 * HandoffService 单元测试。
 *
 * 覆盖新同步流程：runHandoff 从历史组装文档 + 新建 session + 广播。
 * 不再依赖 pi skill / onTurnEnd / abort / cancelInflight。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HandoffService, REPLY_MAX_LENGTH, MAX_MESSAGES, MSG_TRUNCATE_LENGTH } from '../handoff-service.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { SessionService } from '../session/session-service.js'
import type { Message, Segment } from '@xyz-agent/shared'

function createMockSessionService(overrides: Partial<SessionService> = {}): SessionService {
  return {
    getHistory: vi.fn(),
    getSession: vi.fn(),
    create: vi.fn(),
    markHandedOff: vi.fn(),
    ...overrides,
  } as unknown as SessionService
}

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
  } as unknown as IMessageBroker
}

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `msg-${role}-${Date.now()}`,
    role,
    content,
    status: 'done' as const,
  } as Message
}

describe('HandoffService', () => {
  let sessionService: ReturnType<typeof createMockSessionService>
  let broker: ReturnType<typeof createMockBroker>
  let broadcastSessionList: ReturnType<typeof vi.fn>
  let nextPushId: ReturnType<typeof vi.fn>
  let service: HandoffService

  beforeEach(() => {
    sessionService = createMockSessionService()
    broker = createMockBroker()
    broadcastSessionList = vi.fn()
    nextPushId = vi.fn(() => 'push-123')
    service = new HandoffService({ sessionService, broker, broadcastSessionList, nextPushId })
  })

  it('TC1: runHandoff creates new session + broadcasts with doc', async () => {
    const messages = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi there'),
    ]
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({
      label: 'test-session',
      cwd: '/work',
    } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-session-id' } as never)

    await service.runHandoff('src-session-id')

    expect(sessionService.create).toHaveBeenCalledWith('/work', 'handoff from test-session')
    expect(sessionService.markHandedOff).toHaveBeenCalledWith('src-session-id', 'new-session-id')
    expect(broadcastSessionList).toHaveBeenCalled()
    expect(broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.handoffComplete',
        id: 'push-123',
        payload: expect.objectContaining({
          srcSessionId: 'src-session-id',
          newSessionId: 'new-session-id',
          sourceLabel: 'test-session',
          doc: expect.stringContaining('Handoff from test-session'),
          reply: undefined,
        }),
      }),
    )
    // doc should contain message content
    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { doc: string } }
    expect(call.payload.doc).toContain('**User:**')
    expect(call.payload.doc).toContain('hello')
    expect(call.payload.doc).toContain('**Assistant:**')
    expect(call.payload.doc).toContain('hi there')
  })

  it('TC2: runHandoff with reply includes reply in payload', async () => {
    const messages = [makeMessage('user', 'test'), makeMessage('assistant', 'done')]
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({ label: 's1', cwd: '/w' } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-id' } as never)

    await service.runHandoff('src-id', 'focus on the bug')

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { reply: string | undefined } }
    expect(call.payload.reply).toBe('focus on the bug')
  })

  it('TC2b: reply with newlines is sanitized', async () => {
    const messages = [makeMessage('user', 'test'), makeMessage('assistant', 'done')]
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({ label: 's1', cwd: '/w' } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-id' } as never)

    await service.runHandoff('src-id', 'line1\nline2\rline3')

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { reply: string | undefined } }
    expect(call.payload.reply).toBe('line1 line2 line3')
  })

  it('TC3: runHandoff on empty history throws', async () => {
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages: [], truncated: false })

    await expect(service.runHandoff('src-id')).rejects.toThrow('handoff: no history to handoff')
  })

  it('TC4: concurrent handoff rejected', async () => {
    // Use a deferred promise to keep first call inflight
    let resolveFirst!: (v: { messages: Message[]; truncated: false }) => void
    const firstBlocker = new Promise<{ messages: Message[]; truncated: false }>((resolve) => { resolveFirst = resolve })
    vi.mocked(sessionService.getHistory).mockReturnValueOnce(firstBlocker)

    // Start first handoff (will block on getHistory)
    const first = service.runHandoff('src-id').catch(() => {})

    // Wait a tick for the first call to enter the inflight set
    await new Promise((r) => setTimeout(r, 0))

    // Second attempt should be rejected while first is in flight
    await expect(service.runHandoff('src-id')).rejects.toThrow('handoff already in progress')

    // Let first complete (with empty history so it throws, but that's fine for the test)
    resolveFirst({ messages: [], truncated: false })
    await first
  })

  it('TC5: throws when session not found', async () => {
    const messages = [makeMessage('user', 'test'), makeMessage('assistant', 'done')]
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue(undefined)

    await expect(service.runHandoff('src-id')).rejects.toThrow('handoff: source session not found')
  })

  it('TC6: reply 截断 — 超长 reply 被截断到 REPLY_MAX_LENGTH', async () => {
    const messages = [makeMessage('user', 'test')]
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({ label: 's1', cwd: '/w' } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-id' } as never)

    const longReply = 'x'.repeat(6000)
    await service.runHandoff('src-id', longReply)

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { reply: string | undefined } }
    expect(call.payload.reply).toBeDefined()
    expect(call.payload.reply!.length).toBe(REPLY_MAX_LENGTH)
  })

  it('TC7: 单条消息截断 — 超长 content 带 truncated 后缀', async () => {
    const longContent = 'a'.repeat(3000)
    const messages = [makeMessage('user', longContent)]
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({ label: 's1', cwd: '/w' } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-id' } as never)

    await service.runHandoff('src-id')

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { doc: string } }
    expect(call.payload.doc).toContain('a'.repeat(MSG_TRUNCATE_LENGTH) + '...[truncated]')
    // 截断后不应包含完整 3000 字符
    expect(call.payload.doc).not.toContain('a'.repeat(3001))
  })

  it('TC8: MAX_MESSAGES 限制 — 30 条消息只取最后 20 条', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => makeMessage('user', `msg-${i}`))
    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages, truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({ label: 's1', cwd: '/w' } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-id' } as never)

    await service.runHandoff('src-id')

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { doc: string } }
    // 应包含 msg-10（第 20 条从后数，索引 10）到 msg-29
    expect(call.payload.doc).toContain('msg-10')
    expect(call.payload.doc).toContain('msg-29')
    // 不应包含 msg-9（被 MAX_MESSAGES 裁掉的前 10 条）
    expect(call.payload.doc).not.toContain('msg-9')
    expect(call.payload.doc).not.toContain('msg-0')
  })

  it('TC9: Segment[] content 正确提取文本', async () => {
    const segContent: Segment[] = [
      { type: 'text', text: 'hello ' } as Segment,
      { type: 'text', text: 'world' } as Segment,
    ]
    const msg: Message = {
      id: 'msg-seg',
      role: 'user',
      content: segContent,
      status: 'done' as const,
    } as unknown as Message

    vi.mocked(sessionService.getHistory).mockResolvedValue({ messages: [msg], truncated: false })
    vi.mocked(sessionService.getSession).mockReturnValue({ label: 's1', cwd: '/w' } as never)
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'new-id' } as never)

    await service.runHandoff('src-id')

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: { doc: string } }
    expect(call.payload.doc).toContain('hello world')
  })
})
