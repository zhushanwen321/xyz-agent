/**
 * codex-parser 测试（W3）。
 *
 * 测试策略：临时目录 + 真实 TOML fixture 写文件（避免 mock fs）。
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/codex-parser.test.ts
 *
 * 注意：TOML fixture 内容见 ./fixtures/codex-config.toml 与 codex-config-chat.toml。
 * 因 vitest 原生只支持 JSON import（TOML 不支持），且 bundle 校验禁用 ESM 元信息 API，
 * 这里把 fixture TOML 内容内联为常量（与 fixtures/*.toml 保持一致），写入临时 .codex/config.toml。
 *
 * 覆盖：
 *   - T4：正常解析（wire_api=responses → openai-responses），env_key 从 process.env 提取，占位 model。
 *   - T5：env_key 未设环境变量 → apiKeyExtracted=false + warning 提示。
 *   - T6：wire_api=chat → openai-completions + deprecated warning。
 *   - T7：TOML 损坏 → parseError。
 *   - T8：源目录不存在 → null。
 *   - T9：auth.json 的 OPENAI_API_KEY 作为 id 含 'openai' 的 provider 的默认 key 回退。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseCodexProviders } from '../codex-parser.js'

// ── fixture 内容（与 ./fixtures/*.toml 一致，假 key）──────────────
const CODEX_CONFIG_RESPONSES_TOML = `model = "gpt-5.5"
model_provider = "custom"

[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "ROUTER_KEY"
wire_api = "responses"
`

const CODEX_CONFIG_CHAT_TOML = `model = "gpt-5.5"
model_provider = "custom"

[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "ROUTER_KEY"
wire_api = "chat"
`

describe('parseCodexProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  /** 把 content 写到 <home>/.codex/config.toml。 */
  function writeCodexConfig(content: string): string {
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const dest = join(codexDir, 'config.toml')
    writeFileSync(dest, content)
    return dest
  }

  // ── T4：正常解析（responses → openai-responses，env_key 提取，占位 model）──
  it('T4: wire_api=responses → openai-responses，env_key 提取到 key，占位 model', () => {
    writeCodexConfig(CODEX_CONFIG_RESPONSES_TOML)
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.parseError).toBeUndefined()

    const provider = result!.providers[0]
    expect(provider._sourceName).toBe('custom')
    expect(provider.name).toBe('Router')
    expect(provider.api).toBe('openai-responses')
    expect(provider.baseUrl).toBe('http://192.168.1.202:9981/v1')
    // env_key 从 process.env 提取到值
    expect(provider.apiKey).toBe('sk-fake-test')
    expect(provider._apiKeyExtracted).toBe(true)
    // 占位 model：顶层 model 字段
    expect(provider.models).toHaveLength(1)
    expect(provider.models![0].id).toBe('gpt-5.5')
    // warning 含 model list incomplete 提示
    expect(provider._warnings.some((w) => w.includes('model list incomplete'))).toBe(true)
  })

  // ── T5：env_key 未设环境变量 → apiKeyExtracted=false + warning ──────
  it('T5: env_key=NONEXISTENT 且 process.env 无此变量 → apiKeyExtracted=false + warning', () => {
    const toml = `model = "gpt-5.5"
[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "NONEXISTENT_CODEX_KEY"
wire_api = "responses"
`
    writeCodexConfig(toml)
    // 不 stub NONEXISTENT_CODEX_KEY（确保 process.env 无此变量）
    expect(process.env.NONEXISTENT_CODEX_KEY).toBeUndefined()

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.apiKey).toBeUndefined()
    expect(provider._apiKeyExtracted).toBe(false)
    // warning 含 env_key 提示
    expect(
      provider._warnings.some((w) => w.includes('env_key NONEXISTENT_CODEX_KEY not set in environment')),
    ).toBe(true)
  })

  // ── T6：wire_api=chat → openai-completions + deprecated warning ────
  it('T6: wire_api=chat → openai-completions + deprecated warning', () => {
    writeCodexConfig(CODEX_CONFIG_CHAT_TOML)
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.api).toBe('openai-completions')
    expect(provider._warnings.some((w) => w.includes('wire_api=chat is deprecated'))).toBe(true)
  })

  // ── T7：TOML 损坏 → parseError ─────────────────────────────────────
  it('T7: config.toml TOML 损坏 → parseError 含 cannot parse', () => {
    writeCodexConfig('invalid toml {')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse config\.toml/)
  })

  // ── T8：源目录不存在 → null ────────────────────────────────────────
  it('T8: ~/.codex 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.codex'))).toBe(false)

    const result = parseCodexProviders(home)

    expect(result).toBeNull()
  })

  // ── T9：auth.json 的 OPENAI_API_KEY 作为 id 含 'openai' 的 provider 的回退 key ──
  it('T9: provider id 含 openai 且无 env_key → 用 auth.json 的 OPENAI_API_KEY 回退', () => {
    const toml = `model = "gpt-5.5"
[model_providers.openai-default]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
`
    const configPath = writeCodexConfig(toml)
    // 写 auth.json
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-fake-openai-from-auth' }))
    expect(existsSync(configPath)).toBe(true)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider._sourceName).toBe('openai-default')
    expect(provider.apiKey).toBe('sk-fake-openai-from-auth')
    expect(provider._apiKeyExtracted).toBe(true)
  })

  // ── T10：未知 wire_api → 默认 openai-completions + warning ──────────
  it('T10: wire_api=weird → openai-completions + unknown wire_api warning', () => {
    const toml = `model = "gpt-5.5"
[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "ROUTER_KEY"
wire_api = "weird"
`
    writeCodexConfig(toml)
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.api).toBe('openai-completions')
    expect(provider._warnings.some((w) => w.includes('unknown wire_api'))).toBe(true)
  })
})
