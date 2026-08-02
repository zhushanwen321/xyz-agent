/**
 * MessageBus 类型定义。
 *
 * 本 wave（wave:bus-core）实现纯运行时的 MessageBus 核心：per-session 的
 * 环形缓冲（ring buffer）+ 状态快照（stateSnapshot）+ 订阅者集合（subscribers）。
 * 不接线真实 WebSocket——BusClient 是 WS 的最小契约，测试用 mock 注入。
 *
 * 完整 WS 接线（server.ts 把 ws 实例适配为 BusClient）在 runtime-wiring wave。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * WebSocket 的最小契约。
 *
 * MessageBus 只依赖这两个成员：
 * - readyState：1 = OPEN（与浏览器 WebSocket.OPEN 常量一致），仅 OPEN 时才 send。
 * - send：序列化后的 JSON 字符串。
 *
 * 本 wave 不接线真实 ws 库——测试构造 `{ readyState: 1, send: vi.fn() }` 即可。
 * runtime-wiring wave 会把 ws.WebSocket 实例（天然满足此契约）传入。
 */
export interface BusClient {
  /** WS 连接状态，1 = OPEN（同浏览器 WebSocket.OPEN）。 */
  readyState: number
  /** 发送序列化后的消息体（JSON 字符串）。 */
  send(data: string): void
}

/**
 * per-session bus 内部状态。
 *
 * 每个 sessionId 对应一个独立的 SessionBusState：
 * - seqCounter：per-session 单调递增的 seq 分配器（publish 时 ++seqCounter 写入 message.seq）。
 * - streamRing：流式消息的环形缓冲（FIFO），满时淘汰最旧（shift）。固定容量 ringCapacity（默认 1000）。
 * - stateSnapshot：state topic 的最新值去重表（typeKey → 最新 ServerMessage）。新订阅者 connect 时
 *   用 streamRing 全量 + stateSnapshot 合并做初始化（subscribe 当前只返 streamRing snapshot，
 *   stateSnapshot 的合并消费在 runtime-wiring wave）。
 * - subscribers：当前 session 的活跃订阅者（BusClient 集合）。publish 时遍历广播。
 *
 * 不变量：ws ∈ subscribers ⟺ sid ∈ wsSubscriptions[ws]（由 MessageBus 双向维护）。
 */
export interface SessionBusState {
  /** per-session 单调 seq 分配器（publish 前 ++）。 */
  seqCounter: number
  /** 流式消息环形缓冲（FIFO，满则 shift 最旧）。 */
  streamRing: ServerMessage[]
  /** state topic 最新快照（typeKey → 最新消息），用于状态去重与初始化。 */
  stateSnapshot: Map<string, ServerMessage>
  /** 当前 session 的活跃订阅者集合。 */
  subscribers: Set<BusClient>
}
