/**
 * Config 域 ports —— Provider/Skill/Agent 的 CRUD + 默认模型 + 配置目录。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/pi-config-store.ts 实现。
 * pi 的协议类型（PiProviderConfig/PiModelDefinition）只存在于 infra 实现内部，
 * service 只见本文件定义的 ConfigProviderConfig / ConfigModelDefinition。
 */

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
  /** pi agent 配置目录（~/.xyz-agent/pi/agent，settings.json/agents/extensions 所在地）。 */
  getPiAgentDir(): string
}
