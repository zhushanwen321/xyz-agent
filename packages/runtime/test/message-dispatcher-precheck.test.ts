/**
 * MessageDispatcher 预检测试（D-009：busy 时拒绝，广播 send.rejected，不调 pi.prompt）。
 *
 * 锁定 fix-state-tearing 的 D-009 核心决策：sendPrompt 入口检查 activeSession.isGenerating，
 * 若 busy 则广播 send.rejected 并返回 {blocked:true, rejected:true}，不调用 client.prompt。
 *
 * 覆盖：
 * - isGenerating=true → 广播 send.rejected + 不调 pi.prompt + 返回 rejected:true
 * - isGenerating=false → 正常调 pi.prompt + 不广播 send.rejected
 * - BeforeSend hook blocked → 返回 {blocked:true}（不调 pi.prompt，hook 已广播 message.error）
 * - pi.prompt 抛异常 → 广播 message.error + isGenerating 复位 false + 返回 blocked:true
 *
 * mock 策略：全部依赖 mock（svc/pm/broker/workspace），不 spawn pi。
 *
 * 运行：npx vitest run test/message-dispatcher-precheck.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'

function makeMockSession(isGenerating: boolean): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating,
  }
}

function makeMocks(opts: { isGenerating?: boolean; promptError?: Error } = {}) {
  const session = makeMockSession(opts.isGenerating ?? false)
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  const client = { prompt: promptFn } as unknown as IPiEngine

  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  const svc = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
  } as unknown as ISessionServiceInternal

  const pm = {} as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, broker, workspace)
  return { dispatcher, session, promptFn, broadcasts, broker }
}

describe('MessageDispatcher D-009 预检（busy → send.rejected）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('isGenerating=true → 广播 send.rejected + 不调 pi.prompt + 返回 rejected:true', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isGenerating: true })
    // sendMessage 调 sendPrompt（hookContent = content）
    const result = await dispatcher.sendMessage('s1', 'hello')
    // pi.prompt 未被调用
    expect(promptFn).not.toHaveBeenCalled()
    // 广播了 send.rejected
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.payload).toMatchObject({
      sessionId: 's1',
      reason: 'busy',
    })
    // 返回 rejected
    expect(result.rejected).toBe(true)
    expect(result.blocked).toBe(true)
  })

  it('isGenerating=false → 正常调 pi.prompt + 不广播 send.rejected', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isGenerating: false })
    await dispatcher.sendMessage('s1', 'hello')
    expect(promptFn).toHaveBeenCalledWith('hello')
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeUndefined()
  })
})

describe('MessageDispatcher 错误路径', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pi.prompt 抛异常 → 广播 message.error + isGenerating 复位 false', async () => {
    const { dispatcher, promptFn, broadcasts, session } = makeMocks({
      isGenerating: false,
      promptError: new Error('pi crashed'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    expect(promptFn).toHaveBeenCalled()
    // isGenerating 被复位
    expect(session.isGenerating).toBe(false)
    // 广播了 message.error
    const errMsg = broadcasts.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect(errMsg!.payload).toMatchObject({ sessionId: 's1' })
  })
})
