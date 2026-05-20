import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CTX_1M = 1_000_000
const CTX_1K = 1000

export interface ModelRecord {
  id: string
  name: string
  context?: number
  output?: number
  features?: {
    reasoning?: boolean
    tool_call?: boolean
    structured_output?: boolean
    attachment?: boolean
  }
  pricing?: {
    input?: number
    output?: number
  }
}

const DB_PATH = join(homedir(), '.xyz-agent', 'model-db.json')

/** model-id → ModelRecord 的快速查找表 */
const index = new Map<string, ModelRecord>()
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true

  if (!existsSync(DB_PATH)) {
    console.warn('[model-db] database not found at', DB_PATH)
    return
  }

  try {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf-8')) as Record<string, unknown>
    // 结构: { providerSlug: { models: { modelId: { id, limit: { context }, ... } } } }
    for (const providerVal of Object.values(raw)) {
      const provider = providerVal as { models?: Record<string, Record<string, unknown>> }
      if (!provider.models) continue
      for (const model of Object.values(provider.models)) {
        const id = model.id as string | undefined
        if (!id) continue
        const limit = model.limit as { context?: number; output?: number } | undefined
        index.set(id, {
          id,
          name: (model.name ?? id) as string,
          context: limit?.context,
          output: limit?.output,
          features: model.features as ModelRecord['features'],
          pricing: model.pricing as ModelRecord['pricing'],
        })
      }
    }
    console.log(`[model-db] loaded ${index.size} models from ${DB_PATH}`)
  // eslint-disable-next-line taste/no-silent-catch -- intentional: model db is optional, fall back gracefully
  } catch (e) {
    console.error('[model-db] failed to load:', e)
  }
}

/**
 * 按 model id 查找元数据。
 * 支持精确匹配和后缀匹配（如 API 返回 "claude-haiku-4-5-20251001" 匹配同 id）。
 */
export function lookupModel(modelId: string): ModelRecord | undefined {
  load()

  // 精确匹配
  const exact = index.get(modelId)
  if (exact) return exact

  // 模糊匹配：遍历所有 key 做包含匹配（O(n) 但只在未精确命中时执行）
  const lower = modelId.toLowerCase()
  for (const [key, record] of index) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return record
    }
  }

  return undefined
}

// ── Pi provider 映射 ────────────────────────────────────────────

const PI_MODELS_PATH = join(homedir(), '.pi', 'agent', 'models.json')

/** modelId → pi provider name 的查找表 */
const piProviderIndex = new Map<string, string>()
let piProviderLoaded = false

function loadPiProviders(): void {
  if (piProviderLoaded) return
  piProviderLoaded = true

  if (!existsSync(PI_MODELS_PATH)) return

  try {
    const raw = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf-8')) as Record<string, unknown>
    const providers = raw?.providers
    if (!providers || typeof providers !== 'object') return

    // 先收集所有 provider 的 model 映射，再按优先级选取
    // 优先级：非 dev provider > dev provider
    const allMappings = new Map<string, Array<{ providerId: string; isDev: boolean }>>()

    for (const [providerId, prov] of Object.entries(providers)) {
      const p = prov as { models?: Array<{ id: string }> }
      if (!Array.isArray(p.models)) continue
      const isDev = providerId === 'dev'
      for (const m of p.models) {
        const list = allMappings.get(m.id) ?? []
        list.push({ providerId, isDev })
        allMappings.set(m.id, list)
      }
    }

    for (const [modelId, candidates] of allMappings) {
      // 优先选非 dev provider
      const preferred = candidates.find(c => !c.isDev) ?? candidates[0]
      piProviderIndex.set(modelId, preferred.providerId)
    }
    console.log(`[model-db] loaded ${piProviderIndex.size} pi provider mappings`)
  // eslint-disable-next-line taste/no-silent-catch -- intentional: pi provider mapping is optional
  } catch (e) {
    console.error('[model-db] pi models.json not available:', e)
  }
}

/**
 * 根据 modelId 查找 pi 认识的 provider 名称。
 * 例如 modelId="glm-5-turbo" → "llm-simple-router"
 */
export function lookupPiProvider(modelId: string): string | undefined {
  loadPiProviders()
  return piProviderIndex.get(modelId)
}

/** 格式化 context 数字为人类可读字符串，如 200000 → "200K"，1000000 → "1M" */
export function formatContext(ctx?: number): string {
  if (!ctx) return '--'
  if (ctx >= CTX_1M) return `${(ctx / CTX_1M).toFixed(ctx % CTX_1M === 0 ? 0 : 1)}M`
  if (ctx >= CTX_1K) return `${Math.round(ctx / CTX_1K)}K`
  return String(ctx)
}
