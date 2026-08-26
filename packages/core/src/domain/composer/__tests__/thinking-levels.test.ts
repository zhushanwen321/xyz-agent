/**
 * thinking-levels 纯逻辑单元测试（U1-U8，plan: fix-thinking-level-pi-semantics）。
 *
 * 被测对象：domain/composer/thinking-levels.ts —— 思考档位判定纯函数。
 * 语义基准：pi-ai 0.84.1 getSupportedThinkingLevels（node_modules 实装版探针实测）：
 * - non-reasoning 模型只 ['off']
 * - thinkingLevelMap 缺失/空 → 默认五档 off/minimal/low/medium/high（xhigh/max 需显式定义才解锁）
 * - map 是「叠加禁用/映射」语义：mapped===null 显式禁用该档；未列出的普通档默认可用
 *   （非 key 白名单——曾因白名单误读致 {max:'max'} 模型只显示 1 档）
 * - 结果为空 fallback ['off']（对齐 pi clampThinkingLevel 兜底）
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/__tests__/thinking-levels.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  THINKING_LEVELS,
  resolveAvailableLevels,
  resolveThinkingKey,
  resolveThinkingValue,
  highestAvailableLevel,
  isOnOffMap,
  isSameThinkingScheme,
} from '../thinking-levels'

describe('resolveAvailableLevels — pi getSupportedThinkingLevels 语义', () => {
  it('U1: map 缺失（undefined/null/空对象）→ 默认五档 off/minimal/low/medium/high', () => {
    const expected = ['off', 'minimal', 'low', 'medium', 'high']
    expect(resolveAvailableLevels(undefined)).toEqual(expected)
    expect(resolveAvailableLevels(null as unknown as Record<string, string | null>)).toEqual(expected)
    expect(resolveAvailableLevels({})).toEqual(expected)
    // 不含 xhigh/max：它们需 map 显式定义才解锁
    expect(resolveAvailableLevels(undefined)).not.toContain('xhigh')
    expect(resolveAvailableLevels(undefined)).not.toContain('max')
  })

  it('U2: reasoning=false → 只 off（对齐 pi !model.reasoning 分支）', () => {
    expect(resolveAvailableLevels(undefined, false)).toEqual(['off'])
    // 显式 map 也压不过 reasoning=false
    expect(resolveAvailableLevels({ max: 'max' }, false)).toEqual(['off'])
    // reasoning 未传（undefined）不启用此分支（向后兼容既有调用方）
    expect(resolveAvailableLevels({ max: 'max' })).toContain('max')
  })

  it('U3: 叠加规则非白名单 — {max:"max"} → off..high + max 共六档', () => {
    const levels = resolveAvailableLevels({ max: 'max' })
    expect(levels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'max'])
  })

  it('U4: 全部档位均显式 null → fallback ["off"]（不返回空数组）', () => {
    // 全 7 档显式禁用（含 minimal/xhigh/max）才触发空结果 fallback
    const allNull = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null }
    expect(resolveAvailableLevels(allNull)).toEqual(['off'])
    // 部分禁用：未列出的普通档默认可用（叠加规则——与 pi 行为一致，
    // 如 {off:null, low:null} 下 minimal/medium/high 仍可用）
    const partial = resolveAvailableLevels({ off: null, low: null })
    expect(partial).toEqual(['minimal', 'medium', 'high'])
  })

  it('U5: isOnOffMap 显式二档判定不回归（on/off 展示机制保留）', () => {
    expect(isOnOffMap({ off: 'x', high: 'y', minimal: null, low: null, medium: null })).toBe(true)
    // map 缺失不是 on/off（走默认五档路径）
    expect(isOnOffMap(undefined)).toBe(false)
    expect(isOnOffMap({})).toBe(false)
  })

  it('U6: xhigh/max 仅 map 显式定义时可用', () => {
    // 显式定义两档 → 可用
    const withBoth = resolveAvailableLevels({ xhigh: 'xhigh', max: 'max' })
    expect(withBoth).toContain('xhigh')
    expect(withBoth).toContain('max')
    // 只有 high 定义 → 两档不可用
    const withoutBoth = resolveAvailableLevels({ high: 'h' })
    expect(withoutBoth).not.toContain('xhigh')
    expect(withoutBoth).not.toContain('max')
    // 显式 null = 明确禁用
    expect(resolveAvailableLevels({ xhigh: null, max: null })).not.toContain('xhigh')
  })

  it('U7: THINKING_LEVELS 枚举含 minimal，强度序介于 off 与 low 之间', () => {
    const levels = THINKING_LEVELS.map((o) => o.level)
    expect(levels).toContain('minimal')
    const idx = (l: string) => levels.indexOf(l)
    expect(idx('off')).toBeLessThan(idx('minimal'))
    expect(idx('minimal')).toBeLessThan(idx('low'))
  })

  it('U8: resolveThinkingKey fallback 用最高可用档而非硬编码 max', () => {
    // map={low:'l'} 新语义最高可用档是 high（叠加规则），不可用的 'max' 不应被返回
    expect(resolveThinkingKey('unknown-value', { low: 'l' })).toBe('high')
    // map 缺失时 fallback 同理为 high（默认五档的最高档）
    expect(resolveThinkingKey('unknown-value')).toBe('high')
    // value 能正常反查时不走 fallback
    expect(resolveThinkingKey('l', { low: 'l' })).toBe('low')
  })
})

describe('派生函数在新语义下的联动', () => {
  it('highestAvailableLevel: map 缺失 → high（不再是 max）；显式 max → max', () => {
    expect(highestAvailableLevel(undefined)).toBe('high')
    expect(highestAvailableLevel({ max: 'max' })).toBe('max')
  })

  it('isSameThinkingScheme: 基于新可用集判定（map 缺失 vs {max:max} 跨体系）', () => {
    // undefined 可用集 = 五档；{max:'max'} 可用集 = 六档 → 不同体系
    expect(isSameThinkingScheme(undefined, { max: 'max' })).toBe(false)
    // 两个 map 缺失 → 同体系
    expect(isSameThinkingScheme(undefined, undefined)).toBe(true)
  })

  it('resolveThinkingValue: 无映射回退 key 自身（发送链路不受影响）', () => {
    expect(resolveThinkingValue('high', undefined)).toBe('high')
    expect(resolveThinkingValue('max', { max: 'max' })).toBe('max')
  })
})
