/**
 * thinking-levels 纯函数单测（W5 · Q3 核心）。
 *
 * resolveAvailableLevels / highestAvailableLevel 按 thinkingLevelMap 的 value（非 null）
 * 判定可用档位。注意 key 空间（含 minimal/off）与 ThinkingLevel 枚举（含 max）不一致。
 *
 * fixture 来自真实预设（ProviderEditModal.vue THINKING_PRESETS）：
 * - all-levels: undefined → 全 6 档
 * - on-off: { minimal:null, low:null, medium:null, high:null, xhigh:'xhigh' } → 仅 xhigh
 * - high-max: { off:null, minimal:null, low:null, medium:null, high:'high', xhigh:'max' } → high, max
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/thinking-levels.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  resolveAvailableLevels,
  highestAvailableLevel,
  THINKING_LEVELS,
} from '@/components/panel/thinking-levels'

// 真实预设（从 ProviderEditModal.vue:312-316 复制）
const ON_OFF_MAP = { minimal: null, low: null, medium: null, high: null, xhigh: 'xhigh' }
const HIGH_MAX_MAP = { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' }
const ALL_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const SORTED_ALL = [...ALL_LEVELS].sort()

describe('resolveAvailableLevels', () => {
  it('U20: map=undefined（all-levels 预设）→ 全 6 档', () => {
    expect([...resolveAvailableLevels(undefined)].sort()).toEqual(SORTED_ALL)
  })

  it('U21: high-max 预设 → 可用 high + max（按 value 非 null）', () => {
    const result = resolveAvailableLevels(HIGH_MAX_MAP)
    expect(result).toEqual(['high', 'max']) // 按强度升序
  })

  it('U22: on-off 预设 → 仅 xhigh（其余 value 为 null）', () => {
    expect(resolveAvailableLevels(ON_OFF_MAP)).toEqual(['xhigh'])
  })

  it('空对象 {} → 全 6 档（fallback 全可用）', () => {
    expect([...resolveAvailableLevels({})].sort()).toEqual(SORTED_ALL)
  })

  it('全 null 值的 map → 全 6 档（无可用 value，fallback）', () => {
    expect([...resolveAvailableLevels({ off: null, low: null })].sort()).toEqual(SORTED_ALL)
  })
})

describe('highestAvailableLevel', () => {
  it('U23: high-max 预设 → max（value 强度序最高）', () => {
    expect(highestAvailableLevel(HIGH_MAX_MAP)).toBe('max')
  })

  it('U24: map=undefined → max（全可用时最高档）', () => {
    expect(highestAvailableLevel(undefined)).toBe('max')
  })

  it('U25: 空对象 {} → max（fallback）', () => {
    expect(highestAvailableLevel({})).toBe('max')
  })

  it('on-off 预设 → xhigh（唯一可用档）', () => {
    expect(highestAvailableLevel(ON_OFF_MAP)).toBe('xhigh')
  })

  it('返回值始终是合法 ThinkingLevel', () => {
    const validLevels = THINKING_LEVELS.map((o) => o.level)
    expect(validLevels).toContain(highestAvailableLevel(HIGH_MAX_MAP))
    expect(validLevels).toContain(highestAvailableLevel(ON_OFF_MAP))
    expect(validLevels).toContain(highestAvailableLevel(undefined))
  })
})
