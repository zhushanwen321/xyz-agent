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
