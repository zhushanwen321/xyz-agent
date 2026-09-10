/**
 * provider-config-helper scoped-model 残留清理测试（scoped-model design §4.1 A8 / S8）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-config-helper.test.ts
 *
 * A8 语义：deleteProvider 后 scopedModels（providers.json 顶层白名单）中该 provider 的
 * `providerId/` 前缀条目被清，其他 provider 条目保留。
 *
 * 策略：真实 XyzProviderStore（tmpdir providers.json，走 RMW 锁 + 原子写真路径）
 * + mock configStore/authStorage（调用路由断言，模式同 config-service-removebykind.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { XyzProviderStore } from '../provider-extras-store.js'
import { applyProviderWritePolicy, listProviders } from '../provider-config-helper.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import type { IConfigStore } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

let dir: string
let extrasPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-config-helper-'))
  extrasPath = join(dir, 'config', 'providers.json')
  mkdirSync(join(dir, 'config'), { recursive: true })
  // 防线②③ 命中即 warn（诊断日志）——测试期静音，需要断言的用例经 expect(console.warn) 检查
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 预写 providers.json（含顶层 scopedModels 白名单）。 */
function writeScopedModels(scopedModels: string[]): void {
  writeFileSync(extrasPath, JSON.stringify({ version: 1, providers: {}, scopedModels }, null, 2))
}

/** 读回文件态 scopedModels（绕过 store 直接读盘，断言写路径真生效）。 */
function readScopedModels(): string[] {
  return (JSON.parse(readFileSync(extrasPath, 'utf-8')) as { scopedModels?: string[] }).scopedModels ?? []
}

/** 最小 mock IConfigStore（写方法 vi.fn 供断言路由，模式同 config-service-removebykind.test.ts）。 */
function makeStore() {
  return {
    getEnabledModels: vi.fn(() => []),
    getDefaultModel: vi.fn(() => null),
    removeProvider: vi.fn(() => ({ removed: true })),
    cleanEnabledModelsResidue: vi.fn(),
  } as unknown as IConfigStore & {
    removeProvider: ReturnType<typeof vi.fn>
    cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
  }
}

function makeAuth(): FullAuthPick {
  return {
    listCredentialIds: vi.fn(() => []),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as FullAuthPick
}

function makeService(): { svc: ConfigService; store: ReturnType<typeof makeStore> } {
  const store = makeStore()
  const svc = new ConfigService('/tmp/project', store, makeAuth(), new XyzProviderStore(extrasPath))
  return { svc, store }
}

describe('A8: deleteProvider 清 scopedModels 残留', () => {
  it('A8 删除 provider 后 scopedModels 中该 provider 前缀条目被清，其他 provider 条目保留', async () => {
    writeScopedModels(['openai/gpt-4', 'anthropic/claude', 'openai/gpt-3.5'])
    const { svc, store } = makeService()

    await svc.deleteProvider('openai')

    // openai/ 前缀两条被清，anthropic 条目保留（读盘断言，非 mock 回显）
    expect(readScopedModels()).toEqual(['anthropic/claude'])
    // 编排路由：models.json 条目删除 + enabledModels 残留清理照旧
    expect(store.removeProvider).toHaveBeenCalledWith('openai')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
  })

  it('A8 无匹配条目时幂等（scopedModels 原样保留）', async () => {
    writeScopedModels(['anthropic/claude'])
    const { svc } = makeService()

    await svc.deleteProvider('openai')

    expect(readScopedModels()).toEqual(['anthropic/claude'])
  })
})

/**
 * M1b：防线载体 applyProviderWritePolicy（设计 D1 防线②③，catalog-provider-field-authority v3.3）。
 *
 * 纯函数单测（a–j 逐条对应实施计划验收条款）+ 一条 setProvider 接线用例（证明载体真的被
 * setProvider 路径消费，而不只是可独立调用）。
 */
describe('M1b: applyProviderWritePolicy 防线②③', () => {
  it('a1 空串矩阵（provider 级）：name/baseUrl/apiKey/api 收到空串 → merged 无任何键', () => {
    const { merged } = applyProviderWritePolicy(
      {},
      { name: '', baseUrl: '', apiKey: '', api: '' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged).toEqual({})
  })

  it('a2 空串矩阵（模型级）：id/name/api/baseUrl 空串 → 空串键被剥除 + 空 id 模型整条丢弃', () => {
    const { merged } = applyProviderWritePolicy(
      {},
      { models: [{ id: 'm1', name: '', api: '', baseUrl: '' }, { id: '', name: 'orphan' }] },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged.models).toEqual([{ id: 'm1' }])
  })

  it('b apiKey 空串 = 清除语义 → merged.apiKey 键被删除（不是被写成空串）', () => {
    const { merged } = applyProviderWritePolicy(
      { apiKey: 'sk-old', baseUrl: 'https://api.example/v1' },
      { apiKey: '' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged).not.toHaveProperty('apiKey')
  })

  it('c 纯空白串（"  "）与空串同视 → 不写键 + 既有值不变', () => {
    const { merged } = applyProviderWritePolicy(
      { apiKey: 'sk-old', baseUrl: 'https://api.example/v1' },
      { apiKey: '  ', name: '  ', baseUrl: '  ', api: '  ' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged).toEqual({ baseUrl: 'https://api.example/v1' })
  })

  it('d catalog + type 键 → merged 不含 provider 级 api 键 + warn', () => {
    const { merged } = applyProviderWritePolicy(
      { baseUrl: 'https://gw.example' },
      { api: 'anthropic-messages' },
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(merged).not.toHaveProperty('api')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ignored provider-level type for catalog opencode-go'))
  })

  it('e catalog + 非空 baseUrl（settings）→ 写入 merged.baseUrl 且返回 gatewayToSet', () => {
    const { merged, gatewayToSet } = applyProviderWritePolicy(
      {},
      { baseUrl: 'https://gw.example/opencode' },
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(merged.baseUrl).toBe('https://gw.example/opencode')
    expect(gatewayToSet).toBe('https://gw.example/opencode')
  })

  it('f catalog + 显式空串 baseUrl → merged 无 baseUrl 键且返回 gatewayToClear', () => {
    const { merged, gatewayToClear } = applyProviderWritePolicy(
      { baseUrl: 'https://gw.example/old' },
      { baseUrl: '' },
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(merged).not.toHaveProperty('baseUrl')
    expect(gatewayToClear).toBe(true)
  })

  it('g catalog + baseUrl 未带键（undefined）→ 既有 baseUrl 不变且无网关信号', () => {
    const result = applyProviderWritePolicy(
      { baseUrl: 'https://gw.example/keep' },
      {},
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(result.merged.baseUrl).toBe('https://gw.example/keep')
    expect(result.gatewayToSet).toBeUndefined()
    expect(result.gatewayToClear).toBeUndefined()
  })

  it('h 八字段全缺 → 返回 skipUpsert 信号（name 不计入实质字段）', () => {
    const result = applyProviderWritePolicy({}, { name: 'Only Name' }, 'custom', 'settings', 'p-empty')

    expect(result.skipUpsert).toBe(true)
  })

  it('h2 八字段任一在场 → 不返回 skipUpsert（反向对照）', () => {
    const result = applyProviderWritePolicy(
      { headers: { 'X-K': 'v' } },
      {},
      'custom',
      'settings',
      'p-nonempty',
    )

    expect(result.skipUpsert).toBeUndefined()
  })

  it("i source='import' + catalog + 非空 baseUrl/api → 两者均被剥除（不产生隐形网关）", () => {
    const result = applyProviderWritePolicy(
      {},
      { baseUrl: 'https://gw.example', api: 'anthropic-messages' },
      'catalog',
      'import',
      'opencode-go',
    )

    expect(result.merged).toEqual({})
  })

  it("j source='settings' + custom + 非空 baseUrl → 原样写入", () => {
    const { merged } = applyProviderWritePolicy(
      {},
      { baseUrl: 'https://api.example/v1' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged.baseUrl).toBe('https://api.example/v1')
  })
})

describe('M1b: setProvider 接线（防线②③ 经 applyProviderWritePolicy 载体消费信号）', () => {
  /**
   * 最小 mock IConfigStore（setProvider 路径：读既有条目 + 捕获 upsert 入参）+ 真实
   * XyzProviderStore（gatewayBaseUrl 标记落盘/清理走真文件，modify 经 spy 观测调用序）。
   */
  function makeSetProviderService(existing: Record<string, unknown> | undefined) {
    const upsertProvider = vi.fn((_providerId: string, _merged: Record<string, unknown>) => ({}))
    const ensureProviderInWhitelist = vi.fn()
    const store = {
      getProviderConfig: vi.fn(() => existing),
      applyTypeTranslation: vi.fn((t: string) => t),
      upsertProvider,
      ensureProviderInWhitelist,
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const extras = new XyzProviderStore(extrasPath)
    const modifySpy = vi.spyOn(extras, 'modify')
    const svc = new ConfigService('/tmp/project', store, makeAuth(), extras)
    return { svc, upsertProvider, ensureProviderInWhitelist, extras, modifySpy }
  }

  it('catalog 保存空串 baseUrl + 快照 artifact type → 落盘条目不含 baseUrl/api 键（P0 毒化链拆除）', async () => {
    const { svc, upsertProvider } = makeSetProviderService({ name: 'OpenCode Go' })

    await svc.setProvider('opencode-go', {
      type: 'anthropic-messages',
      baseUrl: '',
      headers: { 'X-Custom': 'v' },
    })

    expect(upsertProvider.mock.calls[0]?.[1]).toEqual({ name: 'OpenCode Go', headers: { 'X-Custom': 'v' } })
  })

  it('custom 清除 API Key 哨兵（apiKey:""）→ 落盘条目删键而非写空串', async () => {
    const { svc, upsertProvider } = makeSetProviderService({ apiKey: 'sk-old', baseUrl: 'https://api.example/v1' })

    await svc.setProvider('p-custom', { apiKey: '' })

    expect(upsertProvider.mock.calls[0]?.[1]).toEqual({ baseUrl: 'https://api.example/v1' })
  })

  it('catalog 设置用户网关（非空 baseUrl）→ 落盘条目写入该 baseUrl', async () => {
    const { svc, upsertProvider } = makeSetProviderService({ name: 'OpenCode Go' })

    await svc.setProvider('opencode-go', { baseUrl: 'https://gw.example/opencode' })

    expect(upsertProvider.mock.calls[0]?.[1]).toMatchObject({ baseUrl: 'https://gw.example/opencode' })
  })

  it('b catalog + 非空 baseUrl → extras 写 gatewayBaseUrl 标记，且 upsert 在其后（写序契约）', async () => {
    const { svc, upsertProvider, extras, modifySpy } = makeSetProviderService({ name: 'OpenCode Go' })

    await svc.setProvider('opencode-go', { baseUrl: 'https://gw.example/opencode' })

    expect(extras.getExtrasSync('opencode-go')?.gatewayBaseUrl).toBe('https://gw.example/opencode')
    expect(modifySpy).toHaveBeenCalledTimes(1)
    // 设置网关：先写 extras 标记、后写 models.json（崩溃中间态 = 多余标记，D2 可自愈）
    expect(modifySpy.mock.invocationCallOrder[0]).toBeLessThan(upsertProvider.mock.invocationCallOrder[0]!)
  })

  it('a 既有条目 + 清空网关 → upsert 被调用、落盘条目不含 baseUrl、extras 标记被清（验收场景 A\'/5 单元级）', async () => {
    // 预置形态 = 用户此前设过网关：catalog override {name, baseUrl} + extras 标记
    const { svc, upsertProvider, extras, modifySpy } = makeSetProviderService({
      name: 'OpenCode Go',
      baseUrl: 'https://gw.example',
    })
    await extras.modify('opencode-go', current => ({ ...current, gatewayBaseUrl: 'https://gw.example' }))
    modifySpy.mockClear()

    await svc.setProvider('opencode-go', { baseUrl: '' })

    // (i) 既有条目的剥除/清除必须落盘（否则用户的「清空」是静默 no-op、盘上旧 baseUrl 仍生效）
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    // (ii) 落盘条目不含 baseUrl 键（回退内置端点）
    expect(upsertProvider.mock.calls[0]?.[1]).not.toHaveProperty('baseUrl')
    // (iii) extras 网关标记被清
    expect(extras.getExtrasSync('opencode-go')?.gatewayBaseUrl).toBeUndefined()
    expect(modifySpy).toHaveBeenCalledTimes(1)
  })

  it('清空网关：无标记时短路不调 extras.modify（既有条目照样 upsert）', async () => {
    const { svc, upsertProvider, modifySpy } = makeSetProviderService({
      name: 'OpenCode Go',
      baseUrl: 'https://gw.example/keep',
    })

    await svc.setProvider('opencode-go', { baseUrl: '' })

    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(upsertProvider.mock.calls[0]?.[1]).not.toHaveProperty('baseUrl')
    expect(modifySpy).not.toHaveBeenCalled()
  })

  it('b 新建 + 八字段全缺 → upsertProvider 不被调用（只不物化「新」空壳）', async () => {
    const { svc, upsertProvider } = makeSetProviderService(undefined)

    await svc.setProvider('p-empty', { name: 'Only Name' })

    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('c 既有条目 + 八字段全缺（全清空）→ upsertProvider 被调用，落盘内容为剥除后结果', async () => {
    const { svc, upsertProvider } = makeSetProviderService({
      name: 'OpenCode Go',
      baseUrl: 'https://gw.example',
    })

    await svc.setProvider('opencode-go', { baseUrl: '' })

    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(upsertProvider.mock.calls[0]?.[1]).toEqual({ name: 'OpenCode Go' })
  })

  it('d 新建 + skipUpsert 成立 → ensureProviderInWhitelist 仍被调用（白名单守卫不随 skip 跳过）', async () => {
    const { svc, upsertProvider, ensureProviderInWhitelist } = makeSetProviderService(undefined)

    await svc.setProvider('p-new-empty', { name: 'Only Name' })

    expect(upsertProvider).not.toHaveBeenCalled()
    expect(ensureProviderInWhitelist).toHaveBeenCalledWith('p-new-empty')
  })
})

/**
 * M2b：链 5 凭据判定迁移到 resolver 批量 sync 版（设计 D3 收口）。
 *
 * 不变量：apiKeySet / status 判定经 `listCredentialBackedProviderIds` 单次批量取（auth.json ∪
 * models.json），不得退回 per-provider `hasProviderCredential` / `hasCredentialSync` 循环
 * （那会重新引入 N+1 读盘，B3 先例 provider-config-helper.ts:412）。
 */
describe('M2b: listProviders 凭据判定走 resolver 批量 sync 版（链 5）', () => {
  function makeListStore(providers: Record<string, unknown> = {}) {
    return {
      readModels: vi.fn(() => ({ providers })),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
  }

  function makeResolver(ids: string[]) {
    const resolver: IProviderCredentialResolver = {
      hasProviderCredential: vi.fn(() => false),
      listCredentialBackedProviderIds: vi.fn(() => new Set(ids)),
      resolveProviderCredential: vi.fn(async () => undefined),
    }
    return resolver
  }

  it('apiKeySet 以 resolver 批量结果为权威，且 store/auth 均单次读（无 N+1）', () => {
    const store = makeListStore({ 'my-custom': { name: 'My Custom' } })
    const auth = makeAuth()
    // auth.json 有 anthropic（catalog），但 resolver 批量结果为空 → apiKeySet 应以 resolver 为准
    vi.mocked(auth.listCredentialIds).mockReturnValue(['anthropic'])
    const resolver = makeResolver([])

    const result = listProviders(store, auth, undefined, resolver)

    // 单次批量调用（非 per-provider hasProviderCredential / hasCredentialSync 循环）
    expect(vi.mocked(resolver.listCredentialBackedProviderIds)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resolver.hasProviderCredential)).not.toHaveBeenCalled()
    // 批量单次读盘：readModels / listCredentialIds 各一次
    expect(vi.mocked(store.readModels)).toHaveBeenCalledTimes(1)
    expect(auth.listCredentialIds).toHaveBeenCalledTimes(1)
    expect(auth.hasCredentialSync).not.toHaveBeenCalled()
    // 权威性：resolver 空集 → catalog 凭据判定为 false，status 落到 not_configured
    const anthropic = result.find(p => p.id === 'anthropic')
    expect(anthropic?.kind).toBe('catalog')
    expect(anthropic?.apiKeySet).toBe(false)
    expect(anthropic?.status).toBe('not_configured')
  })

  it('resolver 批量结果命中时 catalog provider 判 connected', () => {
    // catalog 候选来自 models.json 条目（auth.json 无该 id）；无 override.apiKey →
    // 旧内联判定为 false，命中仅可能来自 resolver 批量集
    const store = makeListStore({ anthropic: {} })
    const auth = makeAuth()
    const resolver = makeResolver(['anthropic'])

    const result = listProviders(store, auth, undefined, resolver)

    const anthropic = result.find(p => p.id === 'anthropic')
    expect(anthropic?.apiKeySet).toBe(true)
    expect(anthropic?.status).toBe('connected')
  })

  it('未注入 resolver 时降级旧内联判定（auth.json 集合命中 catalog）', () => {
    const store = makeListStore()
    const auth = makeAuth()
    vi.mocked(auth.listCredentialIds).mockReturnValue(['anthropic'])

    const result = listProviders(store, auth)

    expect(result.find(p => p.id === 'anthropic')?.apiKeySet).toBe(true)
    // 降级路径同样单次读盘（无 per-provider hasCredentialSync）
    expect(auth.hasCredentialSync).not.toHaveBeenCalled()
  })

  it('真 resolver 接线：auth.json-only catalog provider 判 connected（端到端，无 per-provider 判定）', () => {
    const providers = { 'my-custom': { name: 'My Custom' } }
    const store = {
      readModels: vi.fn(() => ({ providers })),
      getEnabledModels: vi.fn(() => []),
      getProviderConfig: vi.fn((id: string) => (providers as Record<string, unknown>)[id]),
    } as unknown as IConfigStore
    const auth = makeAuth()
    // 凭据只在 auth.json（models.json 的 my-custom 无 apiKey）
    vi.mocked(auth.listCredentialIds).mockReturnValue(['anthropic'])
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: vi.fn(async () => undefined) },
      authStorage: auth,
      configStore: store,
    })

    const result = listProviders(store, auth, undefined, resolver)

    // auth.json-only catalog provider 命中（旧内联路径也命中；此处证明真 resolver 接线可达）
    expect(result.find(p => p.id === 'anthropic')?.apiKeySet).toBe(true)
    // 批量形态：不逐 provider 走 getProviderConfig / hasCredentialSync
    expect(store.getProviderConfig).not.toHaveBeenCalled()
    expect(auth.hasCredentialSync).not.toHaveBeenCalled()
  })
})
