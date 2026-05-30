/**
 * ModelService — model aggregation and API discovery.
 *
 * Extracted from server.ts aggregateModels() and discoverModelsFromApi().
 */
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import type { IModelService } from '../interfaces.js'

const API_FETCH_TIMEOUT_MS = 10_000

export const DEFAULT_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
}

export class ModelService implements IModelService {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[] {
    return providers.flatMap(p =>
      p.models.map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        providerId: p.id,
        providerName: p.name,
        api: m.api ?? p.api,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        thinkingLevelMap: m.thinkingLevelMap ?? (m.reasoning ? DEFAULT_THINKING_LEVEL_MAP : undefined),
        cost: m.cost,
        enabled: true,
      } as ModelInfo)),
    )
  }

  async discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
    const base = baseUrl.replace(/\/+$/, '')
    let url: string
    const headers: Record<string, string> = {}

    if (providerType === 'anthropic' || providerType === 'anthropic-messages') {
      url = `${base}/v1/models`
      if (apiKey) {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
    } else {
      url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API 返回 ${res.status}: ${body || res.statusText}`)
    }

    const data = await res.json() as Record<string, unknown>

    const modelList = Array.isArray(data.data)
      ? data.data as Array<Record<string, unknown>>
      : Array.isArray(data.models)
        ? data.models as Array<Record<string, unknown>>
        : []

    return modelList
      .filter(m => typeof m.id === 'string')
      .map(m => ({
        id: m.id as string,
        name: (m.name ?? m.id) as string,
      }))
  }
}
