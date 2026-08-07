/**
 * ConfigService.listBuiltinProviders 单测（wave 2，builtin-provider-rpc）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service.test.ts
 *
 * 测试策略（WC6）：config-service 直接测（不 mock，import 真实 generated JSON）。
 * listBuiltinProviders 是纯函数（模块级 import builtinData，不触 ConfigStore），
 * 故构造 ConfigService 时 configStore 传最小 mock（{} 即可，方法不被调用）。
 */
import { describe, it, expect } from 'vitest'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { BuiltinProviderTemplate } from '@xyz-agent/shared'

// listBuiltinProviders 不触 ConfigStore（纯函数 import JSON），传空对象即可实例化（构造只存引用）。
const service = new ConfigService('/tmp/project', {} as unknown as IConfigStore)

describe('ConfigService.listBuiltinProviders', () => {
  const providers: BuiltinProviderTemplate[] = service.listBuiltinProviders()

  it('t1: 返回 37 个内置 provider', () => {
    expect(providers).toHaveLength(37)
  })

  it('t2: openai authMode===api_key 且 envVars 含 OPENAI_API_KEY', () => {
    const openai = providers.find(p => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai!.authMode).toBe('api_key')
    expect(openai!.envVars).toContain('OPENAI_API_KEY')
  })

  it('t3: 不含 radius（wave 1 已排除）', () => {
    const radius = providers.find(p => p.id === 'radius')
    expect(radius).toBeUndefined()
  })

  it('t4: anthropic authMode===both 且 oauthSupported===true', () => {
    const anthropic = providers.find(p => p.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic!.authMode).toBe('both')
    expect(anthropic!.oauthSupported).toBe(true)
  })

  it('t5: 每个 provider 含全字段，models 元素含 11 字段契约（id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/thinkingLevelMap/compat）', () => {
    expect(providers.length).toBeGreaterThan(0)
    const ALL_11 = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat']
    for (const p of providers) {
      // provider 级字段
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      // api/baseUrl 为 optional，存在时须为 string
      if (p.api !== undefined) expect(typeof p.api).toBe('string')
      if (p.baseUrl !== undefined) expect(typeof p.baseUrl).toBe('string')
      expect(['api_key', 'oauth', 'both', 'ambient']).toContain(p.authMode)
      expect(Array.isArray(p.envVars)).toBe(true)
      expect(typeof p.oauthSupported).toBe('boolean')
      if (p.apiKeyName !== undefined) expect(typeof p.apiKeyName).toBe('string')
      if (p.oauthName !== undefined) expect(typeof p.oauthName).toBe('string')
      expect(typeof p.modelCount).toBe('number')
      if (p.logoUrl !== undefined) expect(typeof p.logoUrl).toBe('string')
      expect(Array.isArray(p.models)).toBe(true)
      expect(p.models.length).toBe(p.modelCount)
      // model 级 11 字段契约（生成脚本恒输出 11 键；可选字段缺省为 null）
      for (const m of p.models) {
        for (const key of ALL_11) {
          expect(m, `${p.id} model ${m.id} 应含字段 ${key}`).toHaveProperty(key)
        }
        expect(typeof m.id).toBe('string')
        expect(typeof m.name).toBe('string')
        expect(typeof m.api).toBe('string')
        if (m.baseUrl !== undefined) expect(typeof m.baseUrl).toBe('string')
        expect(typeof m.reasoning).toBe('boolean')
        expect(Array.isArray(m.input)).toBe(true)
        expect(m.contextWindow).toBeTypeOf('number')
        if (m.maxTokens !== null && m.maxTokens !== undefined) expect(typeof m.maxTokens).toBe('number')
        if (m.thinkingLevelMap !== null && m.thinkingLevelMap !== undefined) expect(typeof m.thinkingLevelMap).toBe('object')
        if (m.compat !== null && m.compat !== undefined) expect(typeof m.compat).toBe('object')
      }
    }
  })

  it('t6: google-vertex envVars 含 GOOGLE_CLOUD_API_KEY（镜像表漏配回归，M-1）', () => {
    const gv = providers.find(p => p.id === 'google-vertex')
    expect(gv).toBeDefined()
    expect(gv!.envVars).toContain('GOOGLE_CLOUD_API_KEY')
  })
})
