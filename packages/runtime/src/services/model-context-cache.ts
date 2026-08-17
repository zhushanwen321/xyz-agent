/**
 * contextWindow 查询缓存（perf 微项 5，00-overview 微项表：index.ts setModelContextWindowResolver）。
 *
 * 动机：resolver（listProviders → aggregateModels → find）在每次 context.update /
 * switchModel 都全量重算——listProviders 内部读 auth.json + catalog 聚合 + 每模型对象构造，
 * aggregateModels 再 flatMap。streaming 期间 token 用量更新高频触发，全部是重复计算。
 *
 * 设计：TTL 缓存聚合结果（ModelInfo[]）。查询热点只在 find，聚合每 ttl 一次。
 * 行为差异（有意接受）：providers/models 配置变更后 ≤ttl 内 contextWindow 沿用旧值——
 * 该值仅用于 usagePercent 展示与切换提示，短暂陈旧无功能影响。
 *
 * 提取为独立工厂（而非 index.ts 闭包内联）：组合根 main() 不可单测，工厂纯依赖注入可测
 * （验收：重复查询零重复计算 spy 断言）。
 */
import type { ModelInfo, ProviderInfo } from '@xyz-agent/shared'

/** 聚合缓存 TTL：略长于 models.json JsonStore 的 3s 读缓存，两层叠加削峰。 */
const DEFAULT_TTL_MS = 5000

/** 依赖注入 seam（index.ts 组合根绑定 configService.listProviders + modelService.aggregateModels）。 */
export interface ContextWindowQueryDeps {
  listProviders(): ProviderInfo[]
  aggregateModels(providers: ProviderInfo[]): ModelInfo[]
}

export interface ContextWindowCacheOptions {
  /** 测试可注入短 TTL（默认 5000ms）。 */
  ttlMs?: number
}

/**
 * 创建带 TTL 缓存的 contextWindow resolver。签名与 SessionService 的
 * ModelContextWindowResolver 对齐（(provider, modelId) => number）。
 */
export function createContextWindowResolver(
  deps: ContextWindowQueryDeps,
  opts?: ContextWindowCacheOptions,
): (provider: string, modelId: string) => number {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  let cache: { models: ModelInfo[]; ts: number } | null = null
  return (provider: string, modelId: string): number => {
    const now = Date.now()
    if (cache === null || now - cache.ts >= ttlMs) {
      cache = { models: deps.aggregateModels(deps.listProviders()), ts: now }
    }
    const model = cache.models.find((m) => m.providerId === provider && m.id === modelId)
    return model?.contextWindow ?? 0
  }
}
