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
