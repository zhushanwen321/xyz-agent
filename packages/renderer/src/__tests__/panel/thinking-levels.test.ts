/**
 * thinking-levels 纯函数单测。
 *
 * thinkingLevelMap 语义：
 * - key = UI 可选档位（ThinkingLevel 枚举值，含 max），用于展示和判定可用
 * - value = 发给 runtime/pi 的实际 level（string=可用，null=不可用）
 * - 发给 pi 的是 value（如 max 档发 xhigh），不是 key
 *
 * fixture 来自真实预设（useProviderEdit.ts THINKING_PRESETS）：
 * - all-levels: undefined → 全 6 档
 * - on-off: { off:'off', high:'high' } → off + high
 * - high-max: { off:'off', high:'high', max:'xhigh' } → off + high + max（max 档发 xhigh）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/thinking-levels.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  resolveAvailableLevels,
  resolveThinkingValue,
  resolveThinkingKey,
  highestAvailableLevel,
  isSameThinkingScheme,
  getDisplayLabel,
  THINKING_LEVELS,
} from '@/components/panel/thinking-levels'

// 真实预设（从 useProviderEdit.ts THINKING_PRESETS 同步）
const ON_OFF_MAP = { off: 'off', high: 'high' }
const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
const ALL_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

describe('resolveAvailableLevels（按 key 判定可用档位）', () => {
  it('map=undefined（all-levels 预设）→ 全 6 档', () => {
    expect([...resolveAvailableLevels(undefined)].sort()).toEqual([...ALL_LEVELS].sort())
  })

  it('high-max 预设 {off,high,max} → 可用 off + high + max（按 key 非 null）', () => {
    expect(resolveAvailableLevels(HIGH_MAX_MAP)).toEqual(['off', 'high', 'max'])
  })

  it('on-off 预设 {off,high} → off + high', () => {
    expect(resolveAvailableLevels(ON_OFF_MAP)).toEqual(['off', 'high'])
  })

  it('空对象 {} → 全 6 档（fallback 全可用）', () => {
    expect([...resolveAvailableLevels({})].sort()).toEqual([...ALL_LEVELS].sort())
  })

  it('全 null 值的 map → 全 6 档（无可用 key，fallback）', () => {
    expect([...resolveAvailableLevels({ off: null, low: null })].sort()).toEqual([...ALL_LEVELS].sort())
  })
})

describe('resolveThinkingValue（UI 档位 key → 发 runtime 的 value）', () => {
  it('high-max: max 档发 xhigh（展示是 max，传递 value 是 xhigh）', () => {
    expect(resolveThinkingValue('max', HIGH_MAX_MAP)).toBe('xhigh')
  })

  it('high-max: high 档发 high', () => {
    expect(resolveThinkingValue('high', HIGH_MAX_MAP)).toBe('high')
  })

  it('on-off: off 档发 off', () => {
    expect(resolveThinkingValue('off', ON_OFF_MAP)).toBe('off')
  })

  it('all-levels（map 空）→ 发 key 自身', () => {
    expect(resolveThinkingValue('medium', undefined)).toBe('medium')
  })
})

describe('resolveThinkingKey（runtime value → UI 档位 key）', () => {
  it('high-max: value xhigh → key max（反查）', () => {
    expect(resolveThinkingKey('xhigh', HIGH_MAX_MAP)).toBe('max')
  })

  it('high-max: value high → key high', () => {
    expect(resolveThinkingKey('high', HIGH_MAX_MAP)).toBe('high')
  })

  it('on-off: value off → key off', () => {
    expect(resolveThinkingKey('off', ON_OFF_MAP)).toBe('off')
  })

  it('all-levels（map 空）→ value 直接是 key', () => {
    expect(resolveThinkingKey('medium', undefined)).toBe('medium')
  })

  it('无法映射时 fallback max', () => {
    expect(resolveThinkingKey('unknown', HIGH_MAX_MAP)).toBe('max')
  })
})

describe('getDisplayLabel', () => {
  it('on-off 模式 high → 「开」', () => {
    expect(getDisplayLabel('high', ON_OFF_MAP)).toBe('开')
  })

  it('high-max 模式 high → 「高」（通用 label）', () => {
    expect(getDisplayLabel('high', HIGH_MAX_MAP)).toBe('高')
  })

  it('high-max 模式 max → 「最高」', () => {
    expect(getDisplayLabel('max', HIGH_MAX_MAP)).toBe('最高')
  })
})

describe('highestAvailableLevel', () => {
  it('high-max 预设 → max（强度最高的可用档）', () => {
    expect(highestAvailableLevel(HIGH_MAX_MAP)).toBe('max')
  })

  it('on-off 预设 → high（强度最高的可用档）', () => {
    expect(highestAvailableLevel(ON_OFF_MAP)).toBe('high')
  })

  it('map=undefined → max（全可用时最高档）', () => {
    expect(highestAvailableLevel(undefined)).toBe('max')
  })

  it('空对象 {} → max（fallback）', () => {
    expect(highestAvailableLevel({})).toBe('max')
  })

  it('返回值始终是合法 ThinkingLevel', () => {
    const validLevels = THINKING_LEVELS.map((o) => o.level)
    expect(validLevels).toContain(highestAvailableLevel(HIGH_MAX_MAP))
    expect(validLevels).toContain(highestAvailableLevel(ON_OFF_MAP))
    expect(validLevels).toContain(highestAvailableLevel(undefined))
  })
})

describe('isSameThinkingScheme（体系判定：可用 key 集合相同即同体系）', () => {
  it('on-off vs on-off → 同体系', () => {
    expect(isSameThinkingScheme(ON_OFF_MAP, ON_OFF_MAP)).toBe(true)
  })

  it('high-max vs high-max → 同体系', () => {
    expect(isSameThinkingScheme(HIGH_MAX_MAP, HIGH_MAX_MAP)).toBe(true)
  })

  it('on-off vs high-max → 跨体系（key 集合不同：{off,high} ≠ {off,high,max}）', () => {
    expect(isSameThinkingScheme(ON_OFF_MAP, HIGH_MAX_MAP)).toBe(false)
  })

  it('high-max vs on-off → 跨体系（不对称也成立）', () => {
    expect(isSameThinkingScheme(HIGH_MAX_MAP, ON_OFF_MAP)).toBe(false)
  })

  it('all-levels(undefined) vs all-levels(undefined) → 同体系（两个全档）', () => {
    expect(isSameThinkingScheme(undefined, undefined)).toBe(true)
  })

  it('all-levels(undefined) vs on-off → 跨体系（全 6 档 ≠ 2 档）', () => {
    expect(isSameThinkingScheme(undefined, ON_OFF_MAP)).toBe(false)
  })

  it('all-levels(undefined) vs high-max → 跨体系', () => {
    expect(isSameThinkingScheme(undefined, HIGH_MAX_MAP)).toBe(false)
  })

  it('空对象 {} vs undefined → 同体系（两者都 fallback 全 6 档）', () => {
    expect(isSameThinkingScheme({}, undefined)).toBe(true)
  })

  it('自定义 map {off,high,xhigh} vs on-off → 跨体系（key 集合不同）', () => {
    const customMap = { off: 'off', high: 'high', xhigh: 'xhigh' }
    expect(isSameThinkingScheme(customMap, ON_OFF_MAP)).toBe(false)
  })

  it('同 key 集合但 value 不同 → 同体系（体系只看 key，不看 value）', () => {
    const mapA = { off: 'off', high: 'high', max: 'xhigh' }
    const mapB = { off: 'off', high: 'high', max: 'ultrathink' }
    expect(isSameThinkingScheme(mapA, mapB)).toBe(true)
  })
})
