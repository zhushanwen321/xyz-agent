/**
 * QuotaService 单测 — 聚焦偏差 #B（providerId→fetcher 映射）+ 偏差 #C（refresh 绕过 throttle）。
 *
 * 任务 1 回归防护：providerId 是用户自定义 id（如 'my-zhipu'），不是 fetcher id（'zhipu'）。
 *   必须经 getProviderInfo → matchQuotaPreset 路由到正确 fetcher，旧实现用 === 导致静默失败。
 * 任务 3 回归防护：refresh 绕过 10s throttle，测试查询每次都发真实请求。
 *
 * 运行：cd packages/runtime && npx vitest run test/services/quota-service.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaService } from '../../src/services/quota-service.js'

// vi.hoisted 提升变量到 vi.mock factory 可访问的位置（factory 会被 hoist 到文件顶部）
const { mockFetchQuota, mockFetchers } = vi.hoisted(() => {
  const mockFetchQuota = vi.fn()
  const mockFetchers = new Map([
    ['zhipu', { id: 'zhipu', authType: 'api-key' as const, fetchQuota: mockFetchQuota }],
    ['kimi-coding', { id: 'kimi-coding', authType: 'api-key' as const, fetchQuota: mockFetchQuota }],
  ])
  return { mockFetchQuota, mockFetchers }
})

// ── mock QUOTA_FETCHERS：注入可控 fetcher，不依赖真实 HTTP ──
vi.mock('../../src/services/quota-providers/index.js', () => ({
  QUOTA_FETCHERS: mockFetchers,
}))

// ── mock pi-provider-store：模拟凭证读取 ──
vi.mock('../../src/infra/pi/pi-provider-store.js', () => ({
  getApiKeyForProvider: vi.fn((providerId: string) => `key-for-${providerId}`),
}))

import { getApiKeyForProvider } from '../../src/infra/pi/pi-provider-store.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-svc-'))
  vi.clearAllMocks()
  vi.mocked(getApiKeyForProvider).mockImplementation((id: string) => `key-for-${id}`)
  mockFetchQuota.mockReset()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('QuotaService — 偏差 #B: providerId→fetcher 映射', () => {
  it('providerId 不等于 fetcher id 时，经 getProviderInfo→matchQuotaPreset 路由到正确 fetcher', async () => {
    // 用户自定义 provider id='my-glm'，baseUrl 命中 zhipu preset
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: (id) =>
        id === 'my-glm'
          ? { baseUrl: 'https://open.bigmodel.cn/api', name: '智谱 GLM' }
          : undefined,
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('my-glm')

    // 旧实现用 QUOTA_PRESETS.find(p => p.fetcher === providerId) 会匹配失败 → 静默返回缓存
    // 新实现经 matchQuotaPreset 命中 zhipu，调到 mock fetcher
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
    // api-key 凭证仍用 providerId 查（getApiKeyForProvider('my-glm')）
    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-my-glm')
  })

  it('name 关键字匹配：provider name 含 zhipu 命中 zhipu preset', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ name: 'Zhipu BigModel' }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('custom-id')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('getProviderInfo 未注入时 fallback：providerId 直接查 fetchers（兼容恰好等于 fetcher id）', async () => {
    const svc = new QuotaService({ dataDir: tmpDir })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('zhipu')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('getProviderInfo 返回的 baseUrl/name 都不命中 preset → 不调 fetcher（静默降级缓存）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://unknown.example.com', name: 'unknown' }),
    })
    mockFetchQuota.mockResolvedValue(null)

    await svc.fetch('weird-id')

    expect(mockFetchQuota).not.toHaveBeenCalled()
  })
})

describe('QuotaService — 偏差 #C: refresh 绕过 throttle', () => {
  it('refresh 绕过 10s throttle，连续调用都触发 fetcher', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.refresh('zhipu')
    await svc.refresh('zhipu')

    // 两次都触发（refresh 不检查 lastFetchTime）
    expect(mockFetchQuota).toHaveBeenCalledTimes(2)
  })

  it('fetch 受 throttle：10s 内第二次 fetch 不触发 fetcher（返回缓存）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('zhipu')
    await svc.fetch('zhipu')

    // fetch 第二次被 throttle 拦截
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })
})
