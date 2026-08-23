/**
 * A5-merge: mergeHoldActive 谓词语义 + 合批格式 + park 策略。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A5-merge mergeHoldActive 谓词', () => {
  it('谓词 true 走合批窗口', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)

    vi.useRealTimers()
    handle.dispose()
  })

  it('谓词 false/缺省立即投', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => false,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })

  it('[锁] isIdle=true + mergeHoldActive=true 时仍走合批（禁止 isIdle 参与立即投判定）', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    port.idle = true
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)

    vi.useRealTimers()
    handle.dispose()
  })

  it('缺省 mergeHoldActive（undefined）+ mergeWindowMs > 0 时立即投', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A5-merge 合批拼接格式', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('多条以 "\\n\\n---\\n\\n" join，details 包装为 {batch: true, items}', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    handle.send(textMsg('msg2'))
    handle.send(textMsg('msg3'))

    vi.advanceTimersByTime(5000)

    expect(port.sendCalls).toHaveLength(1)
    const sent = port.sendCalls[0]!.msg
    expect(sent.payload.content).toBe('msg1\n\n---\n\nmsg2\n\n---\n\nmsg3')

    handle.dispose()
  })

  it('单条消息不包装 batch', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('solo'))

    vi.advanceTimersByTime(5000)

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('solo')

    handle.dispose()
  })
})

describe('A5-merge park 策略', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('park 策略：busy 入队不主动重试，等外部 flush 触发', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, { busyPolicy: 'park' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(30_000)
    expect(port.sendCalls).toHaveLength(0)

    port.idle = true
    handle.flush()
    vi.advanceTimersByTime(0)
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('depth 诊断', () => {
  it('反映当前队列深度', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, { busyPolicy: 'park' })

    expect(handle.depth()).toBe(0)
    handle.send(textMsg('m1'))
    expect(handle.depth()).toBe(1)
    handle.send(textMsg('m2'))
    expect(handle.depth()).toBe(2)

    handle.dispose()
    expect(handle.depth()).toBe(0)
  })
})
