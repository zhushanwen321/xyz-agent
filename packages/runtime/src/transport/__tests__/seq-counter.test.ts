/**
 * SeqCounter 模块隔离单测（TC-W1.6）。
 *
 * 直接 new SeqCounter() 测 assignSeq 单调性，不依赖 broker/services mock。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/seq-counter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { SeqCounter } from '../seq-counter.js'

describe('SeqCounter (TC-W1.6 模块隔离)', () => {
  it('assignSeq 返回严格单调递增正整数（首次 1）', () => {
    const c = new SeqCounter()
    expect(c.assignSeq()).toBe(1)
    expect(c.assignSeq()).toBe(2)
    expect(c.assignSeq()).toBe(3)
    // 继续递增，不重置
    expect(c.assignSeq()).toBe(4)
    expect(c.assignSeq()).toBe(5)
  })

  it('多个独立实例各自从 1 开始（互不干扰，per-broker 实例隔离）', () => {
    const a = new SeqCounter()
    const b = new SeqCounter()
    expect(a.assignSeq()).toBe(1)
    expect(b.assignSeq()).toBe(1) // b 不受 a 影响
    expect(a.assignSeq()).toBe(2)
    expect(b.assignSeq()).toBe(2)
    // 交错调用仍各自独立
    expect(a.assignSeq()).toBe(3)
    expect(b.assignSeq()).toBe(3)
    expect(a.assignSeq()).toBe(4)
  })

  it('N+1 > N 严格单调（连续 100 次）', () => {
    const c = new SeqCounter()
    let prev = 0
    for (let i = 0; i < 100; i++) {
      const cur = c.assignSeq()
      expect(cur).toBeGreaterThan(prev)
      expect(cur).toBe(i + 1)
      prev = cur
    }
  })
})
