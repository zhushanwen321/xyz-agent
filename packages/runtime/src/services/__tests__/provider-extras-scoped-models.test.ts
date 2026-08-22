/**
 * XyzProviderStore scopedModels 扩展单测（tmp 目录真实文件）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-extras-scoped-models.test.ts
 *
 * 覆盖（验收 A1-A4）：
 * - A1 读写往返：modifyScopedModels 写入 → getScopedModels 读回一致；字段缺失时读返回 []
 * - A2 非法容错：手写 providers.json 含非数组 scopedModels / 含非法条目 → 读侧过滤/置空不抛错、providers 域数据不受影响
 * - A3 去重保序由调用方保证（本层不改写），但写入 [] 后文件中字段应保留
 * - A4 与 per-provider modify 串行安全：交错调用 modifyScopedModels 与 modify 同一文件，无丢更新
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XyzProviderStore } from '../provider-extras-store.js'

let dir: string
let file: string
let store: XyzProviderStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-extras-scoped-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  file = join(dir, 'config', 'providers.json')
  store = new XyzProviderStore(file)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('XyzProviderStore scopedModels', () => {
  describe('A1 读写往返（scopedModels）', () => {
    it('A1 modifyScopedModels 写入 → getScopedModels 读回一致', async () => {
      const models = ['openai/gpt-4o', 'anthropic/claude-opus-4-5', 'deepseek/deepseek-v3']
      await store.modifyScopedModels(() => models)
      expect(store.getScopedModelsSync()).toEqual(models)
    })

    it('A1 字段缺失时 getScopedModels 返回 []（文件不存在）', () => {
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('A1 字段缺失时 getScopedModels 返回 []（providers.json 存在但无 scopedModels 字段）', async () => {
      await store.modify('a', () => ({ authMethod: 'api_key' }))
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('A1 modifyScopedModels 读取闭包参数为当前值', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      const result = await store.modifyScopedModels((cur) => [...cur, 'anthropic/claude-sonnet-4'])
      expect(result).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
    })
  })

  describe('A2 非法容错（scopedModels）', () => {
    it('A2 非数组 scopedModels → getScopedModels 返回 []、providers 域不受影响', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { 'openai': { authMethod: 'api_key' } },
        scopedModels: 'not-an-array',
      }, null, 2), 'utf-8')
      expect(store.getScopedModelsSync()).toEqual([])
      expect(store.readAllSync()).toEqual({ 'openai': { authMethod: 'api_key' } })
    })

    it('A2 非数组 scopedModels（number）→ getScopedModels 返回 []', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {},
        scopedModels: 42,
      }, null, 2), 'utf-8')
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('A2 含非法条目（不含/分隔符）→ 过滤掉非法条目并 log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(file, JSON.stringify({
          version: 1,
          providers: {},
          scopedModels: ['openai/gpt-4o', 'invalid-no-slash', 'anthropic/claude-sonnet-4'],
        }, null, 2), 'utf-8')
        expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: invalid entry format (expected provider/modelId):',
          'invalid-no-slash',
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('A2 含非 string 条目 → 过滤掉并 log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(file, JSON.stringify({
          version: 1,
          providers: {},
          scopedModels: ['openai/gpt-4o', 123, null, 'anthropic/claude-sonnet-4'],
        }, null, 2), 'utf-8')
        expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: non-string entry filtered out:',
          123,
        )
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: non-string entry filtered out:',
          null,
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('A2 scopedModels 非法时 providers 域数据完全不受影响', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {
          'openai': { authMethod: 'api_key', modelStates: { 'gpt-4o': { enabled: true } } },
          'anthropic': { authMethod: 'oauth' },
        },
        scopedModels: { not: 'array' },
      }, null, 2), 'utf-8')
      expect(store.readAllSync()).toEqual({
        'openai': { authMethod: 'api_key', modelStates: { 'gpt-4o': { enabled: true } } },
        'anthropic': { authMethod: 'oauth' },
      })
    })
  })

  describe('A3 去重保序（caller 保证，本层不改写）', () => {
    it('A3 写入 [] 后文件中 scopedModels 字段保留为空数组', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o'])

      await store.modifyScopedModels(() => [])
      expect(store.getScopedModelsSync()).toEqual([])

      // 验证文件中 scopedModels 字段保留（非 undefined/缺失）
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      expect(raw.scopedModels).toEqual([])
      expect('scopedModels' in raw).toBe(true)
    })

    it('A3 写入含重复条目时原样保留（本层不去重，由调用方保证）', async () => {
      const models = ['openai/gpt-4o', 'openai/gpt-4o', 'anthropic/claude-sonnet-4']
      await store.modifyScopedModels(() => models)
      expect(store.getScopedModelsSync()).toEqual(models)
    })
  })

  describe('A4 与 per-provider modify 串行安全', () => {
    it('A4 交错调用 modifyScopedModels 与 modify 同一文件，无丢更新', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      await store.modify('openai', () => ({ authMethod: 'api_key' }))

      await Promise.all([
        store.modifyScopedModels((cur) => [...cur, 'anthropic/claude-sonnet-4']),
        store.modify('anthropic', () => ({ authMethod: 'oauth' })),
      ])

      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
      expect(store.getExtrasSync('openai')).toEqual({ authMethod: 'api_key' })
      expect(store.getExtrasSync('anthropic')).toEqual({ authMethod: 'oauth' })
    })

    it('A4 高并发交错：多次 modifyScopedModels + 多次 modify，最终状态一致', async () => {
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) =>
          store.modifyScopedModels((cur) => [...cur, `provider-${i}/model-${i}`]),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          store.modify(`provider-${i}`, () => ({ authMethod: 'api_key' as const })),
        ),
      ])

      const scoped = store.getScopedModelsSync()
      expect(scoped).toHaveLength(10)
      expect(scoped.every(m => /^provider-\d+\/model-\d+$/.test(m))).toBe(true)

      for (let i = 0; i < 10; i++) {
        expect(store.getExtrasSync(`provider-${i}`)).toEqual({ authMethod: 'api_key' })
      }
    })

    it('A4 先 modify 后 modifyScopedModels 基于最新文件读取', async () => {
      await store.modify('openai', () => ({ authMethod: 'api_key' }))
      await store.modifyScopedModels(() => ['openai/gpt-4o'])

      await store.modify('openai', (cur) => ({ ...cur, quota: { enabled: true } }))
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o'])
      expect(store.getExtrasSync('openai')).toEqual({ authMethod: 'api_key', quota: { enabled: true } })
    })
  })
})
