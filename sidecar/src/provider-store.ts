import type { ProviderInfo, ProviderStatus } from '@xyz-agent/shared'
import {
  loadConfig,
  updateProvider as configUpdateProvider,
  removeProvider as configRemoveProvider,
} from './config-store.js'

/**
 * List all configured providers with their status.
 */
export function listProviders(): ProviderInfo[] {
  const config = loadConfig()
  const providers: ProviderInfo[] = []

  for (const [id, prov] of Object.entries(config.providers)) {
    providers.push({
      id,
      name: prov.name ?? id,
      status: prov.apiKey
        ? ('connected' as ProviderStatus)
        : ('not_configured' as ProviderStatus),
      models: prov.models ?? [],
      apiKeySet: !!prov.apiKey,
      baseUrl: prov.baseUrl,
    })
  }

  return providers
}

/**
 * Add or update a provider configuration.
 */
export function setProvider(
  providerId: string,
  data: {
    name?: string
    apiKey?: string
    baseUrl?: string
    models?: string[]
  },
): void {
  configUpdateProvider(providerId, data)
}

/**
 * Remove a provider configuration.
 */
export function deleteProvider(providerId: string): boolean {
  return configRemoveProvider(providerId)
}
