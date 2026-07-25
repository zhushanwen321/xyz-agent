export type ProviderStatus = 'connected' | 'not_configured' | 'error'

export interface ProviderInfo {
  id: string
  name: string
  api?: string
  baseUrl?: string
  apiKeySet: boolean
  headers?: Record<string, string>
  authHeader?: boolean
  status: ProviderStatus
  models: Array<{
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
    /** model 级启停（W2）。省略时默认 true，供 aggregateModels 过滤判断。 */
    enabled?: boolean
  }>
  enabled?: boolean
  /** Coding Plan 额度查询配置（可选；未配置 = 不查额度）。 */
  quota?: {
    /**
     * 使用的 fetcher id（手动指定，匹配 QuotaPreset.fetcher / ProviderQuotaFetcher.id）。
     * 未设置时由 QuotaService 自动按 baseUrl/name 匹配 QUOTA_PRESETS。
     */
    fetcher?: string
    /** 是否启用额度查询。 */
    enabled: boolean
    /**
     * cookie 类 provider 的 cookie 是否已写入 runtime（布尔态，明文不入前端）。
     * api-key 类复用 ProviderInfo.apiKeySet，无需此字段。
     */
    cookieSet?: boolean
    /**
     * api-key 类 provider 是否有 Coding Plan 专属 API Key（明文存 secrets 目录，不写 models.json）。
     * 未设置/false = 复用 ProviderInfo.apiKey（provider 的 API Key）。
     */
    apiKeySet?: boolean
  }
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  api?: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  enabled?: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  /**
   * 目录级管道模型下恒为 true（目录在 = 启用，ADR-0020 §5）。
   * 前端不再渲染文件级开关；保留字段仅为兼容历史消费方，后续废弃。
   */
  enabled: boolean
  source: string
  triggers: string[]
  argumentHint?: string
  // UI 扩展字段（由后端下发或前端补充）
  sourcePath?: string
  sourceIcon?: string
  fileSize?: string
  tools?: string[]
  content?: string
  tag?: string
  /**
   * 生效标注（ADR-0020 §5）：同名多来源合并后，优先级最高（数组靠前）的那条标 true。
   * UI badge 链第一个标「生效」。
   */
  effective?: boolean
  /**
   * 同名多来源 badge 链（ADR-0020 §5）：每个来源一项，按优先级排序（强制 > 可选；可选内按 skillDirs 数组顺序）。
   * 单来源条目可省略；前端据此渲染多源覆盖可视化。
   */
  sources?: Array<{ source: string; sourcePath: string }>
}

export type ScanSourceType = 'pi' | 'claude' | 'agents' | 'custom'

/**
 * discovery.json schema（ADR-0020 §1）—— skill/agent/extension 加载路径的唯一真相源。
 * 位于 `<piAgentDir>/discovery.json`（~/.xyz-agent/pi/agent/discovery.json）。
 * skillDirs / agentDirs / extensionDirs 是有序数组，靠前覆盖靠后（§1.1 层 3）。
 * 强制目录不进此文件（桥接层硬编码注入）。
 *
 * extensionDirs：用户勾选的外部 extension 扫描目录（P1 pi 原生 + P2 xyz-agent + 自定义），
 * 复刻 pi 的 collectAutoExtensionEntries 扫描。npm 安装的 extension 不进此文件（走 settings.json packages[]）。
 */
export interface DiscoveryConfig {
  version: 1
  skillDirs: string[]
  agentDirs: string[]
  extensionDirs: string[]
}

/**
 * UI 加载路径配置项（层 A）。
 * path: 目录路径（~/.pi/agent/skills 等）。
 * enabled: 是否进 discovery.json 数组（目录在 = 加载，ADR-0020 §5）。
 * 排序由数组顺序承载（可拖排序），故 UI 侧是有序 SkillDirConfig[]。
 */
export interface SkillDirConfig {
  path: string
  enabled: boolean
}

export interface ScannedSkillInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string
  triggers: string[]
  argumentHint?: string
  content: string
  fileSize?: string
  tools?: string[]
  alreadyImported: boolean
}

export interface ScannedAgentInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string
  content: string
  icon?: string
  tools?: string[]
  alreadyImported: boolean
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  modelStrategy: string
  icon?: string
  // UI 扩展字段（由后端下发或前端补充）
  source?: string
  sourceType?: string
  iconBg?: string
  type?: string
  tools?: string[]
  modelBind?: string
  modelTags?: { power?: string; efficient?: string; fast?: string }
  overrideParams?: boolean
  params?: { depth: number; width: number; tokens: number; rounds: number }
  content?: string
  /** 生效标注（ADR-0020 §5），语义同 SkillInfo.effective。 */
  effective?: boolean
  /** 同名多来源 badge 链（ADR-0020 §5），语义同 SkillInfo.sources。 */
  sources?: Array<{ source: string; sourcePath: string }>
}
