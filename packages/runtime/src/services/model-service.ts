/**
 * ModelService — model aggregation, API discovery, and model/thinking-level orchestration.
 *
 * The unified business entry for switchModel and setThinkingLevel.
 * All callers (frontend WS handler, plugin RPC) must go through this
 * service to ensure consistent side-effects (broadcast).
 *
 * session 级状态（modelId / thinkingLevel / inputTokens / usagePercent）的单一 owner 是
 * SessionService；本服务只负责「config.defaults 广播」+ 委托
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
import type { ProviderInfo, ModelInfo, ProviderId } from '@xyz-agent/shared'
import type { IModelService, ISessionService, IConfigService, IMessageBroker } from '../interfaces.js'
import type { IModelSource } from './ports/model.js'
import { toErrorMessage } from '../utils/errors.js'
import { toModelInfo } from './model-mapper.js'
import {
  ModelCapabilityRegistry,
  runCapabilityReconcile,
  type CapabilityDrift,
} from './model-capability.js'

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
   * 它是 session 级状态唯一 owner）→ 广播 config.defaults。
   *
   * 全局默认模型的持久化由 pi 侧 setModel 完成（pi 持久化 defaultModel/defaultProvider
   * 到 settings.json）——xyz 不再冗余写一次（D1d）：configService.setDefaultModel 的
   * 全量覆盖写会在 pi 并发写其他字段时把它们回滚，且每次切模型都开双写窗口。
   *
   * session.state_changed 的广播由 SessionService.switchModel 内部负责（含新 modelId +
   * thinkingLevel；usage 已随 D1 协议收敛移出该帧，经 context.update 单帧贯穿），
   * 本方法不再自己 broadcastSessionState。
   */
  async switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<string> {
    this.ensureInitialized()
    // 1. pi RPC + 缓存更新 + 广播 session.state_changed（session 级状态单一 owner；
    //    pi 侧同时持久化 defaultModel/defaultProvider）
    // U6 回执普查：透传 get_state 读回的生效模型复合串（pi pattern 换模时 ≠ 请求值）
    const effective = await this.sessionService.switchModel(sessionId, provider, modelId)

    // 2. Broadcast 全局默认模型（landing 态 Composer 的 fallback）
    this.broker.broadcast({
      type: 'config.defaults',
      id: this.nextPushId(),
      payload: { defaultModel: `${provider}/${modelId}`, source: 'model-switch' },
    })
    return effective
  }

  /**
   * Unified setThinkingLevel entry point.
   *
   * Delegates to SessionService (pi RPC). Thinking level is per-session
   * runtime state — no persistence needed. Returns pi-effective level
   * (P3: pi clamps levels unsupported by the model family).
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    this.ensureInitialized()
    return this.sessionService.setThinkingLevel(sessionId, level)
  }

  aggregateModels(providers: ProviderInfo[]): ModelInfo[] {
    // 对齐 switchModel/setThinkingLevel 既有范式：访问注入依赖前先检查已初始化
    this.ensureInitialized()
    return this.aggregateModelsWithScoped(providers, this.configService.getScopedModels())
  }

  /**
   * 双参版聚合：scopedModels 由调用方传入（读盘值跨 config.providers / model.list
   * 两条消息复用，消除 buildProviderListMsgs 双读盘间写者落盘导致的一帧不一致）。
   * 独立命名而非给公开 aggregateModels 加参——design D2 否决改其签名（单参语义
   * 「内部读白名单」已有多调用方依赖）。纯数据变换，不访问注入依赖。
   */
  aggregateModelsWithScoped(providers: ProviderInfo[], scopedModels: string[]): ModelInfo[] {
    // W2：runtime enabled 过滤——provider.enabled===false 时其下所有 model 不进结果；
    // model.enabled===false 时该 model 不进结果。缺省/true 视为启用（向上兼容存量）。
    // 过滤在 listProviders 读出 ProviderInfo 之后做，config.enabled !== false 语义统一在此处收敛。
    const allModels = providers
      .filter(p => p.enabled !== false)
      .flatMap(p =>
        p.models
          .filter(m => m.enabled !== false)
          .map(m => toModelInfo(p.id, p.name, p.api, m)),
      )

    // scoped model 过滤/排序（design §3.3 D2）：scopedModels 非空时按白名单过滤 + 按序重排
    if (scopedModels.length === 0) return allModels

    // 建立 model 索引（provider/modelId → ModelInfo）
    const modelIndex = new Map<string, ModelInfo>()
    for (const m of allModels) {
      modelIndex.set(`${m.providerId}/${m.id}`, m)
    }

    // 按 scopedModels 序输出（跨 provider 交错序保留）
    const result: ModelInfo[] = []
    for (const scoped of scopedModels) {
      const m = modelIndex.get(scoped)
      if (m) result.push(m) // 解析不到模型的 scoped 条目静默跳过
    }
    return result
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

  // ── 能力注册表服务面（U5，pi-boundary-reliability design D2）──────────

  /** 离线档位计算缓存（3 维缓存键：pi 版本 + models.json mtime + builtin-providers.json mtime）。 */
  private readonly capabilityRegistry = new ModelCapabilityRegistry()

  /** drift 事件上报出口（WS 协议消息类型属后续单元，宿主经 setCapabilityDriftSink 订阅）。 */
  private capabilityDriftSink: ((drifts: CapabilityDrift[]) => void) | undefined

  /** 订阅对账 drift 事件（重复调用覆盖：单订阅者语义，广播化需求出现时再扩）。 */
  setCapabilityDriftSink(sink: (drifts: CapabilityDrift[]) => void): void {
    this.capabilityDriftSink = sink
  }

  /**
   * 给 ProviderInfo.models 逐模型标注 supportedLevels（view-ready，renderer 零推导）。
   * piVersion 建议传消息层 appInfo.piVersion（与 app.info 同源）；缺省 'unknown'——
   * 缓存正确性不依赖该组分（逐模型签名兜底，见 model-capability.ts 缓存键说明）。
   */
  attachSupportedLevels(providers: ProviderInfo[], piVersion?: string): ProviderInfo[] {
    return this.capabilityRegistry.attachSupportedLevels(providers, piVersion)
  }

  /**
   * 在线对账：session 附着后调用（编排 / 降级路径见 runCapabilityReconcile——引擎
   * 不可用或 RPC 失败降级返回 []，绝不反噬附着主链路）。返回本次 drift 项（空 =
   * 一致）；对账结果不缓存不落盘（每附着一次对一次）。
   */
  async reconcileModelCapabilities(sessionId: string): Promise<CapabilityDrift[]> {
    this.ensureInitialized()
    return runCapabilityReconcile({
      sessionId,
      getEngine: () => this.sessionService.getRpcClient(sessionId),
      getConfigProviders: () => this.configService.listProviders(),
      onDrift: drifts => this.capabilityDriftSink?.(drifts),
    })
  }
}
