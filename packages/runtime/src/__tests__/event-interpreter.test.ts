/**
 * EventInterpreter 编排测试。
 *
 * - session-renamed（MF-3 ②）：session_info_changed 中间事件 → onSessionRenamed 回调
 *   （组合根接 sessionService.setLabelCache，runtime 内存 label 自动同步链）
 * - compaction（M4 事件驱动：interpreter 唯一源）：
 *
 * 锁定（SSOT §3.3.4 编排表）：
 * - TC1: compaction_start{reason} → 广播 session.compacting{reason} + onCompactingStateChange(sid,true)
 * - TC2: compaction_end{result} 成功 → message.compactionSummary + session.compacted（无 error）
 *        + onContextUpdate(estimatedTokensAfter) + onCompactingStateChange(sid,false)
 * - TC3: compaction_end aborted（无 errorMessage 真值）→ session.compacted（不带 error）+ 复位，无 compactionSummary
 * - TC4: compaction_end failed（errorMessage 真值）→ session.compacted{error} + message.error 对话流提示 + 复位
 * - 孤儿 end 容错：无 preceding start 的 compaction_end → 复位对 false 幂等无害（不维护配对状态机）
 * - errorMessage 真值判据：aborted:true + errorMessage 真值 → 走 failed（真值优先于 aborted 字段）
 *
 * 运行：npx vitest run src/__tests__/event-interpreter.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import type { PiTranslatedEvent } from '../services/session/types.js'
import type { ServerMessage } from '@xyz-agent/shared'

function makeInterpreter(overrides: {
  send?: (m: ServerMessage) => void
  onCompactingStateChange?: (sid: string, v: boolean) => void
  onContextUpdate?: (sid: string, data: { inputTokens: number; totalTokens: number }) => void
  onSessionRenamed?: (sid: string, name: string | undefined) => void
} = {}) {
  const sent: ServerMessage[] = []
  const send = overrides.send ?? ((m: ServerMessage) => { sent.push(m) })
  const onCompactingStateChange = overrides.onCompactingStateChange ?? vi.fn()
  const onContextUpdate = overrides.onContextUpdate ?? vi.fn()
  const onSessionRenamed = overrides.onSessionRenamed ?? vi.fn()
  const interp = new EventInterpreter('s1', { send, onCompactingStateChange, onContextUpdate, onSessionRenamed })
  return { interp, sent, onCompactingStateChange, onContextUpdate, onSessionRenamed }
}

describe('EventInterpreter session-renamed 编排（MF-3 ②，label 自动同步链）', () => {
  // 链路：event-adapter session_info_changed → {kind:'session-renamed'} → 本 case →
  // onSessionRenamed → 组合根 sessionService.setLabelCache（runtime 内存 label 唯一
  // 数据源）。缺测刻痕：本链路历经 3 个 fix commit 仍无回归钉住。
  it('TC-RN1: session-renamed{name} → onSessionRenamed(sid, name)', () => {
    const { interp, onSessionRenamed } = makeInterpreter()
    interp.interpret([{ kind: 'session-renamed', name: 'renamed-by-pi' }])
    expect(onSessionRenamed).toHaveBeenCalledTimes(1)
    expect(onSessionRenamed).toHaveBeenCalledWith('s1', 'renamed-by-pi')
  })

  it('TC-RN2: name undefined → 回调透传 undefined（组合根 ?? "" 兜底，不伪造名字）', () => {
    const { interp, onSessionRenamed } = makeInterpreter()
    interp.interpret([{ kind: 'session-renamed', name: undefined }])
    expect(onSessionRenamed).toHaveBeenCalledWith('s1', undefined)
  })
})

describe('EventInterpreter compaction 编排 (M4 事件驱动)', () => {
  it('TC1: compaction_start{reason} → session.compacting{reason} + isCompacting=true', () => {
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{ kind: 'compaction-start', reason: 'manual' }])

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('session.compacting')
    expect(sent[0].payload).toMatchObject({ sessionId: 's1', status: 'compacting', reason: 'manual' })
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', true)
  })

  it('TC1-auto: compaction_start{reason:"threshold"} → reason 透传（驱动前端自动文案）', () => {
    const { interp, sent } = makeInterpreter()
    interp.interpret([{ kind: 'compaction-start', reason: 'threshold' }])
    expect(sent[0].payload).toMatchObject({ reason: 'threshold' })
  })

  it('TC2: compaction_end{result} 成功 → compactionSummary + contextUpdate + session.compacted（无 error）+ 复位', () => {
    const onContextUpdate = vi.fn()
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onContextUpdate, onCompactingStateChange })

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'manual',
      result: { summary: '压缩摘要', tokensBefore: 100, estimatedTokensAfter: 30 },
      aborted: false,
    }])

    // compactionSummary 进对话流
    const summary = sent.find((m) => m.type === 'message.compactionSummary')
    expect(summary).toBeDefined()
    expect(summary!.payload).toMatchObject({ sessionId: 's1', summary: '压缩摘要', tokensBefore: 100 })
    // context 用量刷新（estimatedTokensAfter）
    expect(onContextUpdate).toHaveBeenCalledWith('s1', { inputTokens: 30, totalTokens: 30 })
    // session.compacted 不带 error → 前端 compacted handler flush queue
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
    expect(compacted!.payload).toMatchObject({ sessionId: 's1', status: 'compacted' })
    expect((compacted!.payload as { error?: string }).error).toBeUndefined()
    // 复位对称（SUG-新2）
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', false)
  })

  it('TC2b: compaction_end{result 无 summary} 成功（D2 closure）→ 仍恒发 compactionSummary 帧（summary 缺省透传，reducer 侧两侧同 fallback）', () => {
    const { interp, sent } = makeInterpreter({})

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'auto',
      result: { tokensBefore: 999 }, // summary 缺失（LLM 异常返回无摘要的成功压缩）
      aborted: false,
    }])

    // 恒发帧（原 `if (r.summary)` 真值门已删）：payload.summary 为 undefined，下游
    // registry/reducer 走「上下文已压缩」fallback——live 与重开（pi 无条件落盘）一致，
    // 登记例外④消灭（等价性断言见 apply-entry-equivalence E4b）
    const summary = sent.find((m) => m.type === 'message.compactionSummary')
    expect(summary).toBeDefined()
    expect(summary!.payload).toMatchObject({ sessionId: 's1', summary: undefined, tokensBefore: 999 })
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
  })

  it('TC3: compaction_end aborted（无 errorMessage 真值）→ session.compacted（不带 error）+ 复位，无 compactionSummary', () => {
    const onContextUpdate = vi.fn()
    const { interp, sent } = makeInterpreter({ onContextUpdate })

    interp.interpret([{ kind: 'compaction-end', reason: 'threshold', result: undefined, aborted: true }])

    // 无 compactionSummary（压缩未发生）+ 无 message.error（非失败）
    expect(sent.find((m) => m.type === 'message.compactionSummary')).toBeUndefined()
    expect(sent.find((m) => m.type === 'message.error')).toBeUndefined()
    // context 不刷新
    expect(onContextUpdate).not.toHaveBeenCalled()
    // session.compacted 不带 error → 前端 flush（释放 compacting 期间积压消息）
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
    expect((compacted!.payload as { error?: string }).error).toBeUndefined()
  })

  it('TC4: compaction_end failed（errorMessage 真值）→ session.compacted{error} + message.error 对话流提示 + 复位', () => {
    const onContextUpdate = vi.fn()
    const { interp, sent } = makeInterpreter({ onContextUpdate })

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'manual',
      aborted: false,
      errorMessage: 'LLM 报错',
    }])

    // session.compacted 带 error → 前端 compacted handler error 非空 → 不 flush（队列保留）
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
    expect((compacted!.payload as { error?: string }).error).toBe('LLM 报错')
    // message.error 进对话流（错误作为 assistant 消息插入，AGENTS.md 规则 #3）
    const errMsg = sent.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect((errMsg!.payload as { message?: string }).message).toContain('上下文压缩失败')
    expect((errMsg!.payload as { message?: string }).message).toContain('LLM 报错')
    // 无 compactionSummary（压缩未成功）
    expect(sent.find((m) => m.type === 'message.compactionSummary')).toBeUndefined()
    // context 不刷新
    expect(onContextUpdate).not.toHaveBeenCalled()
  })

  it('errorMessage 真值判据：aborted:true + errorMessage 真值 → 走 failed（真值优先于 aborted 字段）', () => {
    // SSOT §3.3.4：失败判据以 errorMessage 真值为准（非 aborted 字段）。
    // pi 三种 aborted:true 形态在 errorMessage 真值层面一致（都 falsy），但若 errorMessage 有值则属 failed。
    const { interp, sent } = makeInterpreter()
    interp.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: true, errorMessage: '取消时附带错误' }])

    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect((compacted!.payload as { error?: string }).error).toBe('取消时附带错误')
    expect(sent.find((m) => m.type === 'message.error')).toBeDefined()
  })

  it('孤儿 compaction_end 容错：无 preceding start → 复位对 false 幂等无害（不维护配对状态机）', () => {
    // SSOT SUG-新3：overflow「已 retry 过一次」早退路径无 compaction_start，直接发 compaction_end{errorMessage}。
    // interpreter 不因「未收到 start」拒绝处理 end，自洽处理（复位 + 按 errorMessage 真值判分支）。
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'overflow',
      aborted: false,
      errorMessage: 'overflow retry exhausted',
    }])

    // failed 分支：session.compacted{error} + message.error
    expect((sent.find((m) => m.type === 'session.compacted')!.payload as { error?: string }).error).toBe('overflow retry exhausted')
    expect(sent.find((m) => m.type === 'message.error')).toBeDefined()
    // 复位（对本来 false 的 isCompacting 写 false，幂等无害）
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', false)
  })

  it('完整生命周期：start → end 成功（置位/复位对称）', () => {
    const onCompactingStateChange = vi.fn()
    const { interp } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{ kind: 'compaction-start', reason: 'manual' }])
    interp.interpret([{
      kind: 'compaction-end',
      reason: 'manual',
      result: { summary: 'S', tokensBefore: 50, estimatedTokensAfter: 20 },
      aborted: false,
    }])

    // 置位 + 复位各一次，顺序 true → false
    expect(onCompactingStateChange).toHaveBeenNthCalledWith(1, 's1', true)
    expect(onCompactingStateChange).toHaveBeenNthCalledWith(2, 's1', false)
  })
})
