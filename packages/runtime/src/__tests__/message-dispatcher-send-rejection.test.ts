/**
 * MessageDispatcher 发送拒绝转译测试（session-occupancy-send-closure D2 runtime 侧）。
 *
 * 锁定：
 * - classifyPromptRejection：pi 双拒绝字符串 → 'compacting' | 'processing'，非 busy → null
 * - busy 预检分型：isCompacting → 'compacting'；isGenerating / isBashRunning → 'busy'（存量）
 * - catch 转译：pi busy 类拒绝 → send.rejected 分型广播 + 零 message.error（不进错误气泡链路）
 *   + isGenerating 复位（转译的拒绝同样意味着 turn 没跑起来）+ 返回 rejected:true（handler 走
 *   message.status{rejected} ack，与预检拒绝同构）
 * - 非 busy pi 错误（auth/无模型等）：保留现状 message.error 广播，无 send.rejected
 * - clientUuid 原样回带：预检与转译两路；未传时 payload 不含该键
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-send-rejection.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher, classifyPromptRejection } from '../services/session/message-dispatcher.js'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

/** pi 0.84.4 agent-session.js prompt() 双拒绝分支原文（PS-22 / PS-23 探针锁守卫）。 */
const PI_COMPACTING_MSG = 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
const PI_PROCESSING_MSG = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    ...overrides,
  }
}

interface MockOpts {
  isBashRunning?: boolean
  isGenerating?: boolean
  isCompacting?: boolean
  promptError?: Error
}

function makeMocks(opts: MockOpts = {}) {
  const session = makeMockSession({
    isBashRunning: opts.isBashRunning ?? false,
    isGenerating: opts.isGenerating ?? false,
    isCompacting: opts.isCompacting ?? false,
  })

  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({ role: 'assistant', content: 'ok' }))

  const client = { prompt: promptFn } as unknown as IPiEngine

  // dispatcher 只依赖 publish 抽象：mock bus 收集发布消息供断言
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, promptFn, broadcasts }
}

/** 取广播中的唯一 send.rejected payload（不存在则 undefined）。 */
function findRejected(broadcasts: ServerMessage[]) {
  return broadcasts.find((m) => m.type === 'send.rejected')?.payload as
    | Extract<ServerMessage, { type: 'send.rejected' }>['payload']
    | undefined
}

function findError(broadcasts: ServerMessage[]) {
  return broadcasts.find((m) => m.type === 'message.error')
}

describe('classifyPromptRejection —— pi 拒绝原文映射（D2 识别函数）', () => {
  it('manual 压缩原文 → compacting', () => {
    expect(classifyPromptRejection(PI_COMPACTING_MSG)).toBe('compacting')
  })

  it('auto 压缩 / post-run 原文 → processing', () => {
    expect(classifyPromptRejection(PI_PROCESSING_MSG)).toBe('processing')
  })

  it('按 includes 匹配：错误消息含原文片段（带前后缀）仍命中', () => {
    expect(classifyPromptRejection(`RPC failed: ${PI_PROCESSING_MSG}`)).toBe('processing')
    expect(classifyPromptRejection(`${PI_COMPACTING_MSG} (session s1)`)).toBe('compacting')
  })

  it('非 busy 的 pi 错误（auth / 无模型等）→ null（保留 message.error 现状）', () => {
    expect(classifyPromptRejection('No model configured')).toBeNull()
    expect(classifyPromptRejection('Authentication failed: 401')).toBeNull()
    expect(classifyPromptRejection('')).toBeNull()
  })
})

describe('sendPrompt busy 预检分型（D2：按命中维度分型广播）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('isCompacting=true → send.rejected{reason:"compacting"} + 中文提示 + 不调 prompt + rejected ack', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isCompacting: true })

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(promptFn).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: true, rejected: true })
    const payload = findRejected(broadcasts)
    expect(payload).toMatchObject({ sessionId: 's1', reason: 'compacting', message: '压缩进行中，消息将自动排队' })
    // 转译/预检拒绝不进错误气泡链路
    expect(findError(broadcasts)).toBeUndefined()
  })

  it('仅 isGenerating=true → reason:"busy"（存量）', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isGenerating: true })

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(promptFn).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: true, rejected: true })
    expect(findRejected(broadcasts)).toMatchObject({ sessionId: 's1', reason: 'busy', message: 'Agent 正在处理' })
  })

  it('仅 isBashRunning=true → reason:"busy"（存量，T7 语义保持）', async () => {
    const { dispatcher, broadcasts } = makeMocks({ isBashRunning: true })

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result).toEqual({ blocked: true, rejected: true })
    expect(findRejected(broadcasts)).toMatchObject({ sessionId: 's1', reason: 'busy' })
  })

  it('预检拒绝 + clientUuid → payload 原样回带（compacting 维度）', async () => {
    const { dispatcher, broadcasts } = makeMocks({ isCompacting: true })

    await dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-pre-1')

    expect(findRejected(broadcasts)).toMatchObject({ reason: 'compacting', clientUuid: 'uuid-pre-1' })
  })

  it('预检拒绝 + clientUuid → payload 原样回带（busy 维度）', async () => {
    const { dispatcher, broadcasts } = makeMocks({ isBashRunning: true })

    await dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-pre-2')

    expect(findRejected(broadcasts)).toMatchObject({ reason: 'busy', clientUuid: 'uuid-pre-2' })
  })

  it('预检拒绝未传 clientUuid → payload 不含 clientUuid 键', async () => {
    const { dispatcher, broadcasts } = makeMocks({ isCompacting: true })

    await dispatcher.sendMessage('s1', 'hello')

    const payload = findRejected(broadcasts)
    expect(payload).toBeDefined()
    expect('clientUuid' in payload!).toBe(false)
  })
})

describe('sendPrompt catch 拒绝转译（D2：pi busy 类拒绝不进 message.error）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('manual 压缩原文 → send.rejected{reason:"compacting"} + 零 message.error + isGenerating 复位 + rejected ack', async () => {
    const { dispatcher, session, broadcasts } = makeMocks({ promptError: new Error(PI_COMPACTING_MSG) })

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result).toEqual({ blocked: true, rejected: true })
    // 转译广播（恰一条 send.rejected）+ 不进错误气泡链路
    const rejected = findRejected(broadcasts)
    expect(rejected).toMatchObject({ sessionId: 's1', reason: 'compacting', message: '压缩进行中，消息将自动排队' })
    expect(broadcasts.filter((m) => m.type === 'send.rejected')).toHaveLength(1)
    expect(findError(broadcasts)).toBeUndefined()
    // 复位语义保持：转译的拒绝也意味着 turn 没跑起来（catch 复位对转译路同样生效）
    expect(session.isGenerating).toBe(false)
  })

  it('auto 压缩 / post-run 原文 → send.rejected{reason:"processing"} + 零 message.error', async () => {
    const { dispatcher, session, broadcasts } = makeMocks({ promptError: new Error(PI_PROCESSING_MSG) })

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result).toEqual({ blocked: true, rejected: true })
    expect(findRejected(broadcasts)).toMatchObject({ sessionId: 's1', reason: 'processing', message: 'Agent 正在处理' })
    expect(findError(broadcasts)).toBeUndefined()
    expect(session.isGenerating).toBe(false)
  })

  it('转译拒绝 + clientUuid → payload 原样回带', async () => {
    const { dispatcher, broadcasts } = makeMocks({ promptError: new Error(PI_COMPACTING_MSG) })

    await dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-trans-1')

    expect(findRejected(broadcasts)).toMatchObject({ reason: 'compacting', clientUuid: 'uuid-trans-1' })
  })

  it('转译路径单次复位：广播面恰好一条 send.rejected、零 message.error（无重复/遗漏）', async () => {
    const { dispatcher, broadcasts } = makeMocks({ promptError: new Error(PI_PROCESSING_MSG) })

    await dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-trans-2')

    expect(broadcasts.filter((m) => m.type === 'send.rejected')).toHaveLength(1)
    expect(broadcasts.filter((m) => m.type === 'message.error')).toHaveLength(0)
  })
})

describe('非 busy 的 pi 错误保留现状（D2 接管副作用表：非 busy 不转译）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('prompt 抛非 busy 错误 → message.error 广播（现状）+ 无 send.rejected + blocked 无 rejected（error envelope → pending.reject）', async () => {
    const { dispatcher, session, broadcasts } = makeMocks({ promptError: new Error('No model configured') })

    const result = await dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-nonbusy')

    expect(result).toEqual({ blocked: true })
    expect(findRejected(broadcasts)).toBeUndefined()
    const err = findError(broadcasts)
    expect(err).toBeDefined()
    expect((err!.payload as { message: string }).message).toBe('No model configured')
    // 现状复位语义不变
    expect(session.isGenerating).toBe(false)
  })
})

describe('正常路径行为不变', () => {
  beforeEach(() => vi.clearAllMocks())

  it('prompt 成功 → 零 send.rejected / message.error + {blocked:false}', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks()

    const result = await dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-ok')

    expect(result).toEqual({ blocked: false })
    expect(promptFn).toHaveBeenCalledWith('hello', undefined)
    expect(findRejected(broadcasts)).toBeUndefined()
    expect(findError(broadcasts)).toBeUndefined()
  })
})

describe('transport → dispatcher 端到端 clientUuid 透传（message.send case 接线）', () => {
  // makeHandler 范式同 session-message-handler-subscribe.test.ts：mock ctx，捕获 reply 与
  // sessionService.sendMessage 实参（transport 层解构/传参断言；sessionService → dispatcher
  // 为一行签名委托，由 typecheck + 上文 dispatcher 单测覆盖）。
  function makeSendHandler() {
    const cap = {
      replies: [] as { id: string | undefined; type: string; payload: Record<string, unknown> }[],
      sendArgs: [] as unknown[][],
    }
    const ctx = {
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      sendError: vi.fn(),
      sessionService: {
        sendMessage: vi.fn(async (...args: unknown[]) => {
          cap.sendArgs.push(args)
          return { blocked: true, rejected: true }
        }),
      },
    }
    const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    return { cap, handler }
  }

  function sendMsg(payload: Record<string, unknown>): ClientMessage {
    return { type: 'message.send', id: 'req-1', payload } as unknown as ClientMessage
  }

  it('payload 带 clientUuid → sessionService.sendMessage 收到四参（含 clientUuid），rejected ack 正常', async () => {
    const { cap, handler } = makeSendHandler()

    await handler.handleSessionMessage(
      sendMsg({ sessionId: 's1', content: 'hello', clientUuid: 'uuid-e2e-1' }),
      {} as never,
    )

    expect(cap.sendArgs).toHaveLength(1)
    expect(cap.sendArgs[0]).toEqual(['s1', 'hello', undefined, 'uuid-e2e-1'])
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0].type).toBe('message.status')
    expect(cap.replies[0].payload).toMatchObject({ sessionId: 's1', status: 'rejected' })
  })

  it('payload 不带 clientUuid → sendMessage 第 4 参 undefined（存量调用形态不变）', async () => {
    const { cap, handler } = makeSendHandler()

    await handler.handleSessionMessage(
      sendMsg({ sessionId: 's1', content: 'hello' }),
      {} as never,
    )

    expect(cap.sendArgs[0]).toEqual(['s1', 'hello', undefined, undefined])
  })
})
