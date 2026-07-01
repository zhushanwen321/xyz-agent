/**
 * ModelService 单测 —— switchModel 广播 session.state_changed 行为验证（W2）。
 *
 * 测试边界：ModelService 是纯编排层（pi RPC 委托 sessionService，persist 委托 configService，
 * 广播委托 broker）。全部依赖 mock，不 spawn pi、不碰真配置文件。
 *
 * 覆盖：switchModel 成功后广播 session.state_changed（含按新 contextWindow + 当前 inputTokens
 * 重算的 usagePercent/inputTokens/contextLimit + modelId + thinkingLevel）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelService } from '../src/services/model-service.js'
import type { IModelSource } from '../src/services/ports/model.js'
import type { ISessionService, IConfigService, IMessageBroker } from '../src/interfaces.js'
import type { ProviderInfo, ServerMessage, SessionSummary } from '@xyz-agent/shared'

// ── mock 工厂 ──────────────────────────────────────────────────

function makeMockSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    switchModel: vi.fn(async () => 's1'),
    setThinkingLevel: vi.fn(async () => undefined),
    getSummary: vi.fn((): SessionSummary | undefined => undefined),
    getInputTokens: vi.fn((): number => 0),
    ...overrides,
  } as unknown as ISessionService
}

function makeMockConfigService(providers: ProviderInfo[], overrides: Partial<IConfigService> = {}): IConfigService {
  return {
    listProviders: vi.fn(() => providers),
    setDefaultModel: vi.fn(),
    getDefaultModel: vi.fn(() => null),
    ...overrides,
  } as unknown as IConfigService
}

function makeMockBroker(): { broker: IMessageBroker; broadcasts: ServerMessage[] } {
  const broadcasts: ServerMessage[] = []
  const broker = {
    broadcast: vi.fn((msg: ServerMessage) => { broadcasts.push(msg) }),
  }
  return { broker: broker as unknown as IMessageBroker, broadcasts }
}

function makeMockModelSource(): IModelSource {
  return { discoverFromApi: vi.fn(async () => []) }
}

/** 构造含 contextWindow 的 provider/model 配置 */
function makeProvider(providerId: string, modelId: string, contextWindow?: number): ProviderInfo {
  return {
    id: providerId,
    name: providerId,
    models: [{ id: modelId, name: modelId, contextWindow }],
  } as ProviderInfo
}

// ── 测试 ──────────────────────────────────────────────────────

describe('ModelService · switchModel 广播 session.state_changed', () => {
  let modelSource: IModelSource

  beforeEach(() => {
    modelSource = makeMockModelSource()
  })

  it('切换成功后广播 session.state_changed，含按新 contextWindow 重算的用量（U6）', async () => {
    const providers = [makeProvider('anthropic', 'claude-4', 200000)]
    const sessionSummary: SessionSummary = {
      id: 's1', label: 'test', cwd: '/tmp', status: 'idle',
      lastActiveAt: Date.now(), modelId: 'old/p', thinkingLevel: 'high', tokenCount: 20000,
    } as SessionSummary
    const sessionService = makeMockSessionService({
      getSummary: vi.fn(() => sessionSummary),
      getInputTokens: vi.fn(() => 12000),
    })
    const configService = makeMockConfigService(providers)
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic', 'claude-4')

    const stateChanged = broadcasts.find((m) => m.type === 'session.state_changed')
    expect(stateChanged).toBeDefined()
    expect(stateChanged!.payload).toMatchObject({
      sessionId: 's1',
      modelId: 'old/p', // switchModel 先调 sessionService.switchModel（mock 不改 summary），summary.modelId 仍是旧值——这是 mock 限制；真实场景 sessionService.switchModel 会改 modelId
      thinkingLevel: 'high',
      inputTokens: 12000,
      contextLimit: 200000,
      usagePercent: 6, // Math.round(12000 / 200000 * 100)
    })
  })

  it('session 不存在（getSummary 返回 undefined）时不广播 session.state_changed（U7）', async () => {
    const providers = [makeProvider('anthropic', 'claude-4', 200000)]
    const sessionService = makeMockSessionService({
      getSummary: vi.fn(() => undefined),
    })
    const configService = makeMockConfigService(providers)
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('ghost', 'anthropic', 'claude-4')

    const stateChanged = broadcasts.find((m) => m.type === 'session.state_changed')
    expect(stateChanged).toBeUndefined()
    // config.defaults 仍广播（不阻塞）
    const configDefaults = broadcasts.find((m) => m.type === 'config.defaults')
    expect(configDefaults).toBeDefined()
  })

  it('新模型 contextWindow 为 undefined 时，contextLimit=0, usagePercent=0，仍广播（U8）', async () => {
    const providers = [makeProvider('anthropic', 'claude-4')] // 无 contextWindow
    const sessionSummary: SessionSummary = {
      id: 's1', label: 'test', cwd: '/tmp', status: 'idle',
      lastActiveAt: Date.now(), modelId: 'anthropic/claude-4', tokenCount: 0,
    } as SessionSummary
    const sessionService = makeMockSessionService({
      getSummary: vi.fn(() => sessionSummary),
      getInputTokens: vi.fn(() => 5000),
    })
    const configService = makeMockConfigService(providers)
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic', 'claude-4')

    const stateChanged = broadcasts.find((m) => m.type === 'session.state_changed')
    expect(stateChanged).toBeDefined()
    expect(stateChanged!.payload).toMatchObject({
      contextLimit: 0,
      usagePercent: 0,
      inputTokens: 5000,
    })
  })

  it('session.inputTokens 为 0（新 session 未对话）时，usagePercent=0，仍广播（U9）', async () => {
    const providers = [makeProvider('openai', 'gpt-4', 128000)]
    const sessionSummary: SessionSummary = {
      id: 's1', label: 'new', cwd: '/tmp', status: 'idle',
      lastActiveAt: Date.now(), modelId: 'openai/gpt-4', tokenCount: 0,
    } as SessionSummary
    const sessionService = makeMockSessionService({
      getSummary: vi.fn(() => sessionSummary),
      getInputTokens: vi.fn(() => 0),
    })
    const configService = makeMockConfigService(providers)
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'openai', 'gpt-4')

    const stateChanged = broadcasts.find((m) => m.type === 'session.state_changed')
    expect(stateChanged).toBeDefined()
    expect(stateChanged!.payload).toMatchObject({
      inputTokens: 0,
      usagePercent: 0,
      contextLimit: 128000,
    })
  })

  it('广播顺序：session.state_changed 先于 config.defaults（U10 顺序验证）', async () => {
    const providers = [makeProvider('anthropic', 'claude-4', 200000)]
    const sessionSummary: SessionSummary = {
      id: 's1', label: 'test', cwd: '/tmp', status: 'idle',
      lastActiveAt: Date.now(), modelId: 'anthropic/claude-4', tokenCount: 0,
    } as SessionSummary
    const sessionService = makeMockSessionService({
      getSummary: vi.fn(() => sessionSummary),
      getInputTokens: vi.fn(() => 0),
    })
    const configService = makeMockConfigService(providers)
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic', 'claude-4')

    const types = broadcasts.map((m) => m.type)
    const stateIdx = types.indexOf('session.state_changed')
    const defaultsIdx = types.indexOf('config.defaults')
    expect(stateIdx).toBeGreaterThanOrEqual(0)
    expect(defaultsIdx).toBeGreaterThanOrEqual(0)
    expect(stateIdx).toBeLessThan(defaultsIdx)
  })
})
