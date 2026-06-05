import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { PiEventListener } from './rpc-client.js'
// Canonical pi event union from types.ts.
// translate() accepts Record<string, unknown> because pi sends event types
// beyond the defined union (compaction_*, auto_retry_*, extension_* etc.).

export type WsSender = (msg: ServerMessage) => void

/** Strip ANSI escape sequences from text (pi RPC mode sends raw escape codes for themed output) */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

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
  /** Called when pi extension fires setStatus via ctx.ui.setStatus(key, text). */
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string }) => void
  /** Called after agent_end with usage data for context window tracking. */
  onContextUpdate?: (sessionId: string, data: { inputTokens: number; totalTokens: number }) => void
  /** Called by EventAdapter to execute plugin hooks on tool/message events. */
  onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<import('./services/plugin-service/plugin-types.js').HookResult>
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
    this.unsub = client.onEvent((event) => {
      void this.handleEvent(event as unknown as Record<string, unknown>).catch((err: unknown) => {
        console.error('[EventAdapter] handleEvent error:', err)
      })
    })
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private hookCallback: EventAdapterOptions['onHookExecute'] | undefined

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    // Capture hookCallback once per event — options is set at construction and never changes
    this.hookCallback = this.options?.onHookExecute
    const msg = await this.translate(event)
    if (msg) {
      this.send(msg)
    }
  }

  private fireHookEvent(eventType: string, data: Record<string, unknown>): void {
    this.hookCallback?.('onPiEvent', { event: eventType, ...data }).catch(() => {})
  }

  private async translate(event: Record<string, unknown>): Promise<ServerMessage | null> {
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

          // FR-5: streaming error (e.g. user abort, upstream failure) — surface
          // as message.stream_error so the renderer can show a final error state.
          case 'error':
            return {
              type: 'message.stream_error',
              payload: {
                sessionId: sid,
                reason: 'error',
                content: sub.content ?? '',
              },
            }

          default:
            console.warn('[EventAdapter] Unhandled message_update sub-type:', sub.type)
            return null
        }
      }

      // ── Tool execution ────────────────────────────────────────
      case 'tool_execution_start': {
        const toolName = event.toolName ?? '' as string
        let input = event.args ?? event.input

        // onBeforeToolCall hook: plugin can block or transform params
        if (this.hookCallback) {
          try {
            const hookResult = await this.hookCallback('onBeforeToolCall', { toolName, input })
            if (hookResult.blocked === true) {
              this.fireHookEvent('tool_execution_start', { toolCallId: event.toolCallId ?? '', toolName, input, blocked: true })
              return null
            }
            if (hookResult.transformedData !== undefined) {
              input = hookResult.transformedData
            }
          // eslint-disable-next-line taste/no-silent-catch
          } catch (e) {
            console.debug(`[event-adapter] hook tool_execution_start error: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        this.fireHookEvent('tool_execution_start', { toolCallId: event.toolCallId ?? '', toolName, input })

        return {
          type: 'message.tool_call_start',
          payload: {
            sessionId: sid,
            toolCallId: event.toolCallId ?? '',
            toolName,
            input,
          },
        }
      }

      case 'tool_execution_end': {
        // pi result is { content: [{ type: 'text', text: '...' }, { type: 'image', ... }] } or a string
        let output: string
        let images: Array<{ data: string; mimeType: string }> | undefined
        const raw = event.result ?? event.output
        if (typeof raw === 'string') {
          output = raw
        } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).content)) {
          const contentArr = (raw as Record<string, unknown>).content as Array<Record<string, unknown>>
          // Concatenate text blocks into a single output string for the renderer.
          output = contentArr
            .filter((c) => c.type === 'text')
            .map((c) => (c.text as string) ?? '')
            .join('\n')
          // Extract image blocks (data + mimeType) so the renderer can display them
          // alongside the text output.
          const imageBlocks = contentArr
            .filter((c) => c.type === 'image')
            .map((c) => ({
              data: String(c.data ?? ''),
              mimeType: String(c.mimeType ?? ''),
            }))
            .filter((img) => img.data !== '' || img.mimeType !== '')
          if (imageBlocks.length > 0) {
            images = imageBlocks
          }
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

        const toolCallId = event.toolCallId ?? '' as string

        // onAfterToolResult hook: plugin can transform output
        if (this.hookCallback) {
          try {
            const hookResult = await this.hookCallback('onAfterToolResult', { toolCallId, output })
            if (hookResult.transformedData !== undefined) {
              output = hookResult.transformedData as string
            }
          // eslint-disable-next-line taste/no-silent-catch
          } catch (e) {
            console.debug(`[event-adapter] hook tool_execution_end error: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        this.fireHookEvent('tool_execution_end', { toolCallId, output, details, images })

        return {
          type: 'message.tool_call_end',
          payload: {
            sessionId: sid,
            toolCallId,
            output,
            details,
            images,
            error: event.isError ? output : event.error,
          },
        }
      }

      // ── Agent lifecycle ────────────────────────────────────────
      case 'agent_start':
        this.fireHookEvent('agent_start', {})
        return null

      case 'agent_end': {
        const messages = event.messages as
          Array<Record<string, unknown>> | undefined
        const lastMsg = messages?.[messages.length - 1]
        const rawReason = (lastMsg?.stopReason as string) ?? 'stop'
        const usage = lastMsg?.usage as
          { input: number; output: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number } | undefined
        // Extract responseModel and diagnostics from the last message so the
        // renderer can show which model answered and per-turn metrics.
        const responseModel = lastMsg?.responseModel as string | undefined
        const diagnostics = lastMsg?.diagnostics as Record<string, unknown> | undefined
        // Emit context.update callback for context window tracking
        if (usage?.input) {
          this.options?.onContextUpdate?.(sid, {
            inputTokens: usage.input,
            totalTokens: usage.totalTokens ?? 0,
          })
        }
        this.fireHookEvent('agent_end', { stopReason: STOP_REASON_MAP[rawReason] ?? rawReason, usage })
        return {
          type: 'message.complete',
          payload: {
            sessionId: sid,
            stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
            usage: usage
              ? { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0 }
              : undefined,
            responseModel,
            diagnostics,
          },
        }
      }

      // ── Extension UI requests ────────────────────────────────
      case 'extension_ui_request': {
        const method = event.method as string | undefined
        // setStatus: translate to internal callback + send WS event
        if (method === 'setStatus') {
          this.options?.onStatusSetUpdate?.({
            sessionId: sid,
            key: String(event.statusKey ?? ''),
            text: stripAnsi(String(event.statusText ?? '')),
          })
          const statusType: ServerMessageType = EXTENSION_EVENTS.STATUS
          this.send({
            type: statusType,
            payload: {
              sessionId: sid,
              statusKey: String(event.statusKey ?? ''),
              text: stripAnsi(String(event.statusText ?? '')),
            },
          })
          return null
        }
        // setWidget: send WS event to frontend
        if (method === 'setWidget') {
          const widgetType: ServerMessageType = EXTENSION_EVENTS.WIDGET
          const widgetPayload = {
            sessionId: sid,
            widgetKey: String(event.widgetKey ?? ''),
            lines: Array.isArray(event.widgetLines) ? (event.widgetLines as unknown[]).map(l => stripAnsi(String(l))) : [],
          }
          console.log('[EventAdapter] setWidget:', widgetPayload.widgetKey, 'lines:', widgetPayload.lines.length, 'sessionId:', sid)
          this.send({
            type: widgetType,
            payload: widgetPayload,
          })
          return null
        }
        // setEditorText: TUI bridge — forward text to frontend
        if (method === 'set_editor_text') {
          return {
            type: 'extension:setEditorText',
            payload: {
              sessionId: sid,
              text: String(event.text ?? ''),
            },
          }
        }
        // setTitle: TUI bridge — forward window/tab title to frontend
        if (method === 'setTitle') {
          return {
            type: 'extension:setTitle',
            payload: {
              sessionId: sid,
              title: String(event.title ?? ''),
            },
          }
        }
        // Bridge methods: route directly via callback, no frontend timeout
        if (method?.startsWith('bridge:')) {
          const requestId = String(event.id ?? '')
          const data = (event as Record<string, unknown>).data as Record<string, unknown> ?? {}
          this.options?.onBridgeUIRequest?.(requestId, sid, method, data)
          return null
        }
        // Interactive methods: confirm, select, input, notify, editor
        if (method === 'confirm' || method === 'select' || method === 'input' || method === 'notify' || method === 'editor') {
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
              // editor: optional prefill value to seed the input
              prefill: method === 'editor' ? (event.prefill as string | undefined) : undefined,
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
        // If no message body, emit a minimal message_start so the renderer
        // can still open the bubble.
        if (!msg) {
          return {
            type: 'message.message_start',
            payload: { sessionId: sid },
          }
        }
        const role = msg.role as string | undefined
        // Role-based routing for non-assistant messages produced by pi.
        // Each role carries a distinct payload shape that the renderer needs.
        if (role === 'bashExecution') {
          return {
            type: 'message.bashExecution',
            payload: {
              sessionId: sid,
              command: msg.command as string | undefined,
              output: msg.output as string | undefined,
              exitCode: msg.exitCode as number | undefined,
            },
          }
        }
        if (role === 'compactionSummary') {
          return {
            type: 'message.compactionSummary',
            payload: {
              sessionId: sid,
              summary: msg.summary as string | undefined,
              tokensBefore: msg.tokensBefore as number | undefined,
            },
          }
        }
        if (role === 'branchSummary') {
          return {
            type: 'message.branchSummary',
            payload: {
              sessionId: sid,
              summary: msg.summary as string | undefined,
              fromId: msg.fromId as string | undefined,
            },
          }
        }
        // custom message（来自 pi.sendMessage）包含 customType/content，转发给 interceptor
        if (msg.customType) {
          return {
            type: 'message.message_start',
            payload: {
              sessionId: sid,
              customType: msg.customType as string,
              content: msg.content as string | undefined,
              // Forward optional structured metadata so the renderer can render
              // expandable details / visibility hints for custom message types.
              details: msg.details as Record<string, unknown> | undefined,
              display: msg.display as boolean | undefined,
            },
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
            // pi RPC sends the extension file path as `extensionPath`; expose it
            // as `extensionName` for the renderer (which already keys by name).
            extensionName: (event.extensionPath as string) ?? '',
            error: event.error ?? 'Unknown extension error',
            errorEvent: event.event as string | undefined,
          },
        }
      case 'tool_execution_update': {
        // partialResult may be a string (simple text progress) or a structured
        // object (e.g. { content, details }) — pass both through unchanged.
        const partialResult = event.partialResult
        const detail: string | Record<string, unknown> | undefined =
          partialResult != null && typeof partialResult === 'object'
            ? (partialResult as Record<string, unknown>)
            : (partialResult as string | undefined)
        return {
          type: 'message.tool_call_update',
          payload: {
            sessionId: sid,
            toolCallId: event.toolCallId ?? '',
            detail,
          },
        }
      }
      // compact 生命周期事件由 session-pool 手动转发，此处丢弃避免重复
      case 'compaction_start':
      case 'compaction_end':
        return null

      // ── FR-3: new event types (TUI bridge surface) ───────────
      case 'auto_retry_start':
        return {
          type: 'message.auto_retry_start',
          payload: {
            sessionId: sid,
            attempt: event.attempt as number | undefined,
            maxAttempts: event.maxAttempts as number | undefined,
            delayMs: event.delayMs as number | undefined,
            errorMessage: event.errorMessage as string | undefined,
          },
        }

      case 'auto_retry_end':
        return {
          type: 'message.auto_retry_end',
          payload: {
            sessionId: sid,
            success: event.success as boolean | undefined,
            attempt: event.attempt as number | undefined,
          },
        }

      case 'queue_update':
        return {
          type: 'message.queue_update',
          payload: {
            sessionId: sid,
            steering: event.steering as string[] | undefined,
            followUp: event.followUp as string[] | undefined,
          },
        }

      case 'session_info_changed':
        return {
          type: 'session.renamed',
          payload: {
            sessionId: sid,
            name: event.name as string | undefined,
          },
        }

      case 'thinking_level_changed':
        return {
          type: 'session.thinkingLevelSet',
          payload: {
            sessionId: sid,
            level: event.level as string | undefined,
          },
        }

      default:
        console.warn('[EventAdapter] Unhandled pi event type:', event.type)
        return null
    }
  }

}
