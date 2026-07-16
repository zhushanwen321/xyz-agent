/**
 * W1 TDD tests：EventInterpreter subagent 内存态 + session.subagents 广播。
 *
 * 背景：runtime 在 subagent 状态变化时主动 broadcast session.subagents，
 * 前端被动消费更新 sidebar badge。EventInterpreter 维护内存态：
 *   - tool-call-start 缓存 startParam（agent/slug/task）
 *   - tool-call-end 合并 details(subagentId/sessionFile/bgResponse) 建 running 记录 → 广播
 *   - bg-notify customStart 更新终态 → 广播
 *
 * U1：start+end 建记录 + 广播
 * U2：bg-notify 更新终态 + 广播
 * U3：非 subagent 工具不触发广播
 * U4：start 无 end 不崩溃不广播
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · subagent 内存态 + session.subagents 广播', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  /** 构造 subagent tool-call-start 事件 */
  function subagentStart(toolCallId: string, startParam: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-start',
      toolCallId,
      toolName: 'subagent',
      input: { action: 'start', startParam },
    }
  }

  /** 构造 subagent tool-call-end 事件（details 含 SubagentToolResult） */
  function subagentEnd(toolCallId: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId,
      toolName: 'subagent',
      output: JSON.stringify(details),
      details,
      images: undefined,
      isError: false,
    }
  }

  // ── U1：start+end 建记录 + 广播 ──────────────────────────────────
  describe('U1: subagent tool-call start+end → 新增 running 记录 + 广播 session.subagents', () => {
    it('start(startParam) + end(details:bgResponse) → 广播含 running 记录', () => {
      const interpreter = new EventInterpreter('sid-u1', { send })

      interpreter.interpret([
        subagentStart('call-1', { agent: 'reviewer', slug: 'fix-bug', task: 'Fix the bug' }),
        subagentEnd('call-1', {
          action: 'start',
          subagentId: 'bg-1-123',
          sessionFile: '/data/sub.jsonl',
          bgResponse: { status: 'running', message: 'detached' },
        }),
      ])

      // tool-call-end 还会产出通用 tool_call_end WS 帧，所以 sent 里至少有 2 条。
      // 找 type=session.subagents 的那条
      const subagentsMsg = sent.find((m) => m.type === 'session.subagents')
      expect(subagentsMsg).toBeDefined()
      const payload = subagentsMsg!.payload as { sessionId: string; subagents: Array<Record<string, unknown>> }
      expect(payload.sessionId).toBe('sid-u1')
      expect(payload.subagents).toHaveLength(1)
      expect(payload.subagents[0].subagentId).toBe('bg-1-123')
      expect(payload.subagents[0].agent).toBe('reviewer')
      expect(payload.subagents[0].slug).toBe('fix-bug')
      expect(payload.subagents[0].task).toBe('Fix the bug')
      expect(payload.subagents[0].status).toBe('running')
      expect(payload.subagents[0].sessionFile).toBe('/data/sub.jsonl')
    })
  })

  // ── U2：bg-notify 更新终态 + 广播 ────────────────────────────────
  describe('U2: bg-notify customStart → 更新终态 + 广播', () => {
    it('已有 running 记录时，bg-notify 到达 → 更新为 done + 广播', () => {
      const interpreter = new EventInterpreter('sid-u2', { send })

      // 先建记录
      interpreter.interpret([
        subagentStart('call-2', { agent: 'reviewer', slug: 'fix-bug', task: 'Fix the bug' }),
        subagentEnd('call-2', {
          action: 'start',
          subagentId: 'bg-1-123',
          sessionFile: '/data/sub.jsonl',
          bgResponse: { status: 'running', message: 'detached' },
        }),
      ])
      const firstBroadcast = sent.filter((m) => m.type === 'session.subagents')
      expect(firstBroadcast).toHaveLength(1)

      // 发 bg-notify
      interpreter.interpret([{
        kind: 'message',
        message: {
          type: 'message.customStart',
          payload: {
            sessionId: 'sid-u2',
            customType: 'subagent-bg-notify',
            details: {
              id: 'bg-1-123',
              status: 'done',
              agent: 'reviewer',
              model: 'glm-5.2',
              startedAt: 1000,
              endedAt: 2000,
            },
          },
        } as ServerMessage,
      }])

      const subagentsMsgs = sent.filter((m) => m.type === 'session.subagents')
      expect(subagentsMsgs).toHaveLength(2)
      const payload = subagentsMsgs[1]!.payload as { subagents: Array<Record<string, unknown>> }
      expect(payload.subagents).toHaveLength(1)
      expect(payload.subagents[0].status).toBe('done')
      expect(payload.subagents[0].startedAt).toBe(1000)
      expect(payload.subagents[0].endedAt).toBe(2000)
      expect(payload.subagents[0].model).toBe('glm-5.2')
    })
  })

  // ── U3：非 subagent 工具不触发 ───────────────────────────────────
  describe('U3: 非 subagent 工具不触发 session.subagents 广播', () => {
    it('write 工具的 start+end → 无 session.subagents 广播', () => {
      const interpreter = new EventInterpreter('sid-u3', { send })

      interpreter.interpret([
        { kind: 'tool-call-start', toolCallId: 'call-w', toolName: 'write', input: { path: '/a.ts' } },
        {
          kind: 'tool-call-end',
          toolCallId: 'call-w',
          toolName: 'write',
          output: 'ok',
          details: undefined,
          images: undefined,
          isError: false,
        },
      ])

      const subagentsMsg = sent.find((m) => m.type === 'session.subagents')
      expect(subagentsMsg).toBeUndefined()
    })
  })

  // ── U4：start 无 end 不崩溃 ──────────────────────────────────────
  describe('U4: start 无 end → 不广播，不崩溃', () => {
    it('只有 subagent tool-call-start（无 end）→ 无 session.subagents 广播，无异常', () => {
      const interpreter = new EventInterpreter('sid-u4', { send })

      interpreter.interpret([
        subagentStart('call-4', { agent: 'worker', slug: 'task-a', task: 'Do task' }),
      ])

      const subagentsMsg = sent.find((m) => m.type === 'session.subagents')
      expect(subagentsMsg).toBeUndefined()
    })
  })
})
