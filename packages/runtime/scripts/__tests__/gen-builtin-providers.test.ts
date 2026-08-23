// 8 用例 vitest 测试：校验 generateBuiltinProviders 提取的 39 provider 元数据结构。
// 测试框架 vitest（禁 node:test / tsx --test）。
import { describe, it, expect } from 'vitest'
import { generateBuiltinProviders } from '../gen-builtin-providers.mjs'

describe('gen-builtin-providers', () => {
  const providers = generateBuiltinProviders()

  it('t1: 生成 39 个内置 provider', () => {
    expect(providers).toHaveLength(39)
  })

  it('t2: openai envVars 含 OPENAI_API_KEY 且 authMode===api_key', () => {
    const openai = providers.find((p) => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai.envVars).toContain('OPENAI_API_KEY')
    expect(openai.authMode).toBe('api_key')
  })

  it('t2b: google-vertex envVars 含 GOOGLE_CLOUD_API_KEY（镜像表漏配回归，M-1）', () => {
    const gv = providers.find((p) => p.id === 'google-vertex')
    expect(gv).toBeDefined()
    expect(gv.envVars).toContain('GOOGLE_CLOUD_API_KEY')
    // 显式 key 路径与 ambient 主凭证并存：authMode 仍为 ambient
    expect(gv.authMode).toBe('ambient')
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
    // 39 - 2 ambient = 37 个，每个 modelCount > 0
    expect(nonAmbient).toHaveLength(37)
    for (const p of nonAmbient) {
      expect(p.modelCount, `${p.id} modelCount 应 > 0`).toBeGreaterThan(0)
      expect(p.models.length, `${p.id} models 数组应非空`).toBeGreaterThan(0)
    }
  })

  it('t8: findEnvKeys 同步校验通过（镜像表与 pi-ai 一致，无 exit 1）', async () => {
    // 直接 import findEnvKeys 对几个代表 provider 传 {[envVar]:'x'} 验证
    // （gen-builtin-providers.mjs 的 verifyEnvVars() 做全量双向校验，这里抽样验证 import 链路可用）
    const { findEnvKeys } = await import('@earendil-works/pi-ai/compat')
    const checks = [
      { id: 'openai', envVar: 'OPENAI_API_KEY' },
      { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
      { id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' },
      { id: 'github-copilot', envVar: 'COPILOT_GITHUB_TOKEN' },
      { id: 'google-vertex', envVar: 'GOOGLE_CLOUD_API_KEY' },
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

  it('t9: model 摘要含全部 11 字段（id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/thinkingLevelMap/compat）', () => {
    const ALL_11 = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat']
    for (const p of providers) {
      expect(p.models.length).toBeGreaterThan(0)
      for (const m of p.models) {
        for (const key of ALL_11) {
          expect(m, `${p.id} model ${m.id} 应含字段 ${key}`).toHaveProperty(key)
        }
      }
    }
    // 抽查：anthropic 首个 model 有真实 thinkingLevelMap/compat（非 null 值）
    const anthropic = providers.find((p) => p.id === 'anthropic')
    const claude = anthropic.models.find((m) => m.id === 'claude-fable-5')
    expect(claude).toBeDefined()
    expect(claude.thinkingLevelMap).not.toBeNull()
    expect(claude.compat).not.toBeNull()
    expect(typeof claude.cost).toBe('object')
    expect(typeof claude.maxTokens).toBe('number')
  })

  it('t10: catalog 指纹（pi-ai 升级 model 级内容漂移守卫）——39 provider + models 总和 + 代表 provider model id 集合', () => {
    // 内容守卫（非 git 快照比对）：pi-ai 升级后 model 增删/改名会破坏以下断言，提示人工核对生成物。
    // 基线值取自 builtin-providers.json（pi-ai 0.84.1，generatedAt 2026-08-23）。
    // provider 总数
    expect(providers).toHaveLength(39)
    // 所有 provider 的 models 总和（模型库整体规模漂移守卫）
    const totalModels = providers.reduce((s, p) => s + p.models.length, 0)
    expect(totalModels).toBe(1220)
    // 代表 provider 的 model id 集合（删/改名即破坏；新增模型用 arrayContaining 容忍）
    const openai = providers.find((p) => p.id === 'openai')!
    expect(openai.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5', 'gpt-4o', 'gpt-5.4-pro']),
    )
    const anthropic = providers.find((p) => p.id === 'anthropic')!
    expect(anthropic.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['claude-fable-5', 'claude-sonnet-4-5', 'claude-opus-4-5']),
    )
    // 小 provider 全量精确断言（深痛：删/改名/新增都会破坏）
    const deepseek = providers.find((p) => p.id === 'deepseek')!
    expect(deepseek.models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })
})
