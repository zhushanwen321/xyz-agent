/**
 * ConfigService.listBuiltinProviders 单测（wave 2，builtin-provider-rpc）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service.test.ts
 *
 * 测试策略（WC6）：config-service 直接测（不 mock，import 真实 generated JSON）。
 * listBuiltinProviders 是纯函数（模块级 import builtinData，不触 ConfigStore），
 * 故构造 ConfigService 时 configStore 传最小 mock（{} 即可，方法不被调用）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { BuiltinProviderTemplate } from '@xyz-agent/shared'
import type { AuthStorage } from '../auth/auth-storage.js'
import type { XyzProviderStore } from '../provider-extras-store.js'

// mock isCatalogProvider → false: keep existing test behavior (custom provider path)。
// wave2：保留 deriveEnabled 真实实现（listProviders 消费），只 override isCatalogProvider。
vi.mock('../provider-catalog.js', async (importActual) => {
  const actual = await importActual<typeof import('../provider-catalog.js')>()
  return { ...actual, isCatalogProvider: vi.fn(() => false) }
})

// listBuiltinProviders 不触 ConfigStore（纯函数 import JSON），传空对象即可实例化（构造只存引用）。
const service = new ConfigService('/tmp/project', {} as unknown as IConfigStore)

describe('ConfigService.listBuiltinProviders', () => {
  const providers: BuiltinProviderTemplate[] = service.listBuiltinProviders()

  it('t1: 返回 37 个内置 provider', () => {
    expect(providers).toHaveLength(37)
  })

  it('t2: openai authMode===api_key 且 envVars 含 OPENAI_API_KEY', () => {
    const openai = providers.find(p => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai!.authMode).toBe('api_key')
    expect(openai!.envVars).toContain('OPENAI_API_KEY')
  })

  it('t3: 不含 radius（wave 1 已排除）', () => {
    const radius = providers.find(p => p.id === 'radius')
    expect(radius).toBeUndefined()
  })

  it('t4: anthropic authMode===both 且 oauthSupported===true', () => {
    const anthropic = providers.find(p => p.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic!.authMode).toBe('both')
    expect(anthropic!.oauthSupported).toBe(true)
  })

  it('t5: 每个 provider 含全字段，models 元素含 11 字段契约（id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/thinkingLevelMap/compat）', () => {
    expect(providers.length).toBeGreaterThan(0)
    const ALL_11 = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat']
    for (const p of providers) {
      // provider 级字段
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      // api/baseUrl 为 optional，存在时须为 string
      if (p.api !== undefined) expect(typeof p.api).toBe('string')
      if (p.baseUrl !== undefined) expect(typeof p.baseUrl).toBe('string')
      expect(['api_key', 'oauth', 'both', 'ambient']).toContain(p.authMode)
      expect(Array.isArray(p.envVars)).toBe(true)
      expect(typeof p.oauthSupported).toBe('boolean')
      if (p.apiKeyName !== undefined) expect(typeof p.apiKeyName).toBe('string')
      if (p.oauthName !== undefined) expect(typeof p.oauthName).toBe('string')
      expect(typeof p.modelCount).toBe('number')
      if (p.logoUrl !== undefined) expect(typeof p.logoUrl).toBe('string')
      expect(Array.isArray(p.models)).toBe(true)
      expect(p.models.length).toBe(p.modelCount)
      // model 级 11 字段契约（生成脚本恒输出 11 键；可选字段缺省为 null）
      for (const m of p.models) {
        for (const key of ALL_11) {
          expect(m, `${p.id} model ${m.id} 应含字段 ${key}`).toHaveProperty(key)
        }
        expect(typeof m.id).toBe('string')
        expect(typeof m.name).toBe('string')
        expect(typeof m.api).toBe('string')
        if (m.baseUrl !== undefined) expect(typeof m.baseUrl).toBe('string')
        expect(typeof m.reasoning).toBe('boolean')
        expect(Array.isArray(m.input)).toBe(true)
        expect(m.contextWindow).toBeTypeOf('number')
        if (m.maxTokens !== null && m.maxTokens !== undefined) expect(typeof m.maxTokens).toBe('number')
        if (m.thinkingLevelMap !== null && m.thinkingLevelMap !== undefined) expect(typeof m.thinkingLevelMap).toBe('object')
        if (m.compat !== null && m.compat !== undefined) expect(typeof m.compat).toBe('object')
      }
    }
  })

  it('t6: google-vertex envVars 含 GOOGLE_CLOUD_API_KEY（镜像表漏配回归，M-1）', () => {
    const gv = providers.find(p => p.id === 'google-vertex')
    expect(gv).toBeDefined()
    expect(gv!.envVars).toContain('GOOGLE_CLOUD_API_KEY')
  })
})

describe('ConfigService auth 清理（I9 清理① + I8，T6）', () => {
  function makeSvc(authStorage?: Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>) {
    const mockStore = {
      getProviderConfig: vi.fn(() => ({ name: 'anthropic' })),
      upsertProvider: vi.fn(() => ({})),
      removeProvider: vi.fn(() => ({ removed: true })),
      // M5-05：deleteProvider 现调 cleanEnabledModelsResidue（决策 4 不变式），mock 必须提供
      cleanEnabledModelsResidue: vi.fn(),
    } as unknown as IConfigStore
    const svc = new ConfigService('/tmp/project', mockStore, authStorage as unknown as Pick<AuthStorage, 'set' | 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>)
    return { svc, mockStore, authStorage }
  }

  it('setProvider 保存 apiKey → 清 auth.json oauth（both provider 切凭据源，幂等）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { apiKey: 'sk-test' })
    expect(authStorage.remove).toHaveBeenCalledWith('anthropic')
  })

  it('setProvider 未传 apiKey（只改 baseUrl）→ 不清 auth.json', () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { baseUrl: 'https://proxy.example.com' })
    expect(authStorage.remove).not.toHaveBeenCalled()
  })

  it('setProvider apiKey 为空串（env 空自定义变量）→ 不清 auth.json（MF-1：防误删 OAuth 凭据）', () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { apiKey: '', authMethod: 'env_var' })
    expect(authStorage.remove).not.toHaveBeenCalled()
  })

  it('deleteProvider → 清 auth.json（I8：OAuth token 强绑定凭据，删除时同步清）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.deleteProvider('anthropic')
    expect(authStorage.remove).toHaveBeenCalledWith('anthropic')
  })

  it('deleteProvider → 清 enabledModels 残留（M5-05，决策 4 不变式，对齐 removeProviderByKind）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc, mockStore } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    await svc.deleteProvider('anthropic')
    expect(mockStore.cleanEnabledModelsResidue).toHaveBeenCalledWith('anthropic')
  })

  it('未注入 authStorage（测试/无 OAuth 场景）→ 两处清理 no-op 不抛错', () => {
    const { svc } = makeSvc()
    expect(() => svc.setProvider('anthropic', { apiKey: 'sk-x' })).not.toThrow()
    expect(() => svc.deleteProvider('anthropic')).not.toThrow()
  })
})

describe('ConfigService.checkEnvVars（I3，wave-env-check TC2）', () => {
  const KEEP: Record<string, string | undefined> = {}
  for (const name of ['CHECK_ENV_A', 'CHECK_ENV_EMPTY', 'CHECK_ENV_B']) {
    KEEP[name] = process.env[name]
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(KEEP)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('已设置（非空）→ true；未设置 / 空串 → false', () => {
    process.env.CHECK_ENV_A = 'sk-abc'
    process.env.CHECK_ENV_EMPTY = ''
    delete process.env.CHECK_ENV_B

    const result = service.checkEnvVars(['CHECK_ENV_A', 'CHECK_ENV_EMPTY', 'CHECK_ENV_B'])
    expect(result).toEqual({ CHECK_ENV_A: true, CHECK_ENV_EMPTY: false, CHECK_ENV_B: false })
  })

  it('names 去重（重复名字只查一次，结果一致）', () => {
    process.env.CHECK_ENV_A = 'x'
    const result = service.checkEnvVars(['CHECK_ENV_A', 'CHECK_ENV_A'])
    expect(Object.keys(result)).toEqual(['CHECK_ENV_A'])
    expect(result.CHECK_ENV_A).toBe(true)
  })

  it('空数组 → 空结果（不抛错）', () => {
    expect(service.checkEnvVars([])).toEqual({})
  })
})

describe('ConfigService authMethod 透传与推断（I6，wave-quick-setup-c TC7）', () => {
  it('setProvider authMethod 写 providers.json（A1-5 写侧切换），不再透传 models.json', async () => {
    const mockStore = {
      getProviderConfig: vi.fn(() => ({ name: 'openai' })),
      upsertProvider: vi.fn((_id: string, merged: Record<string, unknown>) => {
        // 寄生字段禁复活：models.json 条目不含 authMethod
        expect(merged.authMethod).toBeUndefined()
        return {}
      }),
    } as unknown as IConfigStore
    const extrasStore = {
      modify: vi.fn(async (providerId: string, fn: (current: unknown) => unknown) => {
        expect(providerId).toBe('openai')
        // RMW 回调收到 undefined（无既有条目），返回带 authMethod 的新条目
        const next = fn(undefined)
        expect(next).toEqual({ authMethod: 'api_key' })
        return next
      }),
    }
    const svc = new ConfigService('/tmp/project', mockStore, undefined, extrasStore as unknown as Pick<XyzProviderStore, 'modify' | 'getExtrasSync' | 'readAllSync' | 'delete'>)
    await svc.setProvider('openai', { apiKey: 'sk-x', authMethod: 'api_key' })
    expect(mockStore.upsertProvider).toHaveBeenCalled()
    expect(extrasStore.modify).toHaveBeenCalledWith('openai', expect.any(Function))
  })

  it('listProviders 回填 authMethod：providers.json 标注值优先；无标注 $开头→env_var，非空→api_key，空→undefined', () => {
    const mockStore = {
      readModels: vi.fn(() => ({
        providers: {
          // A1-3 读源切换：显式标注从 providers.json 读（models.json authMethod 寄生字段已迁出；
          // deriveAuthMethod 只做 apiKey 推断，不再读 config.authMethod）
          'with-mark': { name: 'A', apiKey: 'sk-x' },
          'env-legacy': { name: 'B', apiKey: '$OPENAI_API_KEY' },
          'plain-legacy': { name: 'C', apiKey: 'sk-y' },
          'empty-legacy': { name: 'D' },
        },
      })),
      // wave2：listProviders 读 enabledModels 派生 enabled（DM3），空数组 = 全启用
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const extrasStore = {
      modify: vi.fn(),
      getExtrasSync: vi.fn(() => undefined),
      readAllSync: vi.fn(() => ({ 'with-mark': { authMethod: 'oauth' } })),
    } as unknown as Pick<XyzProviderStore, 'modify' | 'getExtrasSync' | 'readAllSync' | 'delete'>
    const svc = new ConfigService('/tmp/project', mockStore, undefined, extrasStore)
    const providers = svc.listProviders()
    const byId = Object.fromEntries(providers.map(p => [p.id, p]))
    expect(byId['with-mark'].authMethod).toBe('oauth')
    expect(byId['env-legacy'].authMethod).toBe('env_var')
    expect(byId['plain-legacy'].authMethod).toBe('api_key')
    expect(byId['empty-legacy'].authMethod).toBeUndefined()
  })
})

describe('ConfigService status 派生与 models 合并（M6/T9，wave-list-badge TC1/TC2）', () => {
  it('status：models.json 无 apiKey 但 auth.json 有 oauth → connected（M6）', () => {
    const mockStore = {
      readModels: vi.fn(() => ({ providers: { anthropic: { name: 'Anthropic' } } })),
      // wave2：listProviders 读 enabledModels 派生 enabled（DM3），空数组 = 全启用
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const authStorage = {
      remove: vi.fn(async () => undefined),
      hasOAuth: vi.fn(async () => false),
      hasOAuthSync: vi.fn(() => true),
      hasCredentialSync: vi.fn(() => true),
      // B3：custom status 改用 authIdSet（listCredentialIds），需返回 anthropic 才判 connected
      listCredentialIds: vi.fn(() => ['anthropic']),
    } as unknown as Pick<AuthStorage, 'set' | 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>
    const svc = new ConfigService('/tmp/project', mockStore, authStorage)
    const providers = svc.listProviders()
    expect(providers[0].status).toBe('connected')
  })

  it('status：无 apiKey 且无 oauth 凭据 → not_configured', () => {
    const mockStore = {
      readModels: vi.fn(() => ({ providers: { openai: { name: 'OpenAI' } } })),
      // wave2：listProviders 读 enabledModels 派生 enabled（DM3），空数组 = 全启用
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const authStorage = {
      remove: vi.fn(async () => undefined),
      hasOAuth: vi.fn(async () => false),
      hasOAuthSync: vi.fn(() => false),
      hasCredentialSync: vi.fn(() => false),
      // wave2：补齐 listCredentialIds（isCatalogProvider mock 恒 false → 走 custom，防真实调用崩）
      listCredentialIds: vi.fn(() => []),
    } as unknown as Pick<AuthStorage, 'set' | 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>
    const svc = new ConfigService('/tmp/project', mockStore, authStorage)
    expect(svc.listProviders()[0].status).toBe('not_configured')
  })

  it('models 合并（T9/M5）：models 空 → builtin 兜底；自定义非空 → 保留；不在 builtin 范围 → 不合并', () => {
    const mockStore = {
      readModels: vi.fn(() => ({
        providers: {
          openai: { name: 'OpenAI' },
          anthropic: { name: 'Anthropic', models: [{ id: 'custom-model' }] },
          'unknown-x': { name: 'X' },
        },
      })),
      // wave2：listProviders 读 enabledModels 派生 enabled（DM3），空数组 = 全启用
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const svc = new ConfigService('/tmp/project', mockStore)
    const providers = svc.listProviders()
    const byId = Object.fromEntries(providers.map(p => [p.id, p]))
    // openai 是 builtin provider：models 兜底非空
    expect(byId['openai'].models.length).toBeGreaterThan(0)
    expect(byId['openai'].models[0].id).toBeTruthy()
    // anthropic 自定义 models 保留（builtin 不覆盖）
    expect(byId['anthropic'].models).toEqual([expect.objectContaining({ id: 'custom-model' })])
    // unknown-x 不在 builtin 范围：models 仍为空
    expect(byId['unknown-x'].models).toEqual([])
  })
})
