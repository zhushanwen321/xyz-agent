import type { ServerMessage } from '@xyz-agent/shared'
import type { PiMessage, PiEventListener } from './rpc-client.js'

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
    this.unsub = client.onEvent((event) => this.handleEvent(event))
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private handleEvent(event: PiMessage): void {
    const msg = this.translate(event)
    if (msg) this.send(msg)
  }

  private translate(event: PiMessage): ServerMessage | null {
    const sid = this.sessionId
    const p = event.payload ?? {}

    switch (event.type) {
      case 'text_delta':
        return {
          type: 'message.text_delta',
          payload: { sessionId: sid, delta: p.delta ?? '' },
        }

      case 'thinking_delta':
        return {
          type: 'message.thinking_delta',
          payload: { sessionId: sid, delta: p.delta ?? '' },
        }

      case 'tool_execution_start':
        return {
          type: 'message.tool_call_start',
          payload: {
            sessionId: sid,
            toolCallId: p.toolCallId ?? '',
            toolName: p.toolName ?? '',
            input: p.input,
          },
        }

      case 'tool_execution_end':
        return {
          type: 'message.tool_call_end',
          payload: {
            sessionId: sid,
            toolCallId: p.toolCallId ?? '',
            output: p.output ?? '',
            error: p.error,
          },
        }

      case 'agent_end': {
        const rawReason = (p.stopReason as string) ?? 'stop'
        return {
          type: 'message.complete',
          payload: {
            sessionId: sid,
            stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
            usage: p.usage,
          },
        }
      }

      case 'tool_call_pending':
        return {
          type: 'message.tool_call_pending',
          payload: {
            sessionId: sid,
            toolCallId: p.toolCallId ?? '',
            toolName: p.toolName ?? '',
            input: p.input,
          },
        }

      case 'thinking_start':
        return {
          type: 'message.thinking_start',
          payload: { sessionId: sid },
        }

      case 'thinking_end':
        return {
          type: 'message.thinking_end',
          payload: { sessionId: sid },
        }

      case 'status':
        return {
          type: 'message.status',
          payload: {
            sessionId: sid,
            status: p.status ?? '',
            detail: p.detail,
          },
        }

      case 'error':
        return {
          type: 'message.error',
          payload: { sessionId: sid, message: p.message ?? 'Unknown error' },
        }

      // Known pi events that don't need forwarding to the frontend
      case 'extension_ui_request':
      case 'extension_ui_response':
      case 'extension_config':
        return null

      default:
        console.debug('[EventAdapter] Unhandled pi event type:', event.type, event.payload)
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
