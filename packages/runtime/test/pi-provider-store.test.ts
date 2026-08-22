import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderId } from '@xyz-agent/shared'

import {
  readModels,
  writeModels,
  getProviderNames,
  getProviderConfig,
  getAllModels,
  upsertProvider,
  removeProvider,
  getDefaultModel,
  setDefaultModel,
  getEnabledModels,
  setEnabledModels,
  getDefaultThinkingLevel,
  setDefaultThinkingLevel,
  getSkillPaths,
  setSkillPaths,
  findValidDefaultModel,
  refreshModels,
  setModelsPath,
  readSettings,
  type PiModelsConfig,
  type PiProviderConfig,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { setDiscoveryPath } from '../src/infra/pi/discovery-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'pi-provider-store-test-'))
  mkdirSync(join(tmpDir, 'pi', 'agent'), { recursive: true })
  setModelsPath(join(tmpDir, 'pi', 'agent', 'models.json'))
  setSettingsPath(join(tmpDir, 'pi', 'agent', 'settings.json'))
  // [HISTORICAL] discovery.json 也必须隔离，否则 setSkillPaths 写真实路径污染用户数据。
  // 2026-07-26 事故：本用例 skillPaths round-trip 调 setSkillPaths([tmpDir/skills-a, ...])，
  // 但 beforeEach 漏了 setDiscoveryPath，导致 discovery-store 模块级变量绑定的真实路径
  // (~/.xyz-agent/pi/agent/discovery.json) 被写成 tmp 路径；afterEach rm(tmpDir) 后路径失效，
  // 用户重启 app 发现 skill 扫描路径「凭空消失」。
  setDiscoveryPath(join(tmpDir, 'pi', 'agent', 'discovery.json'))
  refreshModels()
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

const anthropic: PiProviderConfig = {
  apiKey: 'sk-test',
  models: [
    { id: 'claude-sonnet', name: 'Sonnet' },
    { id: 'claude-opus', name: 'Opus' },
  ],
}

describe('pi-provider-store — models.json', () => {
  describe('readModels / writeModels', () => {
    it('returns empty providers when models.json does not exist', () => {
      expect(readModels()).toEqual({ providers: {} })
    })

    it('writes and reads back providers', () => {
      writeModels({ providers: { anthropic } })
      const read = readModels()
      expect(Object.keys(read.providers)).toEqual(['anthropic'])
      expect(read.providers.anthropic?.models?.length).toBe(2)
    })

    it('returns fallback on corrupt JSON', () => {
      const path = join(tmpDir, 'pi', 'agent', 'models.json')
      writeFileSync(path, '{ broken', 'utf-8')
      refreshModels()
      expect(readModels()).toEqual({ providers: {} })
    })

    it('returns fallback on schema mismatch (providers not object)', () => {
      const path = join(tmpDir, 'pi', 'agent', 'models.json')
      writeFileSync(path, JSON.stringify({ providers: 'not-an-object' }), 'utf-8')
      refreshModels()
      expect(readModels()).toEqual({ providers: {} })
    })

    it('serves cached value within TTL', () => {
      writeModels({ providers: { anthropic } })
      // 外部改盘，缓存应挡住
      writeFileSync(
        join(tmpDir, 'pi', 'agent', 'models.json'),
        JSON.stringify({ providers: { openai: { models: [{ id: 'gpt' }] } } }),
        'utf-8',
      )
      expect(getProviderNames()).toEqual(['anthropic'])
    })

    it('re-reads disk after refreshModels', () => {
      writeModels({ providers: { anthropic } })
      writeFileSync(
        join(tmpDir, 'pi', 'agent', 'models.json'),
        JSON.stringify({ providers: { openai: { models: [{ id: 'gpt' }] } } }),
        'utf-8',
      )
      refreshModels()
      expect(getProviderNames()).toEqual(['openai'])
    })
  })

  describe('queries', () => {
    beforeEach(() => {
      writeModels({ providers: { anthropic } })
      refreshModels()
    })

    it('getProviderNames lists provider ids', () => {
      expect(getProviderNames()).toEqual(['anthropic'])
    })

    it('getProviderConfig returns deep copy (not reference)', () => {
      const cfg = getProviderConfig('anthropic')
      expect(cfg?.apiKey).toBe('sk-test')
      // 确认是深拷贝：改返回值不影响内部
      cfg!.apiKey = 'mutated'
      expect(getProviderConfig('anthropic')?.apiKey).toBe('sk-test')
    })

    it('getProviderConfig returns undefined for missing provider', () => {
      expect(getProviderConfig('nonexistent')).toBeUndefined()
    })

    it('getAllModels flattens provider models', () => {
      const all = getAllModels()
      expect(all).toHaveLength(2)
      expect(all.map(m => m.id).sort()).toEqual(['claude-opus', 'claude-sonnet'])
      expect(all[0]?.providerId).toBe('anthropic')
    })
  })

  describe('upsertProvider', () => {
    beforeEach(() => {
      writeModels({ providers: { anthropic } })
      refreshModels()
    })

    it('adds a new provider', () => {
      upsertProvider('openai', { models: [{ id: 'gpt-4' }] })
      refreshModels()
      expect(getProviderNames().sort()).toEqual(['anthropic', 'openai'].sort())
    })

    it('replaces an existing provider', () => {
      writeModels({ providers: { anthropic } })
      refreshModels()
      upsertProvider('anthropic', { models: [{ id: 'claude-new' }] })
      refreshModels()
      expect(getProviderConfig('anthropic')?.models?.map(m => m.id)).toEqual(['claude-new'])
    })

    it('非 catalog provider 显式 models:[] 清空模型 → default 删除且无回退（无其他有 models 的 provider）', () => {
      // 用非 catalog id：catalog provider 的 models:[] 只代表清 override，builtin 模型仍有效
      //（见下方 catalog union 用例），「清空 = provider 无模型」语义只对非 catalog provider 成立
      writeModels({ providers: { 'my-custom-llm': { apiKey: 'sk-x', models: [{ id: 'm1' }] } } })
      refreshModels()
      setDefaultModel('my-custom-llm' as ProviderId, 'm1')
      upsertProvider('my-custom-llm', { apiKey: 'sk-x', models: [] })
      // defaultModel 失效应被修复
      const def = getDefaultModel()
      expect(def).toBeNull() // 无其他有 model 的 provider
    })

    it('partial upsert（无 models 键）保留 defaultProvider/defaultModel（spec §8 OAuth 守卫）', () => {
      // builtin override-only provider：models.json 条目本无 models 数组（models undefined），
      // 模拟 clearApiKey 剥离 apiKey / quota 覆写 / QuickSetup 保存不携带 models 的真实场景。
      writeModels({
        providers: {
          anthropic: { apiKey: 'sk-test' }, // 无 models 键
          openai: { models: [{ id: 'gpt-4' }] }, // 有 models 的 provider（fallback 候选）
        },
      })
      refreshModels()
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet')

      const outcome = upsertProvider('anthropic', { name: 'Anthropic', apiKey: 'sk-test-2' })

      // 守卫契约：models 未参与本次更新 → 不触碰 settings 的 default，无 newDefault 回退
      expect(outcome).toEqual({})
      const settings = readSettings()
      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.defaultModel).toBe('claude-sonnet')
    })

    it('非 catalog provider 显式 models: [] 删除默认并回退到第一个有 models 的 provider', () => {
      writeModels({
        providers: {
          'my-custom-llm': { apiKey: 'sk-x', models: [{ id: 'm1' }] },
          openai: { models: [{ id: 'gpt-4' }] },
        },
      })
      refreshModels()
      setDefaultModel('my-custom-llm' as ProviderId, 'm1')

      const outcome = upsertProvider('my-custom-llm', { name: 'Custom', apiKey: 'sk-x-2', models: [] })

      // 显式空数组 ≠ undefined：仍走默认校验 → 删除失效默认 → 回退第一个有 models 的 provider
      expect(outcome).toEqual({ newDefault: { provider: 'openai', modelId: 'gpt-4' } })
      const settings = readSettings()
      expect(settings.defaultProvider).toBe('openai')
      expect(settings.defaultModel).toBe('gpt-4')
    })

    it('catalog provider 保存 override-only 条目（B-2）：builtin 默认模型仍是有效 default，不被改写/删除', () => {
      // round 1 review must-fix #1：B-2 前端保存 catalog provider 只回传 override 条目
      //（无 override 时为 []），builtin 模型不在回传列表——default 校验须以
      // 「override ∪ builtin catalog」判定有效性，否则 builtin 默认模型被静默重置。
      // anthropic 是 catalog provider（builtin-providers.json，含 claude-sonnet-4-6）。
      writeModels({
        providers: {
          anthropic: { apiKey: 'sk-test' }, // catalog provider 条目：无 override models
          openai: { models: [{ id: 'gpt-4' }] },
        },
      })
      refreshModels()
      // 默认模型取 builtin 列表内的模型（models.json 条目中不存在）
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet-4-6')

      // 场景 ②：保存含 override 条目（用户新加自定义模型）→ defaultModel 不被改为 override 首项
      const outcomeA = upsertProvider('anthropic', { apiKey: 'sk-test', models: [{ id: 'my-override-model' }] })
      expect(outcomeA).toEqual({ newDefault: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' } })
      let settings = readSettings()
      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.defaultModel).toBe('claude-sonnet-4-6')

      // 场景 ①：保存无 override（models: []）→ 不删除 default（builtin 模型仍有效）
      const outcomeB = upsertProvider('anthropic', { apiKey: 'sk-test', models: [] })
      expect(outcomeB).toEqual({ newDefault: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' } })
      settings = readSettings()
      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.defaultModel).toBe('claude-sonnet-4-6')
    })

    it('catalog provider 默认模型真失效（不在 override ∪ builtin 并集）→ 仍回退到有效列表首项', () => {
      writeModels({
        providers: { anthropic: { apiKey: 'sk-test', models: [{ id: 'my-override-model' }] } },
      })
      refreshModels()
      // defaultModel 既不在 override 也不在 builtin anthropic 模型列表 → 应回退
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet')

      const outcome = upsertProvider('anthropic', { apiKey: 'sk-test', models: [{ id: 'my-override-model' }] })

      expect(outcome).toEqual({ newDefault: { provider: 'anthropic', modelId: 'my-override-model' } })
      const settings = readSettings()
      expect(settings.defaultModel).toBe('my-override-model')
    })
  })

  describe('removeProvider', () => {
    it('removes provider and returns removed:true', () => {
      writeModels({ providers: { anthropic, openai: { models: [{ id: 'gpt' }] } } })
      refreshModels()
      const result = removeProvider('openai')
      expect(result.removed).toBe(true)
      refreshModels()
      expect(getProviderNames()).toEqual(['anthropic'])
    })

    it('returns removed:false for missing provider', () => {
      const result = removeProvider('nonexistent')
      expect(result.removed).toBe(false)
    })

    it('migrates defaultModel to another provider when current is removed', () => {
      writeModels({
        providers: {
          anthropic,
          openai: { models: [{ id: 'gpt-4' }] },
        },
      })
      refreshModels()
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet')
      const result = removeProvider('anthropic')
      expect(result.removed).toBe(true)
      expect(result.newDefault?.provider).toBe('openai')
    })
  })

  describe('findValidDefaultModel', () => {
    it('returns null when no providers have models', () => {
      expect(findValidDefaultModel().result).toBeNull()
    })

    it('returns first available provider/model when no default set', () => {
      writeModels({ providers: { anthropic } })
      refreshModels()
      const { result, wasFixed } = findValidDefaultModel()
      expect(result).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet' })
      expect(wasFixed).toBe(true)
    })
  })

  describe('settings interactions', () => {
    beforeEach(() => {
      writeModels({ providers: { anthropic } })
      refreshModels()
    })

    it('setDefaultModel / getDefaultModel round-trip', () => {
      setDefaultModel('anthropic' as ProviderId, 'claude-opus')
      expect(getDefaultModel()).toEqual({ provider: 'anthropic', modelId: 'claude-opus' })
    })

    it('getDefaultModel auto-fixes invalid default', () => {
      setDefaultModel('anthropic' as ProviderId, 'nonexistent-model')
      const result = getDefaultModel()
      expect(result?.modelId).toBe('claude-sonnet') // 回退到 provider 第一个 model
    })

    it('enabledModels round-trip', () => {
      setEnabledModels(['anthropic/*', 'openai/gpt-4'])
      expect(getEnabledModels()).toEqual(['anthropic/*', 'openai/gpt-4'])
    })

    it('defaultThinkingLevel defaults to high', () => {
      expect(getDefaultThinkingLevel()).toBe('high')
    })

    it('defaultThinkingLevel round-trip', () => {
      setDefaultThinkingLevel('low')
      expect(getDefaultThinkingLevel()).toBe('low')
    })

    it('skillPaths round-trip', () => {
      // 用真实存在的目录验证 round-trip（脏数据 /path/a 等不存在的路径会被 setSkillDirs 过滤，
      // 这是 ADR §5 的新行为——非 preset 绝对路径不存在则剔除）
      const realDir1 = join(tmpDir, 'skills-a')
      const realDir2 = join(tmpDir, 'skills-b')
      mkdirSync(realDir1, { recursive: true })
      mkdirSync(realDir2, { recursive: true })
      setSkillPaths([
        { path: realDir1, enabled: true, scope: 'global' },
        { path: realDir2, enabled: true, scope: 'global' },
      ])
      expect(getSkillPaths()).toEqual([realDir1, realDir2])
    })
  })

  describe('atomic write integrity', () => {
    it('write produces valid JSON file on disk', () => {
      writeModels({ providers: { anthropic } })
      const raw = readFileSync(join(tmpDir, 'pi', 'agent', 'models.json'), 'utf-8')
      const parsed = JSON.parse(raw) as PiModelsConfig
      expect(parsed.providers.anthropic).toBeDefined()
    })

    it('write creates parent dirs if missing', () => {
      // 指向更深的不存在路径
      const deepPath = join(tmpDir, 'deep', 'nested', 'models.json')
      setModelsPath(deepPath)
      writeModels({ providers: { anthropic } })
      expect(existsSync(deepPath)).toBe(true)
    })
  })

  // W1：provider/model 级 enabled 字段序列化。
  // enabled 字段用于 provider 级 / model 级启停（默认 true 向上兼容存量）。
  // 需保证写 models.json → 读回时 enabled 值正确保留。
  describe('enabled 字段序列化（W1）', () => {
    it('provider 级 enabled=false 经写盘读回后保留', () => {
      writeModels({
        providers: {
          anthropic: {
            apiKey: 'sk-test',
            enabled: false,
            models: [
              { id: 'claude-sonnet', name: 'Sonnet' },
            ],
          },
        },
      })
      refreshModels()
      const cfg = getProviderConfig('anthropic')
      expect(cfg?.enabled).toBe(false)
    })

    it('provider 级 enabled=true 经写盘读回后保留', () => {
      writeModels({
        providers: {
          openai: {
            apiKey: 'sk-openai',
            enabled: true,
            models: [{ id: 'gpt-4' }],
          },
        },
      })
      refreshModels()
      const cfg = getProviderConfig('openai')
      expect(cfg?.enabled).toBe(true)
    })

    it('model 级 enabled 经写盘读回后保留', () => {
      writeModels({
        providers: {
          anthropic: {
            apiKey: 'sk-test',
            models: [
              { id: 'claude-sonnet', name: 'Sonnet', enabled: false },
              { id: 'claude-opus', name: 'Opus', enabled: true },
            ],
          },
        },
      })
      refreshModels()
      const cfg = getProviderConfig('anthropic')
      expect(cfg?.models?.[0]?.enabled).toBe(false)
      expect(cfg?.models?.[1]?.enabled).toBe(true)
    })

    it('盘上 JSON 文件含 enabled 字段（端到端序列化）', () => {
      writeModels({
        providers: {
          anthropic: {
            enabled: false,
            models: [{ id: 'sonnet', enabled: true }],
          },
        },
      })
      const raw = readFileSync(join(tmpDir, 'pi', 'agent', 'models.json'), 'utf-8')
      const parsed = JSON.parse(raw) as PiModelsConfig
      expect(parsed.providers.anthropic?.enabled).toBe(false)
      expect(parsed.providers.anthropic?.models?.[0]?.enabled).toBe(true)
    })
  })
})
