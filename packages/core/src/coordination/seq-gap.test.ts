/**
 * seq-gap.test.ts —— evalSeqGap 六分支全覆盖（F7，TC-1）。
 *
 * IF3 契约六分支：
 * ① state undefined → pass（无副作用）
 * ② state.subscribed=false → pass
 * ③ msg.seq 非 number → pass
 * ④ seq <= lastSeenSeq → drop（重复/乱序丢弃）
 * ⑤ seq > lastSeenSeq+1 → pass + reconcileFromSeq: seq-1（gap）
 * ⑥ seq === lastSeenSeq+1 → pass（正常递进，无 reconcileFromSeq）
 *
 * 纯函数零 mock：直接 import 调用断言返回值。
 */
import { describe, it, expect } from 'vitest'
import { evalSeqGap } from './seq-gap'
import type { SubscriptionState } from './subscription-state'

const subscribed: SubscriptionState = { lastSeenSeq: 10, subscribed: true }

describe('evalSeqGap', () => {
  it('分支①：state undefined → pass（无副作用）', () => {
    expect(evalSeqGap({ seq: 5 }, undefined)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 11 }, undefined)).toEqual({ action: 'pass' })
    expect(evalSeqGap({}, undefined)).toEqual({ action: 'pass' })
  })

  it('分支②：state.subscribed=false → pass（兼容路径不 gap 检测）', () => {
    const notSubscribed: SubscriptionState = { lastSeenSeq: 10, subscribed: false }
    expect(evalSeqGap({ seq: 5 }, notSubscribed)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 100 }, notSubscribed)).toEqual({ action: 'pass' })
  })

  it('分支③：msg.seq 非 number → pass（无 gap 语义）', () => {
    expect(evalSeqGap({}, subscribed)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: undefined }, subscribed)).toEqual({ action: 'pass' })
  })

  it('分支④：seq <= lastSeenSeq → drop（reconcile 回放重复/乱序）', () => {
    expect(evalSeqGap({ seq: 10 }, subscribed)).toEqual({ action: 'drop' })
    expect(evalSeqGap({ seq: 3 }, subscribed)).toEqual({ action: 'drop' })
    expect(evalSeqGap({ seq: 0 }, subscribed)).toEqual({ action: 'drop' })
  })

  it('分支⑤：seq > lastSeenSeq+1 → pass + reconcileFromSeq: seq-1（gap 回拉）', () => {
    expect(evalSeqGap({ seq: 12 }, subscribed)).toEqual({ action: 'pass', reconcileFromSeq: 11 })
    expect(evalSeqGap({ seq: 20 }, subscribed)).toEqual({ action: 'pass', reconcileFromSeq: 19 })
  })

  it('分支⑥：seq === lastSeenSeq+1 → pass（正常递进，无 reconcileFromSeq）', () => {
    expect(evalSeqGap({ seq: 11 }, subscribed)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 10 + 1 }, subscribed)).toEqual({ action: 'pass' })
  })

  it('边界：lastSeenSeq=0（无历史）时 seq=1 正常递进、seq=2 gap', () => {
    const fresh: SubscriptionState = { lastSeenSeq: 0, subscribed: true }
    expect(evalSeqGap({ seq: 1 }, fresh)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 2 }, fresh)).toEqual({ action: 'pass', reconcileFromSeq: 1 })
    expect(evalSeqGap({ seq: 0 }, fresh)).toEqual({ action: 'drop' })
  })
})
