/**
 * A6-inflight: in-flight 防重 + sendChecked + onSettled。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A6-inflight in-flight 防重: 单 handle 至多一个 flush 在途', () => {
  it('send 入队 → flush 中 → 再 settled 边沿不并发 port.send', () => {
    let settledCb: (() => void) | undefined
    let sendCallCount = 0

    const port = makeMockPort({
      send: (msg, intent) => {
        void msg
        void intent
        sendCallCount++
        return undefined
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })

    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)
    expect(sendCallCount).toBe(1)

    settledCb!()
    expect(port.sendCalls).toHaveLength(1)
    expect(sendCallCount).toBe(1)

    handle.dispose()
  })

  it('async port.send 期间 settled 边沿不并发', async () => {
    let sendResolve: (() => void) | undefined
    let settledCb: (() => void) | undefined

    const port = makeMockPort({
      send: (msg, intent) => {
        void msg
        void intent
        return new Promise<void>((resolve) => { sendResolve = resolve })
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })

    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)

    port.idle = true
    settledCb!()
    expect(port.sendCalls).toHaveLength(1)

    sendResolve!()
    await new Promise((r) => setTimeout(r, 0))

    handle.dispose()
  })
})

describe('A6-inflight sendChecked', () => {
  it('resolve=入队且 port.send 成功', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).resolves.toBeUndefined()
    expect(port.sendCalls).toHaveLength(1)
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('port.send 抛错 reject', async () => {
    const port = makeMockPort({
      send: () => { throw new Error('pi dead') },
    })
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).rejects.toThrow('pi dead')
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('busy 排队时（gate 拦截）行为：入队成功 + 异步终态 resolve', async () => {
    const port = makeMockPort({
      isIdle: () => false,
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    await expect(handle.sendChecked(textMsg('hello'))).resolves.toBeUndefined()
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })

  it('async port.send resolve 后消息从队列移除', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('hello'))
    expect(handle.depth()).toBe(1)

    sendResolve!()
    await promise
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })
})

describe('A6-inflight onSettled 终态信号', () => {
  it('port.send 成功后回调 delivered', () => {
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort()
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))

    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('delivered')
    expect(settledCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('port.send 抛错后回调 rejected', () => {
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => { throw new Error('fail') },
    })
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))

    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('rejected')

    handle.dispose()
  })

  it('async port.send resolve 后回调 delivered', async () => {
    let sendResolve: (() => void) | undefined
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))
    expect(settledCalls).toHaveLength(0)

    sendResolve!()
    await new Promise((r) => setTimeout(r, 0))
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('delivered')

    handle.dispose()
  })

  it('async port.send reject 后回调 rejected', async () => {
    let sendReject: ((err: Error) => void) | undefined
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => new Promise<void>((_, reject) => { sendReject = reject }),
    })
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))
    expect(settledCalls).toHaveLength(0)

    sendReject!(new Error('fail'))
    await new Promise((r) => setTimeout(r, 0))
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('rejected')

    handle.dispose()
  })
})

describe('A6-inflight sendChecked 边界', () => {
  it('disposed 后 sendChecked reject', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)
    handle.dispose()

    await expect(handle.sendChecked(textMsg('hello'))).rejects.toThrow(
      'delivery handle disposed',
    )
  })
})
