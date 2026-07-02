/**
 * thinking-levels 纯函数单测。
 *
 * thinkingLevelMap 语义（key-based）：
 * - key = UI 可选档位（ThinkingLevel 枚举：off/low/medium/high/xhigh/max）
 * - value = 发给 runtime/pi 的实际 level（string = 可用，null = 不可用）
 *
 * fixture 来自真实预设（ProviderEditModal.vue THINKING_PRESETS）：
 * - all-levels: undefined → 全 6 档
 * - on-off: { off:'off', high:'high' } → off + high
 * - high-max: { high:'high', max:'xhigh' } → high + max
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/thinking-levels.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  resolveAvailableLevels,
  resolveThinkingValue,
  resolveThinkingKey,
  highestAvailableLevel,
  THINKING_LEVELS,
} from '@/components/panel/thinking-levels'

// 真实预设（从 ProviderEditModal.vue THINKING_PRESETS 同步）
const ON_OFF_MAP = { off: 'off', high: 'high' }
const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
const ALL_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const SORTED_ALL = [...ALL_LEVELS].sort()

describe('resolveAvailableLevels（按 key 判定可用档位）', () => {
  it('map=undefined（all-levels 预设）→ 全 6 档', () => {
    expect([...resolveAvailableLevels(undefined)].sort()).toEqual(SORTED_ALL)
  })

  it('high-max 预设 {off,high,max} → 可用 off + high + max（按 key 非 null）', () => {
    expect(resolveAvailableLevels(HIGH_MAX_MAP)).toEqual(['off', 'high', 'max'])
  })

  it('on-off 预设 {off,high} → off + high', () => {
    expect(resolveAvailableLevels(ON_OFF_MAP)).toEqual(['off', 'high'])
  })

  it('空对象 {} → 全 6 档（fallback 全可用）', () => {
    expect([...resolveAvailableLevels({})].sort()).toEqual(SORTED_ALL)
  })

  it('全 null 值的 map → 全 6 档（无可用 key，fallback）', () => {
    expect([...resolveAvailableLevels({ off: null, low: null })].sort()).toEqual(SORTED_ALL)
  })
})

describe('resolveThinkingValue（UI 档位 key → 发 runtime 的 value）', () => {
  it('high-max: max 档发 xhigh', () => {
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
  it('high-max: value xhigh → key max', () => {
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
