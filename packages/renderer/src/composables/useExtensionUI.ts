/**
 * Extension UI 交互 composable——订阅编排 + filter 分流读取。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.ui_request
 * → 此 composable 订阅 WS 事件、写入 extensionUIStore（session 级 pending SSOT）→
 * 渲染层（Panel inline ask-user / ExtensionUIDialog modal）从 store 分区派生 →
 * 用户操作 → sendExtensionUIResponse 回传（带 method）→ pi Promise resolve。
 *
 * 状态归属（CW wave `session-active-ssot` T2）：pending 队列已提升到 extensionUIStore
 *（session 级 SSOT），让 deriveStatus 经 hasPendingAskUser 能查到 ask-user 等待状态。
 * 本 composable 只负责：①订阅编排（per-panel 实例各自订阅自己的 sid）；②filter 分流读取
 *（store 存全量 pending，currentAskUserRequest/currentDialogRequest 在 computed 里按 filter 取）。
 *
 * 订阅模型不变（split 双 panel 各自订阅仍工作）：每个 composable 实例独立 subscribe 自己的 sid，
 * 仅读写目标从局部 useSessionScopedState 换为 store（addRequest/removeRequest）。
 * requestId dedup 由 store.addRequest 单一入口处理（收敛，composable 不再手写）。
 *
 * filter 仅用于读取分流（不入库时过滤）——store 存全量，两个 composable 实例（Panel 入 askUser 读取、
 * ExtensionUIDialog 入 dialog 读取）各按 filter 读同一份 store 分区，天然分流（AC-6 保持）。
 */
import { computed, watch, onScopeDispose, type Ref } from 'vue'
import { onUIRequest, onUITimeout, onNotify, sendExtensionUIResponse, getPendingRequests, type ExtensionUIRequest } from '@/api/domains/extension'
import { useToast } from '@/composables/useToast'
import { useExtensionUIStore } from '@/stores/extension-ui'

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
  // pending 队列 SSOT 在 store（T2 迁移）：本 composable 只订阅事件写入 store、按 filter 读 store。
  // store.addRequest 含 requestId dedup（T1），无需手写去重。
  const store = useExtensionUIStore()

  let unsubFns: Array<() => void> = []

  function subscribe(sid: string | null): void {
    // 切换 session 先退订旧订阅
    if (unsubFns.length > 0) {
      unsubFns.forEach(fn => fn())
      unsubFns = []
    }
    if (!sid) return
    // UI 请求入队（全量写入 store，不在入库时 filter——store 是完整 pending SSOT，
    // hasPendingAskUser/hasPendingDialog 才能正确查询；filter 只在下方 computed 读取分流）。
    // M1 竞态修复：handler 闭包捕获 subscribe 时的 sid（参数），调 store.addRequest(sid, ...)
    // 写入订阅时 sid 的分区。即使 session 切换后退订是异步的（watch flush:pre），
    // 旧 sid 的迟到消息也只写旧 sid 分区，不污染新 sid 分区。
    unsubFns.push(
      onUIRequest(sid, (req) => {
        store.addRequest(sid, { ...req, receivedAt: Date.now() })
      }),
    )
    // 超时出队：runtime ExtensionTimeoutManager 5 分钟无响应后广播 extension.ui_timeout，
    // 同时已向 pi 发默认响应（confirm→false，其余→null）。前端必须出队超时的请求，
    // 否则对话框残留，用户点击会发送过期的 ui_response。
    // 按 requestId 精确移除：pi 无串行保证，队列可能同时有多个 pending，超时的不一定在队首。
    // M1 竞态修复：同上，store.removeRequest(sid, ...) 用订阅时 sid。
    unsubFns.push(
      onUITimeout(sid, (requestId) => {
        store.removeRequest(sid, requestId)
      }),
    )
    // 拉取 runtime 缓存的 pending 请求（切换 session 后重新订阅时，runtime 会推送缓存的请求）
    // 异步执行，不阻塞订阅建立
    getPendingRequests(sid)
      .then((pendingRequests) => {
        // 全量写入 store（不入库时 filter）。M1 竞态修复：addRequest(sid, ...) 用订阅时捕获的
        // sid（参数）——只写旧 sid 分区，不读 sessionId.value。即使此响应在 session 切换后到达，
        // 也只写入旧 sid 的 Map 分区，不会污染新 sid。Map 分区已结构性隔离 stale 响应。
        for (const req of pendingRequests) {
          store.addRequest(sid, { ...req, receivedAt: req.receivedAt ?? Date.now() })
        }
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
  // 从 store 分区派生：store 存全量 pending，computed 内按 askUser 取 + filter 过滤。
  // 读 sessionId.value 建立响应式依赖，sid 变化时重算读新分区。
  /** 队列中第一个 ask-user 富交互请求（Panel inline 渲染用）；无则 undefined */
  const currentAskUserRequest = computed(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    const records = store.recordsOf(sid).value
    return (filter ? records.filter(filter) : records).find(r => r.askUser === true)
  })
  /** 队列中第一个非 ask-user 的简单原语请求（ExtensionUIDialog modal 渲染用）；无则 undefined */
  const currentDialogRequest = computed(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    const records = store.recordsOf(sid).value
    return (filter ? records.filter(filter) : records).find(r => r.askUser !== true)
  })

  /** 用户回复指定请求（按 requestId 精确定位，不假设队首） */
  function respond(requestId: string, result: boolean | string | null): void {
    const sid = sessionId.value
    if (!sid) return
    const target = store.getRequestsBySession(sid).find(r => r.requestId === requestId)
    if (!target) return
    sendExtensionUIResponse(target.sessionId, target.requestId, target.method, result)
    // store.removeRequest 按 requestId 精确移除（不区分 askUser/dialog），requestId 全局唯一，
    // 故即使本实例 filter 不同也能正确移除。
    store.removeRequest(sid, requestId)
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
