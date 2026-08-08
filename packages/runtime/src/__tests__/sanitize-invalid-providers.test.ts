import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvalidProvider, sanitizeInvalidProviders, setModelsPath, type PiProviderConfig } from '../infra/pi/pi-provider-store.js'

let tmpDir: string
let modelsPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sanitize-providers-'))
  modelsPath = join(tmpDir, 'models.json')
  setModelsPath(modelsPath)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeModelsFixture(providers: Record<string, unknown>): void {
  writeFileSync(modelsPath, JSON.stringify({ providers }))
}

function readModelsProviders(): Record<string, unknown> {
  return (JSON.parse(readFileSync(modelsPath, 'utf-8'))).providers
}

describe('isInvalidProvider', () => {
  it('WTC1: 空壳 provider（仅 apiKey+name，五字段全缺）判定无效', () => {
    // concurrency-verify-A 场景：外部脚本写入的测试 fixture provider
    expect(isInvalidProvider({ apiKey: 'sk-x', name: 'Verify A' })).toBe(true)
  })

  it('WTC2: 有 baseUrl 的 provider 合法', () => {
    expect(isInvalidProvider({ baseUrl: 'https://api.x.com', apiKey: 'sk' })).toBe(false)
  })

  it('WTC3: models 非空的 provider 合法', () => {
    expect(isInvalidProvider({ models: [{ id: 'm1', name: 'M1' }] })).toBe(false)
  })

  it('WTC4: models 空数组视为未 specify，判定无效', () => {
    // 空数组无法提供任何模型，与 undefined 等效
    expect(isInvalidProvider({ models: [] })).toBe(true)
  })

  it('WTC5: 有 headers 的 provider 合法（cookie provider 不误杀）', () => {
    expect(isInvalidProvider({ headers: { Cookie: 'session=x' } })).toBe(false)
  })

  it('WTC6: 有 modelOverrides 的 provider 合法', () => {
    expect(isInvalidProvider({ modelOverrides: { 'gpt-4': { contextWindow: 8192 } } })).toBe(false)
  })

  it('WTC7: 有 compat（pi 端脏数据 raw 键）的 provider 合法', () => {
    // compat 是 pi 端 provider 级字段，xyz-agent PiProviderConfig 未声明但运行时脏数据可能含。
    // 模拟脏数据：构造合法对象后注入未声明字段（Object.assign 绕过 excess property check，无类型断言）
    const provider: PiProviderConfig = { apiKey: 'sk' }
    Object.assign(provider, { compat: { foo: 1 } })
    expect(isInvalidProvider(provider)).toBe(false)
  })

  it('WTC13: baseUrl 空字符串判定无效（pi zod minLength=1 实测拒绝：must not have fewer than 1 characters）', () => {
    expect(isInvalidProvider({ baseUrl: '', apiKey: 'sk' })).toBe(true)
  })

  it('WTC14: modelOverrides 空对象判定无效（pi applyModelsJson 要求 Object.keys().length>0）', () => {
    expect(isInvalidProvider({ modelOverrides: {} })).toBe(true)
  })

  it('WTC15: provider 值为 null 判定无效（zod ProviderConfigSchema 拒绝非对象值）', () => {
    expect(isInvalidProvider(null as unknown as PiProviderConfig)).toBe(true)
  })
})

describe('sanitizeInvalidProviders', () => {
  it('WTC8: 剔除空壳 provider，保留合法 provider', () => {
    writeModelsFixture({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm1' }] },
      'concurrency-verify-A': { apiKey: 'sk', name: 'Verify A' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual(['concurrency-verify-A'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['legal1', 'legal2'])
  })

  it('WTC9: 无无效 provider 时幂等不触发写（mtime 不变 + 内容不变）', () => {
    writeModelsFixture({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm' }] },
    })
    const mtimeBefore = statSync(modelsPath).mtimeMs
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    // 主断言：mtime 不变（未触发写）。内容断言作为 mtime 精度不足（旧 HFS+ 1s）的兜底。
    expect(statSync(modelsPath).mtimeMs).toBe(mtimeBefore)
    expect(readModelsProviders()).toEqual({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm' }] },
    })
  })

  it('WTC10: models.json 不存在时不创建文件', () => {
    // tmp 目录空，不写 models.json
    expect(existsSync(modelsPath)).toBe(false)
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    expect(existsSync(modelsPath)).toBe(false)
  })

  it('WTC11: 全部无效时全部剔除，文件保留为空 providers 对象', () => {
    writeModelsFixture({
      bad1: { apiKey: 'sk' },
      bad2: { name: 'X' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed.sort()).toEqual(['bad1', 'bad2'])
    // providers 空对象，文件仍存在（非删除）
    expect(readModelsProviders()).toEqual({})
    expect(existsSync(modelsPath)).toBe(true)
  })

  it('WTC12: 连续调用幂等（第二次 removed 为空，缓存未污染）', () => {
    writeModelsFixture({
      bad: { apiKey: 'sk' },
      legal: { baseUrl: 'x' },
    })
    const first = sanitizeInvalidProviders()
    expect(first.removed).toEqual(['bad'])
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    // 第二次后文件状态与第一次后一致
    expect(Object.keys(readModelsProviders()).sort()).toEqual(['legal'])
  })

  it('WTC16: 脏数据含 null provider 不崩溃，null 被剔除且合法 provider 保留', () => {
    // M2 回归：provider 值为 null 时旧实现整个 sanitize 崩溃 → 外层 catch 吞掉 → {removed:[]}
    // 同文件后续合法空壳 provider 不被剔除，"Model not found" 复发。
    writeModelsFixture({
      'p-null': null,
      'concurrency-verify-A': { apiKey: 'sk', name: 'Verify A' },
      legal1: { baseUrl: 'x' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed.sort()).toEqual(['concurrency-verify-A', 'p-null'])
    expect(readModelsProviders()).toEqual({ legal1: { baseUrl: 'x' } })
  })

  it('WTC17: catalog 已知内置 provider 的空壳被修复而非删除（models 合并，apiKey 保留）', () => {
    // MF-5 回归：QuickSetup 保存 baseUrl 为空串模板（opencode 等 7 个）后条目五字段全缺，
    // 旧实现重启即删除（apiKey 静默丢失）。修复：catalog 已知空壳合并 builtin models。
    writeModelsFixture({
      opencode: { apiKey: 'sk-opencode', name: 'OpenCode Zen', authMethod: 'api_key' },
      'concurrency-verify-A': { apiKey: 'sk-x', name: 'Verify A' },
    })
    const result = sanitizeInvalidProviders()
    // 非 catalog 空壳仍删除，catalog 已知空壳修复
    expect(result.removed).toEqual(['concurrency-verify-A'])
    expect(result.repaired).toEqual(['opencode'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['opencode'])
    const repaired = remaining.opencode as Record<string, unknown>
    // apiKey/authMethod 保留（不丢用户刚保存的配置）
    expect(repaired.apiKey).toBe('sk-opencode')
    expect(repaired.authMethod).toBe('api_key')
    // models 从 catalog 合并（模型级 baseUrl 由 catalog 提供）
    expect(Array.isArray(repaired.models)).toBe(true)
    const models = repaired.models as Array<{ id: string; baseUrl?: string }>
    expect(models.length).toBeGreaterThan(0)
    expect(models[0].id).toBe('claude-fable-5')
    expect(models[0].baseUrl).toBe('https://opencode.ai/zen')
    // 修复后不再无效（bundled pi 0.80.3 严格校验可通过）
    expect(isInvalidProvider(repaired as PiProviderConfig)).toBe(false)
    // 幂等：第二次调用不再修复/删除（修复结果已是合法条目）
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })

  it('WTC18: catalog models 全空 baseUrl 的 provider（azure-openai-responses）维持删除而非修复', () => {
    // MF-6 回归：azure-openai-responses 的 38 个 catalog models 全为空串 baseUrl 且无
    // provider 级 baseUrl——合并后 pi modelFromJson 对每个自定义模型强制非空 baseUrl
    // （空串非 nullish）直接 throw，pi 回退 builtin base，QuickSetup 保存的 apiKey 静默失效，
    // 且毒化条目 isInvalidProvider===false 无自愈路径。此类 provider 排除出修复名单（删除）。
    writeModelsFixture({
      'azure-openai-responses': { apiKey: 'sk-azure', name: 'Azure OpenAI', authMethod: 'api_key' },
      opencode: { apiKey: 'sk-opencode', name: 'OpenCode Zen', authMethod: 'api_key' },
    })
    const result = sanitizeInvalidProviders()
    // azure 删除（catalog 无可用 baseUrl 数据），opencode 仍修复（模型级 baseUrl 齐全）
    expect(result.removed).toEqual(['azure-openai-responses'])
    expect(result.repaired).toEqual(['opencode'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['opencode'])
    // 修复条目不存在任何空 baseUrl 模型（pi 组合层不抛错）
    const models = (remaining.opencode as { models: Array<{ baseUrl?: string }> }).models
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(m => !!m.baseUrl)).toBe(true)
    // 幂等：第二次调用不再修复/删除
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })
})
