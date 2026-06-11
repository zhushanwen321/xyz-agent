/**
 * ModelService — model aggregation, API discovery, and model/thinking-level orchestration.
 *
 * The unified business entry for switchModel and setThinkingLevel.
 * All callers (frontend WS handler, plugin RPC) must go through this
 * service to ensure consistent side-effects (persist, broadcast).
 */
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import type { IModelService, ISessionService, IConfigService, IMessageBroker } from '../interfaces.js'

const API_FETCH_TIMEOUT_MS = 10_000

export class ModelService implements IModelService {
  private sessionService!: ISessionService
  private configService!: IConfigService
  private broker!: IMessageBroker
  private nextPushId: () => string

  constructor(pushIdFactory?: () => string) {
    this.nextPushId = pushIdFactory ?? (() => `push_${Date.now()}`)
  }

  /** Wire runtime dependencies (called after all services are constructed). */
  setServices(session: ISessionService, config: IConfigService, broker: IMessageBroker): void {
    this.sessionService = session
    this.configService = config
    this.broker = broker
  }

  /**
   * Unified switchModel entry point.
   *
   * Orchestrates: pi RPC → persist default → broadcast to all panels.
   * Persist failure is logged but does not block the response.
   */
  async switchModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    // 1. Tell pi subprocess to switch model
    await this.sessionService.switchModel(sessionId, provider, modelId)

    // 2. Persist default model (best-effort)
    try {
      this.configService.setDefaultModel(provider, modelId)
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
    const base = baseUrl.replace(/\/+$/, '')
    let url: string
    const headers: Record<string, string> = {}

    if (providerType === 'anthropic' || providerType === 'anthropic-messages') {
      url = `${base}/v1/models`
      if (apiKey) {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
    } else {
      url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API 返回 ${res.status}: ${body || res.statusText}`)
    }

    const data = await res.json() as Record<string, unknown>

    const modelList = Array.isArray(data.data)
      ? data.data as Array<Record<string, unknown>>
      : Array.isArray(data.models)
        ? data.models as Array<Record<string, unknown>>
        : []

    return modelList
      .filter(m => typeof m.id === 'string')
      .map(m => ({
        id: m.id as string,
        name: (m.name ?? m.id) as string,
      }))
  }
}
