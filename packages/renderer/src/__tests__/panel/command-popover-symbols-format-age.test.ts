/**
 * formatAge 相对时间格式化单测（command-popover-symbols 增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/panel/command-popover-symbols-format-age.test.ts
 *
 * 覆盖全部分档：<1m 'now' / <1h 'Nm' / <1d 'Nh' / >=1d 'Nd' 封顶 + 未来时间钳 0。
 * now 显式传参，不依赖真实当前时间。
 */
import { describe, it, expect } from 'vitest'
import { formatAge } from '@/components/panel/command-popover-symbols'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatAge 相对时间分档', () => {
  it('<1m → now；未来时间钳为 now（diff 负值归 0）', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 30_000, now)).toBe('now')
    expect(formatAge(now + 5 * MIN, now)).toBe('now')
  })

  it('<1h → Nm', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 5 * MIN, now)).toBe('5m')
    expect(formatAge(now - 59 * MIN, now)).toBe('59m')
  })

  it('<1d → Nh', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 3 * HOUR, now)).toBe('3h')
    expect(formatAge(now - 23 * HOUR, now)).toBe('23h')
  })

  it('>=1d → Nd 封顶（多天仍用天数）', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - DAY, now)).toBe('1d')
    expect(formatAge(now - 45 * DAY, now)).toBe('45d')
  })
})
