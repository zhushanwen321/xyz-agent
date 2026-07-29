/**
 * format.ts 纯函数单测（W2 wave · TC7）。
 *
 * 覆盖从 WorkflowDetail.vue 提取的 4 个格式化函数：
 * callDotClass（4 状态配色）/ phaseDotClass / formatTokens / formatDuration。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/workflow/__tests__/format.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect } from 'vitest'
import { callDotClass, phaseDotClass, formatTokens, formatDuration } from '../format'

describe('W2 format: callDotClass 状态配色', () => {
  it("completed → 'bg-success'", () => {
    expect(callDotClass('completed')).toBe('bg-success')
  })

  it("failed → 'bg-danger'", () => {
    expect(callDotClass('failed')).toBe('bg-danger')
  })

  it("running → 'bg-accent'", () => {
    expect(callDotClass('running')).toBe('bg-accent')
  })

  it("pending → 'bg-neutral-dim opacity-40'", () => {
    expect(callDotClass('pending')).toBe('bg-neutral-dim opacity-40')
  })
})

describe('W2 format: phaseDotClass 状态配色', () => {
  it("completed → 'bg-success'", () => {
    expect(phaseDotClass('completed')).toBe('bg-success')
  })

  it("running → 'bg-accent'", () => {
    expect(phaseDotClass('running')).toBe('bg-accent')
  })

  it("pending → 'bg-neutral-dim opacity-40'", () => {
    expect(phaseDotClass('pending')).toBe('bg-neutral-dim opacity-40')
  })
})

describe('W2 format: formatTokens', () => {
  it('12345 tok 含 k 单位（12.3k tok）', () => {
    const result = formatTokens(12345, 'tok')
    expect(result).toBe('12.3k tok')
    expect(result).toContain('k')
  })

  it('< 1000 时显示原数 + 单位', () => {
    expect(formatTokens(500, 'tok')).toBe('500 tok')
  })

  it('恰好 1000 触发 k 阈值', () => {
    expect(formatTokens(1000, 'tok')).toBe('1.0k tok')
  })
})

describe('W2 format: formatDuration', () => {
  it('65000ms → 1m5s', () => {
    expect(formatDuration(65000)).toBe('1m5s')
  })

  it('5000ms → 5s', () => {
    expect(formatDuration(5000)).toBe('5s')
  })

  it('不足 1 分钟仍用秒', () => {
    expect(formatDuration(3000)).toBe('3s')
  })

  it('整分钟（60s）→ 1m0s', () => {
    expect(formatDuration(60000)).toBe('1m0s')
  })
})
