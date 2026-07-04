/**
 * FG1 step B 自检 —— 验证 mock + chat store 数据流跑通（非 UI）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/fg1-dataflow.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as mockApi from '@/api/mock'
import { useChatStore } from '@/stores/chat'

describe('FG1 mock + chat store 数据流', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /**
   * 等待指定 session 的 message.complete 事件（mock send 为 ack-return 非阻塞，
   * 流式序列 fire-and-forget，测试需显式等 complete 才能断言终态）。
   */
  function waitForComplete(sid: string): Promise<void> {
    return new Promise((resolve) => {
      const unsub = mockApi.chat.streamSubscribe(sid, (msg) => {
        if (msg.type === 'message.complete') {
          unsub()
          resolve()
        }
      })
    })
  }

  it('session.list 按 cwd 分组返回（D7，对齐后端 SessionGroup[]）', async () => {
    const groups = await mockApi.session.list()
    // fixture 有 2 个 cwd（xyz-agent / work-project），故 2 组、共 5 个 session
    expect(groups.length).toBeGreaterThanOrEqual(2)
    const flat = groups.flatMap((g) => g.sessions)
    expect(flat).toHaveLength(5)
    const s1 = flat.find((s) => s.id === 's1')!
    expect(s1.label).toBe('重构 auth 模块')
    expect(s1.status).toBe('active')
    expect(typeof s1.tokenCount).toBe('number')
    expect(s1.gitBranch).toBe('refactor-auth')
    // 每组都有 cwd 且组内 session 的 cwd 一致
    for (const g of groups) {
      expect(g.cwd).toBeTruthy()
      expect(g.sessions.every((s) => s.cwd === g.cwd)).toBe(true)
    }
  })

  it('session.create 追加并返回新 session', async () => {
    const before = (await mockApi.session.list()).flatMap((g) => g.sessions).length
    const s = await mockApi.session.create(undefined, '测试会话')
    const after = (await mockApi.session.list()).flatMap((g) => g.sessions).length
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
    const done = waitForComplete('s-flow')
    await mockApi.chat.send('s-flow', 'hello')
    await done
    expect(types[0]).toBe('message.message_start')
    expect(types[types.length - 1]).toBe('message.complete')
    expect(types.filter((t) => t === 'message.text_delta').length).toBeGreaterThan(0)
    unsub()
  })

  it('chat store appendUser + applyMessageEvent 产出完整回合', async () => {
    const store = useChatStore()
    store.appendUser('s1', '帮我重构')
    const unsub = mockApi.chat.streamSubscribe('s1', (msg) =>
      store.applyMessageEvent('s1', msg),
    )
    const done = waitForComplete('s1')
    await mockApi.chat.send('s1', '帮我重构')
    await done
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
