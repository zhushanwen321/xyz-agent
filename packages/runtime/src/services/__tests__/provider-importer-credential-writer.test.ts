/**
 * provider-importer catalog 分路写凭据测试（A1-4 收口核心变更，PR #187 round-1 review MUST_FIX #1）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-importer-credential-writer.test.ts
 *
 * 策略（照抄 provider-importer-whitelist.test.ts 的 mock 模式）：
 * mock pi-provider-store（upsertProvider/getProviderNames/ensureProviderInWhitelist），用真实
 * createPreview 注入 preview 缓存条目（catalog provider + 孤儿凭据两种形态），调 applyImport 时
 * 注入 credentialWriter stub，断言：
 *   - 组 1（models.json 定义的 catalog provider）：saveCredential 以 (_sourceName, { type:'api_key', key })
 *     调用，**不写 models.json**（upsertProvider 不调用），条目 imported。
 *   - 组 2（孤儿凭据 → catalog）：saveCredential 同参数形态调用，同样不写 models.json。
 *   - 边界：apiKey 缺失不调 saveCredential（仍 imported）；saveCredential reject → 条目 failed 透传 reason。
 *
 * isCatalogProvider/matchBuiltinTemplate 走真实模块（读 generated/builtin-providers.json），
 * 测试用真实 catalog id（'openai'/'anthropic'）保证分路判定真实。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock pi-provider-store：importer 从此 import upsertProvider/getProviderNames/ensureProviderInWhitelist
vi.mock('../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getProviderNames: vi.fn(() => []),
    upsertProvider: vi.fn(() => ({})),
    ensureProviderInWhitelist: vi.fn(),
  }
})

import { applyImport } from '../migration/provider-importer.js'
import { createPreview, _resetCacheForTest } from '../migration/preview-cache.js'
// 确保 mock 生效后 import（拿到 mocked 版本）
import { getProviderNames, upsertProvider } from '../../infra/pi/pi-provider-store.js'
import type { ParsedProvider, ParsedOrphanCredential } from '../migration/provider-parser.js'
import type { CredentialWriter } from '../auth/auth-storage.js'

const mockedGetProviderNames = vi.mocked(getProviderNames)
const mockedUpsertProvider = vi.mocked(upsertProvider)

/** 构造 catalog provider 的 ParsedProvider（带可选 apiKey 明文——apply 时经 credentialWriter 落 auth.json）。 */
function makeCatalogParsed(sourceName: string, apiKey?: string): ParsedProvider {
  return {
    _sourceName: sourceName,
    _apiKeyExtracted: apiKey !== undefined && apiKey !== '',
    _credentialType: apiKey !== undefined && apiKey !== '' ? 'plaintext' : 'missing',
    _envVarName: undefined,
    _warnings: [],
    name: sourceName,
    ...(apiKey !== undefined ? { apiKey } : {}),
    models: [{ id: 'm1', name: 'M1' }],
  } as unknown as ParsedProvider
}

/** 构造孤儿凭据（auth.json 有、models.json 无定义，apply 时组 2 处理）。 */
function makeOrphan(providerId: string, apiKey: string): ParsedOrphanCredential {
  return {
    providerId,
    credentialType: 'plaintext',
    apiKey,
    warnings: [],
  }
}

/** credentialWriter stub：形态对齐 auth-storage.ts 的 CredentialWriter 接口。 */
function makeCredentialWriter(): CredentialWriter & { saveCredential: ReturnType<typeof vi.fn> } {
  return { saveCredential: vi.fn(async () => undefined) }
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetCacheForTest()
  mockedGetProviderNames.mockReturnValue([])
  mockedUpsertProvider.mockReturnValue({})
})

afterEach(() => {
  _resetCacheForTest()
})

describe('组 1：catalog provider 的秘钥经 credentialWriter 落 auth.json（不写 models.json）', () => {
  it('catalog provider 带 apiKey → saveCredential(_sourceName, { type:"api_key", key }) + imported + 不写 models.json', async () => {
    const writer = makeCredentialWriter()
    // 'openai' 是 builtin-providers.json 真实 catalog id（isCatalogProvider 走真实判定）
    const importId = createPreview('pi', [makeCatalogParsed('openai', 'sk-openai-xyz')])
    const out = await applyImport(importId, ['openai'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    // 写凭据经窄接口，参数序 = (providerId, credential)，凭据形状 = { type:'api_key', key }
    expect(writer.saveCredential).toHaveBeenCalledTimes(1)
    expect(writer.saveCredential).toHaveBeenCalledWith('openai', { type: 'api_key', key: 'sk-openai-xyz' })
    // catalog 分路不建 models.json 条目（定义归 catalog，秘钥归 auth.json）
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    expect(out.result.imported).toEqual([
      { id: 'openai', name: 'openai', status: 'imported' },
    ])
    expect(out.result.failedCount).toBe(0)
  })

  it('catalog provider 无 apiKey → 不调 saveCredential，仍 imported（catalog 定义即可用）', async () => {
    const writer = makeCredentialWriter()
    const importId = createPreview('pi', [makeCatalogParsed('anthropic', undefined)])
    const out = await applyImport(importId, ['anthropic'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(writer.saveCredential).not.toHaveBeenCalled()
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    expect(out.result.imported).toEqual([
      { id: 'anthropic', name: 'anthropic', status: 'imported' },
    ])
  })

  it('saveCredential reject → 条目 failed 透传错误消息 + failedCount=1', async () => {
    const writer = makeCredentialWriter()
    writer.saveCredential.mockRejectedValue(new Error('auth.json locked'))
    const importId = createPreview('pi', [makeCatalogParsed('openai', 'sk-openai-xyz')])
    const out = await applyImport(importId, ['openai'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(out.result.imported).toEqual([
      { id: 'openai', name: 'openai', status: 'failed', reason: 'auth.json locked' },
    ])
    expect(out.result.failedCount).toBe(1)
  })
})

describe('组 2：孤儿凭据（catalog providerId）经 credentialWriter 落 auth.json', () => {
  it('孤儿凭据带 apiKey → saveCredential(providerId, { type:"api_key", key }) + imported + 不写 models.json 模板', async () => {
    const writer = makeCredentialWriter()
    const importId = createPreview('pi', [], [makeOrphan('anthropic', 'sk-ant-orphan-key')])
    const out = await applyImport(importId, ['anthropic'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(writer.saveCredential).toHaveBeenCalledTimes(1)
    expect(writer.saveCredential).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-ant-orphan-key' })
    // catalog 孤儿凭据不落 models.json 模板（B4：定义归 catalog）
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    expect(out.result.imported).toEqual([
      { id: 'anthropic', name: 'anthropic', status: 'imported' },
    ])
    expect(out.result.failedCount).toBe(0)
  })

  it('credentialWriter 未注入 → 回退现有行为：写 models.json 模板（不调 saveCredential）', async () => {
    const importId = createPreview('pi', [], [makeOrphan('anthropic', 'sk-ant-orphan-key')])
    const out = await applyImport(importId, ['anthropic'])
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(mockedUpsertProvider).toHaveBeenCalledWith('anthropic', expect.objectContaining({
      api: expect.any(String),
      baseUrl: expect.any(String),
      apiKey: 'sk-ant-orphan-key',
    }))
    expect(out.result.imported).toEqual([
      { id: 'anthropic', name: 'anthropic', status: 'imported' },
    ])
  })
})
