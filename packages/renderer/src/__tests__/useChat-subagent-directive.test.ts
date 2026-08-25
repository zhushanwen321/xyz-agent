/**
 * useChat `@` 定向消息转发单测（U2b chatApiPort.subagentAction 增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/useChat-subagent-directive.test.ts
 *
 * 覆盖：renderer useChat 的 ChatApiPort.subagentAction 懒转发——send 携带 subagent 段时
 * 经端口调 session.subagentAction（sid, action, params），不走主 agent send 通道。
 * mock 骨架对齐 useChat.test.ts（@/api chat/session/project 三域 stub）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, Segment } from '@xyz-agent/shared'

const { subagentActionMock, sendMock } = vi.hoisted(() => ({
  subagentActionMock: vi.fn().mockResolvedValue(undefined),
  sendMock: vi.fn().mockResolvedValue(undefined),
}))

const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    getHistory: vi.fn(() => Promise.resolve([])),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: sendMock,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: vi.fn(() => Promise.resolve()),
    steer: apiMock.steer,
    followUp: apiMock.followUp,
  },
  session: {
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    writeSegments: vi.fn().mockResolvedValue(undefined),
    // 本测试的主角：subagent 定向消息 RPC（经 renderer useChat chatApiPort 转发）
    subagentAction: subagentActionMock,
  },
}))

import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
})

describe('useChat subagent 定向消息转发', () => {
  it('send 含 subagent 段（subagentId 非空）→ 经 chatApiPort 调 session.subagentAction(message)，不走主 agent send', async () => {
    const { send } = useChat()
    const segments: Segment[] = [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '展开讲讲' },
    ]
    await send('s-directive', segments)

    expect(subagentActionMock).toHaveBeenCalledTimes(1)
    expect(subagentActionMock).toHaveBeenCalledWith('s-directive', 'message', {
      subagentId: 'rec-1',
      text: '展开讲讲',
    })
    // 无主 agent turn（§3.3.8：不经 message.send 通道）
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('subagentId 空串（新建占位 chip）→ subagentAction(start)，slug 自动生成', async () => {
    const { send } = useChat()
    const segments: Segment[] = [
      { type: 'subagent', subagentId: '', slug: '新任务' },
      { type: 'text', text: '帮我修 bug' },
    ]
    await send('s-start-action', segments)

    expect(subagentActionMock).toHaveBeenCalledWith('s-start-action', 'start', {
      slug: expect.stringMatching(/^chat-/),
      task: '帮我修 bug',
    })
    expect(sendMock).not.toHaveBeenCalled()
  })
})
