export type ProviderStatus = 'connected' | 'not_configured' | 'error'

export interface ProviderInfo {
  id: string
  name: string
  status: ProviderStatus
  models: string[]
  apiKeySet: boolean
  baseUrl?: string
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  tags?: string[]
  contextWindow?: number
  enabled?: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  source: string
  triggers: string[]
  // UI 扩展字段（由后端下发或前端补充）
  sourcePath?: string
  sourceIcon?: string
  fileSize?: string
  tools?: string[]
  content?: string
  tag?: string
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
