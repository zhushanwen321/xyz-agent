/**
 * Extension UI 交互 composable——管理 extension.ui_request 请求队列。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.ui_request
 * → 此 composable 维护请求队列 → ExtensionUIDialog 渲染对话框
 * → 用户操作 → sendExtensionUIResponse 回传 → pi Promise resolve。
 *
 * 请求按到达顺序排队（pi runtime 侧串行，extension-timeout-manager 5 分钟超时兜底）。
 *
 * 按 focusedSessionId 订阅：ExtensionUIDialog 是全局单例，监听当前活跃 session 的 ui_request。
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import { onUIRequest, onUITimeout, sendExtensionUIResponse, type ExtensionUIRequest } from '@/api/domains/extension'

/** 活跃 UI 请求队列（FIFO，pi 串行请求，实际同时只有 1 个） */
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
    // 同时已向 pi 发默认响应（confirm→false，其余→null）。前端必须出队当前请求，
    // 否则对话框残留，用户点击会发送过期的 ui_response。
    unsubFns.push(
      onUITimeout(sid, (_requestId) => {
        queue.value.shift()
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
    sendExtensionUIResponse(current.sessionId, current.requestId, result)
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
