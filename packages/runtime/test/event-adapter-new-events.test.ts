/**
 * Task 2 tests: EventAdapter new event translations (FR-1 through FR-6).
 *
 * Covers new pi → WS event mappings added in Phase 0 of the TUI Bridge:
 *  - FR-1: extension_ui_request additions (editor / set_editor_text / setTitle),
 *          extension_error field rename (extensionName ← extensionPath) + errorEvent
 *  - FR-2: message_start role-based routing (bashExecution / compactionSummary /
 *          branchSummary) and customType passthrough of details/display
 *  - FR-3: new event types (auto_retry_start, auto_retry_end, queue_update,
 *          session_info_changed, thinking_level_changed)
 *  - FR-4: tool_execution_end image extraction, tool_execution_update object detail,
 *          agent_end responseModel + diagnostics
 *  - FR-5: message_update error → message.stream_error
 *  - FR-6: extension_ui_request setTitle
 *
 * Each test sends a flat pi event to the adapter and asserts the resulting
 * ServerMessage via toMatchObject (existing fields like sessionId are preserved).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventAdapter, type WsSender, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import type { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

function createAdapter(options?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send, options)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

/** Attach adapter and dispatch a single pi event through the listener */
function dispatchOne(adapter: EventAdapter, event: PiTestEvent): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(piEvent(event))
      return () => {}
    },
  })
}

describe('EventAdapter: new event translations (FR-1~FR-6)', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-1: extension_ui_request additions + extension_error field rename
  // ════════════════════════════════════════════════════════════════════

  describe('FR-1: extension_ui_request — editor method', () => {
    it('translates editor method to extension.ui_request with prefill', async () => {
      dispatchOne(adapter, {
        type: 'extension_ui_request',
        method: 'editor',
        id: 'r1',
        title: 'Edit',
        prefill: 'hello',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      expect(sent[0].payload).toMatchObject({
        method: 'editor',
        title: 'Edit',
        prefill: 'hello',
      })
    })
  })

  describe('FR-1: extension_ui_request — set_editor_text', () => {
    it('translates set_editor_text to extension:setEditorText', async () => {
      dispatchOne(adapter, {
        type: 'extension_ui_request',
        method: 'set_editor_text',
        text: 'new text',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:setEditorText')
      expect(sent[0].payload).toMatchObject({
        text: 'new text',
      })
    })
  })

  describe('FR-1: extension_error — extensionPath field rename + errorEvent', () => {
    it('reads extensionPath (not extensionName) and forwards errorEvent', async () => {
      dispatchOne(adapter, {
        type: 'extension_error',
        extensionPath: 'a/b/c.ts',
        error: 'fail',
        event: 'tool_execution',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toMatchObject({
        extensionName: 'a/b/c.ts',
        error: 'fail',
        errorEvent: 'tool_execution',
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-2: message_start role-based routing
  // ════════════════════════════════════════════════════════════════════

  describe('FR-2: message_start — bashExecution role', () => {
    it('translates role=bashExecution to message.bashExecution', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: {
          role: 'bashExecution',
          command: 'ls',
          output: 'file.txt',
          exitCode: 0,
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.bashExecution')
      expect(sent[0].payload).toMatchObject({
        command: 'ls',
        output: 'file.txt',
        exitCode: 0,
      })
    })
  })

  describe('FR-2: message_start — compactionSummary role', () => {
    it('translates role=compactionSummary to message.compactionSummary', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: {
          role: 'compactionSummary',
          summary: 'compacted',
          tokensBefore: 50000,
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.compactionSummary')
      expect(sent[0].payload).toMatchObject({
        summary: 'compacted',
        tokensBefore: 50000,
      })
    })
  })

  describe('FR-2: message_start — branchSummary role', () => {
    it('translates role=branchSummary to message.branchSummary', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: {
          role: 'branchSummary',
          summary: 'branched',
          fromId: 'e1',
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.branchSummary')
      expect(sent[0].payload).toMatchObject({
        summary: 'branched',
        fromId: 'e1',
      })
    })
  })

  describe('FR-2: message_start — customType with details/display', () => {
    it('passes through details and display for customType messages', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: {
          customType: 'info',
          content: 'hi',
          details: { k: 'v' },
          display: false,
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.message_start')
      expect(sent[0].payload).toMatchObject({
        customType: 'info',
        content: 'hi',
        details: { k: 'v' },
        display: false,
      })
    })
  })

  // [HISTORICAL] pi 0.80.3 agent-loop 在每个 turn 末尾 emit message_start{role:'user'}
  // （agent-loop.ts:112）。若不过滤，前端为 user prompt 再建空气泡（渲染撕裂 +
  // findLastAssistantIndex 错位）。切 upstream 0.80.3（ac83b578）后出现。与 toolResult 同语义。
  describe('FR-2: message_start — user/toolResult roles ignored (pi 0.80.3)', () => {
    it('ignores role=user message_start (no message_start WS sent)', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: { role: 'user', content: 'hi' },
      })
      await flushAsync()

      expect(sent).toHaveLength(0)
    })

    it('ignores role=toolResult message_start (no message_start WS sent)', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: { role: 'toolResult', content: 'result' },
      })
      await flushAsync()

      expect(sent).toHaveLength(0)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-3: new event types
  // ════════════════════════════════════════════════════════════════════

  describe('FR-3: auto_retry_start', () => {
    it('translates auto_retry_start to message.auto_retry_start', async () => {
      dispatchOne(adapter, {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'timeout',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.auto_retry_start')
      expect(sent[0].payload).toMatchObject({
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'timeout',
      })
    })
  })

  describe('FR-3: auto_retry_end', () => {
    it('translates auto_retry_end to message.auto_retry_end', async () => {
      dispatchOne(adapter, {
        type: 'auto_retry_end',
        success: true,
        attempt: 3,
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.auto_retry_end')
      expect(sent[0].payload).toMatchObject({
        success: true,
        attempt: 3,
      })
    })
  })

  describe('FR-3: queue_update', () => {
    it('translates queue_update to message.queue_update', async () => {
      dispatchOne(adapter, {
        type: 'queue_update',
        steering: ['s1'],
        followUp: ['f1'],
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.queue_update')
      expect(sent[0].payload).toMatchObject({
        steering: ['s1'],
        followUp: ['f1'],
      })
    })
  })

  describe('FR-3: session_info_changed', () => {
    it('translates session_info_changed to session.renamed', async () => {
      dispatchOne(adapter, {
        type: 'session_info_changed',
        name: 'new-name',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.renamed')
      expect(sent[0].payload).toMatchObject({
        name: 'new-name',
      })
    })
  })

  describe('FR-3: thinking_level_changed', () => {
    it('translates thinking_level_changed to session.thinkingLevelSet', async () => {
      dispatchOne(adapter, {
        type: 'thinking_level_changed',
        level: 'high',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.thinkingLevelSet')
      expect(sent[0].payload).toMatchObject({
        level: 'high',
      })
    })

    it('U-adapter-1：thinking_level_changed 触发 onThinkingLevelChanged 回调并广播 session.thinkingLevelSet', async () => {
      const onThinkingLevelChanged = vi.fn()
      const { adapter, sent } = createAdapter({ onThinkingLevelChanged })
      dispatchOne(adapter, { type: 'thinking_level_changed', level: 'high' })
      await flushAsync()

      // 回调被调用，参数为 (sessionId, 'high')
      expect(onThinkingLevelChanged).toHaveBeenCalledTimes(1)
      expect(onThinkingLevelChanged).toHaveBeenCalledWith('test-session-1', 'high')
      // 产出 session.thinkingLevelSet 消息
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.thinkingLevelSet')
      expect(sent[0].payload).toMatchObject({ level: 'high' })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-4: image extraction + structured partialResult + agent_end extras
  // ════════════════════════════════════════════════════════════════════

  describe('FR-4: tool_execution_end — image extraction', () => {
    it('extracts image blocks alongside text into images array', async () => {
      dispatchOne(adapter, {
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        result: {
          content: [
            { type: 'text', text: 'ok' },
            { type: 'image', data: 'base64', mimeType: 'image/png' },
          ],
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_end')
      const payload = sent[0].payload as Record<string, unknown>
      expect(payload.toolCallId).toBe('tc1')
      expect(payload.output).toBe('ok')
      expect(payload.images).toEqual([
        { data: 'base64', mimeType: 'image/png' },
      ])
    })
  })

  describe('FR-4: tool_execution_update — structured partialResult', () => {
    it('passes object partialResult through as detail object', async () => {
      dispatchOne(adapter, {
        type: 'tool_execution_update',
        toolCallId: 'tc1',
        partialResult: {
          content: 'running',
          details: { truncated: true },
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toMatchObject({
        toolCallId: 'tc1',
        detail: {
          content: 'running',
          details: { truncated: true },
        },
      })
    })
  })

  describe('FR-4: agent_end — responseModel + diagnostics', () => {
    it('forwards responseModel and diagnostics in message.complete', async () => {
      dispatchOne(adapter, {
        type: 'agent_end',
        messages: [
          {
            stopReason: 'stop',
            usage: { input: 100, output: 50 },
            responseModel: 'gpt-4o',
            diagnostics: { latency: 1.2 },
          },
        ],
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect(sent[0].payload).toMatchObject({
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        responseModel: 'gpt-4o',
        diagnostics: { latency: 1.2 },
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-4b: turn_end — 每 turn 用量更新（不转发 message.complete）
  // pi 0.80.3：1 agent 循环 = N 个 turn，每 turn_end 带 usage。
  // turn_end 经 handleTurnEndPi 提取 usage → turn-usage → onContextUpdate，
  // 不产 message.complete（避免每 turn 触发前端 setStreaming 闪烁）。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-4b: turn_end — 每 turn 用量更新（不发 message.complete）', () => {
    it('turn_end 带 usage → 调 onContextUpdate，不发 message.complete', async () => {
      const onContextUpdate = vi.fn()
      const { adapter, sent } = createAdapter({ onContextUpdate })
      dispatchOne(adapter, {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          usage: { input: 163418, output: 82, totalTokens: 163628 },
        },
        toolResults: [],
      })
      await flushAsync()

      // onContextUpdate 被调，带本 turn 的 inputTokens
      expect(onContextUpdate).toHaveBeenCalledTimes(1)
      expect(onContextUpdate).toHaveBeenCalledWith('test-session-1', {
        inputTokens: 163418,
        totalTokens: 163628,
      })
      // 不转发 message.complete（避免每 turn 触发 setStreaming 闪烁）
      expect(sent.find(m => m.type === 'message.complete')).toBeUndefined()
    })

    it('turn_end 无 usage.input → 不触发 onContextUpdate（守卫）', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter({ onContextUpdate })
      dispatchOne(adapter, {
        type: 'turn_end',
        message: { role: 'assistant', stopReason: 'stop' }, // 无 usage
        toolResults: [],
      })
      await flushAsync()

      expect(onContextUpdate).not.toHaveBeenCalled()
    })

    it('多 turn 循环：每 turn_end 独立触发 onContextUpdate（用量逐 turn 更新）', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter({ onContextUpdate })
      // 模拟 3 个 turn 的循环
      for (const input of [1000, 2000, 3000]) {
        adapter.attach({
          onEvent: (listener) => {
            listener(piEvent({
              type: 'turn_end',
              message: { role: 'assistant', usage: { input, output: 10, totalTokens: input + 10 } },
              toolResults: [],
            }))
            return () => {}
          },
        })
      }
      await flushAsync()

      expect(onContextUpdate).toHaveBeenCalledTimes(3)
      // 最后一次带最新用量
      expect(onContextUpdate).toHaveBeenLastCalledWith('test-session-1', {
        inputTokens: 3000,
        totalTokens: 3010,
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-5: message_update error
  // ════════════════════════════════════════════════════════════════════

  describe('FR-5: message_update — error sub-type', () => {
    it('translates message_update with sub-type error to message.stream_error', async () => {
      dispatchOne(adapter, {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          content: 'aborted by user',
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.stream_error')
      expect(sent[0].payload).toMatchObject({
        reason: 'error',
        content: 'aborted by user',
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
})
