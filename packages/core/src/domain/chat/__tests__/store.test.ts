/**
 * createChatStore factory 行为单测（core chat/domain store，P3 w4 迁移锁定）。
 *
 * 测试 factory 产物不经 pinia defineStore 的纯行为（在 effectScope 内直接调 createChatStore），
 * 锁定 chat 域 store 层核心迁移面：
 * - messages 分区（hydrate 守卫 / setMessages 覆盖 / appendUser）
 * - isGenerating 派生（streamingSessionIds scan + applyMessageEvent 端到端）
 * - finalizeSession reason→终态映射（normal/error + toolCall 级联）
 * - disposeSession 清理全部 per-session ref
 * - pendingSend 生命周期（add/clear + isActive 派生）
 * - LRU（touchLru + evictIfNeeded 阈值驱逐 + evictVirtualKey）
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { textToSegments } from '@xyz-agent/shared'
import type { Message, ServerMessage } from '@xyz-agent/shared'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。返回 store + dispose。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** 构造 ServerMessage（payload 默认带 sessionId） */
function msg(sid: string, type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: sid, ...payload } } as ServerMessage
}

/** 构造 complete user 消息（content: string） */
function userMsg(id: string, content: string = 'hi'): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: 1 }
}

/** 构造 streaming assistant 消息（可选 toolCalls / bashExecution overrides） */
function streamingAssistant(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: '', status: 'streaming', timestamp: 1, ...overrides }
}

describe('createChatStore factory', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
  })
  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  describe('messages 分区（hydrate / setMessages / appendUser）', () => {
    it('hydrate 注入历史 + isHydrated=true', () => {
      const sid = 's1'
      sut.store.hydrate(sid, [userMsg('m1')])
      expect(sut.store.isHydrated(sid)).toBe(true)
      expect(sut.store.getMessages(sid)).toHaveLength(1)
    })

    it('hydrate 幂等守卫（重复调用不二次注入）', () => {
      const sid = 's1'
      const history = [userMsg('m1')]
      sut.store.hydrate(sid, history)
      sut.store.hydrate(sid, history)
      expect(sut.store.getMessages(sid)).toHaveLength(1)
    })

    it('setMessages 覆盖（不受 hydrated 守卫，subagent 虚拟 session 用）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [userMsg('m1', 'a')])
      sut.store.setMessages(sid, [userMsg('m2', 'b')])
      const msgs = sut.store.getMessages(sid)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('m2')
    })

    it('appendUser 返回 id（u- 前缀）+ 注入 complete user 消息', () => {
      const sid = 's1'
      const id = sut.store.appendUser(sid, textToSegments('hi'))
      expect(id).toMatch(/^u-/)
      const msgs = sut.store.getMessages(sid)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].status).toBe('complete')
    })
  })

  describe('pendingBuffer 数据层（m1：pushPending / drainPending / abortPending）', () => {
    it('TC1: pushPending 暂存到 buffer 不碰 messages', () => {
      const sid = 's1'
      sut.store.pushPending(sid, textToSegments('steer msg'), 'steer')
      // buffer[sid] 含 1 项，记录 text + sendMode
      const buf = sut.store.pendingBuffer.value.get(sid)
      expect(buf).toHaveLength(1)
      expect(buf![0].text).toBe('steer msg')
      expect(buf![0].sendMode).toBe('steer')
      // messages[sid] 不变（pending 不进对话流——m1 核心目标）
      expect(sut.store.getMessages(sid)).toHaveLength(0)
    })

    it('TC2: drainPending FIFO + 幂等（同 text 多次暂存，依次取出，第 3 次返回 undefined）', () => {
      const sid = 's1'
      const seg = textToSegments('dup')
      sut.store.pushPending(sid, seg, 'steer')
      sut.store.pushPending(sid, seg, 'steer')

      const r1 = sut.store.drainPending(sid, 'dup', 'steer')
      const r2 = sut.store.drainPending(sid, 'dup', 'steer')
      const r3 = sut.store.drainPending(sid, 'dup', 'steer')

      expect(r1).toBeDefined()
      expect(r2).toBeDefined()
      expect(r3).toBeUndefined()
      expect(sut.store.pendingBuffer.value.get(sid) ?? []).toHaveLength(0)
    })

    it('TC3: abortPending 移除匹配项 + 不碰 messages', () => {
      const sid = 's1'
      sut.store.pushPending(sid, textToSegments('abort me'), 'steer')
      expect(sut.store.getMessages(sid)).toHaveLength(0)

      sut.store.abortPending(sid, 'abort me', 'steer')

      expect(sut.store.pendingBuffer.value.get(sid) ?? []).toHaveLength(0)
      expect(sut.store.getMessages(sid)).toHaveLength(0)
    })

    it('drainPending 无 sendMode 时退化为仅 content 匹配（跨 sendMode 命中）', () => {
      const sid = 's1'
      sut.store.pushPending(sid, textToSegments('same'), 'steer')
      // 不传 sendMode——仅按 text 匹配（normalizeContent + trim 归一化）
      const r = sut.store.drainPending(sid, 'same')
      expect(r).toBeDefined()
      expect(sut.store.pendingBuffer.value.get(sid) ?? []).toHaveLength(0)
    })
  })

  describe('isGenerating 派生（streamingSessionIds scan）', () => {
    it('空 session isGenerating=false', () => {
      expect(sut.store.isGenerating('empty')).toBe(false)
    })

    it('message.message_start 经 applyMessageEvent → isGenerating=true + streaming assistant', () => {
      const sid = 's1'
      sut.store.applyMessageEvent(sid, msg(sid, 'message.message_start', { messageId: 'a1' }))
      expect(sut.store.isGenerating(sid)).toBe(true)
      const m = sut.store.getMessages(sid)[0]
      expect(m.role).toBe('assistant')
      expect(m.status).toBe('streaming')
    })

    it('message.complete → isGenerating=false + status=complete', () => {
      const sid = 's1'
      sut.store.applyMessageEvent(sid, msg(sid, 'message.message_start', { messageId: 'a1' }))
      sut.store.applyMessageEvent(sid, msg(sid, 'message.complete', { stopReason: 'end_turn' }))
      expect(sut.store.isGenerating(sid)).toBe(false)
      expect(sut.store.getMessages(sid)[0].status).toBe('complete')
    })

    it('bash 消息不计入 isGenerating（B1 PR#116：bash 不阻塞）', () => {
      const sid = 's1'
      // message.bashStart 创建 role:'system' streaming bash 消息
      sut.store.applyMessageEvent(sid, msg(sid, 'message.bashStart', { command: 'ls' }))
      expect(sut.store.isGenerating(sid)).toBe(false)
    })
  })

  describe('finalizeSession reason→终态映射', () => {
    it('normal → status=complete', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [streamingAssistant('a1', { content: '生成中' })])
      sut.store.finalizeSession(sid, 'normal')
      expect(sut.store.getMessages(sid)[0].status).toBe('complete')
    })

    it('error → status=error + errorText 写 msg.error（content 不动）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [streamingAssistant('a1', { content: '生成中' })])
      sut.store.finalizeSession(sid, 'error', '报错文本')
      const m = sut.store.getMessages(sid)[0]
      expect(m.status).toBe('error')
      // [M2 error-visibility] 追加形态双通道：content 保持崩溃前正文，errorText 写 msg.error
      expect(m.content).toBe('生成中')
      expect(m.error).toBe('报错文本')
    })

    it('非 streaming entity 不受 finalizeSession 影响（幂等 sealed）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [{ id: 'a1', role: 'assistant', content: '已完成', status: 'complete', timestamp: 1 }])
      sut.store.finalizeSession(sid, 'error', '报错')
      expect(sut.store.getMessages(sid)[0].status).toBe('complete')
    })

    it('running toolCall 级联终态（error reason → toolCall status=error）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [streamingAssistant('a1', {
        toolCalls: [{ id: 'tc1', toolName: 'read', input: {}, status: 'running', startTime: 1 }],
      })])
      sut.store.finalizeSession(sid, 'error')
      expect(sut.store.getMessages(sid)[0].toolCalls![0].status).toBe('error')
    })

    it('normal reason → running toolCall 级联 end_not_received（不设 endTime）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [streamingAssistant('a1', {
        toolCalls: [{ id: 'tc1', toolName: 'read', input: {}, status: 'running', startTime: 1 }],
      })])
      sut.store.finalizeSession(sid, 'normal')
      const tc = sut.store.getMessages(sid)[0].toolCalls![0]
      expect(tc.status).toBe('end_not_received')
      expect(tc.endTime).toBeUndefined()
    })

    it('bash 消息跳过 finalizeSession（finalizeBashOnly 独立域）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [{
        id: 'b1', role: 'system', content: '', status: 'streaming', timestamp: 1,
        bashExecution: { command: 'ls', output: '', exitCode: null, cancelled: false, truncated: false, timestamp: 1 },
      }])
      sut.store.finalizeSession(sid, 'error')
      // bash 消息不被 finalizeSession 改 status
      expect(sut.store.getMessages(sid)[0].status).toBe('streaming')
    })
  })

  describe('disposeSession（清理全部 per-session ref）', () => {
    it('清 messages / hydrated / pendingSend / compactingSessions', () => {
      const sid = 's1'
      sut.store.hydrate(sid, [userMsg('m1')])
      sut.store.addPendingSend(sid)
      sut.store.setCompacting(sid, true)
      expect(sut.store.getMessages(sid)).toHaveLength(1)
      expect(sut.store.isActive(sid)).toBe(true)
      expect(sut.store.isCompacting(sid)).toBe(true)

      sut.store.disposeSession(sid)
      expect(sut.store.getMessages(sid)).toHaveLength(0)
      expect(sut.store.isHydrated(sid)).toBe(false)
      expect(sut.store.isActive(sid)).toBe(false)
      expect(sut.store.isCompacting(sid)).toBe(false)
    })

    it('清 retryStates / queueStates（经 applyMessageEvent 写入后）', () => {
      const sid = 's1'
      sut.store.applyMessageEvent(sid, msg(sid, 'message.auto_retry_start', { attempt: 1, maxAttempts: 3 }))
      sut.store.applyMessageEvent(sid, msg(sid, 'message.queue_update', { steering: ['pending-steer'] }))
      expect(sut.store.getRetryState(sid)).toBeDefined()
      expect(sut.store.getQueueState(sid)).toBeDefined()

      sut.store.disposeSession(sid)
      expect(sut.store.getRetryState(sid)).toBeUndefined()
      expect(sut.store.getQueueState(sid)).toBeUndefined()
    })

    it('TC5: 清 pendingBuffer（与 queueStates 对称）', () => {
      const sid = 's1'
      sut.store.pushPending(sid, textToSegments('steer'), 'steer')
      expect(sut.store.pendingBuffer.value.get(sid)).toHaveLength(1)

      sut.store.disposeSession(sid)
      expect(sut.store.pendingBuffer.value.get(sid)).toBeUndefined()
    })
  })

  describe('appendSystemNotice（追加 system 提示行）', () => {
    it('追加 role=system 消息到会话消息流（sys- 前缀 id + complete 状态）', () => {
      const sid = 's1'
      sut.store.hydrate(sid, [userMsg('u1', 'hello')])

      sut.store.appendSystemNotice(sid, 'compaction summary')

      const messages = sut.store.getMessages(sid)
      expect(messages).toHaveLength(2)
      const notice = messages[1]
      expect(notice.role).toBe('system')
      expect(notice.content).toBe('compaction summary')
      expect(notice.status).toBe('complete')
      expect(notice.id.startsWith('sys-')).toBe(true)
      expect(typeof notice.timestamp).toBe('number')
    })

    it('空会话追加 system 提示行（prev 为空数组）', () => {
      const sid = 's1'
      sut.store.appendSystemNotice(sid, 'notice on empty')
      const messages = sut.store.getMessages(sid)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('system')
      expect(messages[0].content).toBe('notice on empty')
    })
  })

  describe('pendingSend 生命周期', () => {
    it('addPendingSend → isActive=true（pendingSend 计入活跃态）', () => {
      sut.store.addPendingSend('s1')
      expect(sut.store.isActive('s1')).toBe(true)
      expect(sut.store.isGenerating('s1')).toBe(false) // pendingSend 与 isGenerating 正交
    })

    it('clearPendingSend → isActive=false', () => {
      sut.store.addPendingSend('s1')
      sut.store.clearPendingSend('s1')
      expect(sut.store.isActive('s1')).toBe(false)
    })

    it('addPendingSend 挂 30s 超时 timer，到期触发 finalizeSession(timeout)', () => {
      const sid = 's1'
      sut.store.applyMessageEvent(sid, msg(sid, 'message.message_start', { messageId: 'a1' })) // 建 streaming
      sut.store.addPendingSend(sid)
      expect(sut.store.isActive(sid)).toBe(true)

      // 推进 30s（PENDING_SEND_TIMEOUT_MS），pendingSend timer 触发 finalizeSession('timeout')
      vi.advanceTimersByTime(30_000)
      expect(sut.store.isGenerating(sid)).toBe(false) // streaming 被 timeout 收口
    })
  })

  describe('LRU（touchLru / evictIfNeeded / evictVirtualKey）', () => {
    it('evictIfNeeded 驱逐最久未访问的非豁免 session（阈值 LRU_MAX_SESSIONS=8）', () => {
      // 9 个 session 全部 setMessages + touchLru（时间戳递增），s0 最旧
      for (let i = 0; i < 9; i++) {
        const sid = `s${i}`
        sut.store.setMessages(sid, [userMsg(`m${i}`, 'x')])
        sut.store.touchLru(sid)
      }
      sut.store.evictIfNeeded()
      // s0（最久未访问）被驱逐，s8（最新）保留
      expect(sut.store.getMessages('s0')).toHaveLength(0)
      expect(sut.store.getMessages('s8')).toHaveLength(1)
    })

    it('streaming session 豁免驱逐（isLruExempt）', () => {
      const streaming = 's-streaming'
      sut.store.setMessages(streaming, [streamingAssistant('a1')])
      sut.store.touchLru(streaming)
      // 再填 8 个 complete session（均比 streaming 更新）
      for (let i = 0; i < 8; i++) {
        const sid = `s${i}`
        sut.store.setMessages(sid, [userMsg(`m${i}`, 'x')])
        sut.store.touchLru(sid)
      }
      sut.store.evictIfNeeded()
      // streaming session 仍保留（豁免），即使它最旧
      expect(sut.store.getMessages(streaming)).toHaveLength(1)
    })

    it('evictVirtualKey 删除单个虚拟 key（M7：不误删主 session）', () => {
      sut.store.setMessages('subagent:abc', [{ id: 'm1', role: 'assistant', content: 'x', status: 'complete', timestamp: 1 }])
      sut.store.evictVirtualKey('subagent:abc')
      expect(sut.store.getMessages('subagent:abc')).toHaveLength(0)
    })
  })

  describe('applyMessageEvent 经 dispatchMessageEvent 端到端', () => {
    it('tool_call_start 记录 toolCall（contentBlocks 同步挂 toolCall 块）', () => {
      const s = makeStore()
      const sid = 's1'
      s.store.applyMessageEvent(sid, msg(sid, 'message.message_start', { messageId: 'a1' }))
      s.store.applyMessageEvent(sid, msg(sid, 'message.tool_call_start', {
        toolCallId: 'tc1', toolName: 'read', input: {},
      }))
      const msgs = s.store.getMessages(sid)
      const last = msgs[msgs.length - 1]
      expect(last.toolCalls?.[0]).toMatchObject({ id: 'tc1', toolName: 'read', status: 'running' })
      s.dispose()
    })
  })
})
