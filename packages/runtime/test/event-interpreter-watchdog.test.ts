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

  /** 构造一个 extension-ui 事件（ask-user 等阻塞式 UI 请求，应暂停 watchdog）。 */
  function extensionUi(): PiTranslatedEvent {
    return {
      kind: 'extension-ui',
      requestId: 'req-ask',
      sessionId: 'sid-watchdog',
      method: 'select',
      payload: {},
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
    // 不再复用 stream_error（前端会当真错误收口）
    const warn = findStreamWarn()
    expect(warn).toBeDefined()
    expect(warn!.type).toBe('message.stream_warn')
    // stream_error 不应被 WARN 触发（那是真错误的通道）
    const strayError = sent.find((m) => m.type === 'message.stream_error')
    expect(strayError).toBeUndefined()
    // 尚未到 abort，不触发 onSilentAbort
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── WD6/7/8：extension-ui 暂停 watchdog（2026-07-16 对齐 main W1）──
  // ask-user 等交互式 extension UI 等待用户期间暂停 watchdog：
  //   - 暂停期间推进时间不触发 WARN/ABORT（用户未响应不应视为 pi 卡死）
  //   - 用户响应后 pi 继续产出活动事件 → resetWatchdog 隐式恢复
  //   - turn-end 兜底复位 paused 标志（防跨 turn 泄漏）

  it('WD6: extension-ui 期间暂停 watchdog，推进超 ABORT 阈值 → 不触发 WARN/ABORT（pause 保护）', () => {
    interpreter.interpret([turnStart()])
    interpreter.interpret([extensionUi()]) // ask-user 请求 → pauseWatchdog
    // 暂停期间推进远超 ABORT 阈值（5min），用户仍未响应
    vi.advanceTimersByTime(ABORT_THRESHOLD_MS + 60_000)

    expect(findStreamWarn()).toBeUndefined() // 不广播 WARN
    expect(onSilentAbort).not.toHaveBeenCalled() // 不触发 ABORT
  })

  it('WD7: extension-ui 暂停后喂 text_delta 恢复 watchdog → 再静默达 WARN 阈值触发 WARN', () => {
    interpreter.interpret([turnStart()])
    interpreter.interpret([extensionUi()]) // 暂停
    // 暂停期间推进 100s（不到 ABORT，验证暂停生效）
    vi.advanceTimersByTime(100_000)
    expect(findStreamWarn()).toBeUndefined()

    // 用户响应后 pi 继续产出 text_delta → resetWatchdog 隐式恢复（清 paused + 重排 timer）
    interpreter.interpret([textDelta()])
    // 再静默达 WARN 阈值 → 应触发 WARN（证明已恢复）
    vi.advanceTimersByTime(WARN_THRESHOLD_MS + 1_000)
    expect(findStreamWarn()).toBeDefined()
  })

  it('WD8: extension-ui 暂停期间收到 turn-end → watchdog 清除且 paused 复位（之后新 turn 正常工作）', () => {
    interpreter.interpret([turnStart()])
    interpreter.interpret([extensionUi()]) // 暂停
    interpreter.interpret([turnEnd()]) // turn 结束 → clearWatchdog（应复位 paused）

    // 推进超过 ABORT 阈值，watchdog 已 clear，不触发
    vi.advanceTimersByTime(ABORT_THRESHOLD_MS + 1_000)
    expect(onSilentAbort).not.toHaveBeenCalled()

    // 新 turn：paused 应已复位，watchdog 正常工作（静默达 ABORT 触发）
    interpreter.interpret([turnStart()])
    vi.advanceTimersByTime(ABORT_THRESHOLD_MS + 1_000)
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
  })
})

/**
 * M8（perf-quick-batch）：watchdog 消除每帧定时器重排。
 *
 * 现状缺陷：resetWatchdog → scheduleWatchdog 每个 message 事件（含 text_delta）都
 * clearWatchdogTimers（2 个 clearTimeout）+ 重排 2 个 setTimeout。高频 token 流下
 * 每 token = 4 次定时器操作，2000 token = 8000 次。clearTimeout/setTimeout 虽廉价，
 * 但批量下是显著的 V8 定时器堆重排开销 + 无谓的 timer 对象分配。
 *
 * 修复目标：消除每帧重排。只锁不变量不规定机制，但必须满足：
 * - INVAR-M8-1: warn/abort 语义不变（warn 120s 先于 abort 300s）
 * - INVAR-M8-2【关键】: 不得比真实无活动更早触发（朴素"距上次 schedule 超阈值才重排"
 *   会让旧定时器 deadline 比新 deadline 近 → 提前触发，方向错误）
 * - INVAR-M8-3: 不得延后漏报（真实无活动达阈值 ±帧级容差触发）
 * - INVAR-M8-4: 冷启动/长间隔后首 token 正常建立定时器
 *
 * [红灯] 当前实现每事件 4 次定时器操作，1000 事件后 setTimeout+clearTimeout 调用
 * 远超 O(1) 上限 → fail。
 */
describe('EventInterpreter · M8 watchdog 定时器摊还（消除每帧重排）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void
  let onSilentAbort: ReturnType<typeof vi.fn>
  let interpreter: EventInterpreter
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    send = (msg) => { sent.push(msg) }
    onSilentAbort = vi.fn()
    // spy 全局定时器（fake timers 模式下 spy 仍能捕获 vi 内部委托的真实调用计数）
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    interpreter = new EventInterpreter('sid-m8', {
      send,
      onSilentAbort,
    } as ConstructorParameters<typeof EventInterpreter>[1])
  })

  afterEach(() => {
    setTimeoutSpy.mockRestore()
    clearTimeoutSpy.mockRestore()
    vi.useRealTimers()
  })

  function textDelta(): PiTranslatedEvent {
    return {
      kind: 'message',
      message: { type: 'message.text_delta', payload: { sessionId: 'sid-m8', delta: 'x' } },
    }
  }

  /**
   * M8-1: 高频 token 流下定时器操作摊还为 O(1)（不再每 token 4 次）。
   *
   * 判定标准：1000 个 text_delta 后，setTimeout + clearTimeout 总调用次数
   * 不超过某常数上限（如 20），而非 4×1000=4000。
   *
   * [红灯] 当前实现调 scheduleWatchdog 每 4 次/事件 → 4000+ 次 → 远超上限 → fail。
   */
  it('M8-1: 1000 个 text_delta 后 setTimeout/clearTimeout 总调用 O(1)（≤上限，非 4N）', () => {
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm-m8' }])
    // 重置 spy 基线（turn-start 的 startWatchdog 不算 token 流开销）
    setTimeoutSpy.mockClear()
    clearTimeoutSpy.mockClear()

    // 模拟 1000 个连续 text_delta（pi 高速产 token，每两个间隔极小）
    for (let i = 0; i < 1000; i++) {
      interpreter.interpret([textDelta()])
    }

    const totalCalls = setTimeoutSpy.mock.calls.length + clearTimeoutSpy.mock.calls.length
    // O(1) 上限：允许少量摊还（如周期性重排或首尾建立），但禁止线性增长。
    // 4N=4000，O(1) 上限设 50（宽松，留实现选择空间）。
    expect(totalCalls).toBeLessThanOrEqual(50)
  })

  /**
   * M8-2: 不提前触发——token 流期间（持续有活动）绝不触发 warn/abort。
   *
   * 即使定时器摊还，持续活动下 deadline 不断被推远，warn/abort 不应触发。
   * 复用 WD1 语义但在高频场景下验证（防摊还实现把 deadline 算错提前）。
   */
  it('M8-2: 持续 token 流（每 10s 一个 delta）推进 200s → 不触发 warn/abort（不提前）', () => {
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm-m8b' }])
    // 每 10s 一个 token，持续 200s（远超 WARN=120s，但因持续活动不应触发）
    for (let i = 0; i < 20; i++) {
      interpreter.interpret([textDelta()])
      vi.advanceTimersByTime(10_000)
    }
    expect(sent.find((m) => m.type === 'message.stream_warn')).toBeUndefined()
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  /**
   * M8-3: 不延后——真实静默达阈值时 warn/abort 在阈值点触发（容差内）。
   */
  it('M8-3: token 流后静默达 WARN 阈值 → warn 在阈值点触发（不延后）', () => {
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm-m8c' }])
    // 先有几个 token 建立活动基线
    interpreter.interpret([textDelta()])
    interpreter.interpret([textDelta()])
    // 然后静默达 WARN 阈值
    vi.advanceTimersByTime(WARN_THRESHOLD_MS + 500)
    const warn = sent.find((m) => m.type === 'message.stream_warn')
    expect(warn).toBeDefined()
  })

  /**
   * M8-4: 冷启动首 token 正常建立定时器（不被阈值逻辑误判跳过）。
   */
  it('M8-4: turn-start 后单 token → 静默达 ABORT 阈值 → onSilentAbort 触发（定时器正确建立）', () => {
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm-m8d' }])
    interpreter.interpret([textDelta()])
    // 静默超过 ABORT 阈值
    vi.advanceTimersByTime(ABORT_THRESHOLD_MS + 1_000)
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
  })
})
