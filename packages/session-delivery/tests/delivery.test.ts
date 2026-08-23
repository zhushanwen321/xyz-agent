/**
 * @xyz-agent/session-delivery 内核测试。
 *
 * 必测清单（unit 级，vitest fake timers，fullName 含验收 id）：
 * 1. 搬迁：notifier flush/退避/合批场景
 * 2. intent 映射契约
 * 3. subscribeSettled 事件驱动路径
 * 4. watch-dog
 * 5. payload 能力 fail-fast
 * 6. mergeHoldActive 谓词
 * 7. in-flight 防重
 * 8. sendChecked
 * 9. onSettled 终态信号
 * 10. dedupe
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type {
  DeliveryConfig,
  DeliveryIntent,
  DeliveryMessage,
  DeliveryPort,
} from '../src/types.js'

// ─── Mock 工厂 ─────────────────────────────────────────────

function makeMockPort(
  overrides?: Partial<DeliveryPort>,
): DeliveryPort & {
  sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[]
  idle: boolean
  pendingMessages: boolean
  supportedPayloads: readonly ('text' | 'custom')[]
} {
  const sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[] = []
  let idle = true
  let pendingMessages = false
  const supportedPayloads: ('text' | 'custom')[] = ['text', 'custom']

  const port = {
    sendCalls,
    get idle() { return idle },
    set idle(v: boolean) { idle = v },
    get pendingMessages() { return pendingMessages },
    set pendingMessages(v: boolean) { pendingMessages = v },
    get supportedPayloads() { return overrides?.supportedPayloads ?? supportedPayloads },
    isIdle: () => overrides?.isIdle?.() ?? idle,
    hasPendingMessages: () => overrides?.hasPendingMessages?.() ?? pendingMessages,
    send: vi.fn((msg: DeliveryMessage, intent: DeliveryIntent) => {
      sendCalls.push({ msg, intent })
      return overrides?.send?.(msg, intent) ?? undefined
    }),
    // 透传 subscribeSettled 等可选字段
    ...(overrides?.subscribeSettled !== undefined && { subscribeSettled: overrides.subscribeSettled }),
  }

  return port
}

function textMsg(content: string, opts?: Partial<DeliveryMessage>): DeliveryMessage {
  return {
    payload: { kind: 'text', content },
    ...opts,
  }
}

function customMsg(
  customType: string,
  content: string,
  opts?: Partial<DeliveryMessage>,
): DeliveryMessage {
  return {
    payload: { kind: 'custom', customType, content, display: true },
    ...opts,
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 1: 搬迁 — notifier flush/退避/合批场景
// ═══════════════════════════════════════════════════════════════

describe('A1-migration 搬迁: gate 拒绝→退避重试→达上限强发', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('主 agent busy 时 flush 退避，idle 后才发送', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    // busy → 未发送
    expect(port.sendCalls).toHaveLength(0)

    // 推进 1 个退避间隔（100ms）——仍 busy
    vi.advanceTimersByTime(100)
    expect(port.sendCalls).toHaveLength(0)

    // 主 agent 变 idle
    port.idle = true
    vi.advanceTimersByTime(100)

    // idle 后发送
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('主 agent 持续 busy 达退避上限后强制发送', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      backoff: { ms: 100, max: 50 },
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    // 推进超过退避上限（50 × 100ms = 5s）
    vi.advanceTimersByTime(10_000)

    // 达上限后 fallthrough 强制发送
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A1-migration 搬迁: 合批窗口滑动重置', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('窗口内新消息重置 timer，窗口到期后合并发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true, // 始终走合批
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    // 3s 后新消息 → 重置 timer
    vi.advanceTimersByTime(3000)
    handle.send(textMsg('msg2'))
    expect(port.sendCalls).toHaveLength(0)

    // 再推 5s → 窗口到期，合并发送
    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('msg1\n\n---\n\nmsg2')

    handle.dispose()
  })

  it('无后台任务时立即发送（mergeHoldActive=false）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 60_000,
      mergeHoldActive: () => false, // 无合批依赖
    })

    handle.send(textMsg('msg1'))
    // mergeHoldActive=false → 立即投（fake timers 下 setTimeout(fn,100) 不同步触发，
    // 但 scheduleFlush(0) → doSend 是同步链，无 timer 间隔）
    vi.advanceTimersByTime(0)
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A1-migration 搬迁: dispose 短路', () => {
  it('dispose 后 send 不入队不发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.dispose()
    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)
  })

  it('dispose 后退避 timer 不再触发发送', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    handle.dispose()

    // 推进足够久，退避 timer 若未清会触发
    vi.advanceTimersByTime(10_000)
    expect(port.sendCalls).toHaveLength(0)

    vi.useRealTimers()
  })
})

describe('A1-migration 搬迁: flush 强制投递', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('flush 跳过合批窗口直接投递', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 60_000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0) // 在合批窗口中

    handle.flush() // 强制投递
    vi.advanceTimersByTime(0) // flush → scheduleFlush(0) → doSend（fake timer 需推进）
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 2: intent 映射契约
// ═══════════════════════════════════════════════════════════════

describe('A2-intent intent 映射契约', () => {
  it('config.intent 缺省回落 "interrupt-at-turn-boundary"', () => {
    const port = makeMockPort()
    const handle = createDelivery(port) // 无 config.intent

    handle.send(textMsg('hello'))

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.intent).toBe('interrupt-at-turn-boundary')

    handle.dispose()
  })

  it('msg.intent 覆盖 config.intent', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { intent: 'interrupt-at-turn-boundary' })

    handle.send(textMsg('hello', { intent: 'after-run' }))

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.intent).toBe('after-run')

    handle.dispose()
  })

  it('config.intent 被正确传递到 port.send', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { intent: 'after-run' })

    handle.send(textMsg('hello'))

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.intent).toBe('after-run')

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 3: subscribeSettled 事件驱动路径
// ═══════════════════════════════════════════════════════════════

describe('A3-settled subscribeSettled 事件驱动路径', () => {
  it('busy 入队 → settled 回调 → isIdle 复核 true → flush', () => {
    // 不用 fake timers：settled 回调同步触发，doSend 同步执行
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => false, // 初始 busy
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    // busy → scheduleFlush(0) 设退避 timer（真实 timer，100ms 后触发），
    // 但 settled 回调先触发（同步）→ flush → scheduleFlush(0) 清旧 timer → doSend
    expect(port.sendCalls).toHaveLength(0) // busy → 未发送

    // settled 事件触发，isIdle 变 true
    // 注意：不能用 port.idle = true，因为 makeMockPort 的 isIdle 闭包捕获了 overrides.isIdle
    port.isIdle = () => true
    settledCb!()
    // flush → scheduleFlush(0) → idle=true → doSend → port.send
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('settled 回调 → isIdle 复核 false → 不 flush 留队', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => false, // 始终 busy
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    // settled 触发但 isIdle 仍 false → 不 flush
    settledCb!()
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(1) // 仍在队列

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

    handle.send(textMsg('hello')) // 触发订阅
    handle.dispose()

    expect(unsubCalled).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 4: watch-dog
// ═══════════════════════════════════════════════════════════════

describe('A3-settled watch-dog: settled 丢失场景下 30s 复核恢复', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('settled 事件丢失后 watch-dog 30s 复核 flush', () => {
    const port = makeMockPort({
      isIdle: () => false, // 初始 busy
      subscribeSettled: (cb) => {
        void cb
        return () => {}
      },
    })
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      watchdogMs: 30_000,
      backoff: { ms: 100, max: 5 }, // 小上限，快速达限
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    // 退避达上限后仍在 busy（settled 事件丢失），watch-dog 开始运行
    // 推进到退避完成（5 * 100ms = 500ms）
    vi.advanceTimersByTime(600)
    // 退避达上限 → 强制发送（retry-force 默认行为）
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

    // 推进超过退避上限
    vi.advanceTimersByTime(10_000)

    // 达上限后强制发送
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 5: payload 能力 fail-fast
// ═══════════════════════════════════════════════════════════════

describe('A4-payload payload 能力 fail-fast', () => {
  it('supportedPayloads 不含 "custom" 时 send custom 消息被静默吞（warn 不 throw）', () => {
    const port = makeMockPort({
      supportedPayloads: ['text'], // 不支持 custom
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)

    handle.send(customMsg('my-type', 'hello'))

    // send 不 throw，但消息不入队不发送
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('supportedPayloads 不含 "custom" 时 sendChecked custom 消息同步 reject', async () => {
    const port = makeMockPort({
      supportedPayloads: ['text'], // 不支持 custom
    })
    const handle = createDelivery(port)

    await expect(
      handle.sendChecked(customMsg('my-type', 'hello')),
    ).rejects.toThrow('unsupported payload kind: custom')

    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 6: mergeHoldActive 谓词（D4 must-fix #1 语义）
// ═══════════════════════════════════════════════════════════════

describe('A5-merge mergeHoldActive 谓词', () => {
  it('谓词 true 走合批窗口', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0) // 在合批窗口中

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1) // 窗口到期发送

    vi.useRealTimers()
    handle.dispose()
  })

  it('谓词 false/缺省立即投', () => {
    // 不用 fake timers：doSend 是同步链
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => false,
    })

    handle.send(textMsg('msg1'))
    // mergeHoldActive=false → 立即投
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })

  it('[锁] isIdle=true + mergeHoldActive=true 时仍走合批（禁止 isIdle 参与立即投判定）', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    port.idle = true // isIdle = true
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true, // 仍走合批
    })

    handle.send(textMsg('msg1'))
    // isIdle=true 但 mergeHoldActive=true → 不立即投，走合批窗口
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)

    vi.useRealTimers()
    handle.dispose()
  })

  it('缺省 mergeHoldActive（undefined）+ mergeWindowMs > 0 时立即投', () => {
    // 不用 fake timers：doSend 是同步链
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      // mergeHoldActive 未设 → 缺省
    })

    handle.send(textMsg('msg1'))
    // 缺省 mergeHoldActive → 立即投
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 7: in-flight 防重
// ═══════════════════════════════════════════════════════════════

describe('A6-inflight in-flight 防重: 单 handle 至多一个 flush 在途', () => {
  it('send 入队 → flush 中 → 再 settled 边沿不并发 port.send', () => {
    // 不用 fake timers：所有操作同步
    let settledCb: (() => void) | undefined
    let sendCallCount = 0

    const port = makeMockPort({
      send: (msg, intent) => {
        void msg
        void intent
        sendCallCount++
        // 返回 undefined（同步成功）
        return undefined
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })

    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('msg1'))
    // port.send 被调用一次（同步成功）
    expect(port.sendCalls).toHaveLength(1)
    expect(sendCallCount).toBe(1)

    // 发送成功后 queue 为空，settled 边沿触发 → 不应再 port.send
    settledCb!()
    expect(port.sendCalls).toHaveLength(1) // 仍然只有 1 次
    expect(sendCallCount).toBe(1)

    handle.dispose()
  })

  it('async port.send 期间 settled 边沿不并发', async () => {
    // 不用 fake timers：用 real async
    let sendResolve: (() => void) | undefined
    let settledCb: (() => void) | undefined

    const port = makeMockPort({
      send: (msg, intent) => {
        void msg
        void intent
        // 返回一个延迟 resolve 的 Promise
        return new Promise<void>((resolve) => { sendResolve = resolve })
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })

    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('msg1'))
    // port.send 被调用一次（异步挂起中）
    expect(port.sendCalls).toHaveLength(1)

    // settled 边沿触发 → 应不并发 port.send（in-flight 防重）
    port.idle = true
    settledCb!()
    // 仍然只有 1 次 port.send 调用
    expect(port.sendCalls).toHaveLength(1)

    // sendResolve 后 inFlight 解除
    sendResolve!()
    // 微任务队列清空后检查
    await new Promise((r) => setTimeout(r, 0))

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 8: sendChecked
// ═══════════════════════════════════════════════════════════════

describe('A6-inflight sendChecked', () => {
  it('resolve=入队且 port.send 成功', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).resolves.toBeUndefined()
    expect(port.sendCalls).toHaveLength(1)
    expect(handle.depth()).toBe(0) // 已从队列移除

    handle.dispose()
  })

  it('port.send 抛错 reject', async () => {
    const port = makeMockPort({
      send: () => { throw new Error('pi dead') },
    })
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).rejects.toThrow('pi dead')
    expect(handle.depth()).toBe(0) // 已从队列移除

    handle.dispose()
  })

  it('busy 排队时（gate 拦截）行为：入队成功 + 异步终态 resolve', async () => {
    const port = makeMockPort({
      isIdle: () => false, // busy
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    // sendChecked 在 busy 时 resolve（入队成功 + 异步终态）
    await expect(handle.sendChecked(textMsg('hello'))).resolves.toBeUndefined()
    // 消息在队列中（等待异步投递）
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
    // 还在挂起
    expect(handle.depth()).toBe(1)

    sendResolve!()
    await promise
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 9: onSettled 终态信号
// ═══════════════════════════════════════════════════════════════

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
    expect(settledCalls).toHaveLength(0) // 还在挂起

    sendResolve!()
    await new Promise((r) => setTimeout(r, 0)) // 微任务清空
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
    await new Promise((r) => setTimeout(r, 0)) // 微任务清空
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('rejected')

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// Test 10: dedupe
// ═══════════════════════════════════════════════════════════════

describe('A1-migration dedupe', () => {
  it('同 dedupeKey 二次 send 被吞', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key1' })) // 同 key，被吞

    expect(port.sendCalls).toHaveLength(1) // 只发了第一条
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('不同 dedupeKey 正常发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key2' }))

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })

  it('maxKeys LRU 挤出：超容量后旧 key 可重发', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 2 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key2' }))
    handle.send(textMsg('msg3', { dedupeKey: 'key3' })) // 超容量，挤出 key1

    expect(port.sendCalls).toHaveLength(3)

    // key1 已被挤出，可重发
    handle.send(textMsg('msg4', { dedupeKey: 'key1' }))
    expect(port.sendCalls).toHaveLength(4)

    handle.dispose()
  })

  it('无 dedupeKey 时不参与去重', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1')) // 无 dedupeKey
    handle.send(textMsg('msg1')) // 无 dedupeKey，不参与去重

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })

  it('无 dedupe 配置时不去重', () => {
    const port = makeMockPort()
    const handle = createDelivery(port) // 无 dedupe 配置

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key1' })) // 同 key 但无 dedupe

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════
// 补充测试：合批格式、park 策略、depth
// ═══════════════════════════════════════════════════════════════

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
    expect(port.sendCalls).toHaveLength(0) // busy → 不发送

    // 推进很久也不自动重试
    vi.advanceTimersByTime(30_000)
    expect(port.sendCalls).toHaveLength(0)

    // 外部 flush 触发
    port.idle = true
    handle.flush()
    vi.advanceTimersByTime(0) // fake timer 下 flush → scheduleFlush(0) 需推进
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

// ═══════════════════════════════════════════════════════════════
// 补充：sendChecked payload fail-fast + disposed reject
// ═══════════════════════════════════════════════════════════════

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
