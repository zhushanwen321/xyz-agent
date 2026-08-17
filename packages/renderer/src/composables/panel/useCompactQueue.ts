/**
 * useCompactQueue —— per-session 待发消息队列（compact-queued-messages W1）。
 *
 * 用途：compact（上下文压缩）执行期间用户消息需要重放的暂存队列。session.compacted
 * 成功广播后（useChat handler 调 flush）重放：首条 chatApi.send 启动新 run，其余
 * chatApi.steer 入 pi steeringQueue 被该 run 消费（send 先到 pi，新 run 先于 steer 投递）。
 *
 * 单例模式（对齐 useChat 模块级状态）：模块顶层缓存实例，首次 useCompactQueue() 调用
 * 时创建（App.vue setup 绑定 app 级 effect scope——防模块级 onScopeDispose 警告与过早
 * 反注册，保证 registerSessionCleanup 常驻；W5 deleteSession → triggerSessionCleanups
 * 时分区随 session 销毁）。所有公开方法显式接收 sid 并经 updateFor 操作分区——不依赖
 * 全局活跃 sid，兼容 split 多 panel。
 */
import { reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import { chat as chatApi } from '@/api'
import * as events from '@/api/events'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 待发消息条目（D1 继承自 slice） */
export interface QueuedMessage {
  id: string
  text: string
}

/** per-session 分区：待发消息数组（init 返回 reactive 容器，ADR-0049 响应式契约） */
interface CompactQueuePartition {
  messages: QueuedMessage[]
}

export interface CompactQueue {
  /** 入队一条待发消息，返回含 crypto.randomUUID() id 的条目（updateFor push） */
  enqueue(sid: string, text: string): QueuedMessage
  /** 按 id 精确取消，未知 id no-op（不抛错） */
  remove(sid: string, id: string): void
  /** 分区消息数（updateFor 内读 messages.length；调用方包进 computed 时依赖在 reactive 上建立） */
  count(sid: string): number
  /** 只读快照（返回副本，调用方修改不影响队列，UI 预览用） */
  peek(sid: string): QueuedMessage[]
  /** 是否有待发消息（count > 0） */
  hasPending(sid: string): boolean
  /**
   * 重放队列：首条 chatApi.send + 其余依次 chatApi.steer（await 串行）。
   * 成功判定（S1，D-009 契约核对）：runtime sendMessage busy 预检（isGenerating /
   * isCompacting / isBashRunning）时广播 send.rejected 并返回 {blocked, rejected}（不抛错），
   * session-message-handler 据此 reply message.status{rejected}——ack 型 void，renderer 的
   * chatApi.send resolve 且拿不到 status，无法区分「真发送成功」与「预检拒绝」。
   * 故 flush 窗口内临时订阅 send.rejected：收到即视为重放被拒 → 队列保留 + 返回 false
   * （消息不丢，下次 compact 成功时整队重试）。
   * 成功 → 仅移除 snapshot 中的条目（await 窗口内新入队的消息保留）+ 返回 true；
   * 失败（RPC reject 或 send.rejected）→ 队列整体保留（不清空）+ 返回 false
   * （E2 restoreQueue 语义：已发送的条目不计入清除，下次 flush 重新发送整队保证顺序与完整性）。
   * 并发（S2）：per-session in-flight 守卫，flush 进行中重复触发复用同一 promise，不重复发送。
   */
  flush(sid: string): Promise<boolean>
  /** 测试钩子：清空所有分区。生产代码禁止调用（对齐 useSessionScopedState._clearAllForTest 契约）。 */
  _clearAllForTest(): void
}

/** 模块级单例缓存（首次调用时创建，App.vue setup 绑定 app 级 scope） */
let queueInstance: CompactQueue | null = null

/**
 * 获取模块级单例。首次调用创建实例（内部 useSessionScopedState 的 onScopeDispose
 * 在调用方 effect scope 内注册——App.vue setup 是 app 级作用域，App 卸载前常驻）。
 * 后续调用复用同一实例。
 */
export function useCompactQueue(): CompactQueue {
  if (!queueInstance) {
    queueInstance = createCompactQueue()
  }
  return queueInstance
}

function createCompactQueue(): CompactQueue {
  // 常驻 null sid ref：公开方法全部显式接收 sid 并经 updateFor 操作分区，
  // 不使用 update()/current（无全局活跃 sid 概念）。
  const sidRef: Ref<string | null> = ref(null)
  const state = useSessionScopedState<CompactQueuePartition>(
    sidRef,
    () => reactive<CompactQueuePartition>({ messages: [] }),
  )

  function enqueue(sid: string, text: string): QueuedMessage {
    const entry: QueuedMessage = { id: crypto.randomUUID(), text }
    state.updateFor(sid, (p) => {
      p.messages.push(entry)
    })
    return entry
  }

  function remove(sid: string, id: string): void {
    state.updateFor(sid, (p) => {
      // 未知 id 时 filter 结果等同原数组（no-op，不抛错）
      p.messages = p.messages.filter((m) => m.id !== id)
    })
  }

  function count(sid: string): number {
    let n = 0
    state.updateFor(sid, (p) => {
      n = p.messages.length
    })
    return n
  }

  function peek(sid: string): QueuedMessage[] {
    let snapshot: QueuedMessage[] = []
    state.updateFor(sid, (p) => {
      snapshot = p.messages.map((m) => ({ ...m }))
    })
    return snapshot
  }

  function hasPending(sid: string): boolean {
    return count(sid) > 0
  }

  // per-session in-flight 守卫（S2）：flush 进行中重复触发复用同一 promise，不重复发送
  const inflightFlushes = new Map<string, Promise<boolean>>()

  async function flush(sid: string): Promise<boolean> {
    const existing = inflightFlushes.get(sid)
    if (existing) return existing
    const p = doFlush(sid)
    inflightFlushes.set(sid, p)
    try {
      return await p
    } finally {
      inflightFlushes.delete(sid)
    }
  }

  async function doFlush(sid: string): Promise<boolean> {
    const snapshot = peek(sid)
    if (snapshot.length === 0) return true
    // S1：flush 窗口内临时订阅 send.rejected。runtime 广播先于 RPC reply 到达
    //（同 WS 连接 FIFO：dispatcher 同步广播 → handler 同步 reply），await resolve 时标志已就绪。
    // 订阅仅存在于 flush 窗口，用户后续的 send.rejected 不影响本次判定。
    let rejected = false
    const unsub = events.on(sid, (msg: ServerMessage) => {
      if (msg.type === 'send.rejected') rejected = true
    })
    try {
      // 首条 send 启动新 run；其余 steer 串行入 pi steeringQueue，被该 run 消费
      await chatApi.send(sid, snapshot[0].text)
      for (let i = 1; i < snapshot.length; i++) {
        await chatApi.steer(sid, snapshot[i].text)
      }
    } catch {
      // 任一条 RPC 失败 → 队列整体保留（不清空）+ 返回 false（E2 restoreQueue 语义）：
      // 已发送的条目不计入清除，下次 flush 重新发送整队，保证顺序与完整性。
      return false
    } finally {
      unsub()
    }
    if (rejected) {
      // 预检拒绝：消息未实际投递，队列整体保留（不清空）+ 返回 false（下次 compact 重试）
      return false
    }
    // 成功：仅移除 snapshot 中的条目（S2：await 窗口内新入队的消息保留，不被误删）
    const snapshotIds = new Set(snapshot.map((m) => m.id))
    state.updateFor(sid, (p) => {
      p.messages = p.messages.filter((m) => !snapshotIds.has(m.id))
    })
    return true
  }

  return { enqueue, remove, count, peek, hasPending, flush, _clearAllForTest: state._clearAllForTest }
}
