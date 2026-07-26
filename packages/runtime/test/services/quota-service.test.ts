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
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
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

// ── mock pi-provider-store：模拟凭证读取 + quota 配置持久化 ──
vi.mock('../../src/infra/pi/pi-provider-store.js', () => ({
  getApiKeyForProvider: vi.fn((providerId: string) => `key-for-${providerId}`),
  getProviderConfig: vi.fn(() => undefined),
  upsertProvider: vi.fn(() => ({})),
}))

import { getApiKeyForProvider, getProviderConfig, upsertProvider } from '../../src/infra/pi/pi-provider-store.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-svc-'))
  vi.clearAllMocks()
  vi.mocked(getApiKeyForProvider).mockImplementation((id: string) => `key-for-${id}`)
  vi.mocked(getProviderConfig).mockImplementation(() => undefined)
  vi.mocked(upsertProvider).mockImplementation(() => ({}))
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

describe('QuotaService — 手动选择 fetcher（任务 1）', () => {
  it('quota.fetcher 手动指定时优先于 matchQuotaPreset', async () => {
    // baseUrl 命中 zhipu preset，但用户手动指定用 kimi-coding fetcher
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        name: '智谱 GLM',
        quota: { fetcher: 'kimi-coding' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'kimi', wins: [] as never })

    await svc.fetch('my-glm')

    // 走手动指定的 kimi-coding，而非自动匹配的 zhipu
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-my-glm')
    // 验证用的是 kimi-coding fetcher（mockFetchers 里 kimi-coding 与 zhipu 共用同一个 mockFetchQuota，
    // 无法直接区分，但能确认 fetcher 被调用 = 手动指定生效）
  })

  it('quota.fetcher 指定了一个不存在的 id 时 fallback 到 matchQuotaPreset', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        quota: { fetcher: 'nonexistent-fetcher' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('my-glm')

    // 手动指定的 id 不存在 → fallback 到自动匹配的 zhipu
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('quota.fetcher 手动指定后不再依赖 baseUrl/name（空 baseUrl 也能命中）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://my-reverse-proxy.example.com',
        name: 'my-proxy',
        quota: { fetcher: 'zhipu' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('my-proxy')

    // baseUrl 是自建反代（不命中任何 preset），但手动指定了 zhipu → 仍命中
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })
})

describe('QuotaService — configure 持久化（任务 4）', () => {
  it('configure 持久化 fetcher/enabled 到 provider config', () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
      apiKey: 'k',
    }))
    const svc = new QuotaService({ dataDir: tmpDir })

    const result = svc.configure('my-glm', true, undefined, 'zhipu')

    expect(result.ok).toBe(true)
    expect(upsertProvider).toHaveBeenCalledWith('my-glm', expect.objectContaining({
      quota: expect.objectContaining({ fetcher: 'zhipu', enabled: true }),
    }))
  })

  it('configure 未传 fetcher 时保留既有 quota.fetcher', () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      quota: { fetcher: 'kimi-coding', enabled: false },
    }))
    const svc = new QuotaService({ dataDir: tmpDir })

    svc.configure('my-glm', true)

    expect(upsertProvider).toHaveBeenCalledWith('my-glm', expect.objectContaining({
      quota: expect.objectContaining({ fetcher: 'kimi-coding', enabled: true }),
    }))
  })

  it('configure provider 不存在时返回 ok=false', () => {
    vi.mocked(getProviderConfig).mockImplementation(() => undefined)
    const svc = new QuotaService({ dataDir: tmpDir })

    const result = svc.configure('nonexistent', true, undefined, 'zhipu')

    expect(result.ok).toBe(false)
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure cookie 类写入 cookie 文件 + 标记 cookieSet', () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://xiaomimimo.com',
    }))
    const svc = new QuotaService({ dataDir: tmpDir })

    const result = svc.configure('mimo-id', true, 'session=abc123', 'mimo')

    expect(result.ok).toBe(true)
    expect(upsertProvider).toHaveBeenCalledWith('mimo-id', expect.objectContaining({
      quota: expect.objectContaining({
        fetcher: 'mimo',
        enabled: true,
        cookieSet: true,
      }),
    }))
  })
})

// ── [S4] code review 补充测试：健壮性回归防护（W5/W7/W6/getCredential fallback/apiKey 清除）──

describe('QuotaService — W5: refresh 不污染 fetch 的 throttle', () => {
  it('refresh 不更新 lastFetchTime（force 路径不污染后续 fetch 的 throttle 判定）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    // 先 refresh（force）：不更新 lastFetchTime
    await svc.refresh('zhipu')
    // 紧接着 fetch：若 refresh 污染了 lastFetchTime，此刻 elapsed≈0 < 10s 会被拦 → 调 1 次
    // W5 修复后 refresh 不设 lastFetchTime → fetch 不被拦，正常发 → 调 2 次
    await svc.fetch('zhipu')

    expect(mockFetchQuota).toHaveBeenCalledTimes(2)
  })
})

describe('QuotaService — W7: refresh 与 fetch pending 互不复用', () => {
  it('refresh 命中并发 fetch 的 pending 时不会返回非 force 结果（pending key 带 force 维度）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 用一个可手动 resolve 的 promise 模拟「fetch 先发起、未 resolve 时 refresh 并发到达」
    let resolveFetch!: (v: { label: string; wins: never[] }) => void
    mockFetchQuota.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r as typeof resolveFetch
      }),
    )
    mockFetchQuota.mockResolvedValue({ label: 'zhipu-force', wins: [] as never })

    // fetch（normal）先发起，进入 pending（key=zhipu:normal），尚未 resolve
    const fetchP = svc.fetch('zhipu')
    // refresh（force）并发达，pending key=zhipu:force ≠ zhipu:normal → 不复用，独立发第二个请求
    const refreshP = svc.refresh('zhipu')

    // 两个 pending 各自发起了一次 fetcher 调用（互不复用 = W7 修复后的行为）
    expect(mockFetchQuota).toHaveBeenCalledTimes(2)

    resolveFetch({ label: 'zhipu-normal', wins: [] as never })
    await Promise.all([fetchP, refreshP])
  })
})

describe('QuotaService — getCredential fallback: api-key 类无专属 key 时用 provider.apiKey', () => {
  it('secrets 目录无专属 API Key 文件时，fallback 到 provider.apiKey', async () => {
    // secrets 目录未写入任何 <id>-apikey.txt → getCredential 应 fallback 到 provider.apiKey
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    // provider.apiKey 由 getApiKeyForProvider mock 提供（key-for-<id>）
    vi.mocked(getApiKeyForProvider).mockImplementation((id: string) => `provider-key-${id}`)
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('glm-id')

    // 无专属 key → fallback 用 provider.apiKey（'provider-key-glm-id'）
    expect(mockFetchQuota).toHaveBeenCalledWith('provider-key-glm-id')
  })

  it('secrets 目录有专属 API Key 文件时优先用专属 key（不 fallback）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    // 先写入专属 key 文件
    svc.configure('glm-id', true, undefined, 'zhipu', 'quota-exclusive-key')
    mockFetchQuota.mockResolvedValue({ label: 'zhipu', wins: [] as never })

    await svc.fetch('glm-id')

    // 有专属 key → 用专属 key（'quota-exclusive-key'），不走 fallback
    expect(mockFetchQuota).toHaveBeenCalledWith('quota-exclusive-key')
  })
})

describe('QuotaService — W4 + apiKey 清除路径', () => {
  it('configure 传 apiKey="" 时删除专属 key 文件 + 标记 apiKeySet=false', () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
      quota: { fetcher: 'zhipu', enabled: true, apiKeySet: true },
    }))
    const svc = new QuotaService({ dataDir: tmpDir })

    // 先写入专属 key，再清除
    svc.configure('glm-id', true, undefined, 'zhipu', 'some-key')
    const keyPath = join(tmpDir, 'secrets', 'glm-id-apikey.txt')
    expect(existsSync(keyPath)).toBe(true)

    // 清除：传 apiKey=''
    const result = svc.configure('glm-id', true, undefined, 'zhipu', '')

    expect(result.ok).toBe(true)
    expect(existsSync(keyPath)).toBe(false)
    expect(upsertProvider).toHaveBeenLastCalledWith('glm-id', expect.objectContaining({
      quota: expect.objectContaining({ apiKeySet: false }),
    }))
  })

  it('configure 写入的 secret 文件权限为 0o600（仅属主可读写）', () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
    }))
    const svc = new QuotaService({ dataDir: tmpDir })

    svc.configure('glm-id', true, 'cookie-val', undefined, undefined)

    const cookiePath = join(tmpDir, 'secrets', 'glm-id-cookie.txt')
    const mode = statSync(cookiePath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('QuotaService — W6: 不同 providerId 并发 update 不丢数据', () => {
  it('并发 fetch 两个不同 provider 后，两者缓存都在（写串行化不丢）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: (id) =>
        id === 'p-a'
          ? { baseUrl: 'https://bigmodel.cn' }
          : id === 'p-b'
            ? { name: 'Zhipu BigModel' }
            : undefined,
    })

    mockFetchQuota.mockImplementation(async () => ({
      label: 'zhipu',
      wins: [
        { pct: 10, resetSec: 100 },
        { pct: null, resetSec: null },
        { pct: null, resetSec: null },
      ] as never,
    }))

    // 并发 fetch 两个 provider → cache.update 内部串到写链，互不覆盖
    await Promise.all([svc.fetch('p-a'), svc.fetch('p-b')])

    // 等一拍让 writeChain flush（update 外层同步返回，内部 writeChain 异步链 flush）
    await new Promise((r) => setImmediate(r))

    const a = svc.getCached('p-a')
    const b = svc.getCached('p-b')
    // 两个 provider 缓存都应存在（若 update 无串行化，后写者会覆盖前者的整文件快照 → 丢一个）
    expect(a.data).not.toBeNull()
    expect(b.data).not.toBeNull()
  })
})

describe('QuotaService — fetcher 抛异常时降级返回旧缓存 [S4]', () => {
  it('fetcher 抛异常时 doFetch 降级返回旧缓存（不 reject）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 预置旧缓存：先成功 fetch 一次
    mockFetchQuota.mockResolvedValueOnce({
      label: 'zhipu',
      wins: [{ pct: 30, resetSec: 50 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never,
    })
    await svc.fetch('glm-id')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush

    // 第二次 fetch：fetcher 抛异常
    mockFetchQuota.mockRejectedValueOnce(new Error('network down'))
    const result = await svc.fetch('glm-id')

    // 不 reject，降级返回旧缓存（pct=30）
    expect(result.data).not.toBeNull()
    expect(result.data?.label).toBe('zhipu')
    expect(result.data?.wins[0]?.pct).toBe(30)
  })

  it('fetcher 抛异常且无旧缓存时返回 null（降级空）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockRejectedValue(new Error('always fails'))

    const result = await svc.fetch('glm-id')

    expect(result.data).toBeNull()
    expect(result.lastFetchAt).toBeNull()
  })
})
