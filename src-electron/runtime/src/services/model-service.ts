/**
 * ModelService — model aggregation, API discovery, and model/thinking-level orchestration.
 *
 * The unified business entry for switchModel and setThinkingLevel.
 * All callers (frontend WS handler, plugin RPC) must go through this
 * service to ensure consistent side-effects (persist, broadcast).
 *
 * session 级状态（modelId / thinkingLevel / inputTokens / usagePercent）的单一 owner 是
 * SessionService；本服务只负责「全局默认模型持久化 + config.defaults 广播」+ 委托
 * SessionService 做 session 级 RPC/缓存/broadcast。usagePercent 不再在此计算（去重到
 * SessionService.computeUsage）。
 *
 * aggregateModels is pure data transformation (stays here). discoverFromApi is
 * external HTTP — delegated to IModelSource (injected, infra implements).
 *
 * discoverModelsFromApi 负责把 infra 抛出的原始错误（ByteString / fetch failed 等）
 * 分类成结构化 ModelDiscoveryError（含 code + 中文文案）。transport 只 catch + reply，
 * 不再硬编码中文错误文案。
 */
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import type { IModelService, ISessionService, IConfigService, IMessageBroker } from '../interfaces.js'
import type { IModelSource } from './ports/model.js'
import { toErrorMessage } from '../utils/errors.js'

/** discoverModelsFromApi 错误码（domain→文案映射归 service）。 */
export type ModelDiscoveryErrorCode =
  | 'INVALID_AUTH_CHARS' // ByteString：Base URL / API Key 含 HTTP 不支持的字符
  | 'UNREACHABLE'        // fetch failed：无法访问目标 /v1/models
  | 'UNKNOWN'

/**
 * 结构化模型发现错误。code 供调用方分支判断，message 为可直接展示的中文文案。
 *
 * 与 ExtensionInstallError（extension-service）/ FileError 范式对称：readonly code + super(message)。
 */
export class ModelDiscoveryError extends Error {
  readonly code: ModelDiscoveryErrorCode

  constructor(code: ModelDiscoveryErrorCode, message: string) {
    super(message)
    this.name = 'ModelDiscoveryError'
    this.code = code
  }
}

export class ModelService implements IModelService {
  private sessionService!: ISessionService
  private configService!: IConfigService
  private broker!: IMessageBroker
  private nextPushId: () => string

  constructor(
    private readonly modelSource: IModelSource,
    pushIdFactory?: () => string,
  ) {
    this.nextPushId = pushIdFactory ?? (() => `push_${Date.now()}`)
  }

  /** Wire runtime dependencies (called after all services are constructed). */
  setServices(session: ISessionService, config: IConfigService, broker: IMessageBroker): void {
    if (!session || !config || !broker) {
      throw new Error('ModelService.setServices: all dependencies are required')
    }
    this.sessionService = session
    this.configService = config
    this.broker = broker
  }

  private ensureInitialized(): void {
    if (!this.sessionService || !this.configService || !this.broker) {
      throw new Error('ModelService not initialized — call setServices() first')
    }
  }

  /**
   * Unified switchModel entry point.
   *
   * 编排：pi RPC + 缓存更新 + 广播 session 级状态（全部委托 SessionService.switchModel，
   * 它是 session 级状态唯一 owner）→ persist 全局默认模型 → 广播 config.defaults。
   *
   * session.state_changed 的广播由 SessionService.switchModel 内部负责（含按新 contextWindow
   * 重算的用量 + thinkingLevel），本方法不再自己 broadcastSessionState。
   */
  async switchModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    this.ensureInitialized()
    // 1. pi RPC + 缓存更新 + 广播 session.state_changed（session 级状态单一 owner）
    await this.sessionService.switchModel(sessionId, provider, modelId)

    // 2. Persist default model (best-effort)
    try {
      this.configService.setDefaultModel(provider, modelId)
    // eslint-disable-next-line taste/no-silent-catch -- best-effort persist; model switch already succeeded in pi
    } catch (persistErr) {
      console.error('[ModelService] failed to persist default model:', persistErr)
    }

    // 3. Broadcast 全局默认模型（landing 态 Composer 的 fallback）
    this.broker.broadcast({
      type: 'config.defaults',
      id: this.nextPushId(),
      payload: { defaultModel: `${provider}/${modelId}`, source: 'model-switch' as const },
    })
  }

  /**
   * Unified setThinkingLevel entry point.
   *
   * Delegates to SessionService (pi RPC). Thinking level is per-session
   * runtime state — no persistence needed.
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    this.ensureInitialized()
    await this.sessionService.setThinkingLevel(sessionId, level)
  }

  aggregateModels(providers: ProviderInfo[]): ModelInfo[] {
    return providers.flatMap(p =>
      p.models.map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        providerId: p.id,
        providerName: p.name,
        api: m.api ?? p.api,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        thinkingLevelMap: m.thinkingLevelMap,
        cost: m.cost,
        enabled: true,
      } as ModelInfo)),
    )
  }

  async discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
    try {
      return await this.modelSource.discoverFromApi(baseUrl, apiKey, providerType)
    } catch (e) {
      // infra 原始错误分类成结构化 ModelDiscoveryError（含 code + 中文文案）。
      // 文案映射归 service（域决策），transport 只 catch + reply，不硬编码中文。
      throw this.classifyDiscoveryError(e, baseUrl)
    }
  }

  /** 把 infra 抛出的原始错误分类成 ModelDiscoveryError（domain→文案）。 */
  private classifyDiscoveryError(e: unknown, baseUrl: string): ModelDiscoveryError {
    const raw = toErrorMessage(e)
    if (raw.includes('ByteString')) {
      return new ModelDiscoveryError('INVALID_AUTH_CHARS', '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符')
    }
    if (raw.includes('fetch failed')) {
      return new ModelDiscoveryError('UNREACHABLE', `连接失败：无法访问 ${baseUrl}/v1/models`)
    }
    return new ModelDiscoveryError('UNKNOWN', raw)
  }
}
