import type { ServerMessage } from '@xyz-agent/shared'
import type { PiEventListener } from './rpc-client.js'
// Canonical pi event union from types.ts.
// translate() accepts Record<string, unknown> because pi sends event types
// beyond the defined union (compaction_*, auto_retry_*, extension_* etc.).

export type WsSender = (msg: ServerMessage) => void

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  end_turn: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  toolUse: 'tool_use',
  tool_use: 'tool_use',
  error: 'error',
  aborted: 'aborted',
  cancelled: 'aborted',
  content_filter: 'content_filter',
}

/**
 * Translates pi subprocess RPC events into WS protocol ServerMessages.
 *
 * pi RPC events have this structure:
 * - `message_update` with nested `assistantMessageEvent` containing `type`, `delta`, `contentIndex`
 *   - sub-types: text_start, text_delta, text_end, thinking_start, thinking_delta, thinking_end
 * - `message_start` / `message_end` with `message` containing role, content, usage, stopReason
 * - `agent_start` / `turn_start` / `turn_end` / `agent_end` for lifecycle
 * - `extension_ui_request` for tool approvals etc.
 *
 * Each session gets its own adapter instance bound to a WsSender.
 */
export interface EventAdapterOptions {
  /** Called after successfully translating an extension_ui_request event. */
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string) => void
  /** Called for bridge: prefixed extension_ui_request events. Routes the request directly without frontend timeout. */
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
}

export class EventAdapter {
  private unsub: (() => void) | null = null

  constructor(
    private sessionId: string,
    private send: WsSender,
    private options?: EventAdapterOptions,
  ) {}

  /** Start listening to events from an RpcClient. */
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void {
    this.unsub = client.onEvent((event) => this.handleEvent(event as unknown as Record<string, unknown>))
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const msg = this.translate(event)
    if (msg) {
      this.send(msg)
    }
  }

  private translate(event: Record<string, unknown>): ServerMessage | null {
    const sid = this.sessionId

    switch (event.type as string) {
      // ── Streaming content ────────────────────────────────────────
      case 'message_update': {
        const sub = event.assistantMessageEvent as
          { type: string; delta?: string; content?: string; contentIndex?: number } | undefined
        if (!sub) return null

        switch (sub.type) {
          case 'text_delta': {
            const delta = sub.delta ?? ''

            return {
              type: 'message.text_delta',
              payload: { sessionId: sid, delta },
            }
          }

          case 'thinking_start':
            return {
              type: 'message.thinking_start',
              payload: { sessionId: sid },
            }

          case 'thinking_delta':
            return {
              type: 'message.thinking_delta',
              payload: { sessionId: sid, delta: sub.delta ?? '' },
            }

          case 'thinking_end':
            return {
              type: 'message.thinking_end',
              payload: { sessionId: sid },
            }

          // toolcall sub-types carry incremental info but tool_execution_start/end
          // provide the complete, canonical data — skip these to avoid duplicates
          case 'toolcall_start':
          case 'toolcall_delta':
          case 'toolcall_end':
            return null

          // text_start and text_end carry no incremental content needed by frontend
          case 'text_start':
          case 'text_end':
            return null

          default:
            console.warn('[EventAdapter] Unhandled message_update sub-type:', sub.type)
            return null
        }
      }

      // ── Tool execution ────────────────────────────────────────
      case 'tool_execution_start':
        return {
          type: 'message.tool_call_start',
          payload: {
            sessionId: sid,
            toolCallId: event.toolCallId ?? '',
            toolName: event.toolName ?? '',
            input: event.args ?? event.input,
          },
        }

      case 'tool_execution_end': {
        // pi result is { content: [{ type: 'text', text: '...' }] } or a string
        let output: string
        const raw = event.result ?? event.output
        if (typeof raw === 'string') {
          output = raw
        } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).content)) {
          const contentArr = (raw as Record<string, unknown>).content as Array<Record<string, unknown>>
          output = contentArr
            .filter((c) => c.type === 'text')
            .map((c) => (c.text as string) ?? '')
            .join('\n')
        } else if (raw != null) {
          output = JSON.stringify(raw)
        } else {
          output = ''
        }
        // 提取 result.details — pi RPC 返回的结构化扩展数据
        let details: Record<string, unknown> | undefined
        if (raw && typeof raw === 'object') {
          const d = (raw as Record<string, unknown>).details
          if (d && typeof d === 'object' && !Array.isArray(d)) {
            details = d as Record<string, unknown>
          }
        }

        return {
          type: 'message.tool_call_end',
          payload: {
            sessionId: sid,
            toolCallId: event.toolCallId ?? '',
            output,
            details,
            error: event.isError ? output : event.error,
          },
        }
      }

      // ── Agent lifecycle ────────────────────────────────────────
      case 'agent_end': {
        const messages = event.messages as
          Array<Record<string, unknown>> | undefined
        const lastMsg = messages?.[messages.length - 1]
        const rawReason = (lastMsg?.stopReason as string) ?? 'stop'
        const usage = lastMsg?.usage as
          { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined
        return {
          type: 'message.complete',
          payload: {
            sessionId: sid,
            stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
            usage: usage
              ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0 }
              : undefined,
          },
        }
      }

      // ── Extension UI requests ────────────────────────────────
      case 'extension_ui_request': {
        const method = event.method as string | undefined
        // setStatus/setWidget are internal-only, discard
        if (method === 'setStatus' || method === 'setWidget') return null
        // Bridge methods: route directly via callback, no frontend timeout
        if (method?.startsWith('bridge:')) {
          const requestId = String(event.id ?? '')
          const data = (event as Record<string, unknown>).data as Record<string, unknown> ?? {}
          this.options?.onBridgeUIRequest?.(requestId, sid, method, data)
          return null
        }
        // Interactive methods: confirm, select, input, notify
        if (method === 'confirm' || method === 'select' || method === 'input' || method === 'notify') {
          const rawOptions = event.options as Array<{ label: string; value: string }> | undefined
          const requestId = String(event.id ?? '')
          this.options?.onExtensionUIRequest?.(requestId, sid, method)
          return {
            type: 'extension.ui_request',
            payload: {
              sessionId: sid,
              requestId,
              method,
              title: event.title,
              message: event.message,
              options: rawOptions ? rawOptions.map((o) => o.label) : undefined,
              default: event.default as string | undefined,
              level: event.level as 'info' | 'warn' | 'error' | undefined,
            },
          }
        }
        return null
      }

      // ── Status ─────────────────────────────────────────────────
      case 'status':
        return {
          type: 'message.status',
          payload: {
            sessionId: sid,
            status: event.status ?? '',
            detail: event.detail,
          },
        }

      case 'error':
        return {
          type: 'message.error',
          payload: {
            sessionId: sid,
            message: event.message ?? 'Unknown error',
          },
        }

      // ── Lifecycle events ────────────────────────────────────────
      case 'message_start': {
        const msg = event.message as Record<string, unknown> | undefined
        // custom message（来自 pi.sendMessage）包含 customType/content，转发给 interceptor
        if (msg?.customType) {
          return {
            type: 'message.message_start',
            payload: { sessionId: sid, customType: msg.customType as string, content: msg.content as string },
          }
        }
        return {
          type: 'message.message_start',
          payload: { sessionId: sid },
        }
      }

      // ── Lifecycle events not forwarded to frontend ─────────────
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'message_end':
      case 'extension_config':
      case 'extension_ui_response':
      case 'response':
        return null
      case 'extension_error':
        return {
          type: 'extension.error',
          payload: {
            sessionId: sid,
            extensionName: event.extensionName ?? '',
            error: event.error ?? 'Unknown extension error',
          },
        }
      case 'tool_execution_update':
        return {
          type: 'message.tool_call_update',
          payload: {
            sessionId: sid,
            toolCallId: event.toolCallId ?? '',
            detail: event.partialResult as string | undefined,
          },
        }
      // compact 生命周期事件由 session-pool 手动转发，此处丢弃避免重复
      case 'compaction_start':
      case 'compaction_end':
      // auto-retry 事件暂不转发
      case 'auto_retry_start':
      case 'auto_retry_end':
        return null

      default:
        console.warn('[EventAdapter] Unhandled pi event type:', event.type)
        return null
    }
  }

}
