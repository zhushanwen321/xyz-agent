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
})
