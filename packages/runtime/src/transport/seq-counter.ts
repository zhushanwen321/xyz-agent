/**
 * SeqCounter —— 全局单调递增 seq 计数器（P2 可靠投递层地基）。
 *
 * 设计要点：
 * - 每个 ServerMessageBroker 实例持有一个 SeqCounter，broadcast 入口（JSON.stringify 之前）
 *   调用 assignSeq 给 envelope 顶层打 seq。
 * - Node 单线程模型下 `++this.seq` 天然原子，无需锁/无并发原语；同步调用顺序即 seq 顺序。
 * - 首次 assignSeq 返回 1（前缀自增），N+1 > N 严格单调。
 * - assignSeq 在 stringify 之前调用：stringify 失败时 seq 已自增，留下空洞；客户端回放条件
 *   `seq > lastSeq` 天然跳过空洞，无害（spec §3.1 取舍）。
 *
 * 独立模块（不放 broker 类内）：便于 P2-w2 的 SessionBuffer / 回放单测直接 import，
 * 不需要 mock 整个 broker/services 依赖。
 *
 * 边界：Number.MAX_SAFE_INTEGER（2^53 - 1）溢出在 ~285000 年尺度（每秒 1000 条），
 * 不做兜底（YAGNI）。
 */
export class SeqCounter {
  private seq = 0

  /**
   * 返回严格单调递增的正整数（首次返回 1）。
   * 前缀自增保证「调用即推进」，stringify 失败时 seq 已分配，空洞语义正确。
   */
  assignSeq(): number {
    return ++this.seq
  }

  /**
   * 当前已分配的最大 seq（只读，不推进）。
   * 用于 auth.ok 携带 serverSeq（P2-s2：客户端下次重连带回作 lastSeq）。
   * 未调过 assignSeq 时返回 0（初始值，broker 未广播过任何消息）。
   */
  get current(): number {
    return this.seq
  }
}
