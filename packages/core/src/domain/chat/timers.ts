/**
 * Per-session 超时 timer 管理（streaming + bash）。
 *
 * 从 chat.ts 提取以控制文件行数（max-lines 500 上限）。
 * 通过 initTimers() 闭包注入 finalizeSession / finalizeBashOnly 依赖，避免循环 import。
 *
 * [W1 timer-decouple] bash timer 与 streaming timer 收口域解耦（C2 回归防护）：
 * - streaming timer 到期 → finalizeSession（收口整个 session 的 streaming 实体 + timer，正确语义）
 * - bash timer 到期 → finalizeBashOnly（只收口 streaming bash 消息，不跨域误杀正在
 *   streaming 的 assistant turn）。L1 放宽 bash↔streaming 并发后，共存期间 bash timer
 *   到期若调 finalizeSession 会把正在生成的 assistant turn 一并收口（C2 回归）。
 */
import type { FinalizeReason } from '@xyz-agent/core'

const BASH_TIMEOUT_MS = 300_000

/** 清除 per-session timer（export：store.ts 复用，消除本地双份副本——两版语义等价，clearTimeout(undefined) 是 no-op） */
export function clearSessionTimer(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string): void {
  const t = timers.get(sessionId)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(sessionId)
  }
}

/**
 * 初始化 timer 模块。在 chat.ts setup 阶段调用一次，返回 timer 操作函数。
 * 闭包捕获 finalizeSession / finalizeBashOnly 函数，不暴露到模块外部。
 */
export function initTimers(
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void,
  finalizeBashOnly: (sessionId: string) => void,
  streamingTimeoutMs: number,
) {
  /**
   * [ADR-0049 例外] 以下两个 Map 不套 useSessionScopedState。判据：initTimers() factory 由
   * createChatStore（renderer defineStore('chat') 包装，Pinia 按 id 缓存——见 renderer
   * stores/chat.ts）在 setup 内调用一次（store.ts），factory body 全应用只执行一次，两 Map
   * 实质单例。factory 体内非 Vue setup 上下文、无 sidRef: Ref<string|null>；Map 存的是 timer
   * handle（ReturnType<typeof setTimeout>，非 reactive 业务状态）。useSessionScopedState 是
   * setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory 体内不适用——强套需把 factory
   * 改造成 setup composable（破坏 Pinia store 单例语义：每次 useStore() 重新执行会重建 Map
   * 丢失单例）+ reactive 容器语义错位（timer handle 不是响应式状态）。与 lru/coordination/
   * panel-orchestration 同属 ADR-0049 例外（单例性来源不同：那几处是模块级 ES module 单例，
   * 本处是 Pinia defineStore factory 单例）。session 销毁清理：disposeAllTimers() 由
   * createChatStore onScopeDispose 编排调用（store.ts）；测试隔离：factory 模式 per-instance
   * （测试直接调 initTimers() 构造新实例）。
   */
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

  /**
   * bashStartEffect 挂载 bash 专用超时 timer。
   *
   * [W8 PR#116 review] bash timer 是 per-session（非 per-message）：armBashTimer 先
   * clearSessionTimer(bashTimers, sessionId) 再 set，每个 session 只保留一个 timer。
   * 这依赖 runtime 层 isBashRunning 互斥的硬保证——sendBash 预检会拒绝 isBashRunning===true
   * 的请求（runtime message-dispatcher / bash service 保证同时只有一个 streaming bash）。
   * 在此互斥约束下，store 层 per-session timer 是安全的：不会有第二个 streaming bash 与之共存。
   * 若将来 runtime 放开 bash 并发，此处需改为 per-message timer（以 bash 消息 id 为 key）。
   */
  function armBashTimer(sessionId: string): void {
    clearSessionTimer(bashTimers, sessionId)
    bashTimers.set(sessionId, setTimeout(() => {
      // [W1] 不调 finalizeSession：bash timer 到期只收口 bash 消息，不跨域误杀共存
      // 中的 assistant turn streaming（C2 回归防护）。
      finalizeBashOnly(sessionId)
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
