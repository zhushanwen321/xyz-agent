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
  /** pi 的 api 标识（前端直接发送 pi 终值，runtime 透传，见 applyTypeTranslation）。 */
  api?: string
  /** provider 级启停（W1）。省略时默认 true，与 infra PiProviderConfig 同构。 */
  enabled?: boolean
  models?: ConfigModelDefinition[]
}

/** service 侧的 model 定义形状。 */
export interface ConfigModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  /** model 级启停（W1）。省略时默认 true，与 infra PiModelDefinition 同构。 */
  enabled?: boolean
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
 * 实现位于 infra/pi/pi-config-store.ts（封装 pi-provider-store/agent-crud/pi-paths + type 透传）。
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
  /** 透传 provider type → pi api 标识（前端直接发 pi 终值，runtime 不再翻译别名）。 */
  applyTypeTranslation(type: string): string

  // ── Skill paths（discovery.json SSOT，ADR-0020 §1）──
  getSkillPaths(): string[]
  /** 覆盖 skillDirs（有序数组 = 优先级，靠前覆盖靠后）。写 discovery.json + 同步投影 settings.json。 */
  setSkillPaths(paths: string[]): void
  addSkillPath(dir: string): void
  removeSkillPath(dir: string): void
  /** 一次性迁移：settings.json.skills → discovery.json（首启用，幂等）。 */
  migrateSettingsSkillsToDiscovery(): void

  // ── Agent dirs（discovery.json SSOT，ADR-0020 §1）──
  getAgentDirs(): string[]
  /** 覆盖 agentDirs（有序数组 = 优先级，靠前覆盖靠后）。写 discovery.json。 */
  setAgentDirs(dirs: string[]): void

  // ── Agent files（强制目录 + discovery 多目录扫描）──
  /**
   * 扫描 agent .md 文件。
   * - 不带参：扫默认强制目录（向后兼容）。
   * - 带 dirs：扫多目录，同名按数组顺序去重（靠前覆盖靠后）。
   */
  listAgentFiles(dirs?: string[]): AgentFileEntry[]
  writeAgentFile(name: string, content: string): void
  deleteAgentFile(name: string): boolean

  // ── 配置目录 ──
  getConfigDir(): string
  /** pi agent 配置目录（~/.xyz-agent/pi/agent，settings.json/agents/extensions 所在地）。 */
  getPiAgentDir(): string
}
