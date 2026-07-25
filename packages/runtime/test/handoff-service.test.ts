/**
 * HandoffService 单测（TC3-TC9 + 额外守卫）。
 *
 * 覆盖 fast-handoff runtime 编排层的全部分支：
 * - TC3 runHandoff 完整编排成功路径（create/sendMessage/markHandedOff/broadcast）
 * - TC4 focus 透传到 /skill:handoff 命令
 * - TC5 stopReason=aborted 跳过新建/注入
 * - TC6 finalContent 空（无 assistant）→ broadcastHandoffError + 失败
 * - TC7 源 session 不活跃（getClient undefined）抛错 + inflight 不残留
 * - TC8 并发重入拒绝（同一 session 不可并发 handoff）
 * - TC9 abort 委托 SessionService.abort + aborted 标记跳过编排；无 inflight 时 no-op
 * - 额外：onTurnEnd 非 handoff 触发的 turn-end 忽略
 * - 额外：onTurnEnd getSession 返回 undefined（M1 修复）→ broadcastHandoffError
 * - 额外：cancelInflight 清理（C2 修复）；无 inflight 时 no-op
 * - 额外：TOCTOU/abort 后 runHandoff 不抛 already in progress（C3 修复验证）
 *
 * mock 策略（参照 git-service-diff.test.ts / file-service.test.ts 范式）：
 * SessionService / broker / pm 全部构造注入，不起真实 pi 进程。
 *
 * 运行：cd packages/runtime && npx vitest run test/handoff-service.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@xyz-agent/shared'
import { HandoffService } from '../src/services/handoff-service.js'
import type { SessionService } from '../src/services/session/session-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'

/** 构造合法 Message（避免 any，用具体类型 + 满足必填字段）。 */
function msg(role: 'user' | 'assistant' | 'system', content: string): Message {
  return {
    id: `m-${role}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    status: 'complete',
    timestamp: Date.now(),
  }
}

/** 源 session 视图（getSession 返回）。只放 onTurnEnd 用到的字段。 */
function srcSession(over: Partial<{ cwd: string; label: string; sessionFilePath: string }> = {}) {
  return {
    id: 'src-1',
    cwd: '/proj',
    label: 'src',
    sessionFilePath: '/path/ses.jsonl',
    ...over,
  }
}

interface MockOpts {
  sessionService: {
    create: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    getHistory: ReturnType<typeof vi.fn>
    getSession: ReturnType<typeof vi.fn>
    markHandedOff: ReturnType<typeof vi.fn>
  }
  broker: { broadcast: ReturnType<typeof vi.fn> }
  pm: { getClient: ReturnType<typeof vi.fn> }
}

function createMockOpts(): MockOpts {
  return {
    sessionService: {
      create: vi.fn().mockResolvedValue({ id: 'new-1' }),
      sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
      abort: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
      getSession: vi.fn().mockReturnValue(srcSession()),
      markHandedOff: vi.fn(),
    },
    broker: { broadcast: vi.fn() },
    pm: { getClient: vi.fn() },
  }
}

function makeService(opts: MockOpts): HandoffService {
  return new HandoffService({
    sessionService: opts.sessionService as unknown as SessionService,
    broker: opts.broker as unknown as IMessageBroker,
    pm: opts.pm as unknown as IProcessManager,
  })
}

/** 构造一个 prompt vi.fn 的 pi engine client，getClient 返回它。 */
function withClient(opts: MockOpts, client: { prompt: ReturnType<typeof vi.fn> }) {
  opts.pm.getClient.mockReturnValue(client as unknown as IPiEngine)
  return opts
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HandoffService.runHandoff + onTurnEnd (TC3 完整编排成功路径)', () => {
  it('TC3 runHandoff 设 inflight + client.prompt("/skill:handoff")；onTurnEnd 走完整编排并清理 inflight', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    // getHistory 末条 assistant = 文档
    opts.sessionService.getHistory.mockResolvedValue({
      messages: [msg('user', 'go'), msg('assistant', '# doc')],
      truncated: false,
    })
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    // inflight 已设 + client.prompt 被调（/skill:handoff，无 focus）
    expect(prompt).toHaveBeenCalledWith('/skill:handoff')

    await service.onTurnEnd('src-1', 'end')

    // create(srcCwd, handoff from srcLabel)
    expect(opts.sessionService.create).toHaveBeenCalledWith('/proj', 'handoff from src')
    // sendMessage(newId, <含 # doc 的 wrapped>)
    expect(opts.sessionService.sendMessage).toHaveBeenCalledWith('new-1', expect.stringContaining('# doc'))
    expect(opts.sessionService.sendMessage).toHaveBeenCalledWith(
      'new-1',
      expect.stringContaining('<handoff_document'),
    )
    // markHandedOff(srcId, newId)
    expect(opts.sessionService.markHandedOff).toHaveBeenCalledWith('src-1', 'new-1')
    // broadcast session.handoffComplete
    expect(opts.broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.handoffComplete',
        payload: { srcSessionId: 'src-1', newSessionId: 'new-1' },
      }),
    )

    // inflight 在 onTurnEnd 后被清理（再调 runHandoff 不抛 already in progress）
    await expect(service.runHandoff('src-1', undefined)).resolves.toBeUndefined()
  })

  it('TC4 focus 透传：runHandoff(src, "focus on auth") → prompt 参数是 /skill:handoff focus on auth', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    const service = makeService(opts)

    await service.runHandoff('src-1', 'focus on auth')

    expect(prompt).toHaveBeenCalledWith('/skill:handoff focus on auth')
  })

  it('TC5 stopReason=aborted 跳过新建/注入；inflight 被清理', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    await service.onTurnEnd('src-1', 'aborted')

    expect(opts.sessionService.create).not.toHaveBeenCalled()
    expect(opts.sessionService.sendMessage).not.toHaveBeenCalled()
    expect(opts.sessionService.markHandedOff).not.toHaveBeenCalled()
    expect(opts.broker.broadcast).not.toHaveBeenCalled()
    // inflight 已清理
    await expect(service.runHandoff('src-1', undefined)).resolves.toBeUndefined()
  })

  it('TC6 finalContent 空（getHistory 无 assistant）→ broadcastHandoffError + create 未调 + inflight 清理', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    // 无 assistant 消息（只有 user）
    opts.sessionService.getHistory.mockResolvedValue({
      messages: [msg('user', 'x')],
      truncated: false,
    })
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    await service.onTurnEnd('src-1', 'end')

    // broadcastHandoffError → broadcast message.error
    expect(opts.broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.error',
        payload: expect.objectContaining({ sessionId: 'src-1' }),
      }),
    )
    expect(opts.sessionService.create).not.toHaveBeenCalled()
    expect(opts.sessionService.markHandedOff).not.toHaveBeenCalled()
    // inflight 清理
    await expect(service.runHandoff('src-1', undefined)).resolves.toBeUndefined()
  })

  it('TC6b getHistory 返回空 messages → 同样降级 broadcastHandoffError', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    opts.sessionService.getHistory.mockResolvedValue({ messages: [], truncated: false })
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    await service.onTurnEnd('src-1', 'end')

    expect(opts.broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.error' }),
    )
    expect(opts.sessionService.create).not.toHaveBeenCalled()
  })
})

describe('HandoffService.runHandoff 错误路径', () => {
  it('TC7 源 session 不活跃（pm.getClient 返回 undefined）→ 抛错含 "not active"，inflight 不残留', async () => {
    const opts = createMockOpts()
    // getClient 返回 undefined（session 不活跃）
    opts.pm.getClient.mockReturnValue(undefined)
    const service = makeService(opts)

    await expect(service.runHandoff('src-1', undefined)).rejects.toThrow(/not active/)

    // inflight 未残留：再调 runHandoff 不抛 already in progress（仍因 not active 抛错）
    await expect(service.runHandoff('src-1', undefined)).rejects.toThrow(/not active/)
  })

  it('TC8 并发重入拒绝：inflight 已存在时再调 runHandoff 抛 "already in progress"', async () => {
    const opts = createMockOpts()
    // prompt 不 resolve（挂起），保证 runHandoff 不返回、inflight 仍存在
    const prompt = vi.fn().mockReturnValue(new Promise(() => {}))
    withClient(opts, { prompt })
    const service = makeService(opts)

    const first = service.runHandoff('src-1', undefined)
    // 挂 rejection handler，避免 unhandledRejection（不 await —— first 永不 resolve）
    first.catch(() => {})
    // 让 microtask 推进（inflight.set 在 prompt 之前同步完成）
    await Promise.resolve()

    await expect(service.runHandoff('src-1', undefined)).rejects.toThrow(/already in progress/)
  })
})

describe('HandoffService.abort (TC9)', () => {
  it('TC9 runHandoff 后 abort → sessionService.abort 被调；后续 onTurnEnd (非 aborted stopReason) 跳过编排', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    await service.abort('src-1')

    expect(opts.sessionService.abort).toHaveBeenCalledWith('src-1')

    // onTurnEnd stopReason='end'（非 aborted），但 inflight.aborted=true → 跳过新建/注入
    await service.onTurnEnd('src-1', 'end')
    expect(opts.sessionService.create).not.toHaveBeenCalled()
    expect(opts.sessionService.sendMessage).not.toHaveBeenCalled()
    expect(opts.broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC9 abort 无 inflight 时 no-op：不抛错，sessionService.abort 未被调', async () => {
    const opts = createMockOpts()
    const service = makeService(opts)

    await expect(service.abort('unknown')).resolves.toBeUndefined()
    expect(opts.sessionService.abort).not.toHaveBeenCalled()
  })
})

describe('HandoffService.onTurnEnd 边界', () => {
  it('onTurnEnd 非 handoff 触发的 turn-end（inflight 无条目）→ 所有 service 未被调，不抛错', async () => {
    const opts = createMockOpts()
    const service = makeService(opts)

    await expect(service.onTurnEnd('x', 'end')).resolves.toBeUndefined()
    expect(opts.sessionService.getHistory).not.toHaveBeenCalled()
    expect(opts.sessionService.create).not.toHaveBeenCalled()
    expect(opts.broker.broadcast).not.toHaveBeenCalled()
  })

  it('onTurnEnd getSession 返回 undefined（M1 修复）→ broadcastHandoffError 含「源 session 信息不可用」；create 未调', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    opts.sessionService.getHistory.mockResolvedValue({
      messages: [msg('assistant', '# doc')],
      truncated: false,
    })
    // runHandoff 期间 getSession 还在（runHandoff 不读 getSession）
    // onTurnEnd 前 mock getSession 返回 undefined
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    opts.sessionService.getSession.mockReturnValue(undefined)
    await service.onTurnEnd('src-1', 'end')

    expect(opts.broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.error',
        payload: expect.objectContaining({
          sessionId: 'src-1',
          message: expect.stringContaining('源 session 信息不可用'),
        }),
      }),
    )
    expect(opts.sessionService.create).not.toHaveBeenCalled()
  })

  it('onTurnEnd getSession 返回无 label 时用 sessionId 作 source', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    opts.sessionService.getHistory.mockResolvedValue({
      messages: [msg('assistant', '# doc')],
      truncated: false,
    })
    opts.sessionService.getSession.mockReturnValue(srcSession({ label: '' }))
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    await service.onTurnEnd('src-1', 'end')

    // label 空时 source 用 sessionId（src-1）
    expect(opts.sessionService.create).toHaveBeenCalledWith('/proj', 'handoff from src-1')
  })

  it('onTurnEnd create 抛错 → broadcastHandoffError 含失败信息（catch 兜底）；inflight 清理', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    opts.sessionService.getHistory.mockResolvedValue({
      messages: [msg('assistant', '# doc')],
      truncated: false,
    })
    opts.sessionService.create.mockRejectedValue(new Error('disk full'))
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    await expect(service.onTurnEnd('src-1', 'end')).resolves.toBeUndefined()

    expect(opts.broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.error',
        payload: expect.objectContaining({
          sessionId: 'src-1',
          message: expect.stringContaining('disk full'),
        }),
      }),
    )
    // inflight 清理（finally 块）
    await expect(service.runHandoff('src-1', undefined)).resolves.toBeUndefined()
  })
})

describe('HandoffService.cancelInflight (C2 修复)', () => {
  it('cancelInflight 清理 inflight：再调 runHandoff 不抛 already in progress', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    const service = makeService(opts)

    await service.runHandoff('src-1', undefined)
    service.cancelInflight('src-1')

    // inflight 已清理，再调不抛 already in progress
    await expect(service.runHandoff('src-1', undefined)).resolves.toBeUndefined()
    // cancelInflight 不调 sessionService.abort（纯内存清理）
    expect(opts.sessionService.abort).not.toHaveBeenCalled()
  })

  it('cancelInflight 无 inflight 时 no-op（不抛错）', () => {
    const opts = createMockOpts()
    const service = makeService(opts)

    expect(() => service.cancelInflight('unknown')).not.toThrow()
  })
})

describe('HandoffService TOCTOU / abort 后 runHandoff (C3 修复验证)', () => {
  it('abort 后 onTurnEnd 清理 inflight → 新 runHandoff 不抛 already in progress', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockResolvedValue(undefined)
    withClient(opts, { prompt })
    const service = makeService(opts)

    // 第一次 runHandoff（设 inflight）
    await service.runHandoff('src-1', undefined)
    // abort（标 aborted + sessionService.abort）
    await service.abort('src-1')
    expect(opts.sessionService.abort).toHaveBeenCalledTimes(1)
    // onTurnEnd 走 aborted 分支 → finally 清理 inflight
    await service.onTurnEnd('src-1', 'end')

    // 新 runHandoff：abort 后 inflight 已被 onTurnEnd 清理，不应抛 already in progress
    opts.sessionService.abort.mockClear()
    await expect(service.runHandoff('src-1', undefined)).resolves.toBeUndefined()
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('runHandoff 内 client.prompt 抛错 → inflight 清理 + 错误传播（不残留）', async () => {
    const opts = createMockOpts()
    const prompt = vi.fn().mockRejectedValue(new Error('pi rpc broken'))
    withClient(opts, { prompt })
    const service = makeService(opts)

    await expect(service.runHandoff('src-1', undefined)).rejects.toThrow('pi rpc broken')
    // inflight 清理：再调不抛 already in progress
    await expect(service.runHandoff('src-1', undefined)).rejects.toThrow('pi rpc broken')
  })
})
