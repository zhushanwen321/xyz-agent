/**
 * ModelService — model aggregation and API discovery.
 *
 * Extracted from server.ts aggregateModels() and discoverModelsFromApi().
 */
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import type { IModelService } from '../interfaces.js'
import { lookupModel } from '../model-db.js'

const KILOBYTE = 1000
const API_FETCH_TIMEOUT_MS = 10_000

export class ModelService implements IModelService {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[] {
    return providers.flatMap(p =>
      p.models.map(m => {
        const entry: unknown = m
        if (typeof entry === 'string') {
          const dbRecord = lookupModel(entry)
          return {
            id: entry,
            name: dbRecord?.name ?? entry,
            providerId: p.id,
            providerName: p.name,
            contextWindow: dbRecord?.context,
            enabled: true,
          } as ModelInfo
        }
        if (entry && typeof entry === 'object' && 'id' in entry) {
          const meta = entry as { id: unknown; name: unknown; ctx?: unknown; tags?: unknown; enabled?: unknown }
          return {
            id: typeof meta.id === 'string' ? meta.id : String(meta.id),
            name: typeof meta.name === 'string' ? meta.name : String(meta.name ?? meta.id),
            providerId: p.id,
            providerName: p.name,
            tags: Array.isArray(meta.tags) ? meta.tags.filter(t => typeof t === 'string') : [],
            contextWindow: typeof meta.ctx === 'number'
              ? meta.ctx
              : this.parseCtxToNumber(
                typeof meta.ctx === 'string' ? meta.ctx : undefined,
              ),
            enabled: meta.enabled !== false,
          } as ModelInfo
        }
        return {
          id: String(m),
          name: String(m),
          providerId: p.id,
          providerName: p.name,
          enabled: true,
        } as ModelInfo
      }),
    )
  }

  private parseCtxToNumber(ctx?: string): number | undefined {
    if (!ctx || ctx === '--') return undefined
    const match = ctx.match(/^(\d+(?:\.\d+)?)\s*([kK])?$/)
    if (!match) return undefined
    const num = parseFloat(match[1])
    return match[2]?.toLowerCase() === 'k' ? Math.round(num * KILOBYTE) : Math.round(num)
  }

  async discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; ctx?: number }>> {
    const base = baseUrl.replace(/\/+$/, '')
    let url: string
    const headers: Record<string, string> = {}

    if (providerType === 'anthropic') {
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
      .map(m => {
        const id = m.id as string
        const dbRecord = lookupModel(id)
        return {
          id,
          name: (m.name ?? id) as string,
          ctx: dbRecord?.context ?? undefined,
        }
      })
  }
}
