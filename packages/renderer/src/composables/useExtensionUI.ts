/**
 * Extension UI 交互 composable——管理 extension.ui_request 请求队列。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.ui_request
 * → 此 composable 维护 per-sessionId 请求队列 → 渲染层（Panel inline ask-user / ExtensionUIDialog modal）
 * → 用户操作 → sendExtensionUIResponse 回传（带 method）→ pi Promise resolve。
 *
 * 请求按到达顺序排队。pi 不保证串行（同一 extension 可同时多个 pending dialog），
 * 但 99% 场景下 extension 代码用 await 顺序写，实际同时只有 1 个。
 * 超时和取消按 requestId 精确移除（不假设队首）。
 *
 * per-sessionId 分区（ADR-0036）：queue 经 useSessionScopedState 分区到
 * Map<sessionId, ExtensionUIRequest[]>，每个 Panel 实例维护自己 session 的请求队列。
 * 切 sid 时 Map 分区天然隔离——无需手动清 queue，切回自动恢复 pending（AC-1/AC-2）。
 * split 模式下两个 Panel 可同时各有一个 ask-user。
 *
 * 防重复入队（B1 修复）：ExtensionUIDialog（全局，跟 focusedSessionId）和 Panel（per-panel）
 * 可能在 split 模式下订阅同一 sessionId。filter 参数让两个消费者从源头分流——
 * ExtensionUIDialog 只入非 askUser 请求，Panel 只入 askUser 请求——避免同一请求入两份队列。
 */
import { computed, watch, onScopeDispose, reactive, type Ref } from 'vue'
import { onUIRequest, onUITimeout, onNotify, sendExtensionUIResponse, getPendingRequests, type ExtensionUIRequest } from '@/api/domains/extension'
import { useToast } from '@/composables/useToast'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 入队过滤谓词：返回 true 的请求才入队 */
export type UIRequestFilter = (req: ExtensionUIRequest) => boolean

/** ask-user 富交互请求过滤器（Panel 用） */
export const askUserFilter: UIRequestFilter = (req) => req.askUser === true
/** 非 ask-user 的简单原语请求过滤器（ExtensionUIDialog 用） */
export const dialogFilter: UIRequestFilter = (req) => req.askUser !== true

export function useExtensionUI(
  sessionId: Ref<string | null>,
  filter?: UIRequestFilter,
) {
  // per-sessionId 分区队列（ADR-0036 Map 分区派）。
  // init 返回 reactive 数组：下游 computed (.find) 在其上建立依赖，update 内 mutate 时失效重算。
  const queueState = useSessionScopedState<ExtensionUIRequest[]>(
    sessionId,
    () => reactive<ExtensionUIRequest[]>([]),
  )

  let unsubFns: Array<() => void> = []

  /**
   * 请求版本号（W3-1 并发守卫，与 useDetailPane.ts 的 loadToken 模式对齐）。
   * subscribe 进入时自增 token；getPendingRequests 的 then 回调内校验 token，
   * 不匹配说明已切走，丢弃旧 session 的 stale 响应——避免 subscribe(A) 慢响应
   * 在 subscribe(B) 之后 push 到共享 queue，导致 B 的 UI 误显 A 的 extension 对话框。
   * 作用域在 composable 闭包内，跨多次 subscribe 调用共享。
   */
  let pendingReqToken = 0

  function subscribe(sid: string | null): void {
    // 切换 session 先退订旧订阅
    if (unsubFns.length > 0) {
      unsubFns.forEach(fn => fn())
      unsubFns = []
    }
    if (!sid) return
    // UI 请求入队（经 filter 过滤，避免双消费者重复入队）
    // M1 竞态修复：handler 闭包捕获 subscribe 时的 sid（参数），调 updateFor(sid, ...)
    // 写入订阅时 sid 的分区。即使 session 切换后退订是异步的（watch flush:pre），
    // 旧 sid 的迟到消息也只写旧 sid 分区，不污染新 sid 分区。
    unsubFns.push(
      onUIRequest(sid, (req) => {
        if (filter && !filter(req)) return
        queueState.updateFor(sid, (queue) => {
          queue.push({ ...req, receivedAt: Date.now() })
        })
      }),
    )
    // 超时出队：runtime ExtensionTimeoutManager 5 分钟无响应后广播 extension.ui_timeout，
    // 同时已向 pi 发默认响应（confirm→false，其余→null）。前端必须出队超时的请求，
    // 否则对话框残留，用户点击会发送过期的 ui_response。
    // 按 requestId 精确移除：pi 无串行保证，队列可能同时有多个 pending，超时的不一定在队首。
    // M1 竞态修复：同上，updateFor(sid, ...) 用订阅时 sid。
    unsubFns.push(
      onUITimeout(sid, (requestId) => {
        queueState.updateFor(sid, (queue) => {
          const idx = queue.findIndex(r => r.requestId === requestId)
          if (idx !== -1) queue.splice(idx, 1)
        })
      }),
    )
    // 拉取 runtime 缓存的 pending 请求（切换 session 后重新订阅时，runtime 会推送缓存的请求）
    // 异步执行，不阻塞订阅建立
    const token = ++pendingReqToken
    getPendingRequests(sid)
      .then((pendingRequests) => {
        // W3-1：版本不匹配说明已切走，丢弃旧 session 的 stale 响应，避免误推到新 session 的 queue。
        // M1 竞态修复：updateFor(sid, ...) 用订阅时 sid——与 pendingReqToken 守卫双重保险，
        // 即使 token 不匹配（已切走），写入的也是旧 sid 分区，不污染新 sid。
        if (token !== pendingReqToken) return
        queueState.updateFor(sid, (queue) => {
          for (const req of pendingRequests) {
            if (filter && !filter(req)) continue
            queue.push({ ...req, receivedAt: req.receivedAt ?? Date.now() })
          }
        })
      })
      .catch((err) => {
        console.warn('[useExtensionUI] Failed to get pending requests:', err)
      })
  }

  subscribe(sessionId.value)
  watch(sessionId, (sid) => subscribe(sid))

  onScopeDispose(() => {
    unsubFns.forEach(fn => fn())
    unsubFns = []
  })

  // ── 分流渲染：ask-user 走 Panel inline，其余走 ExtensionUIDialog modal ──
  /** 队列中第一个 ask-user 富交互请求（Panel inline 渲染用） */
  const currentAskUserRequest = computed(() =>
    queueState.current.value.find(r => r.askUser === true),
  )
  /** 队列中第一个非 ask-user 的简单原语请求（ExtensionUIDialog modal 渲染用） */
  const currentDialogRequest = computed(() =>
    queueState.current.value.find(r => r.askUser !== true),
  )

  /** 用户回复指定请求（按 requestId 精确定位，不假设队首） */
  function respond(requestId: string, result: boolean | string | null): void {
    const target = queueState.current.value.find(r => r.requestId === requestId)
    if (!target) return
    sendExtensionUIResponse(target.sessionId, target.requestId, target.method, result)
    queueState.update((queue) => {
      const idx = queue.findIndex(r => r.requestId === requestId)
      if (idx !== -1) queue.splice(idx, 1)
    })
  }

  /** 用户取消（等价 respond(requestId, null)） */
  function cancel(requestId: string): void {
    respond(requestId, null)
  }

  return {
    currentAskUserRequest,
    currentDialogRequest,
    respond,
    cancel,
  }
}

/**
 * Extension notify composable——订阅 fire-and-forget 的 extension.notify 推送，渲染为 toast。
 *
 * pi notify 是 fire-and-forget（pi rpc-mode.ts notify 发后不等回复），不走 ExtensionUIDialog。
 * 按 sessionId 订阅，level 映射到 toast 类型：
 * - error → error toast
 * - warning/warn → warning toast
 * - info → info toast
 *
 * 全局单例（Workspace 层单次调用，跟 focusedSessionId）。notify 是非阻塞 toast，
 * 不需要 per-panel 隔离（toast 本就是全局浮层）。
 */
export function useExtensionNotify(focusedSessionId: Ref<string | null>) {
  const { error, info, warning } = useToast()
  let unsubFn: (() => void) | null = null

  function subscribe(sid: string | null) {
    if (unsubFn) {
      unsubFn()
      unsubFn = null
    }
    if (!sid) return
    unsubFn = onNotify(sid, ({ message, level }) => {
      if (level === 'error') error(message)
      else if (level === 'warn') warning(message)
      else info(message)
    })
  }

  watch(focusedSessionId, (sid) => subscribe(sid), { immediate: true })

  onScopeDispose(() => {
    if (unsubFn) unsubFn()
  })
}
