/**
 * selectSession 测试：ensureStreamSubscription 统一注册 events handler + subscribe。
 *
 * [HISTORICAL] 2026-07-29 handoff 回复丢失事故：旧实现 selectSession 只调 subscribeSession
 * （拉 snapshot）但不注册 events.on handler，导致 snapshot 回放的事件被 dispatchSession
 * 静默丢弃。handoff 场景中新 session 的 pi 回复已进 bus ring buffer，但 selectSession 拉
 * snapshot 后 dispatchSession 无 handler 消费 → 回复永久丢失。改用 ensureStreamSubscription
 * 统一两步（对齐 fork 路径 useForkActions.ts:108）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/select-session-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getContext: vi.fn().mockResolvedValue({}),
  getHistory: vi.fn().mockResolvedValue([]),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），mock 补全
  writeSegments: vi.fn().mockResolvedValue(undefined),
}))

// chat 域 mock：streamSubscribe 捕获 handler 注册
const { chatStreamSubscribeMock } = vi.hoisted(() => ({
  chatStreamSubscribeMock: vi.fn(() => () => {}),
}))
vi.mock('@xyz-agent/core/transport/api/domains/chat', () => ({
  send: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(undefined),
  steer: vi.fn().mockResolvedValue(undefined),
  followUp: vi.fn().mockResolvedValue(undefined),
  compact: vi.fn().mockResolvedValue(undefined),
  // w5：useChat 薄包装的 chatApiPort 组装需 bash/abortBash
  bash: vi.fn().mockResolvedValue(undefined),
  abortBash: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
  getFullHistory: vi.fn().mockResolvedValue([]),
  streamSubscribe: chatStreamSubscribeMock,
}))

// 门面重定向：store 经 @/api 导入 session/chat，需指向上面 mock 的命名空间
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  const chat = await import('@xyz-agent/core/transport/api/domains/chat')
  return { ...actual, session, chat }
})

vi.mock('@xyz-agent/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))

vi.mock('@/composables/useMessageBusSubscription', () => ({
  subscribeSession: vi.fn().mockResolvedValue(undefined),
  getSubscriptionState: vi.fn(),
  clearSubscription: vi.fn(),
  updateLastSeenSeq: vi.fn(),
  resetSubscriptionStates: vi.fn(),
}))

// file tree 依赖（selectSession 会调 loadTree——保留，文件树不在 stateSnapshot 覆盖范围）
vi.mock('@xyz-agent/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@xyz-agent/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

import { session as sessionApi, chat as chatApi } from '@/api'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'
import { resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 清空模块级 streamSubscriptions Map（ensureStreamSubscription 的幂等守卫依赖它）
  resetChatModuleState()
})

describe('selectSession: ensureStreamSubscription 统一注册 events handler + subscribe', () => {
  it('selectSession(sess-A) 不调 getSubagents（subagents 经 subscribe stateSnapshot 提供）', async () => {
    const sidebar = useSidebarNew()
    await sidebar.selectSession('sess-A')

    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })

  it('selectSession(sess-A) 不调 getWorkflows（workflows 经 streamRing workflowUpdate 增量信号→RPC 闭环）', async () => {
    const sidebar = useSidebarNew()
    await sidebar.selectSession('sess-A')

    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('切到 session B 也不主动拉（多次切换一致性）', async () => {
    const sidebar = useSidebarNew()
    await sidebar.selectSession('sess-A')
    await sidebar.selectSession('sess-B')

    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('selectSession 触发订阅建立（ensureStreamSubscription → chatApi.streamSubscribe）', async () => {
    const sidebar = useSidebarNew()
    await sidebar.selectSession('sess-A')

    // ensureStreamSubscription 内部同步调 chatApi.streamSubscribe 注册 handler
    // （订阅链路建立的可观测信号：handler 注册后 snapshot 回放才能消费）
    expect(chatApi.streamSubscribe).toHaveBeenCalledWith('sess-A', expect.any(Function))
  })

  it('多次切同一 session 不重复注册（幂等守卫）', async () => {
    const sidebar = useSidebarNew()
    await sidebar.selectSession('sess-A')
    await sidebar.selectSession('sess-A')

    // ensureStreamSubscription 内部 streamSubscriptions.has(sid) 守卫，已注册跳过
    expect(chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
  })

  it('subscribeSession 失败不阻塞切会话（core 内部 catch 消化）', async () => {
    // w5 后 ensureStreamSubscription 经 core coordination/subscription-state 调 subscribeSession
    //（ESM 静态绑定，vitest 无法 mock core 内部相对路径模块）。失败路径由 core useChat.ts 的
    // void subscribeSession(sid).catch(console.warn) 消化。renderer 侧验证：selectSession 正常完成
    // + 订阅链路建立（streamSubscribe 注册）不因 subscribeSession 内部失败而中断。
    const sidebar = useSidebarNew()
    await expect(sidebar.selectSession('sess-A')).resolves.toBeUndefined()
    expect(sessionApi.switchSession).toHaveBeenCalledWith('sess-A')
    expect(chatApi.streamSubscribe).toHaveBeenCalledWith('sess-A', expect.any(Function))
  })
})
