/**
 * W3 TDD tests：EventInterpreter workflow 实时推送。
 *
 * 背景：runtime 在 workflow 发起/结束时刻主动 broadcast session.workflowUpdate 增量信号，
 * 前端收到后调 loadWorkflows RPC 拉取完整列表。
 *
 * U1：workflow tool-call-end(action=run) → 广播 session.workflowUpdate {status:'running'}
 * U2：workflow-result customStart → 广播 session.workflowUpdate {status:'done', reason}
 * U3：非 workflow tool 不触发广播
 * U4：workflow tool action≠run 不触发广播
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · workflow 实时推送 session.workflowUpdate', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  /** 构造 workflow tool-call-end 事件 */
  function workflowEnd(details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId: 'call-wf-1',
      toolName: 'workflow',
      output: JSON.stringify(details),
      details,
      images: undefined,
      isError: false,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId: 'call-wf-1', toolName: 'workflow', content: JSON.stringify(details), isError: false, details, timestamp: 0 },
      },
    }
  }

  /** 构造 customStart message 事件（workflow-result） */
  function customStart(customType: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: {
          sessionId: 'sid-wf',
          customType,
          content: 'test',
          details,
        },
      },
    }
  }

  /** 从 sent 里提取 session.workflowUpdate 消息 */
  function findWorkflowUpdate(): ServerMessage | undefined {
    return sent.find((m) => m.type === 'session.workflowUpdate')
  }

  // ── U1：workflow tool action=run → 广播 running ──────────────
  it('U1: workflow tool-call-end(action=run, status=running) → 广播 session.workflowUpdate running', () => {
    const interpreter = new EventInterpreter('sid-wf', { send })

    interpreter.interpret([
      workflowEnd({ action: 'run', runId: 'wf-test-001', status: 'running', name: 'deploy-flow' }),
    ])

    const update = findWorkflowUpdate()
    expect(update).toBeDefined()
    expect(update!.payload).toMatchObject({
      sessionId: 'sid-wf',
      update: { runId: 'wf-test-001', status: 'running' },
    })
  })

  // ── U2：workflow-result customStart → 广播 done + reason ──────
  it('U2: workflow-result customStart → 广播 session.workflowUpdate done + reason', () => {
    const interpreter = new EventInterpreter('sid-wf', { send })

    interpreter.interpret([
      customStart('workflow-result', {
        runId: 'wf-test-002',
        name: 'test-flow',
        status: 'done',
        reason: 'completed',
        traceLength: 3,
      }),
    ])

    const update = findWorkflowUpdate()
    expect(update).toBeDefined()
    expect(update!.payload).toMatchObject({
      sessionId: 'sid-wf',
      update: { runId: 'wf-test-002', status: 'done', reason: 'completed' },
    })
  })

  // ── U3：非 workflow tool 不触发广播 ───────────────────────────
  it('U3: 非 workflow tool 的 tool-call-end 不触发 session.workflowUpdate', () => {
    const interpreter = new EventInterpreter('sid-wf', { send })

    interpreter.interpret([
      {
        kind: 'tool-call-end',
        toolCallId: 'call-other',
        toolName: 'read',
        output: 'ok',
        details: { action: 'run', runId: 'wf-x', status: 'running' },
        images: undefined,
        isError: false,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'call-other', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, details: { action: 'run', runId: 'wf-x', status: 'running' }, timestamp: 0 },
        },
      },
    ])

    expect(findWorkflowUpdate()).toBeUndefined()
  })

  // ── U4：workflow tool action≠run 不触发广播 ──────────────────
  it('U4: workflow tool action=status 不触发广播（只有 action=run 才广播）', () => {
    const interpreter = new EventInterpreter('sid-wf', { send })

    interpreter.interpret([
      workflowEnd({ action: 'status', runs: [] }),
    ])

    expect(findWorkflowUpdate()).toBeUndefined()
  })

  // ── U5：非 workflow-result customStart 不触发广播 ────────────
  it('U5: subagent-bg-notify customStart 不触发 session.workflowUpdate', () => {
    const interpreter = new EventInterpreter('sid-wf', { send })

    interpreter.interpret([
      customStart('subagent-bg-notify', { id: 'bg-1', status: 'done' }),
    ])

    expect(findWorkflowUpdate()).toBeUndefined()
  })

  // ── W09 review：微项 4 快速路径的 customType 运行时护栏 ──────
  describe('W09 微项 4 快速路径 customType 护栏', () => {
    /** 构造 text_delta message 事件（可选注入 customType 模拟未来新增产出点） */
    function textDelta(payloadExtra?: Record<string, unknown>): PiTranslatedEvent {
      return {
        kind: 'message',
        message: {
          type: 'message.text_delta',
          payload: { sessionId: 'sid-wf', delta: 'x', ...payloadExtra },
        },
      }
    }

    it('无 customType 的 text_delta 走快速路径：只 send 一次，零 workflowUpdate（纯转发）', () => {
      const interpreter = new EventInterpreter('sid-wf', { send })

      interpreter.interpret([textDelta()])

      expect(sent).toHaveLength(1)
      expect(sent[0]!.type).toBe('message.text_delta')
      expect(findWorkflowUpdate()).toBeUndefined()
    })

    it('带 customType 的 text_delta 回落完整检查路径：handleWorkflowResult 生效，广播 session.workflowUpdate', () => {
      const interpreter = new EventInterpreter('sid-wf', { send })

      // 模拟未来新增「带 customType 的 delta 产出点」：护栏必须使其绕开快速路径，
      // 否则 workflow-result 检查被静默跳过（W09 review 指出的绕过风险）。
      interpreter.interpret([
        textDelta({ customType: 'workflow-result', details: { runId: 'wf-guard-1', status: 'done', reason: 'completed' } }),
      ])

      // delta 本身仍被转发（完整路径的 message 分支同样 send）+ workflowUpdate 被广播
      expect(sent).toHaveLength(2)
      expect(sent[0]!.type).toBe('message.text_delta')
      const update = findWorkflowUpdate()
      expect(update).toBeDefined()
      expect(update!.payload).toMatchObject({
        sessionId: 'sid-wf',
        update: { runId: 'wf-guard-1', status: 'done', reason: 'completed' },
      })
    })
  })
})
