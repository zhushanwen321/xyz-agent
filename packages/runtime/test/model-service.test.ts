/**
 * ModelService 单测 —— 瘦身后的 switchModel 编排行为验证。
 *
 * session 级状态（modelId/thinkingLevel/inputTokens/usagePercent）单一 owner 是 SessionService；
 * ModelService 瘦身后职责仅为「持久化全局默认模型 + 广播 config.defaults」+ 委托
 * SessionService.switchModel 做 session 级 RPC/缓存/broadcast。usagePercent 不再在此计算。
 *
 * 测试边界：ModelService 是编排层（session 级委托 sessionService，persist 委托 configService，
 * config.defaults 广播委托 broker）。全部依赖 mock，不 spawn pi、不碰真配置文件。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelService, ModelDiscoveryError } from '../src/services/model-service.js'
import type { ModelDiscoveryErrorCode } from '../src/services/model-service.js'
import type { IModelSource } from '../src/services/ports/model.js'
import type { ISessionService, IConfigService, IMessageBroker } from '../src/interfaces.js'
import type { ProviderInfo, ServerMessage } from '@xyz-agent/shared'

// ── mock 工厂 ──────────────────────────────────────────────────

function makeMockSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    switchModel: vi.fn(async () => 's1'),
    setThinkingLevel: vi.fn(async () => undefined),
    setThinkingLevelCache: vi.fn(),
    getSummary: vi.fn(() => undefined),
    getInputTokens: vi.fn((): number => 0),
    setInputTokens: vi.fn(),
    applyContextUpdate: vi.fn(),
    getUsagePercent: vi.fn((): number => 0),
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

function makeMockModelSource(overrides: Partial<IModelSource> = {}): IModelSource {
  return { discoverFromApi: vi.fn(async () => []), ...overrides }
}

// ── 测试 ──────────────────────────────────────────────────────

describe('ModelService · switchModel 编排（瘦身后）', () => {
  let modelSource: IModelSource

  beforeEach(() => {
    modelSource = makeMockModelSource()
  })

  it('委托 sessionService.switchModel 做 session 级 RPC/缓存/broadcast', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic', 'claude-4')

    expect(sessionService.switchModel).toHaveBeenCalledWith('s1', 'anthropic', 'claude-4')
  })

  it('持久化全局默认模型（configService.setDefaultModel）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic', 'claude-4')

    expect(configService.setDefaultModel).toHaveBeenCalledWith('anthropic', 'claude-4')
  })

  it('广播 config.defaults（全局默认模型，landing Composer fallback）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'openai', 'gpt-4')

    const configDefaults = broadcasts.find((m) => m.type === 'config.defaults')
    expect(configDefaults).toBeDefined()
    expect(configDefaults!.payload).toMatchObject({
      defaultModel: 'openai/gpt-4',
      source: 'model-switch',
    })
  })

  it('不再自己广播 session.state_changed（交由 sessionService.switchModel 内部负责）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic', 'claude-4')

    // ModelService 只广播 config.defaults，不广播 session.state_changed
    const types = broadcasts.map((m) => m.type)
    expect(types).toContain('config.defaults')
    expect(types).not.toContain('session.state_changed')
  })

  it('configService.setDefaultModel 失败时不阻塞（best-effort persist）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([], {
      setDefaultModel: vi.fn(() => { throw new Error('disk full') }),
    })
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    // 不抛（best-effort）
    await expect(svc.switchModel('s1', 'anthropic', 'claude-4')).resolves.toBeUndefined()
    // sessionService.switchModel 仍被调用，config.defaults 仍广播
    expect(sessionService.switchModel).toHaveBeenCalled()
    expect(broadcasts.some((m) => m.type === 'config.defaults')).toBe(true)
  })
})

describe('ModelService · setThinkingLevel 委托', () => {
  let modelSource: IModelSource

  beforeEach(() => {
    modelSource = makeMockModelSource()
  })

  it('委托 sessionService.setThinkingLevel', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.setThinkingLevel('s1', 'high')

    expect(sessionService.setThinkingLevel).toHaveBeenCalledWith('s1', 'high')
  })
})

// ══════════════════════════════════════════════════════════════════
// discoverModelsFromApi · 错误文案翻译（从 settings-handler 下沉）
//
// 原 transport 硬编码的 ByteString/fetch failed → 中文文案，现归 service。
// service 把 infra 抛出的原始错误分类成 ModelDiscoveryError（code + 中文 message）。
// ══════════════════════════════════════════════════════════════════

describe('ModelService · discoverModelsFromApi 错误分类（transport 下沉）', () => {
  const BASE_URL = 'http://x'

  /** 用 reject 的 modelSource 构造 service（discoverFromApi 抛 rawError）。 */
  function makeServiceWithRejectingSource(rawError: unknown): { svc: ModelService; modelSource: IModelSource } {
    const modelSource = makeMockModelSource({ discoverFromApi: vi.fn(async () => { throw rawError }) })
    const svc = new ModelService(modelSource)
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)
    return { svc, modelSource }
  }

  it('ByteString 错误 → ModelDiscoveryError(INVALID_AUTH_CHARS) + 中文「不支持的字符」', async () => {
    const { svc, modelSource } = makeServiceWithRejectingSource(new Error('invalid ByteString'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'INVALID_AUTH_CHARS',
      message: '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符',
    })
    expect(modelSource.discoverFromApi).toHaveBeenCalledWith(BASE_URL, 'k', undefined)
  })

  it('fetch failed → ModelDiscoveryError(UNREACHABLE) + 中文「无法访问」(含 baseUrl)', async () => {
    const { svc } = makeServiceWithRejectingSource(new Error('fetch failed'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'UNREACHABLE',
      message: '连接失败：无法访问 http://x/v1/models',
    })
  })

  it('其他错误 → ModelDiscoveryError(UNKNOWN) + 原始消息透传', async () => {
    const { svc } = makeServiceWithRejectingSource(new Error('rate limited'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'UNKNOWN',
      message: 'rate limited',
    })
  })

  it('成功 → 返回 infra 的模型列表（不抛错）', async () => {
    const modelSource = makeMockModelSource({
      discoverFromApi: vi.fn(async () => [{ id: 'm1', name: 'M1' }]),
    })
    const svc = new ModelService(modelSource)
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)

    const models = await svc.discoverModelsFromApi(BASE_URL, 'k')
    expect(models).toEqual([{ id: 'm1', name: 'M1' }])
  })

  it('ModelDiscoveryError 是 Error 子类（code 可读）', () => {
    const err = new ModelDiscoveryError('INVALID_AUTH_CHARS' as ModelDiscoveryErrorCode, 'msg')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('INVALID_AUTH_CHARS')
    expect(err.name).toBe('ModelDiscoveryError')
  })
})

// ══════════════════════════════════════════════════════════════════
// aggregateModels · enabled 过滤（W2 / U3）
//
// runtime enabled 读写链路的过滤端：listProviders 读出 provider/model 级 enabled，
// aggregateModels 把 enabled===false 的 provider 和 model 过滤掉，不进最终 ModelInfo 结果。
// 过滤规则：
//   - provider.enabled === false → 其下所有 model 不进结果
//   - model.enabled === false → 该 model 不进结果
//   - 缺省（undefined）/ true → 启用（向上兼容存量）
// ══════════════════════════════════════════════════════════════════
describe('ModelService.aggregateModels · enabled 过滤（W2 / U3）', () => {
  it('provider.enabled === false 时其下所有 model 被过滤掉', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        enabled: false, // provider 级禁用
        models: [
          { id: 'm1', name: 'M1' },
          { id: 'm2', name: 'M2' },
        ],
      },
      {
        id: 'p2',
        name: 'P2',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [{ id: 'm3', name: 'M3' }],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    const result = svc.aggregateModels(providers)

    // p1 整体被禁用，其 m1/m2 不进结果；只留 p2/m3
    expect(result.map(m => m.id)).toEqual(['m3'])
  })

  it('model.enabled === false 时该 model 被过滤掉', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [
          { id: 'm1', name: 'M1', enabled: false }, // model 级禁用
          { id: 'm2', name: 'M2', enabled: true },
        ],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    const result = svc.aggregateModels(providers)

    // 只留 m2，m1 被 model 级 enabled=false 过滤
    expect(result.map(m => m.id)).toEqual(['m2'])
  })

  it('存量 model 无 enabled 字段时默认启用（向上兼容）', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        models: [
          { id: 'm1' }, // 无 enabled 字段（存量）
          { id: 'm2', enabled: true },
        ],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    const result = svc.aggregateModels(providers)

    // 缺省 / true 都视为启用，全保留
    expect(result.map(m => m.id).sort()).toEqual(['m1', 'm2'])
  })

  it('U3 端到端：setProvider 写入 model 级 enabled 后 aggregateModels 过滤正确', () => {
    // 模拟 listProviders 读回的 ProviderInfo（model 级 enabled 已透传）
    const providers: ProviderInfo[] = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [
          { id: 'm1', enabled: false },
          { id: 'm2', enabled: true },
        ],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    const result = svc.aggregateModels(providers)

    expect(result.map(m => m.id)).toEqual(['m2'])
    expect(result.find(m => m.id === 'm1')).toBeUndefined()
  })
})
