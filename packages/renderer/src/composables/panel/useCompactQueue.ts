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
import { chat as chatApi } from '@/api'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 待发消息条目（D1 继承自 slice） */
export interface QueuedMessage {
  id: string
  text: string
}

/** per-session 分区：待发消息数组（init 返回 reactive 容器，ADR-0036 响应式契约） */
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
   * 全部成功 → 清空分区 + 返回 true；任一条失败 → 队列整体保留（不清空）+ 返回 false
   * （E2 restoreQueue 语义：已发送的条目不计入清除，下次 flush 重新发送整队保证顺序与完整性）。
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

  async function flush(sid: string): Promise<boolean> {
    const snapshot = peek(sid)
    if (snapshot.length === 0) return true
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
    }
    // 全部成功才清空分区
    state.updateFor(sid, (p) => {
      p.messages = []
    })
    return true
  }

  return { enqueue, remove, count, peek, hasPending, flush, _clearAllForTest: state._clearAllForTest }
}
