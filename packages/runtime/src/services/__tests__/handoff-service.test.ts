/**
 * HandoffService 单元测试（agent-driven）。
 *
 * 覆盖新流程：runHandoff 让源 session 跑 handoff turn → 从 agent_end 提取 doc →
 * 新建 session + 注入 doc + 广播（无 doc/reply 字段，DM3）。abort / timeout /
 * 空文档 / 并发守卫 / extractFinalTextFromAgentEnd / buildHandoffPrompt 全覆盖。
 *
 * 测试框架：vitest（禁止 node:test）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  HandoffService,
  HANDOFF_TIMEOUT_MS,
  HANDOFF_EXIT_POLL_MS,
  extractFinalTextFromAgentEnd,
} from '../handoff-service.js'
import { HANDOFF_PROMPT_TEMPLATE, REPLY_MAX_LENGTH, buildHandoffPrompt } from '../handoff-prompt.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { SessionService } from '../session/session-service.js'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { Message } from '@xyz-agent/shared'

/**
 * Mock IPiEngine：记录 onEvent 注册的 listener，提供 emit 触发。
 * prompt/abort 默认立即 resolve（fire-and-forget ack）。
 */
interface MockClient {
  prompt: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  exited: boolean
  _listeners: Set<(event: unknown) => void>
  /** 触发所有已注册 listener（单参数 event，符合 PiEventListener 签名）。 */
  emit(event: unknown): void
}

function createMockClient(): MockClient {
  const listeners = new Set<(event: unknown) => void>()
  const client: MockClient = {
    prompt: vi.fn(async () => ({})),
    abort: vi.fn(async () => ({})),
    exited: false,
    _listeners: listeners,
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    emit(event: unknown) {
      for (const l of listeners) l(event)
    },
  }
  return client
}

function createMockSessionService(opts: {
  srcSessionId: string
  newSessionId?: string
  srcClient: MockClient
  newClient: MockClient
}): SessionService {
  const newSessionId = opts.newSessionId ?? 'new-1'
  return {
    getHistory: vi.fn(async () => ({
      messages: [makeMessage('user', 'hi')] as Message[],
      truncated: false,
    })),
    getSession: vi.fn(() => ({
      cwd: '/tmp',
      label: 'src',
      sessionFilePath: '/tmp/s.json',
    })) as unknown as SessionService['getSession'],
    create: vi.fn(async () => ({
      id: newSessionId,
      label: 'handoff from src',
      cwd: '/tmp',
    })) as unknown as SessionService['create'],
    markHandedOff: vi.fn() as unknown as SessionService['markHandedOff'],
    ensureActive: vi.fn(async (sessionId: string) => {
      if (sessionId === opts.srcSessionId) return opts.srcClient as unknown as IPiEngine
      if (sessionId === newSessionId) return opts.newClient as unknown as IPiEngine
      throw new Error(`ensureActive: unexpected sessionId ${sessionId}`)
    }) as unknown as SessionService['ensureActive'],
  } as unknown as SessionService
}

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
  } as unknown as IMessageBroker
}

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `msg-${role}`,
    role,
    content,
    status: 'done' as const,
  } as unknown as Message
}

describe('HandoffService', () => {
  let broker: ReturnType<typeof createMockBroker>
  let broadcastSessionList: () => void
  let nextPushId: () => string
  let srcClient: MockClient
  let newClient: MockClient
  let sessionService: SessionService
  let service: HandoffService

  beforeEach(() => {
    broker = createMockBroker()
    broadcastSessionList = vi.fn()
    nextPushId = vi.fn(() => 'push-123')
    srcClient = createMockClient()
    newClient = createMockClient()
    sessionService = createMockSessionService({
      srcSessionId: 'src-1',
      newSessionId: 'new-1',
      srcClient,
      newClient,
    })
    service = new HandoffService({ sessionService, broker, broadcastSessionList, nextPushId })
  })

  it('TC1: runHandoff 主路径 — agent_end 提取 doc，新建 session 注入 doc，广播无 doc/reply', async () => {
    const runPromise = service.runHandoff('src-1')

    // 等一微任务让 ensureActive + onEvent + prompt 注册完成
    await new Promise((r) => setTimeout(r, 0))

    expect(srcClient.onEvent).toHaveBeenCalled()
    expect(srcClient.prompt).toHaveBeenCalledTimes(1)
    expect(srcClient.prompt).toHaveBeenCalledWith(expect.stringContaining(HANDOFF_PROMPT_TEMPLATE))

    // emit agent_end with text content
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc content' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // new session 注入 doc
    expect(newClient.prompt).toHaveBeenCalledWith('doc content')
    // 广播
    expect(broadcastSessionList).toHaveBeenCalled()
    expect(broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.handoffComplete',
        id: 'push-123',
        payload: {
          srcSessionId: 'src-1',
          newSessionId: 'new-1',
          sourceLabel: 'src',
        },
      }),
    )
    // payload 不含 doc / reply 字段（DM3 协议变更）
    // W5：也不含多余的 sessionId（协议类型只有 srcSessionId/newSessionId/sourceLabel，
    // sessionId 会被前端 routeInbound 误当路由字段）
    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: Record<string, unknown> }
    expect(call.payload).not.toHaveProperty('doc')
    expect(call.payload).not.toHaveProperty('reply')
    expect(call.payload).not.toHaveProperty('sessionId')

    // listener 已清理（detach 调用 → _listeners 空 → inflight 清空）
    expect(srcClient._listeners.size).toBe(0)
    // inflight 已清空：再调 runHandoff 不会同步 reject 'already in progress'
    // （会卡在 await agentEndPromise，我们立即 abort 掉避免悬挂）
    const again = service.runHandoff('src-1').catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    await service.abortHandoff('src-1')
    await again
  })

  it('TC2: reply 追加到 prompt；广播无 reply 字段', async () => {
    const runPromise = service.runHandoff('src-1', 'focus on tests')
    await new Promise((r) => setTimeout(r, 0))

    expect(srcClient.prompt).toHaveBeenCalledWith(
      expect.stringContaining('focus on tests'),
    )
    expect(srcClient.prompt).toHaveBeenCalledWith(
      expect.stringContaining(HANDOFF_PROMPT_TEMPLATE),
    )

    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'd' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await runPromise

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: Record<string, unknown> }
    expect(call.payload).not.toHaveProperty('reply')
  })

  it('TC3: agent_end 末条 content 无 text → rejects（empty），create 未调，未广播', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    srcClient.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'write', input: {} }],
          stopReason: 'stop',
        },
      ],
      willRetry: false,
    })

    await expect(runPromise).rejects.toThrow('empty')
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC4: timeout — 不 emit agent_end，advance timer → rejects（timeout），create 未调', async () => {
    vi.useFakeTimers()
    try {
      const runPromise = service.runHandoff('src-1')
      // 预挂 catch，避免 timer 触发的 reject 在 await expect 之前成为 unhandled rejection
      const expectPromise = expect(runPromise).rejects.toThrow('timeout')
      // 让 ensureActive / onEvent / prompt（async resolve）跑完
      await vi.advanceTimersByTimeAsync(0)

      // 推进到超时
      await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS)

      await expectPromise
      expect(sessionService.create).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TC5: 并发守卫 — 同 session 再调 runHandoff 同步 reject（already in progress）', async () => {
    // 第一次不 emit agent_end，保持 pending
    const first = service.runHandoff('src-1').catch(() => {})
    await new Promise((r) => setTimeout(r, 0))

    await expect(service.runHandoff('src-1')).rejects.toThrow('already in progress')

    // 让第一个干净收尾（emit 空 doc 触发 reject 清理 inflight）
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await first
  })

  it('TC6: abortHandoff — abort 调用，runHandoff rejects（abort），未广播，返回 true', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    await expect(service.abortHandoff('src-1')).resolves.toBe(true)

    expect(srcClient.abort).toHaveBeenCalledTimes(1)
    await expect(runPromise).rejects.toThrow('abort')
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC7: abortHandoff 幂等 — inflight 空时 no-op，abort 未调，返回 false', async () => {
    await expect(service.abortHandoff('src-1')).resolves.toBe(false) // no-op，不抛
    expect(srcClient.abort).not.toHaveBeenCalled()
  })

  it('TC8: abort 失败兜底 — abort 抛错，abortHandoff 仍 resolve（true），runHandoff rejects（abort），console.warn 被调', async () => {
    srcClient.abort = vi.fn(async () => {
      throw new Error('pi dead')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    await expect(service.abortHandoff('src-1')).resolves.toBe(true)
    await expect(runPromise).rejects.toThrow('abort')

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('TC8b: W3 pi 中途退出 — srcClient.exited=true 后 runHandoff rejects（source pi exited），不挂到 timeout', async () => {
    vi.useFakeTimers()
    try {
      const runPromise = service.runHandoff('src-1')
      // 预挂 catch，避免 reject 成为 unhandled rejection
      const expectPromise = expect(runPromise).rejects.toThrow('source pi exited')
      // 让 ensureActive / onEvent / prompt（async resolve）跑完
      await vi.advanceTimersByTimeAsync(0)

      // 模拟 pi 中途崩溃：srcClient.exited 置 true
      srcClient.exited = true
      // 推进一个轮询间隔（HANDOFF_EXIT_POLL_MS）让退出探测定时器命中
      await vi.advanceTimersByTimeAsync(HANDOFF_EXIT_POLL_MS)

      await expectPromise
      // 远未到 timeout（10 分钟），证明 exit 探测命中而非超时
      expect(broker.broadcast).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TC8c: W4 settle 后 abort no-op — agent_end resolve 后再 abort 不抛错且广播未发（已 settle 的 promise 不再 reject）', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    // emit agent_end → finalize resolve（内部已 cleanupInflight 移除 entry）
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await runPromise

    // settle 后再 abort：inflight 已空 → no-op 返回 false（不广播、不重复 reject）
    await expect(service.abortHandoff('src-1')).resolves.toBe(false)
    // runHandoff 主路径已广播 session.handoffComplete，不应再叠加 handoffAborted
    const aborted = vi.mocked(broker.broadcast).mock.calls.some(
      (c) => (c[0] as { type?: string }).type === 'session.handoffAborted',
    )
    expect(aborted).toBe(false)
  })

  describe('extractFinalTextFromAgentEnd', () => {
    it('TC9a: 正常单 text block', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ])
      expect(result).toBe('hello')
    })

    it('TC9b: 多 text block join', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      ])
      expect(result).toBe('hello world')
    })

    it('TC9c: messages undefined → ""', () => {
      expect(extractFinalTextFromAgentEnd(undefined)).toBe('')
    })

    it('TC9d: messages 空数组 → ""', () => {
      expect(extractFinalTextFromAgentEnd([])).toBe('')
    })

    it('TC9e: 末条 content 非 text（tool_use）→ ""', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write', input: {} }] },
      ])
      expect(result).toBe('')
    })

    it('TC9f: content 是 string（非数组）→ ""', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: 'plain string content' },
      ])
      expect(result).toBe('')
    })

    it('TC9g: S1 text 字段非 string（{type:"text", text:123}）→ 过滤掉 → ""', () => {
      // pi 若发畸形 {type:'text', text:123}，不应被拼成 "123"；归一化为空文档走 empty reject。
      const result = extractFinalTextFromAgentEnd([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 123 as unknown as string },
            { type: 'text', text: { nested: true } as unknown as string },
          ],
          stopReason: 'stop',
        },
      ])
      expect(result).toBe('')
    })
  })

  describe('buildHandoffPrompt', () => {
    it('TC10a: reply 含换行 + 超长 → sanitize 后追加 focus 后缀（无 \\n，长度 ≤ REPLY_MAX_LENGTH）', () => {
      const longReply = 'line1\nline2\rline3\n' + 'x'.repeat(6000)
      const result = buildHandoffPrompt(longReply)
      expect(result).toContain('The next session will focus on:')
      expect(result).toContain(HANDOFF_PROMPT_TEMPLATE)
      // 结果不含原始换行（sanitize 后的 focus 后缀无 CR/LF）
      const suffix = result.slice(result.indexOf('The next session will focus on:'))
      expect(suffix).not.toMatch(/[\r\n]/)
      // sanitize 部分（前缀 + 空格之后的全部内容）长度受控
      const FOCUS_PREFIX = 'The next session will focus on: '
      const focusContent = suffix.slice(FOCUS_PREFIX.length)
      expect(focusContent.length).toBeLessThanOrEqual(REPLY_MAX_LENGTH)
      expect(focusContent).not.toMatch(/[\r\n]/)
    })

    it('TC10b: reply=undefined → 纯 template 无 focus 后缀', () => {
      const result = buildHandoffPrompt(undefined)
      expect(result).toBe(HANDOFF_PROMPT_TEMPLATE)
      expect(result).not.toContain('focus on:')
    })

    it('TC10c: S3 reply 含 tab/NUL 等控制字符 → sanitize 全部 strip + 折叠空白（不进 prompt）', () => {
      // \t=tab, \0=NUL, \x0b=vertical tab, \x1b=ESC, \x7f=DEL——均属 C0 控制字符集 + DEL，
      // 须被 strip 成空格再折叠，避免畸形空白注入 prompt。
      const dirty = 'a\tb\x00c\x0bd\x1be\x7ff\t\t\tg'
      const result = buildHandoffPrompt(dirty)
      const suffix = result.slice(result.indexOf('The next session will focus on:'))
      const FOCUS_PREFIX = 'The next session will focus on: '
      const focusContent = suffix.slice(FOCUS_PREFIX.length)
      // 控制字符全部被替换 / 折叠：结果只剩字母 + 单空格分隔
      expect(focusContent).toBe('a b c d e f g')
      expect(focusContent).not.toMatch(/[\x00-\x1F\x7F]/)
      expect(focusContent).not.toMatch(/\s{2,}/)
    })
  })
})
