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
})
