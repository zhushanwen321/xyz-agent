/**
 * NavigateInterceptor — decorates a WsSender to intercept navigate-result
 * messages from pi extension's sendMessage() output.
 *
 * The pi extension sends navigate results as custom messages via
 * `pi.sendMessage({ customType: "xyz-navigate-result", content: "..." })`.
 * Pi emits message_start with the custom message data, EventAdapter forwards
 * it as `message.message_start` with `customType`, and this interceptor
 * detects it and resolves the caller's Promise instead of forwarding to the UI.
 *
 * EventAdapter stays pure (event translation only).
 * NavigateInterceptor handles the navigate-specific stream interception.
 */

import type { ServerMessage } from '@xyz-agent/shared'
import type { INavigateInterceptor, INavigateInterceptorFactory } from '../../services/ports/tree.js'

export type WsSender = (msg: ServerMessage) => void

const NAVIGATE_CUSTOM_TYPE = 'xyz-navigate-result'

export class NavigateInterceptor implements INavigateInterceptor {
  private resolveFn: ((data: unknown) => void) | null = null
  private pending = false

  constructor(private readonly downstream: WsSender) {}

  /** Set the resolver for the next navigate operation. */
  setResolver(fn: (data: unknown) => void): void {
    this.resolveFn = fn
    this.pending = false
  }

  /** Clear the resolver without resolving (used by timeout). */
  clearResolver(): void {
    this.resolveFn = null
    this.pending = false
  }

  /**
   * Called when the pi message turn ends (message_end).
   * If a navigate resolver is pending, resolve as cancelled.
   */
  onMessageEnd(): void {
    if (this.resolveFn) {
      const resolver = this.resolveFn
      this.resolveFn = null
      this.pending = false
      resolver({ cancelled: true })
    }
  }

  /** The decorated sender — pass this to EventAdapter instead of the raw WsSender. */
  readonly send: WsSender = (msg: ServerMessage) => {
    // Detect navigate result from custom message
    if (this.resolveFn && msg.type === 'message.message_start') {
      const payload = msg.payload as Record<string, unknown>
      if (payload.customType === NAVIGATE_CUSTOM_TYPE) {
        this.pending = true
        try {
          const content = payload.content as string
          const parsed = JSON.parse(content) as Record<string, unknown>
          const resolver = this.resolveFn
          this.resolveFn = null
          this.pending = false
          resolver(parsed)
          return // intercepted — don't forward to UI
        } catch {
          // JSON parse error — rare, forward to UI and let timeout handle it
          this.pending = false
        }
      }
    }

    this.downstream(msg)
  }
}

/**
 * INavigateInterceptorFactory 实现 —— service 经此创建拦截器，不直接 new NavigateInterceptor。
 */
export class NavigateInterceptorFactory implements INavigateInterceptorFactory {
  createNavigateInterceptor(downstream: WsSender): INavigateInterceptor {
    return new NavigateInterceptor(downstream)
  }
}
