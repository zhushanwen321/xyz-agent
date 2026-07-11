/**
 * Extension UI 交互 composable——管理 extension.ui_request 请求队列。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.ui_request
 * → 此 composable 维护请求队列 → ExtensionUIDialog 渲染对话框
 * → 用户操作 → sendExtensionUIResponse 回传（带 method）→ pi Promise resolve。
 *
 * 请求按到达顺序排队。pi 不保证串行（同一 extension 可同时多个 pending dialog），
 * 但 99% 场景下 extension 代码用 await 顺序写，实际同时只有 1 个。
 * 超时和取消按 requestId 精确移除（不假设队首）。
 *
 * 按 focusedSessionId 订阅：ExtensionUIDialog 是全局单例，监听当前活跃 session 的 ui_request。
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import { onUIRequest, onUITimeout, onNotify, sendExtensionUIResponse, type ExtensionUIRequest } from '@/api/domains/extension'
import { useToast } from '@/composables/useToast'

/** 活跃 UI 请求队列（FIFO，队首优先渲染为对话框） */
const queue = ref<ExtensionUIRequest[]>([])

export function useExtensionUI(focusedSessionId: Ref<string | null>) {
  let unsubFns: Array<() => void> = []

  function subscribe(sid: string | null) {
    unsubFns.forEach((fn) => fn())
    unsubFns = []
    if (!sid) return
    // UI 请求入队
    unsubFns.push(
      onUIRequest(sid, (req) => {
        queue.value.push(req)
      }),
    )
    // 超时出队：runtime ExtensionTimeoutManager 5 分钟无响应后广播 extension.ui_timeout，
    // 同时已向 pi 发默认响应（confirm→false，其余→null）。前端必须出队超时的请求，
    // 否则对话框残留，用户点击会发送过期的 ui_response。
    // 按 requestId 精确移除：pi 无串行保证，队列可能同时有多个 pending，超时的不一定在队首。
    unsubFns.push(
      onUITimeout(sid, (requestId) => {
        const idx = queue.value.findIndex((r) => r.requestId === requestId)
        if (idx !== -1) queue.value.splice(idx, 1)
      }),
    )
  }

  watch(focusedSessionId, (sid) => subscribe(sid), { immediate: true })

  onUnmounted(() => {
    unsubFns.forEach((fn) => fn())
  })

  /** 用户回复当前请求（队首） */
  function respond(result: boolean | string | null): void {
    const current = queue.value[0]
    if (!current) return
    sendExtensionUIResponse(current.sessionId, current.requestId, current.method, result)
    queue.value.shift()
  }

  /** 用户取消 */
  function cancel(): void {
    respond(null)
  }

  return {
    currentRequest: queue,
    respond,
    cancel,
  }
}

/**
 * Extension notify composable——订阅 fire-and-forget 的 extension.notify 推送，渲染为 toast。
 *
 * pi notify 是 fire-and-forget（pi rpc-mode.ts notify 发后不等回复），不走 ExtensionUIDialog。
 * 按 focusedSessionId 订阅，level 映射到 toast 类型：
 * - error → error toast
 * - warning/warn → warning toast
 * - info → info toast
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
