/**
 * resolveQuotaCredentialSource 单测（D3，coding-plan-quota-config-ux §6.4）。
 *
 * 覆盖：显式值优先于标记推断、缺省时按 apiKeySet 推断（历史数据兼容）、
 * undefined 输入兜底 'provider'。两端（UI/runtime）共用此函数的推断语义由这些断言锚定。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-credential-source.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveQuotaCredentialSource } from '../quota-types'

describe('resolveQuotaCredentialSource · 显式值优先（D3）', () => {
  it("显式 'provider' 即使 apiKeySet=true 也不被推断覆盖", () => {
    expect(resolveQuotaCredentialSource({ credentialSource: 'provider', apiKeySet: true })).toBe('provider')
  })

  it("显式 'exclusive' 即使 apiKeySet=false/缺省 也不回退 'provider'", () => {
    expect(resolveQuotaCredentialSource({ credentialSource: 'exclusive' })).toBe('exclusive')
    expect(resolveQuotaCredentialSource({ credentialSource: 'exclusive', apiKeySet: false })).toBe('exclusive')
  })
})

describe('resolveQuotaCredentialSource · 缺省按既存标记推断（历史数据兼容）', () => {
  it('未设置 credentialSource 且 apiKeySet=true → exclusive（旧数据继续用专属 Key，行为不变）', () => {
    expect(resolveQuotaCredentialSource({ apiKeySet: true })).toBe('exclusive')
  })

  it('未设置 credentialSource 且 apiKeySet=false → provider', () => {
    expect(resolveQuotaCredentialSource({ apiKeySet: false })).toBe('provider')
  })

  it('quota 无任何标记 → provider（默认复用 provider 凭据）', () => {
    expect(resolveQuotaCredentialSource(undefined)).toBe('provider')
    expect(resolveQuotaCredentialSource({})).toBe('provider')
  })
})
