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

  it('undefined / 空串 / 未知值 → running（兜底）', () => {
    expect(normalizeSubagentStatus(undefined)).toBe('running')
    expect(normalizeSubagentStatus('')).toBe('running')
    expect(normalizeSubagentStatus('unknown')).toBe('running')
    expect(normalizeSubagentStatus('whatever')).toBe('running')
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
