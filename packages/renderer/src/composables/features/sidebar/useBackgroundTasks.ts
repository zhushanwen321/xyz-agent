/**
 * useBackgroundTasks —— 后台命令列表的 per-session 状态根
 *（docs/design/background-task-sidebar-view.md §3.3 D8①，u-renderer-store）。
 *
 * 职责：registry 全量投影的 per-session Map 分区（useSessionScopedState，ADR-0049）+
 * 变更通道编排。两个数据来源：
 * - 拉取腿（C6 唯一真相入口）：watch sid 变化 / 调 refresh() 时 `backgroundTask.list`
 *   RPC（切换/激活 session、打开 plugin tab 由消费层触发）；模块级 in-flight 去重
 *   （同 sid 并发拉取复用同一 Promise，参照 useContextUsage）；
 * - 广播腿（增量刷新）：`backgroundTask:updated` session 级广播——订阅收敛为**模块级
 *   refCount**（AGENTS 规则 2：同 sid 多实例只开一条底层 events.on 物理订阅；消费组件
 *   ——列表视图 + split mode 下 per-pane 多实例的 DetailPanel——只读写分区状态，不各自挂
 *   listener）。物理 handler 闭包捕获注册时 sid，分发经实例 listener →
 *   `updateFor(capturedSid)` 写「消息所属 sid」分区，结构性消除切 session 竞态（M1）。
 *
 * 分区形态：{ tasks: 全量投影, loaded: 是否成功拉到过一次 }。loaded 区分「从未拉取」与
 * 「拉到空表」（S6 全量空态判定需要）。拉取失败保留分区缓存不降级（下次切入/refresh 自愈）。
 *
 * 生命周期：session 销毁经 registerSessionCleanup 挂进 useSidebar.deleteSession 编排——
 * 清分区 + 抑制在途写入（迟到的 RPC resolve / 广播不得把已销毁 session 的分区僵尸式写回：
 * updateFor 会重建分区，形成泄漏条目）。
 *
 * 切走 session 后旧 sid 订阅释放（refCount--），其分区停更、切回时由拉取腿兜底刷新
 *（C6：广播只做增量刷新，拉取是唯一真相入口）。
 */
import { computed, onScopeDispose, reactive, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import * as events from '@/api/events'
import { registerSessionCleanup, useSessionScopedState } from '@/composables/useSessionScopedState'
import * as backgroundTaskApi from '@/api/domains/background-task'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'

/** 广播消息 type（shared protocol.ts SSOT；Server→Client 冒号 camelCase）。 */
const UPDATED_TYPE = 'backgroundTask:updated'

/** per-session 分区形态。 */
export interface BackgroundTasksPartition {
  /** registry 全量投影（list reply / 广播 payload 原样，不做二次加工）。 */
  tasks: BackgroundTaskEntry[]
  /** 是否成功拉到过一次 list reply（空表也算）——区分「从未拉取」与「拉到空表」。 */
  loaded: boolean
}

function createPartition(): BackgroundTasksPartition {
  return reactive({ tasks: [] as BackgroundTaskEntry[], loaded: false })
}

// ── 模块级 refCount 广播订阅（AGENTS 规则 2：同 sid 多实例共享单条物理订阅）──

type BroadcastListener = (sid: string, tasks: BackgroundTaskEntry[]) => void

/** 各实例注册的分区写入 listener（物理 handler 分发时遍历；各实例写各自的分区 Map，幂等）。 */
// @data-owner #24
const broadcastListeners = new Set<BroadcastListener>()

/** per-sid 物理订阅表：sid → { count: 实例引用数, unsub: 退订函数 }。 */
// @data-owner #24
const sidSubscriptions = new Map<string, { count: number; unsub: () => void }>()

function acquireBroadcastSubscription(sid: string): void {
  const existing = sidSubscriptions.get(sid)
  if (existing) {
    existing.count += 1
    return
  }
  // 物理 handler 闭包捕获注册时 sid（capturedSid）：watch flush:pre 异步退订窗口内该 sid
  // 的迟到广播仍带旧 sid 进来，实例 listener 拿 capturedSid 调 updateFor 写旧 sid 分区，
  // 不污染新 sid 分区（M1 竞态结构性消除，ADR-0049）。
  const unsub = events.on(sid, (msg) => {
    if (msg.type !== UPDATED_TYPE) return
    // session 通道 handler 无泛型收窄（events.ts 宽 MessageHandler）；payload 形状由
    // shared protocol.ts ServerMessageMap 契约化，运行时仅守卫 tasks 数组（坏形状跳过本拍，
    // 下拍广播/拉取自愈）。
    const payload = msg.payload as { tasks?: unknown }
    if (!Array.isArray(payload.tasks)) return
    for (const listener of broadcastListeners) {
      listener(sid, payload.tasks as BackgroundTaskEntry[])
    }
  })
  sidSubscriptions.set(sid, { count: 1, unsub })
}

function releaseBroadcastSubscription(sid: string): void {
  const existing = sidSubscriptions.get(sid)
  if (!existing) return
  existing.count -= 1
  if (existing.count <= 0) {
    existing.unsub()
    sidSubscriptions.delete(sid)
  }
}

// ── 模块级拉取 in-flight 去重（同 sid 并发 refresh/恢复腿复用同一 Promise）──

// @data-owner #24
const inflightFetches = new Map<string, Promise<void>>()

// ── 已销毁 session 抑制表（迟到写入不得僵尸式重建分区，参照 useContextUsage）──

// @data-owner #24
const suppressedSids = new Set<string>()

/** 测试隔离钩子：清空全部模块级簿记（用例间残留防污染）。生产代码禁止调用。 */
export function __resetBackgroundTasksForTest(): void {
  for (const { unsub } of sidSubscriptions.values()) unsub()
  sidSubscriptions.clear()
  broadcastListeners.clear()
  inflightFetches.clear()
  suppressedSids.clear()
}

export interface UseBackgroundTasksReturn {
  /** 当前 sid 的分区（computed 按 sidRef 惰性查分区；null sid 返回临时默认实例不写 Map）。 */
  current: ComputedRef<BackgroundTasksPartition>
  /**
   * 手动重拉（C6：打开 plugin tab / WS 重连等场景由消费层触发）。省略参数时拉当前 sid。
   * 同 sid 在途拉取复用同一 Promise（去重）；失败保留分区缓存不降级（resolve 不 reject，
   * 调用方无需 try-catch）。
   */
  refresh: (targetSid?: string) => Promise<void>
}

/**
 * 后台命令状态根。必须在组件 setup 同步调用（内部 watch/onScopeDispose 依赖实例上下文）。
 *
 * @param sessionIdRef 焦点 session id（string | null | undefined；undefined 归一为 null）
 */
export function useBackgroundTasks(sessionIdRef: Ref<string | null | undefined>): UseBackgroundTasksReturn {
  // null 归一：useSessionScopedState 契约要求 Ref<string|null>（null=无活跃 session）
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  const scoped = useSessionScopedState<BackgroundTasksPartition>(normalizedSid, createPartition)

  /** 实例分区写入 listener：写「消息所属 sid」（capturedSid）分区，非当前视图 sid 也合法
   *  （分区写入与视图无关；视图显示由 current 按 sidRef 派生）。 */
  const listener: BroadcastListener = (sid, tasks) => {
    if (suppressedSids.has(sid)) return
    scoped.updateFor(sid, (p) => {
      p.tasks = tasks
      p.loaded = true
    })
  }
  broadcastListeners.add(listener)

  /**
   * 发起/复用同 sid 的 list RPC；resolve 后写「发起时 sid」分区（闭包捕获，非实时 sid）。
   * 回滚窗口说明：RPC 往返期间若更新的广播先落地，较旧的 reply 会短暂覆盖（list reply
   * 是当下 registry 全量快照，后到写赢）；下一拍广播 / 下次切入重拉自愈，不做 recency 对账
   *（useContextUsage 的复杂度源于「无值占位帧」语义，本域 reply 恒为全量快照，无此问题）。
   */
  function fetchInto(sid: string): Promise<void> {
    const existing = inflightFetches.get(sid)
    if (existing) return existing
    const promise = backgroundTaskApi
      .list(sid)
      .then((tasks) => {
        if (suppressedSids.has(sid)) return
        scoped.updateFor(sid, (p) => {
          p.tasks = tasks
          p.loaded = true
        })
      })
      .catch((err: unknown) => {
        // RPC 失败：保留分区缓存不降级（分区缓存 = 失败兜底显示），下次切入/refresh 自愈。
        // debug 级：可重试瞬态 + transport/pending 层已记错误，避免断连期刷屏（§3.1 断连路径）。
        console.debug('[background-tasks] list failed, keep cached partition', sid, err)
      })
      .finally(() => {
        // settle 即清条目（下次切入重拉）；比对引用防误删后来者
        if (inflightFetches.get(sid) === promise) inflightFetches.delete(sid)
      })
    inflightFetches.set(sid, promise)
    return promise
  }

  async function refresh(targetSid?: string): Promise<void> {
    const sid = targetSid ?? normalizedSid.value
    if (!sid) return
    await fetchInto(sid)
  }

  // 订阅编排：sid 变化先释放旧订阅（refCount--）再获取新订阅（refCount++）。
  // watch 默认 flush:'pre'——切换后旧 sid 的迟到广播在退订前仍经 capturedSid 写旧分区。
  watch(normalizedSid, (sid, oldSid) => {
    if (oldSid) releaseBroadcastSubscription(oldSid)
    if (sid) acquireBroadcastSubscription(sid)
  }, { immediate: true })

  // 拉取腿（C6）：每次进入 sid 视图无条件重拉（immediate 覆盖首挂载；切走期间广播已退订，
  // 分区缓存可能过期，不能依赖缓存不拉——对齐 useContextUsage D3 恢复腿语义）。
  watch(normalizedSid, (sid) => {
    if (sid) {
      suppressedSids.delete(sid) // 重新进入 = 新生命周期，解除清理抑制
      void fetchInto(sid)
    }
  }, { immediate: true })

  // cleanup 编排：session 销毁（useSidebar.deleteSession → triggerSessionCleanups）时
  // 清分区 + 抑制迟到写入（在途 RPC resolve / 退订前的广播）。分区删除本身已由
  // useSessionScopedState 自动注册（幂等），这里补抑制表簿记。
  const unregisterCleanup = registerSessionCleanup((sid) => {
    scoped.cleanup(sid)
    suppressedSids.add(sid)
  })

  onScopeDispose(() => {
    unregisterCleanup()
    broadcastListeners.delete(listener)
    // 释放本实例持有的订阅引用（watch 维护的 acquire/release 在卸载后不再触发，此处按
    // 卸载时刻的 sid 补一次 release；旧 sid 已在切换时释放过）
    const sid = normalizedSid.value
    if (sid) releaseBroadcastSubscription(sid)
  })

  return { current: scoped.current, refresh }
}
