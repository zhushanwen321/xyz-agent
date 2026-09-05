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
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaService } from '../../src/services/quota-service.js'
import { XyzProviderStore } from '../../src/services/provider-extras-store.js'

// vi.hoisted 提升变量到 vi.mock factory 可访问的位置（factory 会被 hoist 到文件顶部）
// [A2-1] fetcher 接口数组化：authType 单值 → auth 数组；fetchQuota(credential, kind)
// kimi-coding 用独立 mock 实例：「手动 fetcher 优先于 preset 匹配」用例需要区分
// 「命中 kimi-coding 而非 zhipu」的可证伪信号（共享同一 mock 时优先级退化无法检出）
const { mockFetchQuota, kimiMockFetchQuota, mockFetchers } = vi.hoisted(() => {
  const mockFetchQuota = vi.fn()
  const kimiMockFetchQuota = vi.fn()
  const mockFetchers = new Map([
    ['zhipu', { id: 'zhipu', auth: ['api-key'] as const, fetchQuota: mockFetchQuota }],
    ['kimi-coding', { id: 'kimi-coding', auth: ['api-key', 'oauth'] as const, fetchQuota: kimiMockFetchQuota }],
    ['mimo', { id: 'mimo', auth: ['cookie'] as const, fetchQuota: mockFetchQuota }],
  ])
  return { mockFetchQuota, kimiMockFetchQuota, mockFetchers }
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
let extrasStore: XyzProviderStore
let extrasPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-svc-'))
  extrasPath = join(tmpDir, 'pi', 'agent', 'config', 'providers.json')
  extrasStore = new XyzProviderStore(extrasPath)
  vi.clearAllMocks()
  vi.mocked(getApiKeyForProvider).mockImplementation((id: string) => `key-for-${id}`)
  vi.mocked(getProviderConfig).mockImplementation(() => undefined)
  vi.mocked(upsertProvider).mockImplementation(() => ({}))
  mockFetchQuota.mockReset()
  kimiMockFetchQuota.mockReset()
})

/** 读 providers.json 单 provider 断言用（文件不存在返回 undefined = 无扩展数据）。 */
function readExtras(providerId: string): Record<string, unknown> | undefined {
  if (!existsSync(extrasPath)) return undefined
  return (JSON.parse(readFileSync(extrasPath, 'utf-8')).providers as Record<string, Record<string, unknown>>)[providerId]
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('my-glm')

    // 旧实现用 QUOTA_PRESETS.find(p => p.fetcher === providerId) 会匹配失败 → 静默返回缓存
    // 新实现经 matchQuotaPreset 命中 zhipu，调到 mock fetcher
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
    // api-key 凭证仍用 providerId 查（getApiKeyForProvider('my-glm')），kind 按来源形态传递
    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-my-glm', 'api-key', { workspaceUrl: undefined })
  })

  it('name 关键字匹配：provider name 含 zhipu 命中 zhipu preset', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ name: 'Zhipu BigModel' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('custom-id')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('getProviderInfo 未注入时 fallback：providerId 直接查 fetchers（兼容恰好等于 fetcher id）', async () => {
    const svc = new QuotaService({ dataDir: tmpDir })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('zhipu')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('getProviderInfo 返回的 baseUrl/name 都不命中 preset → 不调 fetcher（静默降级缓存）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://unknown.example.com', name: 'unknown' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: false, reason: 'network' })

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
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

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
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

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
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    const result = await svc.fetch('my-glm')

    // 走手动指定的 kimi-coding（独立 mock 实例）而非 baseUrl 匹配的 zhipu；
    // zhipu 的 mock 未被调用 = 优先级退化回 preset 匹配时可证伪
    expect(kimiMockFetchQuota).toHaveBeenCalledTimes(1)
    expect(kimiMockFetchQuota).toHaveBeenCalledWith('key-for-my-glm', 'api-key', { workspaceUrl: undefined })
    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data?.label).toBe('kimi')
  })

  it('quota.fetcher 指定了一个不存在的 id 时 fallback 到 matchQuotaPreset', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        quota: { fetcher: 'nonexistent-fetcher' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

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
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('my-proxy')

    // baseUrl 是自建反代（不命中任何 preset），但手动指定了 zhipu → 仍命中
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })
})

describe('QuotaService — configure 持久化（任务 4，A1-5 写侧切换：落 config/providers.json）', () => {
  it('configure 持久化 fetcher/enabled 到 providers.json，不再写 models.json', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
      apiKey: 'k',
    }))
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    const result = await svc.configure('my-glm', true, undefined, 'zhipu')

    expect(result.ok).toBe(true)
    expect(readExtras('my-glm')).toEqual({ quota: { fetcher: 'zhipu', enabled: true } })
    // A1-5：quota 不再经 upsertProvider 写 models.json（寄生字段禁复活）
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure 未传 fetcher 时保留既有 quota.fetcher（providers.json 无条目回退 models.json 旧值）', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      quota: { fetcher: 'kimi-coding', enabled: false },
    }))
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    await svc.configure('my-glm', true)

    expect(readExtras('my-glm')).toEqual({ quota: { fetcher: 'kimi-coding', enabled: true } })
  })

  it('configure provider 不存在时返回 ok=false', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => undefined)
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    const result = await svc.configure('nonexistent', true, undefined, 'zhipu')

    expect(result.ok).toBe(false)
    expect(upsertProvider).not.toHaveBeenCalled()
    expect(existsSync(extrasPath)).toBe(false)
  })

  it('persist 失败（extrasStore.modify reject）→ ok=false + "failed to persist quota config"，secrets 副作用不回滚', async () => {
    // round-1 review MUST_FIX #2：persistQuotaConfig 的 modify catch 分支——
    // cookie 文件已写（副作用发生在 persist 之前）但 providers.json 持久化失败，
    // configure 必须报错而不是静默吞掉
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://xiaomimimo.com',
    }))
    const modifySpy = vi.spyOn(extrasStore, 'modify').mockRejectedValue(new Error('EACCES: disk full'))
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    const result = await svc.configure('mimo-id', true, 'session=abc123', 'mimo')

    expect(result).toEqual({ ok: false, error: 'failed to persist quota config' })
    expect(modifySpy).toHaveBeenCalledTimes(1)
    // secrets 副作用已发生：cookie 文件已落盘（持久化失败不回滚已写 secret）
    expect(readFileSync(join(tmpDir, 'secrets', 'mimo-id-cookie.txt'), 'utf-8')).toBe('session=abc123')
    // providers.json 未物化，models.json 也不写（寄生字段禁复活）
    expect(existsSync(extrasPath)).toBe(false)
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure cookie 类写入 cookie 文件 + 标记 cookieSet', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://xiaomimimo.com',
    }))
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    const result = await svc.configure('mimo-id', true, 'session=abc123', 'mimo')

    expect(result.ok).toBe(true)
    expect(readExtras('mimo-id')).toEqual({ quota: { fetcher: 'mimo', enabled: true, cookieSet: true } })
    expect(upsertProvider).not.toHaveBeenCalled()
  })
})

// ── [S4] code review 补充测试：健壮性回归防护（W5/W7/W6/getCredential fallback/apiKey 清除）──

describe('QuotaService — W5: refresh 不污染 fetch 的 throttle', () => {
  it('refresh 不更新 lastFetchTime（force 路径不污染后续 fetch 的 throttle 判定）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

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
    let resolveFetch!: (v: { ok: true; data: { label: string; wins: never[] } }) => void
    mockFetchQuota.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r as typeof resolveFetch
      }),
    )
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu-force', wins: [] as never } })

    // fetch（normal）先发起，进入 pending（key=zhipu:normal），尚未 resolve
    const fetchP = svc.fetch('zhipu')
    // refresh（force）并发达，pending key=zhipu:force ≠ zhipu:normal → 不复用，独立发第二个请求
    const refreshP = svc.refresh('zhipu')

    // [A2-2] 凭证解析链含 await（getAuthCredential）——fetchQuota 调用延后一个微任务，
    // 等一拍再断言（旧实现同步解析凭证，调用零延迟）
    await new Promise((r) => setImmediate(r))
    // 两个 pending 各自发起了一次 fetcher 调用（互不复用 = W7 修复后的行为）
    expect(mockFetchQuota).toHaveBeenCalledTimes(2)

    resolveFetch({ ok: true, data: { label: 'zhipu-normal', wins: [] as never } })
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
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    // 无专属 key → fallback 用 provider.apiKey（'provider-key-glm-id'）
    expect(mockFetchQuota).toHaveBeenCalledWith('provider-key-glm-id', 'api-key', { workspaceUrl: undefined })
  })

  it('secrets 目录有专属 API Key 文件时优先用专属 key（不 fallback）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    // 先写入专属 key 文件
    await svc.configure('glm-id', true, undefined, 'zhipu', 'quota-exclusive-key')
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    // 有专属 key → 用专属 key（'quota-exclusive-key'），不走 fallback
    expect(mockFetchQuota).toHaveBeenCalledWith('quota-exclusive-key', 'api-key', { workspaceUrl: undefined })
  })
})

describe('QuotaService — W4 + apiKey 清除路径', () => {
  it('configure 传 apiKey="" 时删除专属 key 文件 + 标记 apiKeySet=false（落 providers.json）', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
    }))
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    // 先写入专属 key，再清除
    await svc.configure('glm-id', true, undefined, 'zhipu', 'some-key')
    const keyPath = join(tmpDir, 'secrets', 'glm-id-apikey.txt')
    expect(existsSync(keyPath)).toBe(true)

    // 清除：传 apiKey=''
    const result = await svc.configure('glm-id', true, undefined, 'zhipu', '')

    expect(result.ok).toBe(true)
    expect(existsSync(keyPath)).toBe(false)
    expect(readExtras('glm-id')).toEqual({ quota: { fetcher: 'zhipu', enabled: true, apiKeySet: false } })
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure 写入的 secret 文件权限为 0o600（仅属主可读写）', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
    }))
    const svc = new QuotaService({ dataDir: tmpDir, providerExtrasStore: extrasStore })

    await svc.configure('glm-id', true, 'cookie-val', undefined, undefined)

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
      ok: true,
      data: {
        label: 'zhipu',
        wins: [
          { pct: 10, resetSec: 100 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ] as never,
      },
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

// ── [A2-2] 凭证解析链（三形态 + auth.json 通道）──

describe('QuotaService — A2-2: api-key 形态优先级（secrets > auth.json > models.json）', () => {
  it('三者都有时优先 secrets 专属 key', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      getAuthCredential: async () => ({ type: 'api_key', key: 'auth-json-key' }),
    })
    await svc.configure('glm-id', true, undefined, 'zhipu', 'secrets-key')
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('secrets-key', 'api-key', { workspaceUrl: undefined })
  })

  it('无 secrets key 时 auth.json api_key 优先于 models.json apiKey（场景 A 断链修复）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      getAuthCredential: async () => ({ type: 'api_key', key: 'auth-json-key' }),
    })
    // getApiKeyForProvider mock 默认返回 key-for-<id>（models.json 通道有值）
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('auth-json-key', 'api-key', { workspaceUrl: undefined })
  })

  it('auth.json 无凭证时 fallback models.json apiKey（现状保留）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      getAuthCredential: async () => undefined,
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-glm-id', 'api-key', { workspaceUrl: undefined })
  })

  it('getAuthCredential 未注入时跳过 auth.json 来源（向后兼容）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-glm-id', 'api-key', { workspaceUrl: undefined })
  })

  it('getAuthCredential 抛异常不阻断来源链（降级 models.json）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      getAuthCredential: async () => {
        throw new Error('auth.json locked')
      },
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-glm-id', 'api-key', { workspaceUrl: undefined })
  })
})

describe('QuotaService — A2-2: oauth 形态与 kimi 双形态降级', () => {
  it('auth.json 只有 oauth 凭证时，api-key 形态不误用 oauth 凭证（继续走 models.json apiKey）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://api.kimi.com',
        quota: { fetcher: 'kimi-coding' },
      }),
      getAuthCredential: async () => ({
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'r',
        expires: Date.now() + 3_600_000,
      }),
    })
    // models.json 通道有 apiKey（getApiKeyForProvider mock）→ api-key 形态应先命中
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    await svc.fetch('kimi-id')

    // auth 数组序 ['api-key','oauth']：api-key 形态有凭证（models.json）则用 api-key，
    // oauth 凭证不回灌 api-key 形态（形态语义隔离）
    expect(kimiMockFetchQuota).toHaveBeenCalledWith('key-for-kimi-id', 'api-key', { workspaceUrl: undefined })
  })

  it('kimi 场景：无 api-key 凭证（secrets/auth.json/models.json 全 miss）但有 oauth 凭证 → 按数组序降级用 oauth', async () => {
    vi.mocked(getApiKeyForProvider).mockImplementation(() => undefined)
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://api.kimi.com',
        quota: { fetcher: 'kimi-coding' },
      }),
      getAuthCredential: async () => ({
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'r',
        expires: Date.now() + 3_600_000,
      }),
    })
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    await svc.fetch('kimi-id')

    // api-key 形态全 miss → 数组序下一形态 oauth，凭证取 access，kind='oauth'
    expect(kimiMockFetchQuota).toHaveBeenCalledTimes(1)
    expect(kimiMockFetchQuota).toHaveBeenCalledWith('oauth-access-token', 'oauth', { workspaceUrl: undefined })
  })

  it('cookie 类 fetcher：凭证从 secrets cookie 文件读，kind=cookie', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      getProviderInfo: () => ({
        baseUrl: 'https://platform.xiaomimimo.com',
        quota: { fetcher: 'mimo' },
      }),
      getAuthCredential: async () => ({ type: 'api_key', key: 'auth-json-key' }),
    })
    // 写入 cookie 文件（secrets 来源）
    await svc.configure('mimo-id', true, 'session=abc', 'mimo')
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'mimo', wins: [] as never } })

    await svc.fetch('mimo-id')

    // cookie 形态只认 secrets cookie 文件（auth.json api_key 不参与），kind='cookie'
    expect(mockFetchQuota).toHaveBeenCalledWith('session=abc', 'cookie', { workspaceUrl: undefined })
  })

  it('api-key/oauth 形态全 miss（fetcher.auth 不含 cookie）→ 不发请求返回缓存', async () => {
    vi.mocked(getApiKeyForProvider).mockImplementation(() => undefined)
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      getAuthCredential: async () => undefined,
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    const result = await svc.fetch('glm-id')

    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
    expect(result.reason).toBeUndefined()
  })
})

// ── [A2-4] 失败 reason 透传 ──

describe('QuotaService — A2-4: 失败 reason 透传与清除', () => {
  it('查询失败（unauthorized）→ 结果 data=null + reason；getCached 携带旧缓存数据 + reason', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 预置旧缓存：先成功 fetch 一次
    mockFetchQuota.mockResolvedValueOnce({
      ok: true,
      data: {
        label: 'zhipu',
        wins: [{ pct: 30, resetSec: 50 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never,
      },
    })
    await svc.fetch('glm-id')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush

    // 第二次查询（refresh 绕过 10s throttle——fetch 会被 throttle 拦截返回缓存，测不到失败路径）：401 失败
    mockFetchQuota.mockResolvedValueOnce({ ok: false, reason: 'unauthorized' })
    const result = await svc.refresh('glm-id')

    // 失败态：data=null（旧缓存不作为当前数据展示），reason 透传，lastFetchAt=上次成功时间
    expect(result.data).toBeNull()
    expect(result.reason).toBe('unauthorized')
    expect(result.lastFetchAt).not.toBeNull()

    // getCached：旧缓存数据保留内存（供「查看上次成功数据」）+ reason 透传
    const cached = svc.getCached('glm-id')
    expect(cached.data?.label).toBe('zhipu')
    expect(cached.reason).toBe('unauthorized')
  })

  it('成功后清除 reason（getCached 不再携带失败标记）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    mockFetchQuota.mockResolvedValueOnce({ ok: false, reason: 'network' })
    await svc.fetch('glm-id')
    expect(svc.getCached('glm-id').reason).toBe('network')

    // refresh 强制重查（绕过 throttle）成功 → reason 清除
    mockFetchQuota.mockResolvedValueOnce({
      ok: true,
      data: { label: 'zhipu', wins: [{ pct: 10, resetSec: 5 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never },
    })
    const result = await svc.refresh('glm-id')
    expect(result.data).not.toBeNull()
    expect(result.reason).toBeUndefined()
    expect(svc.getCached('glm-id').reason).toBeUndefined()
  })

  it('无旧缓存时失败：data=null + lastFetchAt=null + reason', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: false, reason: 'no-subscription' })

    const result = await svc.fetch('glm-id')

    expect(result).toEqual({ data: null, lastFetchAt: null, reason: 'no-subscription' })
  })
})

describe('QuotaService — fetcher 抛异常时防御兜底 [A2-1 契约不 throw，逃逸兜底]', () => {
  it('fetcher 抛异常时降级为 network 失败态（不 reject，不返回旧缓存数据）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 预置旧缓存：先成功 fetch 一次
    mockFetchQuota.mockResolvedValueOnce({
      ok: true,
      data: {
        label: 'zhipu',
        wins: [{ pct: 30, resetSec: 50 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never,
      },
    })
    await svc.fetch('glm-id')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush

    // 第二次查询（refresh 绕过 throttle）：fetcher 抛异常（契约外逃逸）
    mockFetchQuota.mockRejectedValueOnce(new Error('network down'))
    const result = await svc.refresh('glm-id')

    // 不 reject，降级 network 失败态（data=null + reason=network）
    expect(result.data).toBeNull()
    expect(result.reason).toBe('network')
    // 旧缓存仍可经 getCached 查看（内存保留）
    expect(svc.getCached('glm-id').data?.label).toBe('zhipu')
  })

  it('fetcher 抛异常且无旧缓存时返回空失败态（lastFetchAt=null）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockRejectedValue(new Error('always fails'))

    const result = await svc.fetch('glm-id')

    expect(result).toEqual({ data: null, lastFetchAt: null, reason: 'network' })
  })
})
