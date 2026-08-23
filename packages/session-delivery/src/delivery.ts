/**
 * 投递内核实现：createDelivery。
 *
 * 核心行为：
 * - send() 入队 → dedup → 合批窗口判定 → 立即投或窗口到期投
 * - flush() → isIdle gate (backoff 退避) → port.send
 * - settled 边沿 → isIdle 复核 → flush
 * - watch-dog 定期复核（防 settled 事件丢失）
 * - in-flight 防重：单 handle 至多一个 flush 在途
 */

import { LruSet } from './lru.js'
import type {
  DeliveryConfig,
  DeliveryHandle,
  DeliveryIntent,
  DeliveryMessage,
  DeliveryPort,
} from './types.js'

/** 默认配置（D4 策略默认值）。 */
const DEFAULT_CONFIG: Required<
  Omit<DeliveryConfig, 'mergeHoldActive' | 'dedupe' | 'onSettled'>
> = {
  intent: 'interrupt-at-turn-boundary',
  busyPolicy: 'retry-force',
  mergeWindowMs: 0,
  backoff: { ms: 100, max: 50 },
  watchdogMs: 30_000,
}

/**
 * 创建投递句柄。
 *
 * 约束：同 session 必须单例 handle（多 handle 并发投递竞态无保护）。
 * subscribeSettled 的退订语义由适配器负责兑现。
 */
export function createDelivery(
  port: DeliveryPort,
  config?: DeliveryConfig,
): DeliveryHandle {
  // 合并配置
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    backoff: config?.backoff ?? DEFAULT_CONFIG.backoff,
  }

  // ─── 内部状态 ─────────────────────────────────────────────
  const queue: DeliveryMessage[] = []
  let mergeTimer: ReturnType<typeof setTimeout> | undefined
  let backoffTimer: ReturnType<typeof setTimeout> | undefined
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false // in-flight 防重：至多一个 flush 在途
  let disposed = false
  let settledUnsub: (() => void) | undefined

  // 去重
  const dedupSet = config?.dedupe ? new LruSet(config.dedupe.maxKeys) : null

  // ─── 合批窗口重置 ──────────────────────────────────────────
  function resetMergeTimer(): void {
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer)
      mergeTimer = undefined
    }
    if (cfg.mergeWindowMs > 0) {
      mergeTimer = setTimeout(() => {
        mergeTimer = undefined
        flush()
      }, cfg.mergeWindowMs)
    }
  }

  // ─── settled 订阅管理 ──────────────────────────────────────
  function ensureSettledSub(): void {
    if (settledUnsub || !port.subscribeSettled) return
    settledUnsub = port.subscribeSettled(() => {
      if (disposed) return
      // settled 边沿 → isIdle 复核 → flush
      if (safeIsIdle()) {
        flush()
      }
    })
  }

  function teardownSettledSub(): void {
    if (settledUnsub) {
      settledUnsub()
      settledUnsub = undefined
    }
  }

  // ─── watch-dog ─────────────────────────────────────────────
  function startWatchdog(): void {
    if (watchdogTimer !== undefined) return
    if (!port.subscribeSettled) return // 无订阅装配不用 watch-dog
    watchdogTimer = setInterval(() => {
      if (disposed) return
      if (queue.length === 0) return
      if (safeIsIdle()) {
        flush()
      }
    }, cfg.watchdogMs)
  }

  function stopWatchdog(): void {
    if (watchdogTimer !== undefined) {
      clearInterval(watchdogTimer)
      watchdogTimer = undefined
    }
  }

  // ─── isIdle 安全调用（catch → 视为不可发送） ──────────────
  function safeIsIdle(): boolean {
    try {
      return port.isIdle()
    } catch {
      // session 已关闭等异常 → 视为不可发送
      return false
    }
  }

  // ─── 合批拼接 ──────────────────────────────────────────────
  function buildBatchPayload(messages: DeliveryMessage[]): DeliveryMessage {
    if (messages.length === 1) return messages[0]!

    // 多条以 "\n\n---\n\n" join，details 包装为 { batch: true, items }
    const contents = messages.map((m) => m.payload.content)
    const content = contents.join('\n\n---\n\n')

    // payload kind 取第一条的 kind（同批次应同 kind）
    const first = messages[0]!
    if (first.payload.kind === 'custom') {
      return {
        ...first,
        payload: {
          kind: 'custom',
          customType: first.payload.customType,
          content,
          display: first.payload.display,
          details: { batch: true, items: messages.map((m) => m.payload) },
        },
      }
    }
    return {
      ...first,
      payload: { kind: 'text', content },
    }
  }

  // ─── doSend：实际发送 ─────────────────────────────────────
  function doSend(): void {
    if (disposed || queue.length === 0 || inFlight) return

    inFlight = true
    const batch = buildBatchPayload(queue.splice(0))
    const intent: DeliveryIntent = batch.intent ?? cfg.intent

    try {
      const result = port.send(batch, intent)
      // 处理 Promise 返回值
      if (result && typeof (result as Promise<void>).then === 'function') {
        ;(result as Promise<void>).then(
          () => {
            inFlight = false
            cfg.onSettled?.(batch, 'delivered')
            // 发送后如有新消息入队，继续 flush
            if (queue.length > 0) scheduleFlush(0)
          },
          (err: unknown) => {
            inFlight = false
            warn('port.send failed', err)
            cfg.onSettled?.(batch, 'rejected')
            // 错误重试（同 backoff 参数）
            if (cfg.busyPolicy === 'retry-force') {
              scheduleFlush(0)
            }
          },
        )
      } else {
        // 同步返回（void）= 成功
        inFlight = false
        cfg.onSettled?.(batch, 'delivered')
        if (queue.length > 0) scheduleFlush(0)
      }
    } catch (err) {
      inFlight = false
      warn('port.send threw', err)
      cfg.onSettled?.(batch, 'rejected')
      if (cfg.busyPolicy === 'retry-force') {
        scheduleFlush(0)
      }
    }
  }

  // ─── scheduleFlush：isIdle gate + 退避 ────────────────────
  function scheduleFlush(attempt: number): void {
    if (disposed || queue.length === 0) return

    // in-flight 防重
    if (inFlight) return

    // park 策略：不主动重试，等外部触发
    if (cfg.busyPolicy === 'park' && attempt > 0) return

    // 清残留退避 timer（settled 回调 / flush 外部入口可能覆盖旧 schedule）
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer)
      backoffTimer = undefined
    }

    // isIdle gate
    const idle = safeIsIdle()
    if (!idle && attempt < cfg.backoff.max) {
      // busy → 退避重试
      backoffTimer = setTimeout(() => {
        backoffTimer = undefined
        scheduleFlush(attempt + 1)
      }, cfg.backoff.ms)
      return
    }

    // idle 或达上限 → 发送
    doSend()
  }

  // ─── warn 辅助 ─────────────────────────────────────────────
  function warn(msg: string, err?: unknown): void {
    // 内核无 logger 依赖，用 console.warn
    // eslint-disable-next-line no-console -- 内核无 logger 依赖，投递失败必须可见
    console.warn(`[session-delivery] ${msg}`, err ?? '')
  }

  // ─── 入口函数 ──────────────────────────────────────────────

  function send(msg: DeliveryMessage, opts?: { merge?: boolean }): void {
    if (disposed) return

    // 1. payload 能力 fail-fast（D9）
    if (!port.supportedPayloads.includes(msg.payload.kind)) {
      warn(`unsupported payload kind: ${msg.payload.kind}`)
      return
    }

    // 2. dedup
    if (dedupSet && msg.dedupeKey) {
      if (dedupSet.has(msg.dedupeKey)) return // 已见过，吞
      dedupSet.add(msg.dedupeKey)
    }

    // 3. 入队
    queue.push(msg)

    // 4. 合批窗口判定
    const useMerge =
      opts?.merge ?? (cfg.mergeWindowMs > 0 && cfg.mergeHoldActive != null && cfg.mergeHoldActive())

    if (useMerge) {
      // 走合批窗口：重置 timer
      resetMergeTimer()
      // 订阅 settled（等待边沿唤醒）
      ensureSettledSub()
      return
    }

    // 5. 立即投：无合批依赖
    resetMergeTimer() // 清残留 timer
    ensureSettledSub() // 确保 settled 订阅
    scheduleFlush(0)
  }

  async function sendChecked(msg: DeliveryMessage): Promise<void> {
    if (disposed) throw new Error('delivery handle disposed')

    // payload 能力 fail-fast（D9）
    if (!port.supportedPayloads.includes(msg.payload.kind)) {
      throw new Error(`unsupported payload kind: ${msg.payload.kind}`)
    }

    // dedup
    if (dedupSet && msg.dedupeKey) {
      if (dedupSet.has(msg.dedupeKey)) return // 已见过，resolve
      dedupSet.add(msg.dedupeKey)
    }

    // 入队
    queue.push(msg)

    // 立即尝试发送（不走合批窗口——sendChecked 是同步确认变体）
    const intent: DeliveryIntent = msg.intent ?? cfg.intent

    // isIdle gate 快速检查
    if (!safeIsIdle()) {
      // busy → scheduleFlush 退避，resolve（入队成功 + 异步终态）
      ensureSettledSub()
      scheduleFlush(0)
      return
    }

    // 立即发送
    try {
      const result = port.send(msg, intent)
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result
      }
      // 从队列中移除已发消息
      const idx = queue.indexOf(msg)
      if (idx !== -1) queue.splice(idx, 1)
      cfg.onSettled?.(msg, 'delivered')
    } catch (err) {
      // port.send 抛错 → reject
      const idx = queue.indexOf(msg)
      if (idx !== -1) queue.splice(idx, 1)
      cfg.onSettled?.(msg, 'rejected')
      throw err
    }
  }

  function flush(): void {
    if (disposed) return
    // 清合批 timer
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer)
      mergeTimer = undefined
    }
    scheduleFlush(0)
  }

  function depth(): number {
    return queue.length
  }

  function dispose(): void {
    disposed = true

    // 清所有 timer
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer)
      mergeTimer = undefined
    }
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer)
      backoffTimer = undefined
    }
    stopWatchdog()
    teardownSettledSub()

    // 丢弃队列
    queue.length = 0
    dedupSet?.clear()
    inFlight = false
  }

  return { send, sendChecked, flush, depth, dispose }
}
