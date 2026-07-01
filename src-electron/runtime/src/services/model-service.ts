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

/** 百分比上限（与 index.ts onContextUpdate 一致） */
const MAX_PERCENT = 100

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
   * Orchestrates: pi RPC → persist default → broadcast session 级状态变更（含按新模型
   * contextWindow 重算的用量）→ broadcast 全局默认模型。
   *
   * 为什么除 config.defaults 外还要广播 session.state_changed：config.defaults 是全局默认
   * （不带 sessionId），前端无法据它定位「哪个 session 换了模型」。session.state_changed 带
   * sessionId，前端据它同步 Composer 工具条（模型显示 / 用量 / 思考强度）。缺这条广播导致
   * 切换模型后 UI 不跟随（用量停在旧值、模型显示靠 defaultModel fallback 而非 per-session 真值）。
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

    // 3. Broadcast session 级状态变更（modelId + 按新 contextWindow 重算用量 + thinkingLevel）
    this.broadcastSessionState(sessionId, provider, modelId)

    // 4. Broadcast 全局默认模型（landing 态 Composer 的 fallback）
    this.broker.broadcast({
      type: 'config.defaults',
      id: this.nextPushId(),
      payload: { defaultModel: `${provider}/${modelId}`, source: 'model-switch' as const },
    })
  }

  /**
   * 广播 session.state_changed：切换模型后立即把新 modelId + 按新 contextWindow 重算的用量
   * 推给前端，无需等下一次 agent_end。算法与 index.ts onContextUpdate 一致。
   */
  private broadcastSessionState(sessionId: string, provider: string, modelId: string): void {
    const summary = this.sessionService.getSummary(sessionId)
    if (!summary) return // session 不在活跃 Map（磁盘 session），无法重算
    const providers = this.configService.listProviders()
    const models = this.aggregateModels(providers)
    const model = models.find(m => m.providerId === provider && m.id === modelId)
    const contextWindow = model?.contextWindow ?? 0
    const inputTokens = this.sessionService.getInputTokens(sessionId)
    const usagePercent = contextWindow > 0
      ? Math.min(Math.round((inputTokens / contextWindow) * MAX_PERCENT), MAX_PERCENT)
      : 0
    this.broker.broadcast({
      type: 'session.state_changed',
      id: this.nextPushId(),
      payload: {
        sessionId,
        modelId: summary.modelId,
        thinkingLevel: summary.thinkingLevel,
        usagePercent,
        inputTokens,
        contextLimit: contextWindow,
      },
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
