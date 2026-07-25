import { describe, it, expect } from 'vitest'
import { matchQuotaPreset, QUOTA_PRESETS } from '../quota-presets'

describe('QUOTA_PRESETS', () => {
  it('有 5 个预设', () => {
    expect(QUOTA_PRESETS).toHaveLength(5)
  })

  it('每个预设都有必需字段', () => {
    for (const preset of QUOTA_PRESETS) {
      expect(preset.fetcher).toBeTruthy()
      expect(preset.label).toBeTruthy()
      expect(['api-key', 'cookie']).toContain(preset.auth)
      expect(preset.match.baseUrlPattern || preset.match.namePattern).toBeTruthy()
    }
  })
})

describe('matchQuotaPreset', () => {
  it('baseUrl 匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn/api' })
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 匹配 zhipu（不区分大小写）', () => {
    const result = matchQuotaPreset({ name: 'Zhipu' })
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 匹配 kimi', () => {
    const result = matchQuotaPreset({ name: 'kimi' })
    expect(result?.fetcher).toBe('kimi-coding')
  })

  it('baseUrl 匹配 minimax', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://api.minimaxi.com/v1' })
    expect(result?.fetcher).toBe('minimax')
  })

  it('name 匹配 mimo', () => {
    const result = matchQuotaPreset({ name: 'MiMo' })
    expect(result?.fetcher).toBe('mimo')
  })

  it('name 匹配 opencode', () => {
    const result = matchQuotaPreset({ name: 'opencode' })
    expect(result?.fetcher).toBe('opencode-go')
  })

  it('无匹配返回 undefined', () => {
    const result = matchQuotaPreset({ name: 'openai' })
    expect(result).toBeUndefined()
  })

  it('无参数返回 undefined', () => {
    const result = matchQuotaPreset({})
    expect(result).toBeUndefined()
  })

  it('baseUrl 优先于 name 匹配', () => {
    // baseUrl 匹配 zhipu，name 匹配 kimi
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn', name: 'kimi' })
    expect(result?.fetcher).toBe('zhipu')
  })
})
