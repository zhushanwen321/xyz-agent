import { describe, it, expect } from 'vitest'
import { normalizeSubagentStatus, deriveClosedDisplay } from '../src/subagent'

describe('normalizeSubagentStatus', () => {
  it('done / completed / success → done', () => {
    expect(normalizeSubagentStatus('done')).toBe('done')
    expect(normalizeSubagentStatus('completed')).toBe('done')
    expect(normalizeSubagentStatus('success')).toBe('done')
  })

  it('failed / error → failed', () => {
    expect(normalizeSubagentStatus('failed')).toBe('failed')
    expect(normalizeSubagentStatus('error')).toBe('failed')
  })

  it('cancelled / canceled → cancelled', () => {
    expect(normalizeSubagentStatus('cancelled')).toBe('cancelled')
    expect(normalizeSubagentStatus('canceled')).toBe('cancelled')
  })

  it('crashed → crashed', () => {
    expect(normalizeSubagentStatus('crashed')).toBe('crashed')
  })

  it('running / pending / active → running', () => {
    expect(normalizeSubagentStatus('running')).toBe('running')
    expect(normalizeSubagentStatus('pending')).toBe('running')
    expect(normalizeSubagentStatus('active')).toBe('running')
  })

  it('closed → closed', () => {
    expect(normalizeSubagentStatus('closed')).toBe('closed')
  })

  it('undefined / 空串 → running（无状态信息，保持初始运行态）', () => {
    expect(normalizeSubagentStatus(undefined)).toBe('running')
    expect(normalizeSubagentStatus('')).toBe('running')
  })

  it('未知值 → closed（终态方向兜底，不把已结束记录翻回运行中）', () => {
    expect(normalizeSubagentStatus('unknown')).toBe('closed')
    expect(normalizeSubagentStatus('whatever')).toBe('closed')
    // idle 是 v4 已删除的死值（idle 已折入 running），按未知值走终态兜底
    expect(normalizeSubagentStatus('idle')).toBe('closed')
  })
})

describe('deriveClosedDisplay（closed 统一终态的展示派生，v4 B-1）', () => {
  it('closedReason=cancelled → cancelled', () => {
    expect(deriveClosedDisplay({ closedReason: 'cancelled' })).toBe('cancelled')
  })

  it('cancelled + error → cancelled（取消优先，error 不参与——对齐 TUI cancelled 分支先于 error 检查）', () => {
    expect(deriveClosedDisplay({ closedReason: 'cancelled', error: 'aborted' })).toBe('cancelled')
  })

  it('closedReason=gc + error → failed（gc 失败终态，真实失败）', () => {
    expect(deriveClosedDisplay({ closedReason: 'gc', error: 'Model timeout' })).toBe('failed')
  })

  it('closedReason 缺失 + error → failed（legacy 兜底 gc，对齐 extension 侧 closedReason ?? "gc"）', () => {
    expect(deriveClosedDisplay({ error: 'boom' })).toBe('failed')
  })

  it('分歧输入回归：parent-*/user-close 级联关闭 + 合成 error → done（非 failed）', () => {
    // disposeAllRecords 级联关闭合成 error: "closed due to parent-fork/parent-new" 等，
    // 是正常关闭语义而非 subagent 自身失败——与 extension TUI/LLM 文案一致判 finished。
    // 旧规则（error 有值即 failed）会把正常级联关闭显示为失败，此用例锁定不回退。
    expect(deriveClosedDisplay({ closedReason: 'parent-fork', error: 'closed due to parent-fork' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-new', error: 'closed due to parent-new' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-shutdown', error: 'closed due to parent-shutdown' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'user-close', error: 'closed due to user-close' })).toBe('done')
  })

  it('其余 closed → done（自然完成 / parent-* / user-close / gc 无 error / 无任何字段）', () => {
    expect(deriveClosedDisplay({ closedReason: 'gc' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-fork' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-new' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'user-close' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-shutdown' })).toBe('done')
    expect(deriveClosedDisplay({})).toBe('done')
  })
})
