/**
 * A3-settled: subscribeSettled 事件驱动路径 + watch-dog。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A3-settled subscribeSettled 事件驱动路径', () => {
  it('busy 入队 → settled 回调 → isIdle 复核 true → flush', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    port.isIdle = () => true
    settledCb!()
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('settled 回调 → isIdle 复核 false → 不 flush 留队', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    settledCb!()
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })

  it('dispose 退订 settled 订阅', () => {
    let unsubCalled = false
    const port = makeMockPort({
      subscribeSettled: (cb) => {
        void cb
        return () => { unsubCalled = true }
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    handle.dispose()

    expect(unsubCalled).toBe(true)
  })
})

describe('A3-settled watch-dog: settled 丢失场景下 30s 复核恢复', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('settled 事件丢失后 watch-dog 30s 复核 flush', () => {
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        void cb
        return () => {}
      },
    })
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      watchdogMs: 30_000,
      backoff: { ms: 100, max: 5 },
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(600)
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })

  it('无 subscribeSettled 装配时不用 watch-dog，纯退避轮询', () => {
    const port = makeMockPort({
      isIdle: () => false,
    })
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      backoff: { ms: 100, max: 5 },
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(10_000)

    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})
