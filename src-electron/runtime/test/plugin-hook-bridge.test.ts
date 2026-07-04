import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventAdapter, type WsSender, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { HookResult, HookContext } from '../src/services/plugin-service/plugin-types.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

/**
 * FR-8 Hook Bridge tests.
 *
 * Covers:
 * 1. EventAdapter onHookExecute callback — blocked, transformedData, passthrough
 * 2. PluginService registerSendMessageHook — blocked returns { blocked, reason }, passthrough returns null
 */

type PiTestEvent = PiMessage & Record<string, unknown>

function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

// ── EventAdapter onHookExecute ────────────────────────────────

describe('EventAdapter: onHookExecute callback', () => {
  let sent: ServerMessage[]
  let send: WsSender

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  it('calls onHookExecute with correct hookType and context for tool_execution_start', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-1', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-100',
          toolName: 'read_file',
          args: { path: '/tmp/a.txt' },
        }))
        return () => {}
      },
    })

    // Wait for async handleEvent
    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled())

    expect(hookFn).toHaveBeenCalledWith('onBeforeToolCall', {
      toolName: 'read_file',
      input: { path: '/tmp/a.txt' },
    })
  })

  it('calls onHookExecute for tool_execution_end with onAfterToolResult', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-2', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_end',
          toolCallId: 'tc-200',
          result: 'file contents here',
          isError: false,
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled())

    expect(hookFn).toHaveBeenCalledWith('onAfterToolResult', {
      toolCallId: 'tc-200',
      output: 'file contents here',
    })
  })

  it('blocks event when hookResult.blocked === true', async () => {
    const hookFn = vi.fn().mockResolvedValue({
      blocked: true,
      reason: 'Plugin blocked this tool',
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-3', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-blocked',
          toolName: 'dangerous_tool',
          args: {},
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled())

    // Event is blocked — no message forwarded to frontend
    expect(sent).toHaveLength(0)
  })

  it('replaces input with transformedData when hook returns it', async () => {
    const transformedInput = { path: '/safe/path.txt', sanitized: true }
    const hookFn = vi.fn().mockResolvedValue({
      blocked: false,
      transformedData: transformedInput,
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-4', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-transform',
          toolName: 'write_file',
          args: { path: '/unsafe/path.txt' },
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0].type).toBe('message.tool_call_start')
    const payload = sent[0].payload as Record<string, unknown>
    expect(payload.input).toEqual(transformedInput)
  })

  it('replaces output with transformedData for tool_execution_end', async () => {
    const hookFn = vi.fn().mockResolvedValue({
      blocked: false,
      transformedData: 'REDACTED OUTPUT',
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-5', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_end',
          toolCallId: 'tc-trans-end',
          result: 'sensitive data',
          isError: false,
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0].type).toBe('message.tool_call_end')
    const payload = sent[0].payload as Record<string, unknown>
    expect(payload.output).toBe('REDACTED OUTPUT')
  })

  it('forwards event normally when onHookExecute is undefined', async () => {
    const adapter = createEventAdapter('sess-6', send) // no options

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-no-hook',
          toolName: 'read_file',
          args: { path: '/tmp/x' },
        }))
        return () => {}
      },
    })

    // handleEvent is async even without hook — wait for it
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].type).toBe('message.tool_call_start')
    expect((sent[0].payload as Record<string, unknown>).toolName).toBe('read_file')
  })

  it('proceeds with original data when hook throws', async () => {
    const hookFn = vi.fn().mockRejectedValue(new Error('hook crash')) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-7', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-err',
          toolName: 'read_file',
          args: { path: '/tmp/y' },
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    // Hook error → proceed with original data
    expect(sent[0].type).toBe('message.tool_call_start')
    const payload = sent[0].payload as Record<string, unknown>
    expect(payload.input).toEqual({ path: '/tmp/y' })
  })
})

// ── PluginService registerSendMessageHook ──────────────────────

describe('PluginService: registerSendMessageHook', () => {
  /** Minimal mock to construct PluginService without touching fs/workers */
  function createMocks() {
    const registry = {
      getAllDescriptors: vi.fn().mockReturnValue([]),
      scan: vi.fn().mockResolvedValue([]),
    } as unknown as PluginRegistry

    const broker = { broadcast: vi.fn() }
    const setSendMessageHook = vi.fn()
    const sessionService = {
      setSendMessageHook,
      listPersistedSessions: vi.fn().mockReturnValue([]),
      getSummary: vi.fn().mockReturnValue(undefined),
      sendMessage: vi.fn(),
    }

    return { registry, broker, sessionService, setSendMessageHook }
  }

  it('registers setSendMessageHook during initialize()', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never },
    )

    await service.initialize()

    expect(setSendMessageHook).toHaveBeenCalledTimes(1)
    expect(setSendMessageHook).toHaveBeenCalledWith(expect.any(Function))

    await service.shutdown()
  })

  it('hook returns { blocked: true, reason } when executeHooks blocks', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never },
    )

    // Mock executeHooks to return blocked
    const executeHooksSpy = vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: true,
      reason: 'Content policy violation',
      blockedBy: 'plugin-safety',
    })

    await service.initialize()

    // Extract the hook function that was registered
    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string } | null>

    const result = await hookFn('sess-1', 'some dangerous content')

    expect(executeHooksSpy).toHaveBeenCalledWith(
      'onBeforeSendMessage',
      expect.objectContaining({
        sessionId: 'sess-1',
        content: 'some dangerous content',
        hookType: 'onBeforeSendMessage',
      }),
    )

    expect(result).toEqual({ blocked: true, reason: 'Content policy violation' })

    await service.shutdown()
  })

  it('hook returns null when executeHooks does not block', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never },
    )

    // Mock executeHooks to return not blocked
    vi.spyOn(service, 'executeHooks').mockResolvedValue({ blocked: false })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string } | null>

    const result = await hookFn('sess-2', 'normal message')

    expect(result).toBeNull()

    await service.shutdown()
  })

  it('does not register hook when sessionService is absent', async () => {
    const { registry, broker } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      // No sessionService
    )

    await service.initialize()

    // setSendMessageHook was never called (no sessionService)
    expect(broker.broadcast).toHaveBeenCalled() // initialize still broadcasts plugin list

    await service.shutdown()
  })
})
