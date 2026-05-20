import type { ProviderInfo, ProviderStatus } from '@xyz-agent/shared'
import {
  loadConfig,
  updateProvider as configUpdateProvider,
  removeProvider as configRemoveProvider,
} from './config-store.js'

// 内存缓存，避免每次调用都穿透到 config-store 读磁盘
let cachedProviders: ProviderInfo[] | null = null

// 验证结果缓存，用于区分 connected 和 error 状态
const validationCache = new Map<string, { valid: boolean; checkedAt: number }>()
const VALIDATION_TTL_MINUTES = 5
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
const VALIDATION_TTL = VALIDATION_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND // 5 分钟

function invalidateCache(): void {
  cachedProviders = null
}

function getProviderStatus(id: string, hasApiKey: boolean): ProviderStatus {
  if (!hasApiKey) return 'not_configured' as ProviderStatus

  const cached = validationCache.get(id)
  if (cached && Date.now() - cached.checkedAt < VALIDATION_TTL && !cached.valid) {
    return 'error' as ProviderStatus
  }

  return 'connected' as ProviderStatus
}

function ensureCache(): ProviderInfo[] {
  if (cachedProviders) return cachedProviders

  const config = loadConfig()
  const providers: ProviderInfo[] = []

  for (const [id, prov] of Object.entries(config.providers)) {
    providers.push({
      id,
      name: prov.name ?? id,
      type: prov.type,
      status: getProviderStatus(id, !!prov.apiKey),
      models: prov.models ?? [],
      apiKeySet: !!prov.apiKey,
      baseUrl: prov.baseUrl,
      enabled: prov.enabled !== false,
    })
  }

  cachedProviders = providers
  return providers
}

/**
 * List all configured providers with their status.
 */
export function listProviders(): ProviderInfo[] {
  return ensureCache()
}

/**
 * Add or update a provider configuration.
 */
export function setProvider(
  providerId: string,
  data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; ctx?: number; tags?: string[]; enabled?: boolean }>
    enabled?: boolean
  },
): void {
  configUpdateProvider(providerId, data)
  invalidateCache()
}

/**
 * Remove a provider configuration.
 */
export function deleteProvider(providerId: string): boolean {
  const result = configRemoveProvider(providerId)
  invalidateCache()
  return result
}

/** Update validation result cache. Called after validateProvider. */
export function setValidationResult(providerId: string, valid: boolean): void {
  validationCache.set(providerId, { valid, checkedAt: Date.now() })
  invalidateCache()
}

/** Force reload from disk on next access. */
export function reload(): void {
  invalidateCache()
}

/** Alias for reload — invalidate provider cache, forcing reload on next access. */
export function refreshProviders(): void {
  invalidateCache()
}
