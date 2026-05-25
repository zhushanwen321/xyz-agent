/**
 * NavigateInterceptor — decorates a WsSender to intercept navigate-result
 * messages from pi extension's sendMessage() output.
 *
 * The pi extension sends navigate results as JSON embedded in text_delta events.
 * This interceptor detects the __xyz_type marker, buffers across chunks,
 * and resolves the caller's Promise instead of forwarding to the UI.
 *
 * EventAdapter stays pure (event translation only).
 * NavigateInterceptor handles the navigate-specific stream interception.
 */

import type { ServerMessage } from '@xyz-agent/shared'

export type WsSender = (msg: ServerMessage) => void

export class NavigateInterceptor {
  private resolveFn: ((data: unknown) => void) | null = null
  private buffer = ''
  private streaming = false
  private cancelled = false

  constructor(private readonly downstream: WsSender) {}

  /** Set the resolver for the next navigate operation. */
  setResolver(fn: (data: unknown) => void): void {
    this.resolveFn = fn
    this.buffer = ''
    this.streaming = false
  }

  /** Clear the resolver without resolving (used by timeout). */
  clearResolver(): void {
    this.resolveFn = null
    this.buffer = ''
    this.streaming = false
    this.cancelled = true
  }

  /**
   * Called when the pi message turn ends (message_end).
   * If a navigate stream was in progress but not completed, resolve as cancelled.
   */
  onMessageEnd(): void {
    if (this.resolveFn && this.streaming) {
      const resolver = this.resolveFn
      this.resolveFn = null
      this.buffer = ''
      this.streaming = false
      resolver({ cancelled: true })
    }
    // 流结束后重置 cancelled 标志，后续消息正常转发
    this.cancelled = false
  }

  /** The decorated sender — pass this to EventAdapter instead of the raw WsSender. */
  readonly send: WsSender = (msg: ServerMessage) => {
    // 超时/取消后吞掉后续 delta，避免 JSON 碎片泄露给 UI
    if (this.cancelled && msg.type === 'message.text_delta') {
      return
    }

    if (this.resolveFn && msg.type === 'message.text_delta') {
      const delta = (msg.payload as { delta?: string }).delta ?? ''

      if (!this.streaming && /"__xyz_type"\s*:\s*"navigate-result"/.test(delta)) {
        this.streaming = true
        this.buffer = delta
      } else if (this.streaming) {
        this.buffer += delta
      }

      if (this.streaming) {
        try {
          const parsed = JSON.parse(this.buffer) as Record<string, unknown>
          const resolver = this.resolveFn
          this.resolveFn = null
          this.buffer = ''
          this.streaming = false
          resolver(parsed)
          return // intercepted — don't forward to UI
        } catch {
          // JSON incomplete, wait for more deltas
          return
        }
      }
    }

    this.downstream(msg)
  }
}
