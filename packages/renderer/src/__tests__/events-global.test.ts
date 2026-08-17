import { describe, it, expect } from 'vitest'
import * as events from '../api/events'

describe('events 全局通道', () => {
  it('onGlobalType 注册后，dispatchGlobal 同 type 触发 handler，off 后不再触发', () => {
    const received: string[] = []
    const off = events.onGlobalType('config.skills', (msg) => {
      received.push(msg.type)
    })
    events.dispatchGlobal({ type: 'config.skills', payload: { skills: [] } })
    expect(received).toEqual(['config.skills'])
    off()
    events.dispatchGlobal({ type: 'config.skills', payload: { skills: [] } })
    expect(received).toEqual(['config.skills'])
  })

  it('onGlobal（全类型）收到所有 dispatchGlobal 消息', () => {
    const seen: string[] = []
    const off = events.onGlobal((msg) => seen.push(msg.type))
    events.dispatchGlobal({ type: 'config.providers', payload: {} })
    events.dispatchGlobal({ type: 'model.list', payload: {} })
    expect(seen).toEqual(['config.providers', 'model.list'])
    off()
  })

  it('dispatchSession 不触发 global handler（通道隔离）', () => {
    let globalHit = false
    const off = events.onGlobal(() => {
      globalHit = true
    })
    events.dispatchSession('sess-1', { type: 'message.text_delta', payload: { sessionId: 'sess-1' } })
    expect(globalHit).toBe(false)
    off()
  })

  it('dispatch（旧名）仍按 sessionId 路由，向后兼容', () => {
    const seen: string[] = []
    const off = events.on('sess-2', (msg) => seen.push(msg.type))
    events.dispatch('sess-2', { type: 'message.complete', payload: { sessionId: 'sess-2' } })
    expect(seen).toEqual(['message.complete'])
    off()
  })
})

describe('events crossSession 通道（ADR-0060）', () => {
  it('onCrossSession 注册后，dispatchCrossSession 触发 handler，off 后不再触发', () => {
    const seen: string[] = []
    const off = events.onCrossSession((msg) => seen.push(msg.type))
    events.dispatchCrossSession({ type: 'extension:widget', payload: { sessionId: 's1' } })
    expect(seen).toEqual(['extension:widget'])
    off()
    events.dispatchCrossSession({ type: 'extension:widget', payload: { sessionId: 's1' } })
    expect(seen).toEqual(['extension:widget'])
  })

  it('dispatchCrossSession 不触发 global/session handler（通道隔离）', () => {
    let globalHit = false
    let sessionHit = false
    const offG = events.onGlobal(() => {
      globalHit = true
    })
    const offS = events.on('s1', () => {
      sessionHit = true
    })
    events.dispatchCrossSession({ type: 'extension:widget', payload: { sessionId: 's1' } })
    expect(globalHit).toBe(false)
    expect(sessionHit).toBe(false)
    offG()
    offS()
  })

  it('dispatchSession/dispatchGlobal 不触发 crossSession handler（反向隔离）', () => {
    let crossHit = false
    const off = events.onCrossSession(() => {
      crossHit = true
    })
    events.dispatchSession('s1', { type: 'extension:widget', payload: { sessionId: 's1' } })
    events.dispatchGlobal({ type: 'config.providers', payload: {} })
    expect(crossHit).toBe(false)
    off()
  })

  it('无订阅者时 dispatchCrossSession 不抛（no-op）', () => {
    expect(() =>
      events.dispatchCrossSession({ type: 'extension:widget', payload: { sessionId: 's1' } }),
    ).not.toThrow()
  })
})
