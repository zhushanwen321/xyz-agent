/**
 * SessionBuffer —— per-session ring buffer（P2-s1-w2 可靠投递层）。
 *
 * 设计要点（spec §3.1）：
 * - 每个 SessionBuffer 归属一个 sessionId（由 SessionBufferManager 的 Map 键维护，本类内部不存 sid）。
 * - `entries: Array<{ seq, data }>` 按 seq 升序存「broadcast 已 stringify 一次的字符串原样」，
 *   回放零再序列化（DM2）。`data` 是 `ws.send` 收到的同一字符串，严格相等。
 * - 双限 LRU 驱逐：`maxCount`（条数）+ `maxBytes`（字节），OR 触发从头部 LRU 删（最老的最先淘汰）。
 *   每删一条调 `onEvict(evicted.seq)`，由上层 broker 推进全局 evictedWatermark（D4）。
 * - `append` 的 `seq` 参数是 w1 `SeqCounter.assignSeq()` 已分配的值——本模块只读不再调计数器
 *   （w1 retrospect 约定：多入口调 assignSeq 会破坏全局单调性）。
 *
 * 巨消息豁免不在本类处理（由 broker 在 append 前用 `Buffer.byteLength(payload,'utf8') <= maxBytesPerSession`
 * 过滤，避免单条 >maxBytes 入桶瞬间清空整桶）。本类只保证 append 进来的条目在双限内驱逐。
 *
 * 独立模块（不入 broker 类）：便于模块隔离单测（不依赖 broker/services mock）。
 */
export interface BufferedMessage {
  /** 全局单调 seq（broadcast assignSeq 分配的值，回放合并排序的键）。 */
  seq: number
  /** 已 stringify 的消息字符串原样（与 ws.send 入参完全一致，回放零再序列化）。 */
  data: string
}

/**
 * 单个 session 的 ring buffer。
 * entries 按 seq 升序（append 顺序即升序，w1 assignSeq 单调）；filter 保序。
 */
export class SessionBuffer {
  /** 按 seq 升序的缓冲条目（push 到尾部，从头部 LRU 驱逐）。 */
  readonly entries: BufferedMessage[] = []
  /** 当前桶累计字节数（entries 各条 Buffer.byteLength(data,'utf8') 之和，真实 UTF-8 字节）。 */
  bytes = 0

  constructor(
    /** 条数上限（如 1000）。 */
    private readonly maxCount: number,
    /** 字节上限（如 8MB）。 */
    private readonly maxBytes: number,
    /**
     * 每驱逐一条的回调，参数是被驱逐条目的 seq。
     * broker 用它推进全局 evictedWatermark（D4：只 LRU 驱逐推进 watermark）。
     * 反向依赖解耦：本类不 import broker 类型，靠回调注入。
     */
    private readonly onEvict: (seq: number) => void,
  ) {}

  /**
   * 追加一条已序列化消息到尾部，更新 bytes，按需从头驱逐。
   *
   * 字节口径用 Buffer.byteLength(data, 'utf8')（真实 UTF-8 字节数），而非 data.length（UTF-16 code unit
   * 计数）。env 名 XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION 是字节语义，CJK/emoji 的 .length 显著小于
   * 真实字节数（「你好」length=2 但 byteLength=6），用 .length 会让内存上限语义偏松。与 broker 入桶
   * 阈值判定（message-broker.ts）口径一致。性能可接受（每条消息一次 byteLength 调用，广播频率不高）。
   *
   * @param seq w1 assignSeq 已分配的值（本模块只读，不调计数器）
   * @param data broadcast 已 stringify 的字符串原样
   */
  append(seq: number, data: string): void {
    this.entries.push({ seq, data })
    this.bytes += Buffer.byteLength(data, 'utf8')
    this.evictIfNeeded()
  }

  /**
   * 双限驱逐：条数 OR 字节超限则从头部 LRU 删，每删一条调 onEvict。
   * while 循环保证删到两项都满足为止（字节超限可能需删多条）。
   *
   * 边界：单条 byteLength > maxBytes 时（理论上 broker 已豁免不入桶，但兜底防护），
   * while 条件中 `this.bytes > this.maxBytes` 会持续 true——但该条刚 push 进来，
   * shift 会删它自身，之后 entries 为空、bytes 归 0，循环终止。不会死循环。
   */
  private evictIfNeeded(): void {
    while (this.entries.length > this.maxCount || this.bytes > this.maxBytes) {
      const evicted = this.entries.shift()
      if (!evicted) break // 理论上不会（while 条件保证非空），兜底
      this.bytes -= Buffer.byteLength(evicted.data, 'utf8')
      this.onEvict(evicted.seq)
    }
  }

  /**
   * 返回桶内 seq > lastSeq 的条目（保升序）。
   * 用于 getReplayPlan 收集缺失段——桶内已按 seq 升序，filter 不改变顺序。
   */
  getReplayPlan(lastSeq: number): BufferedMessage[] {
    return this.entries.filter((e) => e.seq > lastSeq)
  }

  /** 当前桶条数（entries.length 的语义别名，便于测试断言）。 */
  get size(): number {
    return this.entries.length
  }
}
