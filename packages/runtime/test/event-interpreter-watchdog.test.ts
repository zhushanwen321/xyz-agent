/**
 * W6 TDD 测试：EventInterpreter turn 级 pi watchdog（设计文档 A2）。
 *
 * 背景：pi 子进程偶发静默卡死（坏 session 特征：JSONL 只有 session + session_info 两行、零 message）。
 * EventInterpreter 需在 turn 维度维护一个 watchdog 定时器：
 *   - turn-start / 每个有效事件（text_delta / tool-call-*）reset watchdog
 *   - 超过 WARN 阈值（120s）→ 广播 message.stream_error 警告前端用户
 *   - 超过 ABORT 阈值（300s）→ 触发 onSilentAbort 回调（由上层 abort pi 子进程 + 复位 isGenerating）
 *   - 正常 agent_end 到达 → clear watchdog
 *   - 工具执行期间（tool-call-start ~ tool-call-end）不计入静默判定，避免长任务误报
 *
 * [红灯说明] 当前 EventInterpreter 尚未实现 watchdog：
 *   - 构造选项 EventInterpreterOptions 没有 onSilentAbort 字段
 *   - 类上没有 watchdog 相关的 start/reset/clear 方法
 *   故本文件中类型断言（opts.onSilentAbort）与方法调用会报错 → 测试红灯。实现 watchdog 后应转绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

/** watchdog 默认阈值（设计文档 A2）。实现应把这些常量 export 或在内部用同值。 */
const WARN_THRESHOLD_MS = 120_000
const ABORT_THRESHOLD_MS = 300_000

describe('EventInterpreter · W6 turn 级 pi watchdog（A2）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void
  let onSilentAbort: ReturnType<typeof vi.fn>
  let interpreter: EventInterpreter

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    send = (msg) => { sent.push(msg) }
    onSilentAbort = vi.fn()
    // 注入 onSilentAbort 回调（实现后此字段属于 EventInterpreterOptions）。
    // 此处用 as 强转绕过当前缺失的类型字段，使测试能在「字段未实现」状态下编译。
    interpreter = new EventInterpreter('sid-watchdog', {
      send,
      onSilentAbort,
    } as ConstructorParameters<typeof EventInterpreter>[1])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 构造一个 turn-start 事件（assistant turn 开始）。 */
  function turnStart(messageId = 'a-msg-1'): PiTranslatedEvent {
    return { kind: 'turn-start', messageId }
  }

  /** 构造一个 text_delta message 事件（pi 仍在产出 → 非静默）。 */
  function textDelta(): PiTranslatedEvent {
    return {
      kind: 'message',
      message: { type: 'message.text_delta', payload: { sessionId: 'sid-watchdog', delta: 'x' } },
    }
  }

  /** 构造一个 tool-call-start 事件（工具执行开始）。 */
  function toolCallStart(): PiTranslatedEvent {
    return { kind: 'tool-call-start', toolCallId: 'call-1', toolName: 'bash', input: {} }
  }

  /** 构造一个 tool-call-end 事件（工具执行结束）。 */
  function toolCallEnd(): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId: 'call-1',
      output: 'done',
      details: undefined,
      images: undefined,
      toolName: 'bash',
      isError: false,
    }
  }

  /** 构造一个 agent_end turn-end 事件（turn 正常结束）。 */
  function turnEnd(): PiTranslatedEvent {
    return {
      kind: 'turn-end',
      message: {
        type: 'message.complete',
        payload: { sessionId: 'sid-watchdog', stopReason: 'end_turn' },
      },
      stopReason: 'end_turn',
    }
  }

  /** 取出 sent 中的 message.stream_warn 帧（WARN 广播，B1 后与 stream_error 物理隔离）。 */
  function findStreamWarn(): ServerMessage | undefined {
    return sent.find((m) => m.type === 'message.stream_warn')
  }

  // ── WD1：正常 turn 不误报 ─────────────────────────────────────
  it('WD1: 连续 message_update（每 30s 一个 text_delta）推进 60s → onSilentAbort 不被调用', () => {
    interpreter.interpret([turnStart()])
    // 两个 30s 间隔的 text_delta —— pi 正常产文本，不应触发 abort
    interpreter.interpret([textDelta()])
    vi.advanceTimersByTime(30_000)
    interpreter.interpret([textDelta()])
    vi.advanceTimersByTime(30_000)

    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── WD2：工具执行期间不误报 ───────────────────────────────────
  it('WD2: tool-call-start 后推进 100s 再发 tool-call-end → onSilentAbort 不被调用', () => {
    interpreter.interpret([turnStart()])
    interpreter.interpret([toolCallStart()])
    // 工具执行 100s（低于 ABORT 阈值，且工具执行期间 watchdog 应被挂起/重置）
    vi.advanceTimersByTime(100_000)
    interpreter.interpret([toolCallEnd()])

    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── WD3：静默卡死检测 ─────────────────────────────────────────
  it('WD3: turn-start 后无任何事件，推进超过 ABORT 阈值 → onSilentAbort 被调用', () => {
    interpreter.interpret([turnStart()])
    // 超过 ABORT 阈值仍无任何事件 → 视为静默卡死，触发 abort
    vi.advanceTimersByTime(ABORT_THRESHOLD_MS + 1_000)

    expect(onSilentAbort).toHaveBeenCalledTimes(1)
    // 回调应携带 sessionId，供上层定位要 abort 的 session
    expect(onSilentAbort).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid-watchdog' }))
  })

  // ── WD4：agent_end 清除 watchdog ──────────────────────────────
  it('WD4: 正常 agent_end 到达后，watchdog timer 被 clear（之后再推进时间不触发 abort）', () => {
    interpreter.interpret([turnStart()])
    interpreter.interpret([turnEnd()]) // 正常结束 → 应 clear watchdog

    // 推进超过 ABORT 阈值，因 watchdog 已被 clear，不应触发
    vi.advanceTimersByTime(ABORT_THRESHOLD_MS + 1_000)

    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── WD5：WARN 级别先广播再算 abort ────────────────────────────
  it('WD5: 推进超过 WARN 但未到 ABORT → 广播 message.stream_warn（非 stream_error），onSilentAbort 不调用', () => {
    interpreter.interpret([turnStart()])
    // 超过 WARN 阈值但未到 ABORT 阈值
    vi.advanceTimersByTime(WARN_THRESHOLD_MS + 1_000)

    // B1: WARN 走独立类型 message.stream_warn（提示性，不中断），
    // 不再复用 message.stream_error（前端会当真错误收口）
    const warn = findStreamWarn()
    expect(warn).toBeDefined()
    expect(warn!.type).toBe('message.stream_warn')
    // stream_error 不应被 WARN 触发（那是真错误的通道）
    const strayError = sent.find((m) => m.type === 'message.stream_error')
    expect(strayError).toBeUndefined()
    // 尚未到 abort，不触发 onSilentAbort
    expect(onSilentAbort).not.toHaveBeenCalled()
  })
})
