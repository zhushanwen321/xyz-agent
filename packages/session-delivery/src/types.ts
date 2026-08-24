/**
 * @xyz-agent/session-delivery 类型定义。
 *
 * 设计约束：
 * - 零 pi 依赖：不出现 steer/followUp/triggerTurn/streamingBehavior 等 pi 词汇
 * - 意图驱动：调用方声明 intent，内核处理与 session 运行状态的冲突
 * - 判别联合 payload：适配器声明 supportedPayloads 能力
 */

// ─── 投递意图 ───────────────────────────────────────────────

/** 投递意图（D3）：turn 边界抢占 / run 结束后注入，均含 idle 唤醒语义。 */
export type DeliveryIntent = 'interrupt-at-turn-boundary' | 'after-run'

// ─── 消息 payload ───────────────────────────────────────────

/** 文本 payload（runtime 通路一期唯一支持）。 */
export interface TextPayload {
  kind: 'text'
  content: string
}

/** custom message payload（extension 通路支持）。 */
export interface CustomPayload {
  kind: 'custom'
  customType: string
  content: string
  display: boolean
  details?: unknown
}

/** 判别联合（D9）：envelope / payload 分离。 */
export type DeliveryPayload = TextPayload | CustomPayload

// ─── 消息 envelope ──────────────────────────────────────────

/** 投递消息 envelope。 */
export interface DeliveryMessage {
  payload: DeliveryPayload
  /** 缺省回落 config.intent。 */
  intent?: DeliveryIntent
  /** 去重 key（开 dedupe 时必填）。 */
  dedupeKey?: string
  /** 持久性预留（一期仅 'in-memory'）。 */
  durability?: 'in-memory'
}

// ─── 端口（注入运行时能力） ──────────────────────────────────

/** 内核与外部世界的唯一接口（D2 端口注入）。 */
export interface DeliveryPort {
  /** 本通路支持的 payload kind（D9 fail-fast）。 */
  supportedPayloads: readonly DeliveryPayload['kind'][]
  /** 主 agent 是否空闲。 */
  isIdle(): boolean
  /** 是否有排队中的消息。 */
  hasPendingMessages(): boolean
  /** 投递消息（intent → pi 参数的翻译在适配器内部）。 */
  send(msg: DeliveryMessage, intent: DeliveryIntent): Promise<void> | void
  /** agent_settled 边沿订阅（D8）。缺省时内核退化退避轮询。返回退订函数。 */
  subscribeSettled?(cb: () => void): () => void
}

// ─── 配置 ───────────────────────────────────────────────────

/** 内核配置（D4 策略默认值）。 */
export interface DeliveryConfig {
  /** 默认意图：'interrupt-at-turn-boundary'（D3）。 */
  intent?: DeliveryIntent
  /** busy 策略：'retry-force'（默认）/ 'park'。 */
  busyPolicy?: 'retry-force' | 'park'
  /** 合批窗口（ms）：0 = 关；>0 = 滑动窗口合批。 */
  mergeWindowMs?: number
  /** 合批依赖谓词（D4 must-fix #1）。true 时 send() 走合批窗口，false/缺省时立即投。
   *  禁止用 isIdle 代替。 */
  mergeHoldActive?: () => boolean
  /** 退避参数。 */
  backoff?: { ms: number; max: number }
  /** watch-dog 复核间隔（ms）。默认 30_000。 */
  watchdogMs?: number
  /** 去重配置（条数 LRU）。 */
  dedupe?: { maxKeys: number }
  /** 投递终态信号（D4）。 */
  onSettled?: (msg: DeliveryMessage, outcome: 'delivered' | 'rejected') => void
}

// ─── Handle ──────────────────────────────────────────────────

/** 投递句柄（createDelivery 返回）。 */
export interface DeliveryHandle {
  /** 唯一常规入口（D4 入口收敛）；合批窗口 + 空闲零延迟立即投。 */
  send(msg: DeliveryMessage, opts?: { merge?: boolean }): void
  /** 入队 + 可达性同步确认。reject = 入队失败。 */
  sendChecked(msg: DeliveryMessage): Promise<void>
  /** 强制投递尝试（shutdown / park 外部重触发 / settled 边沿内部复用）。 */
  flush(): void
  /** 队列深度（诊断/测试）。 */
  depth(): number
  /** 销毁（清空队列 + 清 timer + 退订 settled）。 */
  dispose(): void
}
