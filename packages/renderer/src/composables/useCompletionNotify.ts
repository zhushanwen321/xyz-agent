/**
 * useCompletionNotify —— 后台 session 完成时提示音 + 未读标记。
 *
 * 挂钩 useConnection.ts routeInbound 的 message.complete 事件。
 * 为什么挂 routeInbound 而非 chat-message-effects：
 *   前端对 session 消息流的订阅是惰性的（ensureStreamSubscription 在首次 send 时建立）。
 *   挂在 chat-message-effects 会漏掉后台从未交互过的 session——
 *   恰恰是提示音最有价值的场景。routeInbound 是全局兜底层，已有 session.exited 先例。
 *
 * 触发条件：
 *   仅「后台完成」响（sid !== focusedSessionId || document.visibilityState !== 'visible'）
 *   stopReason: stop（成功）和 error（失败）都响，aborted 不响
 *   1s 防抖（多 session 同时完成只响一次）
 *   读取 settingsStore.system.completionSound 开关
 */
import { playSuccess, playError } from '@/composables/useCompletionSound'
import { markUnread } from '@/composables/useSessionMarkers'
import { useSettingsStore } from '@/stores/settings'

/** 上次播放提示音的时间戳（模块级，防抖用） */
let lastPlayTime = 0
const DEBOUNCE_MS = 1000

/**
 * 处理 session 完成事件。
 * 由 useConnection.ts routeInbound 在 message.complete 时调用。
 *
 * @param sessionId 完成的 session id
 * @param stopReason 停止原因：'stop'|'error'|'aborted'
 * @param focusedSessionId 当前焦点 session id
 */
export function handleCompletion(
  sessionId: string,
  stopReason: string,
  focusedSessionId: string | null,
): void {
  // 1. 过滤 stopReason：aborted 不触发
  if (stopReason === 'aborted') return

  // 2. 判定后台完成：sid !== focusedSessionId 或页面不可见
  const isBackground = sessionId !== focusedSessionId || document.visibilityState !== 'visible'
  if (!isBackground) return

  // 3. 标记未读（无论是否播放提示音，都标记）
  markUnread(sessionId)

  // 4. 读取设置开关
  const settingsStore = useSettingsStore()
  if (settingsStore.system.completionSound === false) return

  // 5. 1s 防抖
  const now = Date.now()
  if (now - lastPlayTime < DEBOUNCE_MS) return
  lastPlayTime = now

  // 6. 播放提示音（读用户设置的 successSound/errorSound，空则用平台默认）
  const successName = settingsStore.system.successSound
  const errorName = settingsStore.system.errorSound
  if (stopReason === 'error') {
    void playError(errorName)
  } else {
    void playSuccess(successName)
  }
}

/**
 * useCompletionNotify composable（函数式封装）。
 * @param focusedSessionId 当前焦点 session id（Ref 或 getter）
 */
export function useCompletionNotify(focusedSessionId: () => string | null) {
  return {
    handleCompletion: (sessionId: string, stopReason: string) =>
      handleCompletion(sessionId, stopReason, focusedSessionId()),
  }
}

/**
 * 测试专用：重置防抖状态。
 */
export function __resetDebounceForTest(): void {
  lastPlayTime = 0
}
