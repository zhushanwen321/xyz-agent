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
}
