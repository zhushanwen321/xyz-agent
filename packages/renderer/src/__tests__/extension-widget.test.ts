/**
 * extension domain onWidget/onStatus 订阅（issues.md #11 / code-architecture §4.9）。
 * 验证：session 通道过滤、1000 行截断、未知 type 忽略、取消订阅、session 隔离。
 */
import { describe, it, expect } from 'vitest'
import * as events from '../api/events'
import * as extension from '../api/domains/extension'

describe('extension domain onWidget/onStatus', () => {
  it('onWidget 收到 extension:widget 并透传 payload', () => {
    const received: { key: string; lines: string[] }[] = []
    const off = extension.onWidget('sess-1', (p) => received.push({ key: p.widgetKey, lines: p.lines }))
    events.dispatchSession('sess-1', {
      type: 'extension:widget',
      payload: { sessionId: 'sess-1', widgetKey: 'terminal', lines: ['a', 'b'] },
    })
    off()
    expect(received).toEqual([{ key: 'terminal', lines: ['a', 'b'] }])
  })

  it('onWidget 忽略非 extension:widget 消息（session 通道上的其他 type 不触发）', () => {
    let hit = false
    const off = extension.onWidget('sess-1', () => {
      hit = true
    })
    events.dispatchSession('sess-1', {
      type: 'extension:status',
      payload: { sessionId: 'sess-1', statusKey: 'k', text: 't' },
    })
    events.dispatchSession('sess-1', { type: 'message.complete', payload: { sessionId: 'sess-1' } })
    off()
    expect(hit).toBe(false)
  })

  it('onWidget 截断超过 1000 行的 payload，保留尾部最新', () => {
    const big = Array.from({ length: 1500 }, (_, i) => `line-${i}`)
    let received: string[] = []
    const off = extension.onWidget('sess-1', (p) => {
      received = p.lines
    })
    events.dispatchSession('sess-1', {
      type: 'extension:widget',
      payload: { sessionId: 'sess-1', widgetKey: 'terminal', lines: big },
    })
    off()
    expect(received).toHaveLength(1000)
    // 保留尾部：line-500（索引 500）到 line-1499
    expect(received[0]).toBe('line-500')
    expect(received[999]).toBe('line-1499')
  })

  it('onWidget 取消订阅后不再触发', () => {
    let count = 0
    const off = extension.onWidget('sess-1', () => {
      count++
    })
    events.dispatchSession('sess-1', {
      type: 'extension:widget',
      payload: { sessionId: 'sess-1', widgetKey: 'terminal', lines: ['x'] },
    })
    off()
    events.dispatchSession('sess-1', {
      type: 'extension:widget',
      payload: { sessionId: 'sess-1', widgetKey: 'terminal', lines: ['y'] },
    })
    expect(count).toBe(1)
  })

  it('onWidget 按 sessionId 隔离（其他 session 的 widget 不触发）', () => {
    let hit = false
    const off = extension.onWidget('sess-1', () => {
      hit = true
    })
    events.dispatchSession('sess-2', {
      type: 'extension:widget',
      payload: { sessionId: 'sess-2', widgetKey: 'terminal', lines: ['x'] },
    })
    off()
    expect(hit).toBe(false)
  })

  it('onStatus 收到 extension:status 并透传 payload', () => {
    const received: { key: string; text: string }[] = []
    const off = extension.onStatus('sess-1', (p) => received.push({ key: p.statusKey, text: p.text }))
    events.dispatchSession('sess-1', {
      type: 'extension:status',
      payload: { sessionId: 'sess-1', statusKey: 'progress', text: 'building' },
    })
    off()
    expect(received).toEqual([{ key: 'progress', text: 'building' }])
  })
})
