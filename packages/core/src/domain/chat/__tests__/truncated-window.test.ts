/**
 * [u4d-truncated-ui] 截断窗口状态测试（crash-resilience §3.3 D4）。
 *
 * 三视角（TEST-STRATEGY §3，本文件覆盖构建者白盒 + 使用者黑盒；DOM 视角在
 * ui/renderer 组件测试）：
 * 1. historyWindowFromReply 归一（u4b 全字段 / legacy 布尔 / 缺省字段）
 * 2. store hydrate/reconcile 路径写入窗口状态（必测断言⑤：hydrate 接线字段正确）
 * 3. loadMoreHistory 收敛 truncated（需求③：getFullHistory 被 mock api 层断言被调）
 * 4. disposeSession / LRU 驱逐清理分区
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/truncated-window.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { Message } from '@xyz-agent/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import type { UseChatDeps } from '../use-chat-types'
import { historyWindowFromReply } from '../truncated-window'

// ── 1. 归一函数 ──────────────────────────────────────────────────

describe('historyWindowFromReply 归一', () => {
  it('u4b 全字段 reply：truncated/loadedTurns/totalTurnsEstimate 原样透传', () => {
    expect(
      historyWindowFromReply({ historyTruncated: true, truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }),
    ).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
  })

  it('legacy reply（仅 historyTruncated 布尔）：truncated 回落，计数回落 0', () => {
    expect(historyWindowFromReply({ historyTruncated: false })).toEqual({
      truncated: false,
      loadedTurns: 0,
      totalTurnsEstimate: 0,
    })
    expect(historyWindowFromReply({ historyTruncated: true })).toEqual({
      truncated: true,
      loadedTurns: 0,
      totalTurnsEstimate: 0,
    })
  })
})

// ── 2/3/4. store + useChat 集成 ─────────────────────────────────

function makeMsg(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

function makeFixture() {
  const scope = effectScope(true)
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
    getFullHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
    streamSubscribe: vi.fn(() => vi.fn()),
  }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => ({ applySnapshot: vi.fn() }),
    toast: { error: vi.fn() },
    t: (k: string) => k,
    getCompactQueue: () => ({
      flush: vi.fn().mockResolvedValue(true),
      enqueue: vi.fn(),
      peek: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      confirmDelivery: vi.fn(() => false),
    }),
  }
  const useChat = scope.run(() => createUseChat(deps))!
  return {
    useChat,
    chatStore,
    chatApi,
    dispose: () => scope.stop(),
  }
}

describe('store 截断窗口状态（hydrate/reconcile 接线）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('必测⑤ hydrate 接线：hydrateHistory 把窗口契约字段正确写入 store 窗口状态', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({
      messages: [makeMsg('m1')],
      historyTruncated: true,
      truncated: true,
      loadedTurns: 20,
      totalTurnsEstimate: 42,
    })
    await f.useChat.hydrateHistory('s1')
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    // 布尔显隐从窗口状态派生（单一事实）
    expect(f.useChat.hasMoreHistory('s1')).toBe(true)
    f.dispose()
  })

  it('hydrate 不带 window（mock 门面 legacy reply）→ 无窗口记录，按未截断处理', async () => {
    const f = makeFixture()
    f.chatStore.hydrate('s1', [makeMsg('m1')])
    expect(f.chatStore.getHistoryWindow('s1')).toBeUndefined()
    expect(f.useChat.hasMoreHistory('s1')).toBe(false)
    f.dispose()
  })

  it('reconcileHistory 刷新窗口状态（切入链每次拿最新预算窗口响应）', async () => {
    const f = makeFixture()
    f.chatStore.hydrate('s1', [makeMsg('m1')], { truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    // 切出切回：u4b 预算窗口响应 → truncated 翻回 true（顶部条重显）
    f.chatStore.reconcileHistory('s1', [makeMsg('m2')], { truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    f.dispose()
  })

  it('reconcileHistory 未 hydrate 分支等价 hydrate：窗口状态一并写入', () => {
    const f = makeFixture()
    f.chatStore.reconcileHistory('s1', [makeMsg('m1')], { truncated: true, loadedTurns: 5, totalTurnsEstimate: 9 })
    expect(f.chatStore.isHydrated('s1')).toBe(true)
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 5, totalTurnsEstimate: 9 })
    f.dispose()
  })

  it('disposeSession 清理窗口分区', () => {
    const f = makeFixture()
    f.chatStore.hydrate('s1', [makeMsg('m1')], { truncated: true, loadedTurns: 3, totalTurnsEstimate: 9 })
    expect(f.chatStore.getHistoryWindow('s1')).toBeDefined()
    f.chatStore.disposeSession('s1')
    expect(f.chatStore.getHistoryWindow('s1')).toBeUndefined()
    f.dispose()
  })
})

describe('loadMoreHistory 全量通路收敛（需求③：点击「加载更早」触发 getFullHistory）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('truncated=true 时点击通路：loadMoreHistory 调 chatApi.getFullHistory 且收敛 truncated=false', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({
      messages: [makeMsg('m1')],
      historyTruncated: true,
      truncated: true,
      loadedTurns: 20,
      totalTurnsEstimate: 42,
    })
    await f.useChat.hydrateHistory('s1')
    expect(f.useChat.hasMoreHistory('s1')).toBe(true)

    // 「加载更早」→ getFullHistory（mock api 层断言被调）
    f.chatApi.getFullHistory.mockResolvedValueOnce({ messages: [makeMsg('m0'), makeMsg('m1')], truncated: false })
    await f.useChat.loadMoreHistory('s1')
    expect(f.chatApi.getFullHistory).toHaveBeenCalledWith('s1')
    // 全量加载完成 → truncated=false → 顶部条消失（需求③收敛态）
    expect(f.useChat.hasMoreHistory('s1')).toBe(false)
    expect(f.chatStore.getHistoryWindow('s1')!.truncated).toBe(false)
    f.dispose()
  })

  it('u4b ①档巨型文件降级：getFullHistory 返回逆序窗口（truncated=true）→ 入口保持可见', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeMsg('m1')], historyTruncated: true, truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    await f.useChat.hydrateHistory('s1')
    f.chatApi.getFullHistory.mockResolvedValueOnce({ messages: [makeMsg('m0'), makeMsg('m1')], truncated: true })
    await f.useChat.loadMoreHistory('s1')
    expect(f.useChat.hasMoreHistory('s1')).toBe(true)
    f.dispose()
  })
})
