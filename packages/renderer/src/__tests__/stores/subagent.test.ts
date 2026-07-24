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

// mock sessionApi（loadSubagents / selectSubagent / cancelSubagent 内部调用）
vi.mock('@/api/domains/session', () => ({
  getSubagents: vi.fn(),
  getSubagentHistory: vi.fn(),
  subagentAction: vi.fn(),
}))

// subagent store 经 @/api 门面导入 session，需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  return { ...actual, session }
})

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

/** chatStore mock：W4 新签名 —— applySubagentStreamDelta / finalizeSubagentStream / setMessages（fetchAndInject 用） */
function makeChatMock() {
  const messages = new Map<string, Message[]>()
  return {
    applySubagentStreamDelta: vi.fn((sid: string, lines: string[]) => {
      // 镜像 chat store 真实行为：全量替换 content + push 新 streaming（测试只需记录调用）
      const prev = messages.get(sid) ?? []
      messages.set(sid, [
        ...prev,
        {
          id: `sa-${Math.random()}`,
          role: 'assistant',
          content: lines.join('\n'),
          status: 'streaming',
          contentBlocks: [{ type: 'text', refId: 'text' }],
          timestamp: Date.now(),
        } as Message,
      ])
    }),
    finalizeSubagentStream: vi.fn((sid: string) => {
      const prev = messages.get(sid)
      if (!prev) return
      messages.set(sid, prev.map((m) => (m.status === 'streaming' ? { ...m, status: 'complete' } : m)))
    }),
    setMessages: vi.fn((sid: string, msgs: Message[]) => { messages.set(sid, msgs) }),
    _map: messages,
  }
}

describe('subagent store — state 初值', () => {
  it('recordsBySession 初值为空 Map', () => {
    const store = useSubagentStore()
    expect(store.getRecordsBySession('session-1')).toEqual([])
  })
})

describe('subagent store — loadSubagents', () => {
  it('成功时写入该 sid 分区', async () => {
    const records = [makeRecord(), makeRecord({ subagentId: 'bg-2', agent: 'worker' })]
    vi.mocked(sessionApi.getSubagents).mockResolvedValue(records)

    const store = useSubagentStore()
    await store.loadSubagents('session-1')

    expect(store.getRecordsBySession('session-1')).toHaveLength(2)
    expect(store.getRecordsBySession('session-1')[0].agent).toBe('reviewer')
  })

  it('失败时保留分区数据并设 loadError（M1：失败不覆盖）', async () => {
    vi.mocked(sessionApi.getSubagents).mockRejectedValue(new Error('network'))

    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord()]) // 预置旧数据
    await store.loadSubagents('session-1')

    // M1 契约：失败不覆盖现有分区数据，设 loadError 供错误态展示
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-test-1-111')
    expect(store.loadError).toBe('network')
    expect(store.isLoading).toBe(false)
  })

  it('sessionId 为空时不写分区', async () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord()])
    await store.loadSubagents('')

    // 空 sid 不写分区（已有数据保留，不调 RPC）
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })
})

describe('subagent store — clearSubagents', () => {
  it('清空所有分区 + 退出所有 panel overlay', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    // 预置：panel-A 正在看一个 subagent
    store.applyRecords('session-1', [makeRecord({ status: 'done' })])
    await store.selectSubagent('panel-A', 'session-1', 'bg-test-1-111', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)
    expect(store.isViewing('panel-A')).toBe(true)

    store.clearSubagents()

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.isViewing('panel-A')).toBe(false)
  })
})

describe('subagent store — clearSession (per-session 分区释放)', () => {
  it('清除指定 sid 分区，不影响其他 sid', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-a' })])
    store.applyRecords('session-2', [makeRecord({ subagentId: 'bg-b' })])

    store.clearSession('session-1')

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.getRecordsBySession('session-2')).toHaveLength(1)
  })

  it('清除不存在的 sid 分区是 no-op', () => {
    const store = useSubagentStore()
    expect(() => store.clearSession('never')).not.toThrow()
  })
})

describe('subagent store — per-panel getters', () => {
  it('isViewing per-panel 隔离', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)

    expect(store.isViewing('panel-A')).toBe(true)
    expect(store.isViewing('panel-B')).toBe(false)
  })

  it('getViewingSubagentId 返回当前查看的 subagentId', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)

    expect(store.getViewingSubagentId('panel-A')).toBe('bg-1')
    expect(store.getViewingSubagentId('panel-B')).toBeNull()
  })

  it('getActiveSubagentVirtualId 返回虚拟 session ID', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)

    expect(store.getActiveSubagentVirtualId('panel-A', 'session-1')).toBe('subagent:session-1:bg-1')
  })

  it('getCurrentSubagent 从 mainSession 分区查找当前查看的记录', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-target', agent: 'worker' })])

    await store.selectSubagent('panel-A', 'session-1', 'bg-target', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)

    const record = store.getCurrentSubagent('panel-A', 'session-1')
    expect(record?.agent).toBe('worker')
    expect(store.getCurrentSubagent('panel-B', 'session-1')).toBeNull()
  })
})

describe('subagent store — isRunning', () => {
  it('status=running 返回 true', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1', status: 'running' })])

    expect(store.isRunning('session-1', 'bg-1')).toBe(true)
  })

  it('status=done 返回 false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1', status: 'done' })])

    expect(store.isRunning('session-1', 'bg-1')).toBe(false)
  })

  it('未知 subagentId 返回 false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1' })])
    expect(store.isRunning('session-1', 'nonexistent')).toBe(false)
  })
})

describe('subagent store — hasRunning', () => {
  it('分区存在 running → true', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [
      makeRecord({ subagentId: 'bg-1', status: 'done' }),
      makeRecord({ subagentId: 'bg-2', status: 'running' }),
    ])
    expect(store.hasRunning('session-1')).toBe(true)
  })

  it('分区无 running → false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1', status: 'done' })])
    expect(store.hasRunning('session-1')).toBe(false)
  })

  it('未知 sid → false', () => {
    const store = useSubagentStore()
    expect(store.hasRunning('never')).toBe(false)
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

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)

    expect(sessionApi.getSubagentHistory).toHaveBeenCalledWith('session-1', 'bg-1')
    expect(chat.setMessages).toHaveBeenCalledWith('subagent:session-1:bg-1', fakeHistory)
  })

  it('getSubagentHistory 失败时 fail-fast throw（调用方负责 catch + 回滚）', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockRejectedValue(new Error('network'))
    const store = useSubagentStore()
    const chat = makeChatMock()

    // W2/M5 fail-fast 契约：selectSubagent → fetchAndInject 不静默注入空数组，
    // 错误上抛由调用方（onSelectSubagent）catch + toast + backToMain 回滚。
    await expect(
      store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages),
    ).rejects.toThrow('network')

    // 失败时不应注入历史（避免用户看到空对话流，无重试入口）
    expect(chat.setMessages).not.toHaveBeenCalled()
  })
})

describe('subagent store — backToMain', () => {
  it('清除 viewing 状态', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.selectSubagent('panel-A', 'session-1', 'bg-1', chat.applySubagentStreamDelta, chat.finalizeSubagentStream, chat.setMessages)
    expect(store.isViewing('panel-A')).toBe(true)

    store.backToMain('panel-A')

    expect(store.isViewing('panel-A')).toBe(false)
    expect(store.getViewingSubagentId('panel-A')).toBeNull()
  })
})

describe('subagent store — cancelSubagent', () => {
  it('调 subagentAction RPC + 乐观更新分区 status→cancelled', async () => {
    vi.mocked(sessionApi.subagentAction).mockResolvedValue(undefined)
    const store = useSubagentStore()
    // 预置一条 running subagent
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-cancel-target', status: 'running' })])
    expect(store.getRecordsBySession('session-1')[0].status).toBe('running')

    await store.cancelSubagent('session-1', 'bg-cancel-target')

    // 调了 RPC
    expect(sessionApi.subagentAction).toHaveBeenCalledWith('session-1', 'cancel', 'bg-cancel-target')
    // 乐观更新：status 变 cancelled（不等 WS 推送）
    expect(store.getRecordsBySession('session-1').find(r => r.subagentId === 'bg-cancel-target')?.status).toBe('cancelled')
  })

  it('RPC 失败 → 不改 status（乐观更新回滚）', async () => {
    vi.mocked(sessionApi.subagentAction).mockRejectedValue(new Error('session not active'))
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-fail', status: 'running' })])

    await expect(store.cancelSubagent('session-1', 'bg-fail')).rejects.toThrow('session not active')
    // status 保持 running（回滚）
    expect(store.getRecordsBySession('session-1').find(r => r.subagentId === 'bg-fail')?.status).toBe('running')
  })
})
