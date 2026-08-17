/**
 * createContextWindowResolver 单测（perf W17 微项 5：contextWindow 查询缓存）。
 *
 * 覆盖：
 * - TTL 窗口内重复查询零重复聚合（listProviders / aggregateModels 各只执行 1 次，spy 断言）
 * - 不同 (provider, modelId) 的多次查询共享同一份聚合缓存
 * - TTL 过期后重新聚合（拿到新配置）
 * - 查询语义与原 index.ts 内联 resolver 一致：命中返回 contextWindow / 未命中返回 0
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/model-context-cache.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelId, ModelInfo, ProviderId, ProviderInfo } from '@xyz-agent/shared'
import { createContextWindowResolver } from '../src/services/model-context-cache.js'

function model(provider: string, id: string, contextWindow?: number): ModelInfo {
  return {
    providerId: provider as ProviderId,
    id: id as ModelId,
    name: id,
    providerName: provider,
    contextWindow,
  }
}

/** spy 版依赖（固定 models）：listProviders / aggregateModels 计数可断言。 */
function makeDeps(models: ModelInfo[]) {
  const listProviders = vi.fn((): ProviderInfo[] => [])
  const aggregateModels = vi.fn((): ModelInfo[] => models)
  return { deps: { listProviders, aggregateModels }, listProviders, aggregateModels }
}

/** deps 代理版（models 可变）：TTL 过期用例需要中途改配置。 */
function makeMutableDeps(getModels: () => ModelInfo[]) {
  const listProviders = vi.fn((): ProviderInfo[] => [])
  const aggregateModels = vi.fn((): ModelInfo[] => getModels())
  return { deps: { listProviders, aggregateModels }, listProviders }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createContextWindowResolver（微项 5：TTL 查询缓存）', () => {
  it('TTL 窗口内重复查询零重复计算（listProviders / aggregateModels 各 1 次）', () => {
    const { deps, listProviders, aggregateModels } = makeDeps([model('p1', 'm1', 128_000)])
    const resolve = createContextWindowResolver(deps)

    expect(resolve('p1', 'm1')).toBe(128_000)
    expect(resolve('p1', 'm1')).toBe(128_000)
    expect(resolve('p1', 'm1')).toBe(128_000)
    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(aggregateModels).toHaveBeenCalledTimes(1)
  })

  it('不同 (provider, modelId) 查询共享同一份聚合缓存（仍 1 次聚合）', () => {
    const { deps, aggregateModels } = makeDeps([model('p1', 'm1', 100), model('p2', 'm2', 200)])
    const resolve = createContextWindowResolver(deps)

    expect(resolve('p1', 'm1')).toBe(100)
    expect(resolve('p2', 'm2')).toBe(200)
    expect(aggregateModels).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后重新聚合：拿到新配置的 contextWindow', () => {
    let models = [model('p1', 'm1', 100)]
    const { deps, listProviders } = makeMutableDeps(() => models)
    const resolve = createContextWindowResolver(deps, { ttlMs: 5000 })

    expect(resolve('p1', 'm1')).toBe(100)
    // 配置变更 + TTL 过期 → 重新读配置聚合
    models = [model('p1', 'm1', 999)]
    vi.advanceTimersByTime(5001)
    expect(resolve('p1', 'm1')).toBe(999)
    expect(listProviders).toHaveBeenCalledTimes(2)
  })

  it('查询语义与原内联 resolver 一致：未命中模型 / 未提供 contextWindow → 0', () => {
    const { deps } = makeDeps([model('p1', 'm1', 100), model('p1', 'm2')])
    const resolve = createContextWindowResolver(deps)

    expect(resolve('nope', 'm1')).toBe(0) // provider 不存在
    expect(resolve('p1', 'nope')).toBe(0) // model 不存在
    expect(resolve('p1', 'm2')).toBe(0) // contextWindow 未提供（?? 0）
  })
})
