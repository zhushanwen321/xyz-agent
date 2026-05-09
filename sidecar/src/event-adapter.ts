import type { ServerMessage } from '@xyz-agent/shared'
import type { PiEventListener } from './rpc-client.js'

export type WsSender = (msg: ServerMessage) => void

/**
 * Loosely typed representation of a pi RPC event.
 * pi sends events with various shapes that don't fit the narrow PiMessage interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi events have dynamic shapes
type PiEvent = Record<string, any>

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
export class EventAdapter {
  private unsub: (() => void) | null = null

  constructor(
    private sessionId: string,
    private send: WsSender,
  ) {}

  /** Start listening to events from an RpcClient. */
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void {
    this.unsub = client.onEvent((event) => this.handleEvent(event as unknown as PiEvent))
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private handleEvent(event: PiEvent): void {
    const msg = this.translate(event)
    if (msg) {
      console.debug('[EventAdapter] → WS:', msg.type)
      this.send(msg)
    }
  }

  private translate(event: PiEvent): ServerMessage | null {
    const sid = this.sessionId

    switch (event.type) {
      // ── Streaming content ────────────────────────────────────────
      case 'message_update': {
        const sub = event.assistantMessageEvent as
          { type: string; delta?: string; content?: string; contentIndex?: number } | undefined
        if (!sub) return null

        switch (sub.type) {
          case 'text_delta':
            return {
              type: 'message.text_delta',
              payload: { sessionId: sid, delta: sub.delta ?? '' },
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

          // toolcall sub-types from message_update
          case 'toolcall_start':
            return {
              type: 'message.tool_call_start',
              payload: {
                sessionId: sid,
                toolCallId: '',  // Will be in toolcall_end or tool_execution_start
                toolName: '',
                input: null,
              },
            }

          case 'toolcall_end': {
            // toolcall_end carries the complete toolCall object
            const tc = event.toolCall as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined
            return {
              type: 'message.tool_call_start',
              payload: {
                sessionId: sid,
                toolCallId: tc?.id ?? '',
                toolName: tc?.name ?? '',
                input: tc?.arguments ?? null,
              },
            }
          }

          // text_start and text_end carry no incremental content needed by frontend
          case 'text_start':
          case 'text_end':
            return null

          default:
            console.debug('[EventAdapter] Unhandled message_update sub-type:', sub.type)
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

      case 'tool_execution_end':
        return {
          type: 'message.tool_call_end',
          payload: {
            sessionId: sid,
            toolCallId: event.toolCallId ?? '',
            output: event.result ?? event.output ?? '',
            error: event.isError ? String(event.result ?? '') : event.error,
          },
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

      // ── Extension UI requests (tool approvals etc.) ────────────
      case 'extension_ui_request': {
        const method = event.method as string | undefined
        // Forward confirm/select as tool approval requests
        if (method === 'confirm' || method === 'select') {
          return {
            type: 'message.tool_call_pending',
            payload: {
              sessionId: sid,
              toolCallId: event.id ?? '',
              toolName: event.title ?? '',
              input: event,
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

      // ── Lifecycle events not forwarded to frontend ─────────────
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'message_end':
      case 'extension_ui_response':
      case 'extension_config':
      case 'extension_error':
      case 'response':
        return null

      default:
        console.debug('[EventAdapter] Unhandled pi event type:', event.type)
        return null
    }
  }

  // ── Helper methods for non-session messages ──────────────────────

  sendSessionCreated(id: string, session: Record<string, unknown>): void {
    this.send({ type: 'session.created', id, payload: { session } })
  }

  sendSessionDeleted(id: string, sessionId: string): void {
    this.send({ type: 'session.deleted', id, payload: { sessionId } })
  }

  sendSessionList(sessions: Record<string, unknown>[]): void {
    this.send({ type: 'session.list', payload: { sessions } })
  }

  sendProviderList(providers: Record<string, unknown>[]): void {
    this.send({ type: 'config.providers', payload: { providers } })
  }

  sendModelList(models: Record<string, unknown>[]): void {
    this.send({ type: 'model.list', payload: { models } })
  }

  sendError(code: string, message: string, id?: string): void {
    this.send({ type: 'error', id, payload: { code, message } })
  }
}
