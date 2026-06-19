/**
 * Ports — service 层定义、infra 层实现的依赖倒置接口（方案 C 三层架构）。
 *
 * 🔒 核心约束：services 只通过 ports 访问外部能力，不直接 import infra/。
 * 接口签名只用内部类型（来自 @xyz-agent/shared 或本文件定义），不出现 PiXxx。
 *
 * R3a（本文件）落地 IConfigStore；其余 5 个接口为骨架签名（R3b/R3c 填充）。
 * 标记 🔨 的方法表示「签名已定、待后续阶段在 service 侧接入」。
 */

// ── IConfigStore（R3a 已落地）──────────────────────────────────────
// ConfigService 经此 port 访问 pi 的配置存储（Provider/Skill/Agent + 默认模型 + 配置目录）。
// pi 的协议类型（PiProviderConfig/PiModelDefinition）只存在于 infra 实现内部，
// service 只见本接口定义的 ConfigProviderConfig / ConfigModelDefinition。

/** service 侧的 provider 配置形状（pi-provider-store 的 PiProviderConfig 的 service 视图）。 */
export interface ConfigProviderConfig {
  name?: string
  apiKey?: string
  baseUrl?: string
  /** pi 的 api 标识（由 service 传的 type 经 mapTypeToApi 翻译而来）。 */
  api?: string
  models?: ConfigModelDefinition[]
}

/** service 侧的 model 定义形状。 */
export interface ConfigModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  compat?: Record<string, unknown>
}

/** pi models.json 的 service 视图。 */
export interface ConfigModelsConfig {
  providers: Record<string, ConfigProviderConfig>
}

/** 默认模型引用。 */
export interface DefaultModelRef {
  provider: string
  modelId: string
}

/** upsertProvider 的返回（含可能的新默认模型）。 */
export interface UpsertProviderResult {
  newDefault?: DefaultModelRef
}

/** removeProvider 的返回。 */
export interface RemoveProviderResult {
  removed: boolean
  newDefault?: DefaultModelRef
}

/** listAgentFiles 的返回项。 */
export interface AgentFileEntry {
  name: string
  path: string
  content: string
}

/**
 * 配置存储 port —— Provider/Skill/Agent 的 CRUD + 默认模型 + 配置目录。
 * 实现位于 infra/pi/pi-config-store.ts（封装 pi-config-bridge + mapTypeToApi）。
 */
export interface IConfigStore {
  // ── 默认模型 ──
  getDefaultModel(): DefaultModelRef | null
  setDefaultModel(provider: string, modelId: string): void

  // ── Provider CRUD ──
  readModels(): ConfigModelsConfig
  getProviderConfig(providerId: string): ConfigProviderConfig | undefined
  upsertProvider(providerId: string, merged: ConfigProviderConfig): UpsertProviderResult
  removeProvider(providerId: string): RemoveProviderResult
  /** 翻译 xyz provider type → pi api 标识（pi 协议翻译，归属 infra）。 */
  applyTypeTranslation(type: string): string

  // ── Skill paths（pi settings.json）──
  getSkillPaths(): string[]
  addSkillPath(dir: string): void
  removeSkillPath(dir: string): void

  // ── Agent files（pi agents 目录）──
  listAgentFiles(): AgentFileEntry[]
  writeAgentFile(name: string, content: string): void
  deleteAgentFile(name: string): boolean

  // ── 配置目录 ──
  getConfigDir(): string
}

// ── R3b: IPiEngine / IPiProcess（已落地）─────────────────────────

/**
 * pi 任意 JSON 响应的逃生类型。
 *
 * pi 的 sendCommand 响应结构是动态的（get_state/fork/getHistory 各不相同），
 * 无法用单一精确类型描述。services 用 `as PiMessage` 后再 `as` 具体结构——
 * 这是「类型系统对 pi 动态响应认输」的诚实标注，不是协议泄露。
 *
 * 定义在 ports 而非 infra/rpc-client，让 services 从 ports 引用，不碰 rpc-client。
 */
export type PiMessage = unknown

/** pi 事件监听器：接收原始 pi 事件（动态 JSON），由 EventAdapter 翻译成 ServerMessage。 */
export type PiEventListener = (event: PiMessage) => void

/** pi 扩展命令描述（getCommands 返回项）。 */
export interface PiCommandInfo {
  name: string
  description?: string
  source: string
}

/** pi 进程退出回调。 */
export type PiExitCallback = (sessionId: string, code: number | null) => void

/**
 * pi 引擎 port —— 每个 session 对应一个实例（RpcClient 实现）。
 * services 经此与 pi 交互，不直接持有 RpcClient 具体类。
 *
 * sendCommand 是逃生方法：返回 PiMessage(unknown)，调用方自行 as 具体结构。
 * 这是刻意的——pi 的命令响应结构动态，精确化收益低且要跟 pi 改。
 */
export interface IPiEngine {
  prompt(content: string): Promise<PiMessage>
  abort(): Promise<PiMessage>
  steer(content: string): Promise<PiMessage>
  followUp(content: string): Promise<PiMessage>
  setModel(provider: string, modelId: string): Promise<PiMessage>
  setThinkingLevel(level: string): Promise<PiMessage>
  getHistory(): Promise<PiMessage>
  getCommands(): Promise<PiCommandInfo[]>
  /** 逃生方法：发送任意 pi 命令，返回动态响应。调用方自行 as 具体结构。 */
  sendCommand(type: string, params?: Record<string, unknown>, timeout?: number): Promise<PiMessage>
  /** 订阅 pi 事件流。返回 unsubscribe。事件由 EventAdapter 翻译，service 一般不直接处理。 */
  onEvent(listener: PiEventListener): () => void
}

/**
 * pi 进程池 port —— session↔pi 绑定（ProcessManager 实现）。
 * services 经此管理 session 的 pi 进程，getClient 返回 IPiEngine 而非 RpcClient。
 */
export interface IPiProcess {
  createSession(sessionId: string, cwd: string, options?: unknown): Promise<IPiEngine>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): IPiEngine | undefined
  hasClient(sessionId: string): boolean
  onSessionExit(callback: PiExitCallback): () => void
}

// ── R3c1: IModelSource（已落地）──────────────────────────────────

/** discoverFromApi 返回的模型元信息。 */
export interface DiscoveredModelMeta {
  id: string
  name: string
  contextWindow?: number
}

/**
 * 模型发现 port —— 经 HTTP 探测 LLM API 获取可用模型列表。
 * ModelService 的 aggregateModels 是纯数据转换（ProviderInfo[]→ModelInfo[]），
 * 属业务逻辑留 service；discoverFromApi 是外部 HTTP 调用，经此 port 注入。
 */
export interface IModelSource {
  /**
   * 探测 LLM API 的 /v1/models 端点，返回模型列表。
   * 兼容 anthropic（x-api-key）与 openai-compatible（Bearer）两种鉴权。
   */
  discoverFromApi(baseUrl: string, apiKey?: string, providerType?: string): Promise<DiscoveredModelMeta[]>
}

// ── R3c2 骨架签名（service 侧尚未接入）──────────────────────────
// 🔨 IInstaller          — 安装器（npm install/uninstall/installDeps + git clone）。
// 🔨 IExtensionResolver  — 扩展路径发现 + 解析。
// 与 R3a 同理，空接口会触发 no-empty-object-type，方法确定后再声明。
