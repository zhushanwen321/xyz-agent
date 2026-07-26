/**
 * Per-session 超时 timer 管理（streaming + bash）。
 *
 * 从 chat.ts 提取以控制文件行数（max-lines 500 上限）。
 * 通过 initTimers() 闭包注入 finalizeSession 依赖，避免循环 import。
 */
import type { FinalizeReason } from './chat-store-types'

const BASH_TIMEOUT_MS = 300_000

/** 清除 per-session timer */
function clearSessionTimer(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string): void {
  const t = timers.get(sessionId)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(sessionId)
  }
}

/**
 * 初始化 timer 模块。在 chat.ts setup 阶段调用一次，返回 timer 操作函数。
 * 闭包捕获 finalizeSession 函数，不暴露到模块外部。
 */
export function initTimers(
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void,
  streamingTimeoutMs: number,
) {
  const streamingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const bashTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ── streaming timer ──

  /** message_start 挂载超时兜底（防 message.complete 永不到）。 */
  function armStreamingTimer(sessionId: string): void {
    clearSessionTimer(streamingTimers, sessionId)
    streamingTimers.set(sessionId, setTimeout(() => {
      finalizeSession(sessionId, 'timeout')
      streamingTimers.delete(sessionId)
    }, streamingTimeoutMs))
  }

  /** 取消 streaming 超时 timer */
  function clearStreamingTimer(sessionId: string): void {
    clearSessionTimer(streamingTimers, sessionId)
  }

  // ── bash timer ──

  /** bashStartEffect 挂载 bash 专用超时 timer */
  function armBashTimer(sessionId: string): void {
    clearSessionTimer(bashTimers, sessionId)
    bashTimers.set(sessionId, setTimeout(() => {
      finalizeSession(sessionId, 'timeout')
      bashTimers.delete(sessionId)
    }, BASH_TIMEOUT_MS))
  }

  /** 取消 bash 超时 timer */
  function clearBashTimer(sessionId: string): void {
    clearSessionTimer(bashTimers, sessionId)
  }

  /** HMR / dispose / 测试 teardown 时清理所有 timer */
  function disposeAllTimers(): void {
    for (const timers of [streamingTimers, bashTimers]) {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }

  return { armStreamingTimer, clearStreamingTimer, armBashTimer, clearBashTimer, disposeAllTimers }
}
