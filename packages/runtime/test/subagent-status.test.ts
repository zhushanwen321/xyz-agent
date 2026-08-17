import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeSubagentStatus } from '../src/services/session/subagent-status.js'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('未知状态触发 console.warn 兜底告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    normalizeSubagentStatus('future-status')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[normalizeSubagentStatus] unknown status'),
    )
    // 已知状态不触发 warn
    warnSpy.mockClear()
    normalizeSubagentStatus('done')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
