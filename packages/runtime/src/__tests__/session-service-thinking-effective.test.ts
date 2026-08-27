/**
 * SessionService.setThinkingLevel 返回 pi 生效值锁定（P3，pi-assumption final gate V3 附带发现）。
 *
 * 背景：pi 会钳制模型族不支持的思考档（mimo 族 max → high，clampThinkingLevel 就近
 * 回落），且钳制时不发事件不写 entry。旧实现 reply 与内存缓存都用请求值——前端 pending
 * 确认（session.thinkingLevelSet 回灌）与 summary 投影会短暂显示未生效档位。
 *
 * 锁定：
 * - pi 生效值 ≠ 请求值 → 返回生效值 + 内存缓存（getSummary 投影源）写生效值
 * - get_state 异常形态（thinkingLevel 缺失/非 string）→ 请求值兜底不炸
 * - 无活跃进程 → 请求值兜底（行为同旧版）
 *
 * mock 构造照抄 session-service-w07-bus.test.ts makeEnv（被测方法路径不消费
 * extensionService/sessionStore 等依赖，{} as never 占位）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-thinking-effective.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'

function makeEnv(getStateValue: () => unknown, withClient = true) {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
  const client = {
    setThinkingLevel: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ thinkingLevel: getStateValue() })),
  } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => (withClient ? client : undefined)),
  } as unknown as IProcessManager

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService
    { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, client, pm, broadcasts }
}

describe('SessionService.setThinkingLevel 返回 pi 生效值（P3）', () => {
  it('请求 max 被 pi 钳制为 high → 返回 high；pi 收到请求值 max；缓存（getSummary 投影源）为 high 非请求值', async () => {
    const { svc, client } = makeEnv(() => 'high')
    await svc.initializeManagedSession('s1', client, '/tmp', 't')
    const returned = await svc.setThinkingLevel('s1', 'max')
    expect(returned).toBe('high')
    expect(client.setThinkingLevel).toHaveBeenCalledWith('max')
    expect(svc.getSummary('s1')?.thinkingLevel).toBe('high')
  })

  it('生效值与请求值一致（无钳制）→ 返回请求值，行为同旧版', async () => {
    const { svc } = makeEnv(() => 'high')
    await svc.initializeManagedSession('s1', {} as unknown as IPiEngine, '/tmp', 't')
    const returned = await svc.setThinkingLevel('s1', 'high')
    expect(returned).toBe('high')
  })

  it('get_state 异常形态（thinkingLevel 缺失）→ 请求值兜底不炸', async () => {
    const { svc } = makeEnv(() => undefined)
    await svc.initializeManagedSession('s1', {} as unknown as IPiEngine, '/tmp', 't')
    const returned = await svc.setThinkingLevel('s1', 'low')
    expect(returned).toBe('low')
  })

  it('无活跃进程 → 请求值兜底（行为同旧版）', async () => {
    const { svc } = makeEnv(() => 'high', false)
    const returned = await svc.setThinkingLevel('s1', 'low')
    expect(returned).toBe('low')
  })
})

describe('SessionService.switchModel 返回 pi 生效模型（U6 回执普查）', () => {
  it('pi pattern 换模（get_state 读回 ≠ 请求值）→ 返回生效复合串；缓存（getSummary 投影源）写生效值非请求值', async () => {
    // 请求 model-a，pi pattern 引擎实际切到同族 model-b（事故 A 形态）
    const { svc, client } = makeEnv(() => 'high')
    ;(client.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      thinkingLevel: 'high',
      model: { id: 'model-b', provider: 'p' },
    })
    await svc.initializeManagedSession('s1', client, '/tmp', 't')
    const returned = await svc.switchModel('s1', 'p' as never, 'model-a')
    expect(client.setModel).toHaveBeenCalledWith('p', 'model-a')
    expect(returned).toBe('p/model-b')
    expect(svc.getSummary('s1')?.modelId).toBe('p/model-b')
  })

  it('get_state 读回与请求一致 → 返回请求复合串（常态路径）', async () => {
    const { svc } = makeEnv(() => 'high')
    await svc.initializeManagedSession('s1', {} as unknown as IPiEngine, '/tmp', 't')
    const returned = await svc.switchModel('s1', 'p' as never, 'model-a')
    expect(returned).toBe('p/model-a')
  })

  it('get_state 失败 → 请求值兜底不炸（读回是旁路，不反噬切模型主链路）', async () => {
    const { svc, client } = makeEnv(() => 'high')
    ;(client.getState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('state unavailable'))
    await svc.initializeManagedSession('s1', client, '/tmp', 't')
    const returned = await svc.switchModel('s1', 'p' as never, 'model-a')
    expect(returned).toBe('p/model-a')
  })
})
