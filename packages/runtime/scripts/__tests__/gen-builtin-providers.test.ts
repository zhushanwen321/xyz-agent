// 8 用例 vitest 测试：校验 generateBuiltinProviders 提取的 37 provider 元数据结构。
// 测试框架 vitest（禁 node:test / tsx --test）。
import { describe, it, expect } from 'vitest'
import { generateBuiltinProviders } from '../gen-builtin-providers.mjs'

describe('gen-builtin-providers', () => {
  const providers = generateBuiltinProviders()

  it('t1: 生成 37 个内置 provider', () => {
    expect(providers).toHaveLength(37)
  })

  it('t2: openai envVars 含 OPENAI_API_KEY 且 authMode===api_key', () => {
    const openai = providers.find((p) => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai.envVars).toContain('OPENAI_API_KEY')
    expect(openai.authMode).toBe('api_key')
  })

  it('t3: anthropic authMode===both 且 envVars 含 ANTHROPIC_API_KEY', () => {
    const anthropic = providers.find((p) => p.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic.authMode).toBe('both')
    expect(anthropic.envVars).toContain('ANTHROPIC_API_KEY')
  })

  it('t4: openai-codex authMode===oauth 且 oauthSupported===true', () => {
    const codex = providers.find((p) => p.id === 'openai-codex')
    expect(codex).toBeDefined()
    expect(codex.authMode).toBe('oauth')
    expect(codex.oauthSupported).toBe(true)
  })

  it('t5: 排除 radius（dynamic provider 无静态 catalog）', () => {
    const radius = providers.find((p) => p.id === 'radius')
    expect(radius).toBeUndefined()
  })

  it('t6: provider id 唯一（无重复）', () => {
    const ids = providers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('t7: 非 ambient provider models 非空（排除 google-vertex/amazon-bedrock）', () => {
    const ambient = new Set(['google-vertex', 'amazon-bedrock'])
    const nonAmbient = providers.filter((p) => !ambient.has(p.id))
    // 37 - 2 ambient = 35 个，每个 modelCount > 0
    expect(nonAmbient).toHaveLength(35)
    for (const p of nonAmbient) {
      expect(p.modelCount, `${p.id} modelCount 应 > 0`).toBeGreaterThan(0)
      expect(p.models.length, `${p.id} models 数组应非空`).toBeGreaterThan(0)
    }
  })

  it('t8: findEnvKeys 同步校验通过（镜像表与 pi-ai 一致，无 exit 1）', async () => {
    // 直接 import findEnvKeys 对几个代表 provider 传 {[envVar]:'x'} 验证
    // （gen-builtin-providers.mjs 的 verifyEnvVars() 做全量校验，这里抽样验证 import 链路可用）
    const { findEnvKeys } = await import('@earendil-works/pi-ai/compat')
    const checks = [
      { id: 'openai', envVar: 'OPENAI_API_KEY' },
      { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
      { id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' },
      { id: 'github-copilot', envVar: 'COPILOT_GITHUB_TOKEN' },
    ]
    for (const { id, envVar } of checks) {
      const got = findEnvKeys(id, { [envVar]: 'x' })
      expect(got, `${id} findEnvKeys 应识别 ${envVar}`).toContain(envVar)
    }
    // 确认生成的 providers 里对应 envVars 字段也一致
    for (const { id, envVar } of checks) {
      const p = providers.find((x) => x.id === id)
      expect(p.envVars, `${id} 生成结果 envVars 应含 ${envVar}`).toContain(envVar)
    }
  })
})
