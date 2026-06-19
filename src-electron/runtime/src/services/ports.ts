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

// ── 以下接口为 R3b/R3c 骨架签名（service 侧尚未接入）──────────────
// 空接口会触发 @typescript-eslint/no-empty-object-type，故 R3b/R3c 的接口在
// 方法签名确定后再声明。各 port 的职责与覆盖范围记录于此，供后续阶段实现：
//
// 🔨 R3b: IPiEngine   — pi 引擎交互（每 session 一个实例）。
//                       service 经此发 prompt/abort/steer，不再直接持有 rpc-client。
//                       方法：prompt/abort/steer/followUp/compact/setModel/getHistory/getCommands。
// 🔨 R3b: IPiProcess  — pi 进程池（session↔pi 绑定）。
//                       方法：createSession/destroySession/getClient/hasClient/onExit。
// 🔨 R3b: IPiEvents   — pi 事件流（翻译后内部事件 PiTranslatedEvent，非 PiEvent）。
//                       方法：onEvent(listener) → 返回 unsubscribe。
// 🔨 R3c: IModelSource — 模型发现（HTTP 探测 + 聚合）。
//                       方法：aggregateModels/discoverFromApi。
// 🔨 R3c: IInstaller   — 安装器（npm/git）。
//                       方法：installNpm/installGit。
