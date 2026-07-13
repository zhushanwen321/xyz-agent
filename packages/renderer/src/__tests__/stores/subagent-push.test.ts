/**
 * E1/E2 TDD tests：subagent store subscribeSubagentPush + 切会话重订阅。
 *
 * E1：订阅 session.subagents 推送后，records 自动更新驱动 badge 计数
 * E2：切会话重订阅到新 sessionId，旧 sessionId 推送不再影响 records
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSubagentStore } from '@/stores/subagent'
import * as events from '@/api/events'
import type { SubagentRecord, ServerMessage } from '@xyz-agent/shared'

// mock sessionApi（store 内部 import）
vi.mock('@/api/domains/session', () => ({
  getSubagents: vi.fn().mockResolvedValue([]),
  getSubagentHistory: vi.fn().mockResolvedValue([]),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  // events 模块的 sessionHandlers 是模块级 Map，每个测试前清空
  // 通过调用 off 不现实，直接用 events 模块的内部状态
})

/** 构造测试 SubagentRecord */
function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'bg-1',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'fix',
    task: 'Fix',
    status: 'running',
    ...overrides,
  }
}

/** 构造 session.subagents server message */
function makeSubagentsMsg(sessionId: string, subagents: SubagentRecord[]): ServerMessage {
  return {
    type: 'session.subagents',
    id: 'push-id',
    payload: { sessionId, subagents },
  } as ServerMessage
}

describe('E1: subscribeSubagentPush → records 自动更新', () => {
  it('订阅后 dispatchSession 推送 → records 替换为推送内容', () => {
    const store = useSubagentStore()
    const unsub = store.subscribeSubagentPush('session-1')

    const record = makeRecord()
    events.dispatchSession('session-1', makeSubagentsMsg('session-1', [record]))

    expect(store.records).toHaveLength(1)
    expect(store.records[0].subagentId).toBe('bg-1')
    expect(store.records[0].status).toBe('running')

    unsub()
  })

  it('Sidebar subagentCount computed 读 store.records.length = 1', () => {
    const store = useSubagentStore()
    const unsub = store.subscribeSubagentPush('session-1')

    events.dispatchSession('session-1', makeSubagentsMsg('session-1', [makeRecord()]))
    unsub()

    // subagentCount 是 Sidebar.vue 的 computed(() => store.records.length)
    // 这里直接验 store.records.length，等价于 badge 计数
    expect(store.records.length).toBe(1)
  })
})

describe('E2: 切会话重订阅 → 旧 sessionId 推送不再影响 records', () => {
  it('subscribeSubagentPush(session-B) 后，session-A 推送不覆盖 records', () => {
    const store = useSubagentStore()

    // 先订阅 session-A
    const unsubA = store.subscribeSubagentPush('session-A')
    events.dispatchSession('session-A', makeSubagentsMsg('session-A', [
      makeRecord({ subagentId: 'bg-a', agent: 'x' }),
    ]))
    expect(store.records).toHaveLength(1)
    expect(store.records[0].subagentId).toBe('bg-a')

    // 切到 session-B（取消旧订阅 + 订阅新的）
    unsubA()
    store.clearSubagents()
    const unsubB = store.subscribeSubagentPush('session-B')

    // session-B 首次推送
    events.dispatchSession('session-B', makeSubagentsMsg('session-B', [
      makeRecord({ subagentId: 'bg-b', agent: 'y' }),
    ]))
    expect(store.records[0].subagentId).toBe('bg-b')

    // session-A 再推送 → 不应影响（已取消订阅）
    events.dispatchSession('session-A', makeSubagentsMsg('session-A', [
      makeRecord({ subagentId: 'bg-a2', agent: 'z' }),
    ]))

    // records 仍是 session-B 的数据
    expect(store.records).toHaveLength(1)
    expect(store.records[0].subagentId).toBe('bg-b')

    unsubB()
  })
})
