/**
 * provider-importer 测试（W2，cw-2026-07-26-migration-other-agents）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/provider-importer.test.ts
 *
 * mock 策略：
 *   - vi.mock('../provider-parser.js')：控制 parseProviders 返回 fixture（含 apiKey 明文，验证脱敏）。
 *   - vi.mock('../../../infra/pi/pi-provider-store.js')：控制 getProviderNames（冲突检测）+ upsertProvider（捕获写参）。
 *
 * 覆盖：
 *   - T3：previewImport 返回的 JSON 不含 fixture 的 apiKey 值（'sk-real-key-123'）——脱敏红线。
 *   - T4：applyImport 调 upsertProvider 时传的 config 不含 _ 开头字段（剥离元数据）。
 *   - T5：冲突 provider（existingIds 含 foo）preview 标 duplicate-id + apply 标 skipped。
 *   - T6：upsertProvider 对 'A' 抛错，selectedIds=['A','B','C'] → A failed / B,C imported / failedCount=1。
 *   - T7：parseProviders 返回 null（源未安装）→ previewImport 返回 SOURCE_NOT_INSTALLED。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.mock 必须在 import 之前（vitest hoist）──────────────────────

// mock parseProviders：默认返回 null（源未安装），各 test 用 mockReturnValue 覆盖
vi.mock('../provider-parser.js', () => ({
  parseProviders: vi.fn(() => null),
}))

// mock pi-provider-store：getProviderNames 默认空数组（无冲突），upsertProvider 默认 no-op
vi.mock('../../../infra/pi/pi-provider-store.js', () => ({
  getProviderNames: vi.fn(() => []),
  upsertProvider: vi.fn(() => ({})),
}))

// ── import（在 mock 之后，拿到 mock 版本）──────────────────────────
import { previewImport, applyImport } from '../provider-importer.js'
import { parseProviders } from '../provider-parser.js'
import { getProviderNames, upsertProvider } from '../../../infra/pi/pi-provider-store.js'
import { _resetCacheForTest } from '../preview-cache.js'
import type { ParsedProvider, ParseResult } from '../provider-parser.js'

// ── fixture helpers ──────────────────────────────────────────

/** 构造 ParsedProvider fixture。注意 apiKey 含明文（用于脱敏断言）。 */
function fp(overrides: Partial<ParsedProvider> = {}): ParsedProvider {
  return {
    _sourceName: 'p1',
    _apiKeyExtracted: true,
    _warnings: [],
    api: 'anthropic-messages',
    baseUrl: 'https://example.com',
    apiKey: 'sk-real-key-123',
    models: [{ id: 'm1', name: 'M1' }],
    ...overrides,
  }
}

/** 把 ParseResult 字面量包成 mock 返回值（parseProviders mockReturnValue 需 ParseResult | null）。 */
function result(providers: ParsedProvider[]): ParseResult {
  return { providers }
}

// ── tests ────────────────────────────────────────────────────

describe('provider-importer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    // 重置默认 mock 行为
    vi.mocked(parseProviders).mockReturnValue(null)
    vi.mocked(getProviderNames).mockReturnValue([])
    vi.mocked(upsertProvider).mockImplementation(() => ({}))
  })

  // ── T3：脱敏红线 —— preview 不含 apiKey 明文 ──────────────────
  it('T3: previewImport 返回的 JSON 不含 fixture 的 apiKey 值（脱敏）', () => {
    const fixture = [fp({ _sourceName: 'leaky' })]
    vi.mocked(parseProviders).mockReturnValue(result(fixture))

    const out = previewImport('pi')

    // 必须成功（有 importId）
    expect('importId' in out).toBe(true)
    const serialized = JSON.stringify(out)
    // 红线：apiKey 明文绝不进 preview 序列化结果
    expect(serialized).not.toContain('sk-real-key-123')
    // 但 apiKeyExtracted 布尔要保留（提示前端 key 已提取）
    if ('preview' in out) {
      expect(out.preview.providers[0].apiKeyExtracted).toBe(true)
    }
  })

  // ── T4：apply 剥离 _ 前缀元数据 ──────────────────────────────
  it('T4: applyImport 调 upsertProvider 时 config 不含 _ 开头字段', () => {
    const fixture = [
      fp({ _sourceName: 'A' }),
      fp({ _sourceName: 'B', apiKey: 'sk-B-key' }),
    ]
    vi.mocked(parseProviders).mockReturnValue(result(fixture))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = applyImport(prev.importId, ['A', 'B'])

    expect('result' in applyOut).toBe(true)
    expect(upsertProvider).toHaveBeenCalledTimes(2)

    // 捕获每次 upsertProvider 调用的 config 参数，断言无 _ 前缀字段
    for (const call of vi.mocked(upsertProvider).mock.calls) {
      const [, config] = call
      const keys = Object.keys(config)
      const underscoreKeys = keys.filter((k) => k.startsWith('_'))
      expect(underscoreKeys).toEqual([])
    }
  })

  // ── T5：冲突检测（duplicate-id → skipped）────────────────────
  it('T5: existingIds 含 foo → preview conflict=duplicate-id, apply status=skipped', () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp({ _sourceName: 'foo' })]))
    vi.mocked(getProviderNames).mockReturnValue(['foo'])

    const prev = previewImport('pi')
    if (!('preview' in prev)) throw new Error('preview should succeed')
    expect(prev.preview.providers[0].conflict).toBe('duplicate-id')

    const applyOut = applyImport(prev.importId, ['foo'])
    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported).toHaveLength(1)
    expect(applyOut.result.imported[0]).toMatchObject({ id: 'foo', status: 'skipped' })
    // skipped 的 provider 不应调 upsertProvider
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  // ── T6：upsertProvider 部分失败（A failed, B/C imported, failedCount=1）──
  it('T6: upsertProvider 对 A 抛错 → A failed, B/C imported, failedCount=1', () => {
    vi.mocked(parseProviders).mockReturnValue(
      result([
        fp({ _sourceName: 'A' }),
        fp({ _sourceName: 'B' }),
        fp({ _sourceName: 'C' }),
      ]),
    )
    // upsertProvider 对 id='A' 抛错，其余成功
    vi.mocked(upsertProvider).mockImplementation((id: string) => {
      if (id === 'A') throw new Error('write failed for A')
      return {}
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = applyImport(prev.importId, ['A', 'B', 'C'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    const byId = Object.fromEntries(applyOut.result.imported.map((i) => [i.id, i]))
    expect(byId.A.status).toBe('failed')
    expect(byId.A.reason).toContain('write failed for A')
    expect(byId.B.status).toBe('imported')
    expect(byId.C.status).toBe('imported')
    expect(applyOut.result.failedCount).toBe(1)
  })

  // ── T7：源未安装 → SOURCE_NOT_INSTALLED ──────────────────────
  it('T7: parseProviders 返回 null → previewImport 返回 SOURCE_NOT_INSTALLED', () => {
    vi.mocked(parseProviders).mockReturnValue(null)

    const out = previewImport('claude')

    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('SOURCE_NOT_INSTALLED')
      expect(out.error.message).toContain('claude')
    }
  })

  // ── T7b：applyImport 缓存过期 → PREVIEW_EXPIRED ───────────────
  it('T7b: importId 不存在（缓存过期）→ applyImport 返回 PREVIEW_EXPIRED', () => {
    const out = applyImport('nonexistent-import-id', ['A'])

    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('PREVIEW_EXPIRED')
    }
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  // ── T8：apply 后缓存删除（一次性，防 importId 复用）──────────
  it('applyImport 成功后删缓存——再次 apply 同 importId 返回 PREVIEW_EXPIRED', () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp({ _sourceName: 'A' })]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const first = applyImport(prev.importId, ['A'])
    expect('result' in first).toBe(true)

    // 第二次 apply 同 importId → 缓存已被删 → PREVIEW_EXPIRED
    const second = applyImport(prev.importId, ['A'])
    expect('error' in second).toBe(true)
    if ('error' in second) {
      expect(second.error.code).toBe('PREVIEW_EXPIRED')
    }
  })

  // ── T9：selectedIds 过滤——未勾选的 provider 不写 ─────────────
  it('applyImport 仅处理 selectedIds 勾选的 provider（未勾选不调 upsertProvider）', () => {
    vi.mocked(parseProviders).mockReturnValue(
      result([fp({ _sourceName: 'A' }), fp({ _sourceName: 'B' })]),
    )

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const out = applyImport(prev.importId, ['A']) // 只勾选 A

    if (!('result' in out)) throw new Error('apply should succeed')
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(vi.mocked(upsertProvider).mock.calls[0][0]).toBe('A')
    expect(out.result.imported).toHaveLength(1)
    expect(out.result.imported[0].id).toBe('A')
  })
})
