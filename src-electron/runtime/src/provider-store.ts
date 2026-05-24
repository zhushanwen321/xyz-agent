import type { ProviderInfo, ProviderStatus } from '@xyz-agent/shared'
import {
  readModels,
  upsertProvider as bridgeUpsertProvider,
  removeProvider as bridgeRemoveProvider,
  refreshModels,
} from './pi-config-bridge.js'
import type { PiProviderConfig } from './pi-config-bridge.js'

/**
 * List all configured providers from pi's models.json.
 */
export function listProviders(): ProviderInfo[] {
  const modelsConfig = readModels()
  const providers: ProviderInfo[] = []

  for (const [id, prov] of Object.entries(modelsConfig.providers)) {
    providers.push({
      id,
      name: id,
      status: getProviderStatus(!!prov.apiKey),
      models: prov.models ?? [],
      apiKeySet: !!prov.apiKey,
      baseUrl: prov.baseUrl,
      enabled: true,
    })
  }

  return providers
}

function getProviderStatus(hasApiKey: boolean): ProviderStatus {
  if (!hasApiKey) return 'not_configured' as ProviderStatus
  return 'connected' as ProviderStatus
}

/**
 * Add or update a provider configuration in pi's models.json.
 */
export function setProvider(
  providerId: string,
  data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number }>
    enabled?: boolean
  },
): void {
  // Merge with existing config if present
  const existing = readModels().providers[providerId] ?? {}
  const merged: PiProviderConfig = {
    ...existing,
    ...(data.apiKey !== undefined ? { apiKey: data.apiKey } : {}),
    ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
    ...(data.models !== undefined
      ? {
        models: data.models.map(m =>
          typeof m === 'string' ? { id: m } : { id: m.id, name: m.name, contextWindow: m.contextWindow },
        ),
      }
      : {}),
  }
  bridgeUpsertProvider(providerId, merged)
}

/**
 * Remove a provider configuration from pi's models.json.
 */
export function deleteProvider(providerId: string): boolean {
  return bridgeRemoveProvider(providerId)
}

/** Force reload from disk on next access. */
export function reload(): void {
  refreshModels()
}

/** Alias for reload — invalidate provider cache, forcing reload on next access. */
export function refreshProviders(): void {
  refreshModels()
}
