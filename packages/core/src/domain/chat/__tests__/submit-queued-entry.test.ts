/**
 * submitQueuedEntry 单测（session-occupancy u4b / D5.1——flush 逐条提交的 send/steer
 * 等价编排）。
 *
 * 覆盖契约（设计 D5.1 两通道最小编排）：
 * - channel='send'（队首，启动新 run）：挂 inflight 占位（防确认帧被 message_end 处理序
 *   ② 误拦漏配 ① 分区匹配）→ ensureStreamSubscription（订阅保障）→ chatApi.send 携
 *   clientUuid = 条目 id（D2 消歧）。
 * - channel='steer'（并入当前 run）：仅 chatApi.steer——不挂占位（steer 条目无确认配额）、
 *   不 pushPending（defer 条目入流由 pending 气泡承担，确认走 ① 队列分区匹配非腿 1 暂存）。
 * - RPC 失败原样上抛（flush 侧决策留队/回滚/停止后续），本函数只负责「挂」不管「回滚」。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/submit-queued-entry.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { submitQueuedEntry } from '../useChat'
import type { SubmitQueuedEntryDeps } from '../useChat'
import { createChatStore } from '../store'

function makeDeps(over: Partial<{ send: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }> = {}) {
  const chat = createChatStore()
  const send = over.send ?? vi.fn(() => Promise.resolve())
  const steer = over.steer ?? vi.fn(() => Promise.resolve())
  const deps: SubmitQueuedEntryDeps = {
    chatApi: {
      send: send as unknown as SubmitQueuedEntryDeps['chatApi']['send'],
      steer: steer as unknown as SubmitQueuedEntryDeps['chatApi']['steer'],
      streamSubscribe: vi.fn(() => () => {}) as unknown as SubmitQueuedEntryDeps['chatApi']['streamSubscribe'],
    },
    chat,
    sessionStore: { applySnapshot: vi.fn() },
    toast: { error: vi.fn() },
    t: vi.fn((key: string) => key),
    getCompactQueue: vi.fn(),
  }
  return { deps, chat, send, steer }
}

describe('submitQueuedEntry（u4b / D5.1）', () => {
  it('send 通道：挂 inflight 占位 + 建会话订阅 + chatApi.send 携 clientUuid=条目 id', async () => {
    const { deps, chat } = makeDeps()
    await submitQueuedEntry('s1', { id: 'entry-1', text: 'm1' }, 'send', deps)

    // 占位先于 RPC（乐观语义——确认帧到达时 inflight>0 由 ① 优先消费不被 ② 误拦）
    expect(chat.getInflight('s1')).toBe(1)
    expect(deps.chatApi.streamSubscribe).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(deps.chatApi.send).toHaveBeenCalledTimes(1)
    expect(deps.chatApi.send).toHaveBeenCalledWith('s1', 'm1', { clientUuid: 'entry-1' })
  })

  it('steer 通道：仅 chatApi.steer——不挂占位、不建订阅', async () => {
    const { deps, chat } = makeDeps()
    await submitQueuedEntry('s1', { id: 'entry-2', text: 'm2' }, 'steer', deps)

    expect(chat.getInflight('s1')).toBe(0)
    expect(deps.chatApi.streamSubscribe).not.toHaveBeenCalled()
    expect(deps.chatApi.send).not.toHaveBeenCalled()
    expect(deps.chatApi.steer).toHaveBeenCalledWith('s1', 'm2')
  })

  it('steer 通道不 pushPending（defer 条目不进暂存——确认走 ① 分区匹配非腿 1 drainN）', async () => {
    const { deps, chat } = makeDeps()
    await submitQueuedEntry('s1', { id: 'entry-3', text: 'm3' }, 'steer', deps)
    // pendingBuffer 无货：drainN 取不出任何条目（与 pushPending 的正常 steer 提交对照）
    expect(chat.drainN('s1', 'steer', 5)).toEqual([])
  })

  it('send 通道 RPC reject 原样上抛（回滚归 flush 侧——本函数只负责挂占位）', async () => {
    const { deps, chat } = makeDeps({
      send: vi.fn(() => Promise.reject(new Error('rpc fail'))),
    })
    await expect(
      submitQueuedEntry('s1', { id: 'entry-4', text: 'm4' }, 'send', deps),
    ).rejects.toThrow('rpc fail')
    // 占位保持挂起状态：flush catch 分支负责 decrementInflight 回滚（重试时重挂）
    expect(chat.getInflight('s1')).toBe(1)
  })
})
