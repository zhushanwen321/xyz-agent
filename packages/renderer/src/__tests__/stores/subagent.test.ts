/**
 * subagent store 单测 —— state / getters / actions 覆盖。
 *
 * 覆盖：
 * - records 初值空数组
 * - loadSubagents 成功写入 records + 失败清空
 * - clearSubagents 清空 records + 退出所有 panel overlay
 * - isViewing / getViewingSubagentId / getActiveSubagentVirtualId per-panel 隔离
 * - getCurrentSubagent 从 records 查找
 * - isRunning 读 records status
 * - selectSubagent 写入 viewing 状态 + 调 setMessages 注入历史
 * - backToMain 清除 viewing + 停止 streaming/轮询
 *
 * 运行：npx vitest run src/__tests__/stores/subagent.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSubagentStore } from '@/stores/subagent'
import type { SubagentRecord, Message } from '@xyz-agent/shared'

// mock sessionApi（loadSubagents / selectSubagent 内部调用）
vi.mock('@/api/domains/session', () => ({
  getSubagents: vi.fn(),
  getSubagentHistory: vi.fn(),
}))

import * as sessionApi from '@/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 构造测试 SubagentRecord */
function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'bg-test-1-111',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    slug: 'review-code',
    task: 'Review the code',
    status: 'done',
    ...overrides,
  }
}

/** chatStore mock：getMessages/setMessages 收集调用 */
function makeChatMock() {
  const messages = new Map<string, Message[]>()
  return {
    getMessages: vi.fn((sid: string) => messages.get(sid) ?? []),
    setMessages: vi.fn((sid: string, msgs: Message[]) => { messages.set(sid, msgs) }),
    _map: messages,
  }
}

describe('subagent store — state 初值', () => {
  it('records 初值为空数组', () => {
    const store = useSubagentStore()
    expect(store.records).toEqual([])
  })
})

describe('subagent store — loadSubagents', () => {
  it('成功时写入 records', async () => {
    const records = [makeRecord(), makeRecord({ subagentId: 'bg-2', agent: 'worker' })]
    vi.mocked(sessionApi.getSubagents).mockResolvedValue(records)

    const store = useSubagentStore()
    await store.loadSubagents('session-1')

    expect(store.records).toHaveLength(2)
    expect(store.records[0].agent).toBe('reviewer')
  })

  it('失败时 records 清空', async () => {
    vi.mocked(sessionApi.getSubagents).mockRejectedValue(new Error('network'))

    const store = useSubagentStore()
    store.records = [makeRecord()] // 预置旧数据
    await store.loadSubagents('session-1')

    expect(store.records).toEqual([])
  })

  it('sessionId 为空时 records 清空', async () => {
    const store = useSubagentStore()
    store.records = [makeRecord()]
    await store.loadSubagents('')

    expect(store.records).toEqual([])
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })
})

describe('subagent store — clearSubagents', () => {
  it('清空 records + 退出所有 panel overlay', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    // 预置：panel-A 正在看一个 subagent
    store.records = [makeRecord({ status: 'done' })]
    await store.selectSubagent('panel-A', 'session-1', 'bg-test-1-111', chat.getMessages, chat.setMessages)
    expect(store.isViewing('panel-A')).toBe(true)

    store.clearSubagents()

    expect(store.records).toEqual([])
    expect(store.isViewing('panel-A')).toBe(false)
  })
})

describe('subagent store — per-panel getters', () => {
  it('isViewing per-panel 隔离', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.getMessages, chat.setMessages)

    expect(store.isViewing('panel-A')).toBe(true)
    expect(store.isViewing('panel-B')).toBe(false)
  })

  it('getViewingSubagentId 返回当前查看的 subagentId', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.getMessages, chat.setMessages)

    expect(store.getViewingSubagentId('panel-A')).toBe('bg-1')
    expect(store.getViewingSubagentId('panel-B')).toBeNull()
  })

  it('getActiveSubagentVirtualId 返回虚拟 session ID', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.getMessages, chat.setMessages)

    expect(store.getActiveSubagentVirtualId('panel-A')).toBe('subagent:bg-1')
  })

  it('getCurrentSubagent 从 records 查找当前查看的记录', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()
    store.records = [makeRecord({ subagentId: 'bg-target', agent: 'worker' })]

    await store.selectSubagent('panel-A', 'session-1', 'bg-target', chat.getMessages, chat.setMessages)

    const record = store.getCurrentSubagent('panel-A')
    expect(record?.agent).toBe('worker')
    expect(store.getCurrentSubagent('panel-B')).toBeNull()
  })
})

describe('subagent store — isRunning', () => {
  it('status=running 返回 true', () => {
    const store = useSubagentStore()
    store.records = [makeRecord({ subagentId: 'bg-1', status: 'running' })]

    expect(store.isRunning('bg-1')).toBe(true)
  })

  it('status=done 返回 false', () => {
    const store = useSubagentStore()
    store.records = [makeRecord({ subagentId: 'bg-1', status: 'done' })]

    expect(store.isRunning('bg-1')).toBe(false)
  })

  it('未知 subagentId 返回 false', () => {
    const store = useSubagentStore()
    expect(store.isRunning('nonexistent')).toBe(false)
  })
})

describe('subagent store — selectSubagent', () => {
  it('调 getSubagentHistory + setMessages 注入历史', async () => {
    const fakeHistory: Message[] = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
    ]
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue(fakeHistory)
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.getMessages, chat.setMessages)

    expect(sessionApi.getSubagentHistory).toHaveBeenCalledWith('session-1', 'bg-1')
    expect(chat.setMessages).toHaveBeenCalledWith('subagent:bg-1', fakeHistory)
  })

  it('getSubagentHistory 失败时 setMessages 注入空数组', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockRejectedValue(new Error('network'))
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.getMessages, chat.setMessages)

    expect(chat.setMessages).toHaveBeenCalledWith('subagent:bg-1', [])
  })
})

describe('subagent store — backToMain', () => {
  it('清除 viewing 状态', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.getMessages, chat.setMessages)
    expect(store.isViewing('panel-A')).toBe(true)

    store.backToMain('panel-A')

    expect(store.isViewing('panel-A')).toBe(false)
    expect(store.getViewingSubagentId('panel-A')).toBeNull()
  })
})
