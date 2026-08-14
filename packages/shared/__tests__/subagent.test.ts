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
    // cancelled 携带 error 也不覆盖：取消语义优先（用户主动行为非失败）
    expect(deriveClosedDisplay({ closedReason: 'cancelled', error: 'aborted' })).toBe('cancelled')
  })

  it('error 有值 → failed（gc 失败终态；closedReason 缺失的 legacy 数据同理）', () => {
    expect(deriveClosedDisplay({ closedReason: 'gc', error: 'Model timeout' })).toBe('failed')
    expect(deriveClosedDisplay({ error: 'boom' })).toBe('failed')
  })

  it('其余 closed → done（自然完成 / parent-fork / parent-new / user-close / 无 reason）', () => {
    expect(deriveClosedDisplay({ closedReason: 'gc' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-fork' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-new' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'user-close' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-shutdown' })).toBe('done')
    expect(deriveClosedDisplay({})).toBe('done')
  })
})
