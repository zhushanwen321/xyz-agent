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
  }>
  enabled?: boolean
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
}

export type ScanSourceType = 'pi' | 'claude' | 'agents' | 'custom'

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
}
