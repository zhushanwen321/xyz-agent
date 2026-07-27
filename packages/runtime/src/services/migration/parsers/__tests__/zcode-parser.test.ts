/**
 * zcode-parser 测试（W3）。
 *
 * 测试策略：临时目录 + 真实 fixture JSON 写文件（避免 mock fs）。
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/zcode-parser.test.ts
 *
 * 覆盖：
 *   - T3：正常解析（2 provider），kind 映射，明文提取+加密留空，thinkingLevelMap 推断。
 *   - T4：config.json 损坏 → parseError。
 *   - T5：源目录不存在 → null。
 *   - T6：未知 kind → 该 provider 跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseZcodeProviders } from '../zcode-parser.js'
import zcodeConfigFixture from './fixtures/zcode-config.json' with { type: 'json' }

describe('parseZcodeProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zcode-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  /** 把 config.json 写到 <home>/.zcode/v2/config.json。 */
  function writeZcodeConfig(content: string): string {
    const v2Dir = join(home, '.zcode', 'v2')
    mkdirSync(v2Dir, { recursive: true })
    const dest = join(v2Dir, 'config.json')
    writeFileSync(dest, content)
    return dest
  }

  // ── T3：正常解析（2 provider），kind 映射 ──────────────────────────
  it('T3: 解析 2 provider，kind 映射，明文提取 + 加密留空', () => {
    writeZcodeConfig(JSON.stringify(zcodeConfigFixture))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)
    expect(result!.parseError).toBeUndefined()

    // bigmodel：kind=anthropic → anthropic-messages，明文 apiKey 提取
    const bigmodel = result!.providers.find((p) => p._sourceName === 'bigmodel')!
    expect(bigmodel.api).toBe('anthropic-messages')
    expect(bigmodel.apiKey).toBe('sk-fake-bigmodel-plaintext')
    expect(bigmodel._apiKeyExtracted).toBe(true)
    expect(bigmodel.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(bigmodel.name).toBe('BigModel')
    // models 转换：contextWindow / maxTokens / reasoning / thinkingLevelMap
    expect(bigmodel.models).toHaveLength(2)
    const glm46 = bigmodel.models!.find((m) => m.id === 'glm-4.6')!
    expect(glm46.contextWindow).toBe(128000)
    expect(glm46.maxTokens).toBe(16384)
    expect(glm46.reasoning).toBe(true)
    // thinkingLevelMap 从 variants 推断
    expect(glm46.thinkingLevelMap).toEqual({ low: 'low', medium: 'medium', high: 'high' })

    // router：kind=openai-compatible → openai-completions（+ warning），无明文 apiKey
    const router = result!.providers.find((p) => p._sourceName === 'router')!
    expect(router.api).toBe('openai-completions')
    expect(router.apiKey).toBeUndefined()
    expect(router._apiKeyExtracted).toBe(false)
    expect(router.baseUrl).toBe('https://router.example.com/v1')
    // warning：openai-compatible 映射提示
    expect(router._warnings.some((w) => w.includes('mapped to openai-completions'))).toBe(true)
  })

  // ── T4：config.json 损坏 → parseError ──────────────────────────────
  it('T4: config.json JSON 损坏 → parseError 含 cannot parse', () => {
    writeZcodeConfig('{ broken json')

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse zcode config\.json/)
  })

  // ── T5：源目录不存在 → null ────────────────────────────────────────
  it('T5: ~/.zcode/v2/config.json 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.zcode'))).toBe(false)

    const result = parseZcodeProviders(home)

    expect(result).toBeNull()
  })

  // ── T6：未知 kind → 该 provider 跳过 ───────────────────────────────
  it('T6: 未知 kind 的 provider 被跳过（不进结果）', () => {
    const config = {
      provider: {
        weird: {
          name: 'Weird',
          kind: 'some-unknown-protocol',
          options: { apiKey: 'sk-fake', baseURL: 'https://x.com' },
          models: { m1: { name: 'M1' } },
        },
        anthropic1: {
          name: 'AnthropicOne',
          kind: 'anthropic',
          options: { baseURL: 'https://a.com' },
          models: { m2: { name: 'M2' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    // weird 跳过，只剩 anthropic1
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0]._sourceName).toBe('anthropic1')
  })

  // ── T7：kind 缺失 → 跳过 ───────────────────────────────────────────
  it('T7: kind 缺失的 provider 被跳过', () => {
    const config = {
      provider: {
        nokind: {
          name: 'NoKind',
          options: { apiKey: 'sk-fake' },
          models: { m1: { name: 'M1' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
  })
})
