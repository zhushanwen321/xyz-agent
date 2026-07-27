/**
 * pi-parser 测试（W3）。
 *
 * 测试策略：用临时目录写真实 fixture 文件，传临时 homeDir 给解析器（避免 mock fs，更真实）。
 * fixture 通过 JSON import 加载（vitest 原生支持），写入临时目录的 .pi/agent/ 下。
 *
 * 注意：禁止 meta.url（validate-runtime-bundle §3 禁用），用 JSON import 取代路径解析。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/pi-parser.test.ts
 *
 * 覆盖：
 *   - T1：正常解析（3 provider → 2，gemini 丢弃，auth.json 合并，协议直传）。
 *   - T2：只有 google-generative-ai → providers 空。
 *   - T7：models.json JSON 损坏 → parseError。
 *   - T8：源目录不存在 → 返回 null。
 *   - T9：auth.json 不存在 → 回退 models.json 的 apiKey。
 *   - T10：auth.json 损坏 → 不阻断，warning 提示，仍从 models.json 取 key。
 *   - T11：~/.pi/agent 存在但无 models.json → parseError。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parsePiProviders } from '../pi-parser.js'
// fixture 通过 JSON import 加载（vitest resolveJSON 模块，避免 meta.url）
import piModelsFixture from './fixtures/pi-models.json' with { type: 'json' }
import piModelsGeminiOnlyFixture from './fixtures/pi-models-gemini-only.json' with { type: 'json' }
import piAuthFixture from './fixtures/pi-auth.json' with { type: 'json' }

describe('parsePiProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pi-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  /** 把 fixture JSON 写到 <home>/.pi/agent/<target>。 */
  function writePiAgentFile(target: string, content: string): string {
    const piAgentDir = join(home, '.pi', 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    const dest = join(piAgentDir, target)
    writeFileSync(dest, content)
    return dest
  }

  // ── T1：正常解析（3 provider → 2，gemini 丢弃）──────────────────────
  it('T1: 解析 3 provider → 2（gemini 丢弃），auth.json 合并，协议直传', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsFixture))
    writePiAgentFile('auth.json', JSON.stringify(piAuthFixture))

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)

    // deepseek-router：auth.json 的 key 覆盖 models.json（models.json 里 deepseek 无 apiKey）
    const deepseek = result!.providers.find((p) => p._sourceName === 'deepseek-router')!
    expect(deepseek.api).toBe('anthropic-messages')
    expect(deepseek.apiKey).toBe('sk-fake-deepseek-from-auth')
    expect(deepseek._apiKeyExtracted).toBe(true)
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
    // models 数组透传
    expect(deepseek.models).toHaveLength(2)
    expect(deepseek.models![0].id).toBe('deepseek-chat')
    // compat 字段容忍（不 crash）
    expect(deepseek.models![0].compat).toBeDefined()
    // thinkingLevelMap 透传
    expect(deepseek.models![1].thinkingLevelMap).toBeDefined()

    // zhipu：auth.json 的 key 覆盖 models.json 的 apiKey
    const zhipu = result!.providers.find((p) => p._sourceName === 'zhipu')!
    expect(zhipu.api).toBe('openai-completions')
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-from-auth') // auth.json 优先
    expect(zhipu._apiKeyExtracted).toBe(true)

    // gemini 被丢弃（不在结果中）
    expect(result!.providers.find((p) => p._sourceName === 'gemini')).toBeUndefined()

    // 无整体性 parseError
    expect(result!.parseError).toBeUndefined()
  })

  // ── T2：只有 google-generative-ai → providers 空 ──────────────────
  it('T2: 只有 google-generative-ai 的 fixture → providers 为空', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsGeminiOnlyFixture))
    writePiAgentFile('auth.json', JSON.stringify(piAuthFixture))

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    // gemini 被丢弃不产生 parseError（parseError 只在整体性错误）
    expect(result!.parseError).toBeUndefined()
  })

  // ── T7：models.json JSON 损坏 → parseError ─────────────────────────
  it('T7: models.json JSON 损坏 → parseError 含 cannot parse', () => {
    writePiAgentFile('models.json', '{ not valid json ///')

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse models\.json/)
  })

  // ── T8：源目录不存在 → null ────────────────────────────────────────
  it('T8: ~/.pi/agent 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.pi'))).toBe(false)

    const result = parsePiProviders(home)

    expect(result).toBeNull()
  })

  // ── T9：auth.json 不存在 → 回退 models.json 的 apiKey ──────────────
  it('T9: auth.json 不存在 → apiKey 从 models.json 取', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsFixture))
    // 故意不写 auth.json

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    const zhipu = result!.providers.find((p) => p._sourceName === 'zhipu')!
    // auth.json 不存在 → 回退 models.json 里的 sk-fake-zhipu-in-models
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-in-models')
    expect(zhipu._apiKeyExtracted).toBe(true)

    // deepseek 在 models.json 无 apiKey → apiKeyExtracted=false
    const deepseek = result!.providers.find((p) => p._sourceName === 'deepseek-router')!
    expect(deepseek.apiKey).toBeUndefined()
    expect(deepseek._apiKeyExtracted).toBe(false)
  })

  // ── T10：auth.json 损坏 → 不阻断，warning 提示 ─────────────────────
  it('T10: auth.json JSON 损坏 → 不阻断，每个 provider 的 _warnings 含提示', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsFixture))
    writePiAgentFile('auth.json', '{ broken')

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)
    // auth 损坏不产生 parseError（非整体性，models.json 仍可解析）
    expect(result!.parseError).toBeUndefined()
    // 每个 provider 的 _warnings 含 auth.json parse failed 提示
    for (const p of result!.providers) {
      expect(p._warnings.some((w) => w.includes('auth.json parse failed'))).toBe(true)
    }
    // apiKey 回退到 models.json（auth.json 不可用）
    const zhipu = result!.providers.find((p) => p._sourceName === 'zhipu')!
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-in-models')
  })

  // ── T11：models.json 缺失 → parseError ────────────────────────────
  it('T11: ~/.pi/agent 存在但无 models.json → parseError 含 not found', () => {
    // 只建 .pi/agent 目录，不写 models.json
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/models\.json not found/)
  })
})
