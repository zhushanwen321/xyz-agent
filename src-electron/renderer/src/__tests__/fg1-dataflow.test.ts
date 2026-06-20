/**
 * FG1 step B 自检 —— 验证 mock + chat store 数据流跑通（非 UI）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/fg1-dataflow.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as mockApi from '@/api/mock'
import { useChatStore } from '@/stores/chat'

describe('FG1 mock + chat store 数据流', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('session.list 返回 5 个 fixture 全字段', async () => {
    const list = await mockApi.session.list()
    expect(list).toHaveLength(5)
    expect(list[0].id).toBe('s1')
    expect(list[0].label).toBe('重构 auth 模块')
    expect(list[0].status).toBe('active')
    expect(typeof list[0].tokenCount).toBe('number')
    expect(list[0].gitBranch).toBe('refactor-auth')
  })

  it('session.create 追加并返回新 session', async () => {
    const before = (await mockApi.session.list()).length
    const s = await mockApi.session.create('测试会话')
    const after = (await mockApi.session.list()).length
    expect(s.label).toBe('测试会话')
    expect(s.status).toBe('active')
    expect(after).toBe(before + 1)
  })

  it('session.switchSession 不存在的 id 抛错', async () => {
    await expect(mockApi.session.switchSession('nope')).rejects.toThrow()
    await expect(mockApi.session.switchSession('s1')).resolves.toBeUndefined()
  })

  it('chat.send 模拟流式（start → deltas → complete）', async () => {
    const types: string[] = []
    const unsub = mockApi.chat.streamSubscribe('s-flow', (msg) => types.push(msg.type))
    await mockApi.chat.send('s-flow', 'hello')
    expect(types[0]).toBe('message.message_start')
    expect(types[types.length - 1]).toBe('message.complete')
    expect(types.filter((t) => t === 'message.text_delta').length).toBeGreaterThan(0)
    unsub()
  })

  it('chat store appendUser + appendAssistantChunk 产出完整回合', async () => {
    const store = useChatStore()
    store.appendUser('s1', '帮我重构')
    const unsub = mockApi.chat.streamSubscribe('s1', (msg) =>
      store.appendAssistantChunk('s1', msg),
    )
    await mockApi.chat.send('s1', '帮我重构')
    unsub()

    const msgs = store.getMessages('s1')
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('帮我重构')
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].status).toBe('complete')
    expect(msgs[1].content.length).toBeGreaterThan(0)
  })

  it('chat store 按 sessionId 隔离（s1/s2 互不干扰）', () => {
    const store = useChatStore()
    store.appendUser('s1', 'A')
    store.appendUser('s2', 'B')
    expect(store.getMessages('s1')).toHaveLength(1)
    expect(store.getMessages('s2')).toHaveLength(1)
    expect(store.getMessages('s1')[0].content).toBe('A')
    expect(store.getMessages('s2')[0].content).toBe('B')
  })
})
