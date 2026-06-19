/**
 * ModelService — model aggregation, API discovery, and model/thinking-level orchestration.
 *
 * The unified business entry for switchModel and setThinkingLevel.
 * All callers (frontend WS handler, plugin RPC) must go through this
 * service to ensure consistent side-effects (persist, broadcast).
 *
 * aggregateModels is pure data transformation (stays here). discoverFromApi is
 * external HTTP — delegated to IModelSource (injected, infra implements).
 */
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import type { IModelService, ISessionService, IConfigService, IMessageBroker } from '../interfaces.js'
import type { IModelSource } from './ports/model.js'

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
   * Orchestrates: pi RPC → persist default → broadcast to all panels.
   * Persist failure is logged but does not block the response.
   */
  async switchModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    this.ensureInitialized()
    // 1. Tell pi subprocess to switch model
    await this.sessionService.switchModel(sessionId, provider, modelId)

    // 2. Persist default model (best-effort)
    try {
      this.configService.setDefaultModel(provider, modelId)
    // eslint-disable-next-line taste/no-silent-catch -- best-effort persist; model switch already succeeded in pi
    } catch (persistErr) {
      console.error('[ModelService] failed to persist default model:', persistErr)
    }

    // 3. Broadcast to all frontend panels
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
    return this.modelSource.discoverFromApi(baseUrl, apiKey, providerType)
  }
}
