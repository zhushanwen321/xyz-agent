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
 * per-sessionId 分区：每个 Panel 各调 useExtensionUI(Ref(sessionId))，各自维护自己 session
 * 的请求队列与 WS 订阅生命周期。split 模式下两个 Panel 可同时各有一个 ask-user。
 *
 * 防重复入队（B1 修复）：ExtensionUIDialog（全局，跟 focusedSessionId）和 Panel（per-panel）
 * 可能在 split 模式下订阅同一 sessionId。filter 参数让两个消费者从源头分流——
 * ExtensionUIDialog 只入非 askUser 请求，Panel 只入 askUser 请求——避免同一请求入两份队列。
 */
import { ref, computed, watch, onUnmounted, type Ref } from 'vue'
import { onUIRequest, onUITimeout, onNotify, sendExtensionUIResponse, type ExtensionUIRequest } from '@/api/domains/extension'
import { useToast } from '@/composables/useToast'

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
  // 本 session 专属队列（per-sessionId 分区，不再模块级单例）
  const queue = ref<ExtensionUIRequest[]>([])

  let unsubFns: Array<() => void> = []

  function subscribe(sid: string | null): void {
    // 切换 session 先退订旧订阅
    if (unsubFns.length > 0) {
      unsubFns.forEach(fn => fn())
      unsubFns = []
    }
    if (!sid) return
    // UI 请求入队（经 filter 过滤，避免双消费者重复入队）
    unsubFns.push(
      onUIRequest(sid, (req) => {
        if (filter && !filter(req)) return
        queue.value.push({ ...req, receivedAt: Date.now() })
      }),
    )
    // 超时出队：runtime ExtensionTimeoutManager 5 分钟无响应后广播 extension.ui_timeout，
    // 同时已向 pi 发默认响应（confirm→false，其余→null）。前端必须出队超时的请求，
    // 否则对话框残留，用户点击会发送过期的 ui_response。
    // 按 requestId 精确移除：pi 无串行保证，队列可能同时有多个 pending，超时的不一定在队首。
    unsubFns.push(
      onUITimeout(sid, (requestId) => {
        const idx = queue.value.findIndex(r => r.requestId === requestId)
        if (idx !== -1) queue.value.splice(idx, 1)
      }),
    )
  }

  subscribe(sessionId.value)
  watch(sessionId, (sid) => subscribe(sid))

  onUnmounted(() => {
    unsubFns.forEach(fn => fn())
    unsubFns = []
  })

  // ── 分流渲染：ask-user 走 Panel inline，其余走 ExtensionUIDialog modal ──
  /** 队列中第一个 ask-user 富交互请求（Panel inline 渲染用） */
  const currentAskUserRequest = computed(() =>
    queue.value.find(r => r.askUser === true),
  )
  /** 队列中第一个非 ask-user 的简单原语请求（ExtensionUIDialog modal 渲染用） */
  const currentDialogRequest = computed(() =>
    queue.value.find(r => r.askUser !== true),
  )

  /** 用户回复指定请求（按 requestId 精确定位，不假设队首） */
  function respond(requestId: string, result: boolean | string | null): void {
    const target = queue.value.find(r => r.requestId === requestId)
    if (!target) return
    sendExtensionUIResponse(target.sessionId, target.requestId, target.method, result)
    const idx = queue.value.findIndex(r => r.requestId === requestId)
    if (idx !== -1) queue.value.splice(idx, 1)
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

  onUnmounted(() => {
    if (unsubFn) unsubFn()
  })
}
