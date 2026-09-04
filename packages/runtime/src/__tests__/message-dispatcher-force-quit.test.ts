/**
 * MessageDispatcher.forceQuit / 强杀收敛编排测试（sidebar 强制退出入口）。
 *
 * 锁定：
 * - FQ1: forceQuit 活跃 session → 按序 detach → destroy → persist stopped('User forced quit') →
 *        广播 session.exited{code:null, reason:用户指引文案} → removeEntry（与 abort 超时路径同构）
 * - FQ2: forceQuit 不在活跃进程表（pm.getClient 返回 undefined）→ 幂等成功：
 *        不调 destroy/persist/removeEntry、不广播（竞态兜底，菜单渲染后 session 恰好退出）
 * - FQ3: abort RPC 超时（client.abort 抛 RpcTimeoutError）→ 复用同一强杀编排：
 *        persist stopped 带 'Abort failed (pi unresponsive)' 诊断 reason + session.exited 用户文案
 *
 * mock 模式参考 message-dispatcher-bash.test.ts 的 makeMocks。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-force-quit.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import { RpcTimeoutError } from '../utils/errors.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

type SessionExitedMsg = ServerMessage<'session.exited'>
function findSessionExited(b: ServerMessage[]): SessionExitedMsg | undefined {
  return b.find((m) => m.type === 'session.exited') as SessionExitedMsg | undefined
}

function makeMockSession(): IManagedSessionView {
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
  }
}

interface MockOpts {
  /** pm.getClient 返回值；undefined 模拟 session 不在活跃进程表 */
  active?: boolean
  abortError?: Error
}

interface ForceQuitMocks {
  dispatcher: MessageDispatcher
  destroySessionFn: ReturnType<typeof vi.fn>
  detachSessionFn: ReturnType<typeof vi.fn>
  persistOutcomeFn: ReturnType<typeof vi.fn>
  removeEntryFn: ReturnType<typeof vi.fn>
  broadcasts: ServerMessage[]
  callOrder: string[]
}

function makeMocks(opts: MockOpts = {}): ForceQuitMocks {
  const client = opts.abortError
    ? { abort: vi.fn(async () => { throw opts.abortError! }) }
    : { abort: vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abort']>>) }

  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // 编排顺序断言：detach → destroy → persist → removeEntry 必须按此相对顺序
  const callOrder: string[] = []
  const detachSessionFn = vi.fn(() => { callOrder.push('detach') })
  const destroySessionFn = vi.fn(async () => { callOrder.push('destroy') })
  const persistOutcomeFn = vi.fn(() => { callOrder.push('persist') })
  const removeEntryFn = vi.fn(() => { callOrder.push('remove') })

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转。
  // ensureActive/getSession 不在 forceQuit/abort 收敛路径上，空 mock 即可。
  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => makeMockSession()),
    detachSession: detachSessionFn,
    persistSessionOutcome: persistOutcomeFn,
    removeSessionEntry: removeEntryFn,
    ensureActive: vi.fn(),
    getSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => (opts.active === false ? undefined : client)),
    destroySession: destroySessionFn,
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, destroySessionFn, detachSessionFn, persistOutcomeFn, removeEntryFn, broadcasts, callOrder }
}

describe('MessageDispatcher forceQuit —— sidebar 强制退出', () => {
  it('FQ1: 活跃 session → detach→destroy→persist(stopped,User forced quit)→广播 session.exited(code:null)→removeEntry，按序执行', async () => {
    const m = makeMocks({ active: true })

    await m.dispatcher.forceQuit('s1')

    // 编排顺序：destroy 是 async 但必须在 detach 之后、persist 之前完成
    expect(m.callOrder).toEqual(['detach', 'destroy', 'persist', 'remove'])
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
    const exited = findSessionExited(m.broadcasts)
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    // exitReason 面向用户可操作：含恢复指引（重开/历史完整）
    expect(exited!.payload.reason).toContain('强制退出')
    expect(exited!.payload.reason).toContain('恢复')
  })

  it('FQ2: 不在活跃进程表 → 幂等成功：不 destroy/persist/remove、不广播', async () => {
    const m = makeMocks({ active: false })

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })
})

describe('MessageDispatcher abort RPC 超时 —— 复用强杀编排', () => {
  it('FQ3: client.abort 抛 RpcTimeoutError → 同一编排收敛 + stopped 带诊断 reason + session.exited 用户文案', async () => {
    const m = makeMocks({
      active: true,
      abortError: new RpcTimeoutError('abort', 5000),
    })

    await m.dispatcher.abort('s1')

    expect(m.callOrder).toEqual(['detach', 'destroy', 'persist', 'remove'])
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', expect.stringContaining('Abort failed (pi unresponsive)'))
    const exited = findSessionExited(m.broadcasts)
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    expect(exited!.payload.reason).toContain('pi 无响应')
  })
})
