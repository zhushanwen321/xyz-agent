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
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  modelStrategy: string
  icon?: string
}
