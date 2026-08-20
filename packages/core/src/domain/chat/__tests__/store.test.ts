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
import { effectScope, effect, toRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { textToSegments, segmentsToText } from '@xyz-agent/shared'
import type { Message, Segment, ServerMessage } from '@xyz-agent/shared'
import { replayEntries } from '../apply-entry'

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

    it('appendUser 返回 id（u- 前缀）+ 注入 complete user 消息（segments 保留）', () => {
      const sid = 's1'
      const segs: Segment[] = [{ type: 'skill', name: 'code-review' }, { type: 'text', text: 'please review' }]
      const id = sut.store.appendUser(sid, segs)
      expect(id).toMatch(/^u-/)
      const msgs = sut.store.getMessages(sid)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].status).toBe('complete')
      // entry 化后 overlay 覆写回原 segments（badge 不丢）+ 引用原样透传（FIFO 断言锚定）
      expect(msgs[0].content).toBe(segs)
    })
  })

  // ── [W2 fix-chat-flow-order D6 → 后修 overlay-only] appendUser：entry 形态派生 ref 消息，
  //    reducer 的 user entry 唯一来源 = 真实 message_end(user) 帧（乐观 entry 不喂——双计防护）──
  describe('appendUser entry 化（W2 后修：overlay-only + 权威帧入流）', () => {
    it('overlay-only：ref 消息 id = 返回 id（entry.id 派生）、segments 原样；reducer 不吃乐观 entry（防双计）', () => {
      const sid = 's-w2'
      const id = sut.store.appendUser(sid, textToSegments('hello'))
      // reducer 不喂：user entry 唯一来源 = 真实 message_end(user)（W22 等价性——乐观 entry
      // 与真实帧双喂会双计同一条 user 消息）
      expect(sut.store._entryStatesForTest.get(sid)).toBeUndefined()
      // ref 消息（overlay）：id = entry.id 派生——clientUuid 映射链（useChat）消费同一值
      expect(sut.store.getMessages(sid)[0].id).toBe(id)
      expect(sut.store.getMessages(sid)[0].role).toBe('user')
      expect(sut.store.getMessages(sid)[0].content).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('结构化 segments（skill/file/mention/image/text）在消息流原样保留——badge 不丢', () => {
      const sid = 's-w2-badge'
      const segs: Segment[] = [
        { type: 'skill', name: 'code-review' },
        { type: 'file', path: '/a/b.ts', lineRange: [1, 9] },
        { type: 'mention', name: 'dev' },
        { type: 'image', id: 'img1', path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png' },
        { type: 'text', text: 'please review' },
      ]
      sut.store.appendUser(sid, segs)
      const msgs = sut.store.getMessages(sid)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe(segs)
      expect((msgs[0].content as Segment[])[0]).toEqual({ type: 'skill', name: 'code-review' })
    })

    it('clientUuid 形态契约：返回 id 匹配 extension TAG 正则 u-[0-9a-fA-F-]{36}', () => {
      const id = sut.store.appendUser('s-w2-uuid', textToSegments('x'))
      // xyz-client-msg-id-mapper.js TAG_MATCH 锚定该形态——重开 badge 回填链的硬约束
      expect(id).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    })

    it('live ≡ reload（user 类型）：appendUser 派生的 ref 投影 ≡ 真实 message_end 帧喂入的 reducer 投影 ≡ 同形态 entry 重放', () => {
      const sid = 's-w2-equiv'
      // live 乐观（ref 投影）
      sut.store.appendUser(sid, textToSegments('same question'))
      // live 权威：真实 message_end(user) 帧（adapter 重构形态：无 id）→ registry → reducer
      sut.store.applyMessageEvent(sid, {
        type: 'message.message_end',
        payload: {
          sessionId: sid,
          entry: {
            type: 'message',
            parentId: null,
            timestamp: new Date(0).toISOString(),
            message: { role: 'user', content: 'same question', timestamp: 0 },
          },
        },
      } as ServerMessage)
      // ref：乐观 user 一条（真实帧不 commit ref——与 W21 assistant 同款 overlay 分工）
      expect(sut.store.getMessages(sid)).toHaveLength(1)
      // reducer：真实帧一条（乐观不喂）
      const liveMsgs = sut.store._entryStatesForTest.get(sid)!.messages
      expect(liveMsgs).toHaveLength(1)
      // 重开侧：同形态 user entry（pi 持久化形态——content 纯文本）重放同一 reducer
      const reloadState = replayEntries([{
        type: 'message',
        id: 'pi-uuidv7-entry',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: 'same question', timestamp: 0 },
      }])
      // 剥异源字段（id：位置派生 vs pi uuidv7；piEntryId：entry.id 衍生）后逐字段等价——
      // 权威帧与重放对 user 类型构造性同构（Segment[]/string 归一到同一投影）
      const strip = (m: Message) => {
        const { id: _i, piEntryId: _p, ...rest } = m
        return rest
      }
      expect(liveMsgs.map(strip)).toEqual(reloadState.messages.map(strip))
    })

    it('steer 投递（queue_update drain）后 user 气泡进消息流且 segments 完整（用户可见行为）', () => {
      const sid = 's-w2-steer'
      const segs: Segment[] = [{ type: 'skill', name: 'deploy' }, { type: 'text', text: ' --prod' }]
      sut.store.pushPending(sid, segs, 'steer')
      // pi 入队（全量数组，展开后文本 ≠ 原文）→ 投递（数组清空）：countDrained N=1 → FIFO 取出
      sut.store.applyMessageEvent(sid, { type: 'message.queue_update', payload: { sessionId: sid, steering: ['skill deploy 展开后全文'], pendingMessageCount: 1 } } as ServerMessage)
      sut.store.applyMessageEvent(sid, { type: 'message.queue_update', payload: { sessionId: sid, steering: [], pendingMessageCount: 0 } } as ServerMessage)
      const msgs = sut.store.getMessages(sid)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].status).toBe('complete')
      // 引用断言：drainN 从深响应式 pendingBuffer 取出的 segments 是 reactive Proxy，
      // toRaw 解回原引用（与 pending-drain-fifo.test.ts 同判据——FIFO 取最早的精确判据）
      expect(toRaw(msgs[0].content)).toBe(segs)
      expect(segmentsToText(msgs[0].content as Segment[])).toBe('/skill:deploy --prod')
    })
  })

  describe('hydrate 尾窗锚（W5 D5：唯一写方 = hydrate，唯一读方 = loadMoreHistory）', () => {
    it('hydrate 记锚：user 消息带 piEntryId 时取 piEntryId', () => {
      sut.store.hydrate('s1', [
        { id: 'ent-u2', piEntryId: 'ent-u2', role: 'user', content: 'q2', status: 'complete', timestamp: 2 },
      ])
      expect(sut.store.getHydrateAnchor('s1')).toBe('ent-u2')
    })

    it('hydrate 记锚：system 消息无 piEntryId 字段时取 id（对称取值 piEntryId ?? id）', () => {
      // compaction 等 system 族消息：reducer 产物无 piEntryId，但 id 即 entry 派生 uuidv7
      sut.store.hydrate('s1', [
        { id: 'ent-comp', role: 'system', content: 'ctx compressed', status: 'complete', timestamp: 1 },
      ])
      expect(sut.store.getHydrateAnchor('s1')).toBe('ent-comp')
    })

    it('空 history 不记锚（新 session 无 load-more，锚缺失走兜底）', () => {
      sut.store.hydrate('s1', [])
      expect(sut.store.getHydrateAnchor('s1')).toBeUndefined()
    })

    it('锚记尾窗首条而非末条（切分点 = 最旧可见消息的 entry 身份）', () => {
      sut.store.hydrate('s1', [
        { id: 'ent-first', piEntryId: 'ent-first', role: 'user', content: 'q1', status: 'complete', timestamp: 1 },
        { id: 'ent-last', piEntryId: 'ent-last', role: 'assistant', content: 'a1', status: 'complete', timestamp: 2 },
      ])
      expect(sut.store.getHydrateAnchor('s1')).toBe('ent-first')
    })

    it('重 hydrate（dispose 后 hydrated 已清）覆盖旧锚；hydrate 幂等守卫内不重写', () => {
      const sid = 's1'
      sut.store.hydrate(sid, [userMsg('m1')])
      // 幂等守卫：已 hydrated 的二次 hydrate 不改锚
      sut.store.hydrate(sid, [userMsg('m2')])
      expect(sut.store.getHydrateAnchor(sid)).toBe('m1')
      // disposeSession 清 hydrated + 锚后重 hydrate → 新锚覆盖（LRU 驱逐重进同语义）
      sut.store.disposeSession(sid)
      expect(sut.store.getHydrateAnchor(sid)).toBeUndefined()
      sut.store.hydrate(sid, [userMsg('m3')])
      expect(sut.store.getHydrateAnchor(sid)).toBe('m3')
    })

    it('disposeSession 清锚 + 分区隔离（A/B session 锚互不干扰）', () => {
      sut.store.hydrate('sa', [userMsg('anchor-a')])
      sut.store.hydrate('sb', [userMsg('anchor-b')])
      expect(sut.store.getHydrateAnchor('sa')).toBe('anchor-a')
      expect(sut.store.getHydrateAnchor('sb')).toBe('anchor-b')
      sut.store.disposeSession('sa')
      expect(sut.store.getHydrateAnchor('sa')).toBeUndefined()
      expect(sut.store.getHydrateAnchor('sb')).toBe('anchor-b') // B 不受 A 销毁影响
    })

    it('LRU 驱逐清锚（随 hydrated 同生共死，驱逐重进后重 hydrate 重建）', () => {
      // 9 个 session 全部 hydrate（记锚）+ touchLru，s0 最旧被驱逐
      for (let i = 0; i < 9; i++) {
        const sid = `s${i}`
        sut.store.hydrate(sid, [userMsg(`anchor-${i}`)])
        sut.store.touchLru(sid)
      }
      expect(sut.store.getHydrateAnchor('s0')).toBe('anchor-0') // 前置：锚已记录
      sut.store.evictIfNeeded()
      expect(sut.store.getMessages('s0')).toHaveLength(0) // 前置：s0 被驱逐
      expect(sut.store.getHydrateAnchor('s0')).toBeUndefined() // 锚随分区同点清理
      expect(sut.store.getHydrateAnchor('s8')).toBe('anchor-8') // 保留 session 的锚不受影响
    })
  })

  describe('pendingBuffer 数据层（m1：pushPending / drainN 计数 FIFO / abortPending）', () => {
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

    it('TC2: drainN 计数 FIFO（同 text 多次暂存，取 n 条按入队顺序，超出取尽即止）', () => {
      const sid = 's1'
      const seg = textToSegments('dup')
      sut.store.pushPending(sid, seg, 'steer')
      sut.store.pushPending(sid, seg, 'steer')

      const r1 = sut.store.drainN(sid, 'steer', 1)
      const r2 = sut.store.drainN(sid, 'steer', 5) // n 超过存量 → 取尽即止（扩展注入例外收敛路径）
      const r3 = sut.store.drainN(sid, 'steer', 1)

      expect(r1).toHaveLength(1)
      expect(r2).toHaveLength(1)
      expect(r3).toHaveLength(0)
      expect(sut.store.pendingBuffer.value.get(sid) ?? []).toHaveLength(0)
    })

    it('TC2b: drainN sendMode 隔离（steer 计数不动 follow-up 项）', () => {
      const sid = 's1'
      sut.store.pushPending(sid, textToSegments('steer one'), 'steer')
      sut.store.pushPending(sid, textToSegments('follow one'), 'follow-up')

      const r = sut.store.drainN(sid, 'steer', 5)

      expect(r).toHaveLength(1)
      expect(sut.store.drainN(sid, 'follow-up', 1)).toHaveLength(1)
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

    it('TC3b: abortPending 保留文本匹配（W14 D6 差异：回滚有准确原文，sendMode 必填隔离）', () => {
      const sid = 's1'
      sut.store.pushPending(sid, textToSegments('rollback target'), 'steer')
      sut.store.pushPending(sid, textToSegments('other'), 'steer')

      // sendMode 不匹配（follow-up）→ no-op
      sut.store.abortPending(sid, 'rollback target', 'follow-up')
      expect(sut.store.pendingBuffer.value.get(sid) ?? []).toHaveLength(2)

      sut.store.abortPending(sid, 'rollback target', 'steer')
      const buf = sut.store.pendingBuffer.value.get(sid) ?? []
      expect(buf).toHaveLength(1)
      expect(buf[0].text).toBe('other')
    })
  })

  describe('isGenerating 派生（D-3 per-session 惰性派生，判定与旧全 Map scan 等价）', () => {
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
      // [W1 fix-chat-flow-order] bashStart 只写 ephemeral executingBash 不建消息项，
      // bashResult 经 entry 入流的 bashExecution 消息 status 恒 complete——两种形态都不阻塞。
      sut.store.applyMessageEvent(sid, msg(sid, 'message.bashStart', { command: 'ls' }))
      expect(sut.store.isGenerating(sid)).toBe(false)
    })

    it('P3: A session 同 sid commit 不重算 B 的 isGenerating 派生（失效收敛）', () => {
      sut.store.setMessages('A', [streamingAssistant('a1')])
      sut.store.setMessages('B', [userMsg('b1')])
      expect(sut.store.isGenerating('A')).toBe(true)
      expect(sut.store.isGenerating('B')).toBe(false)

      // effect 订阅 isGenerating('B')：其依赖只有 B 分区内层 ref + 外层 Map
      const spy = vi.fn(() => { sut.store.isGenerating('B') })
      const scope = effectScope(true)
      scope.run(() => { effect(spy) })
      expect(spy).toHaveBeenCalledTimes(1)

      // A 的 token commit（同 sid：内层 ref 替换新数组，外层 Map 恒等）→ B 派生不重算
      sut.store.setMessages('A', [streamingAssistant('a1'), streamingAssistant('a2')])
      expect(spy).toHaveBeenCalledTimes(1)

      // B 自己更新（B 分区内层 ref 替换为含 streaming）→ B 派生重算翻 true
      sut.store.setMessages('B', [userMsg('b1'), streamingAssistant('b2')])
      expect(spy).toHaveBeenCalledTimes(2)
      expect(sut.store.isGenerating('B')).toBe(true)
      scope.stop()
    })
  })

  describe('D-3 生命周期：sessionStreamingFlags 与 messages 分区同生共死', () => {
    it('LRU 显式驱逐（evictSessionWithVirtual）后 flags 同步清理，其他 session 不受影响', () => {
      sut.store.setMessages('s1', [userMsg('m1')])
      sut.store.setMessages('s2', [userMsg('m2')])
      sut.store.isGenerating('s1') // 惰性建 flag（false，非豁免）
      sut.store.isGenerating('s2')
      expect(sut.store._sessionStreamingFlagsForTest.has('s1')).toBe(true)
      expect(sut.store._sessionStreamingFlagsForTest.has('s2')).toBe(true)

      sut.store.evictSessionWithVirtual('s1') // 非豁免（无 streaming）→ 驱逐
      expect(sut.store.getMessages('s1')).toHaveLength(0)
      expect(sut.store._sessionStreamingFlagsForTest.has('s1')).toBe(false)
      expect(sut.store._sessionStreamingFlagsForTest.has('s2')).toBe(true)
    })

    it('evictVirtualKey 清虚拟 key 的 flags（subagent 分区驱逐泄漏防护）', () => {
      const virtualId = 'subagent:s1:c1'
      sut.store.setMessages(virtualId, [userMsg('m1')])
      sut.store.isGenerating(virtualId)
      expect(sut.store._sessionStreamingFlagsForTest.has(virtualId)).toBe(true)

      sut.store.evictVirtualKey(virtualId)
      expect(sut.store._sessionStreamingFlagsForTest.has(virtualId)).toBe(false)
    })

    it('disposeSession 清 flags', () => {
      sut.store.setMessages('s1', [userMsg('m1')])
      sut.store.isGenerating('s1')
      expect(sut.store._sessionStreamingFlagsForTest.has('s1')).toBe(true)

      sut.store.disposeSession('s1')
      expect(sut.store._sessionStreamingFlagsForTest.has('s1')).toBe(false)
    })

    it('驱逐后再次 isGenerating 重建 flag 且行为正确（复访兜底）', () => {
      sut.store.setMessages('s1', [userMsg('m1')])
      sut.store.isGenerating('s1')
      sut.store.evictSessionWithVirtual('s1')
      // 驱逐后 flag 已清；重新写入消息后再问 → 重建 flag，派生值正确
      sut.store.setMessages('s1', [streamingAssistant('a1')])
      expect(sut.store.isGenerating('s1')).toBe(true)
      expect(sut.store._sessionStreamingFlagsForTest.has('s1')).toBe(true)
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

  describe('finalizeAllStreaming（断连 / 崩溃兜底收口，review #1.2）', () => {
    it('disconnect → 全部候选 session 的 streaming 复位（isGenerating false）+ 消息 error 收口 + 独立瞬态清空', () => {
      const s1 = 's1'
      const s2 = 's2'
      // s1：streaming assistant（messages 分区来源的候选）
      sut.store.setMessages(s1, [userMsg('u1'), streamingAssistant('a1', { content: '生成中' })])
      // s2：无消息实体、仅 retry/queue 瞬态（瞬态 Map 来源的候选——只遍历 messages 会漏）
      sut.store.applyMessageEvent(s2, msg(s2, 'message.auto_retry_start', { attempt: 1 }))
      sut.store.applyMessageEvent(s2, msg(s2, 'message.queue_update', { steering: ['q1'] }))
      sut.store.setCompacting(s2, true)
      expect(sut.store.isGenerating(s1)).toBe(true)
      expect(sut.store.getRetryState(s2)).toBeDefined()
      expect(sut.store.getQueueState(s2)).toBeDefined()
      expect(sut.store.isCompacting(s2)).toBe(true)

      sut.store.finalizeAllStreaming('disconnect')

      // streaming 实体收口为 error（disconnect 属 error 类 reason）→ isGenerating 复位
      expect(sut.store.getMessages(s1)[1].status).toBe('error')
      expect(sut.store.isGenerating(s1)).toBe(false)
      // 独立瞬态（retry/queue/compacting）清空——clearIndependentTransient 断连兜底
      expect(sut.store.getRetryState(s2)).toBeUndefined()
      expect(sut.store.getQueueState(s2)).toBeUndefined()
      expect(sut.store.isCompacting(s2)).toBe(false)
    })

    it('幂等：已收口 session 二次调用 no-op（重连成功后 ring 回放已收口的场景）', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [streamingAssistant('a1', { content: '生成中' })])
      sut.store.finalizeAllStreaming('disconnect')
      expect(sut.store.getMessages(sid)[0].status).toBe('error')
      // 二次调用（如 grace 到期与 IPC 崩溃路径竞态双触发）：sealed 不再改状态
      sut.store.finalizeAllStreaming('disconnect')
      expect(sut.store.getMessages(sid)[0].status).toBe('error')
      expect(sut.store.isGenerating(sid)).toBe(false)
    })

    it('无瞬态 session（全部已 complete）不受影响', () => {
      const sid = 's1'
      sut.store.setMessages(sid, [userMsg('u1'), { id: 'a1', role: 'assistant', content: '已完成', status: 'complete', timestamp: 1 }])
      sut.store.finalizeAllStreaming('disconnect')
      expect(sut.store.getMessages(sid)[1].status).toBe('complete')
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

    it('LRU 驱逐同步清 changeSetStatuses 前缀条目（W19 review Fix-2：与 messages 分区同生共死）', () => {
      // 9 个 session 全部带 ready 变更集状态（经 applyFileChanges 真实入口写入），s0 最旧被驱逐
      for (let i = 0; i < 9; i++) {
        const sid = `s${i}`
        sut.store.setMessages(sid, [{ id: `a${i}`, role: 'assistant', content: '', status: 'complete', timestamp: 1 }])
        sut.store.applyFileChanges(sid, `a${i}`, [], 'ready', true)
        sut.store.touchLru(sid)
      }
      expect(sut.store.getChangeSetStatus('s0', 'a0')).toBe('ready') // 前置：status 已写入

      sut.store.evictIfNeeded()
      expect(sut.store.getMessages('s0')).toHaveLength(0) // 前置：s0 被驱逐
      // 驱逐同步清该 sid 的 changeSetStatuses 条目（此前仅 disposeSession 清理 → map 泄漏）
      expect(sut.store.getChangeSetStatus('s0', 'a0')).toBeUndefined()
      // 保留 session 的条目不受影响
      expect(sut.store.getChangeSetStatus('s8', 'a8')).toBe('ready')
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
        // [w21] entry 形态 payload（event-adapter 翻译时重构的 toolCall entry）
        entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() },
      }))
      const msgs = s.store.getMessages(sid)
      const last = msgs[msgs.length - 1]
      expect(last.toolCalls?.[0]).toMatchObject({ id: 'tc1', toolName: 'read', status: 'running' })
      s.dispose()
    })
  })

  // ── [W21] entry 形态实时 feed 喂 reducer（applyEntryFrame）──
  // 实时路径（message_end / tool_call_end 重构 entry）与文件重放（replayEntries）喂同一个
  // applyEntry reducer；messages ref 走 overlay 路径不受影响（ref 收敛归 W22 对账）。
  describe('applyEntryFrame（w21 实时 feed 喂 reducer）', () => {
    it('message_end（user entry）→ reducer state 累积 user 投影；messages ref 不受影响（overlay 路径不动）', () => {
      const s = makeStore()
      const sid = 's-w21-user'
      s.store.applyMessageEvent(sid, msg(sid, 'message.message_end', {
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(1000).toISOString(),
          message: { role: 'user', content: 'hello', timestamp: 1000 },
        },
      }))
      const state = s.store._entryStatesForTest.get(sid)
      expect(state?.messages).toHaveLength(1)
      expect(state?.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }], status: 'complete' })
      // ref 不动（send 时 appendUser 的乐观消息负责实时渲染；ref 收敛归 W22 对账）
      expect(s.store.getMessages(sid)).toHaveLength(0)
      s.dispose()
    })

    it('message_end（assistant entry with toolCalls）→ tool_call_end（toolResult entry）→ reducer 回填 output/isError', () => {
      const s = makeStore()
      const sid = 's-w21-tool'
      // pi 时序：assistant message_end（含 toolCalls）先于 tool_execution_end（探针定论，agent-session.ts:545）
      s.store.applyMessageEvent(sid, msg(sid, 'message.message_end', {
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(2000).toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              { type: 'toolCall', id: 'tc-9', name: 'read', arguments: { path: '/x' } },
            ],
            timestamp: 2000,
          },
        },
      }))
      s.store.applyMessageEvent(sid, msg(sid, 'message.tool_call_end', {
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(3000).toISOString(),
          message: { role: 'toolResult', toolCallId: 'tc-9', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: true, timestamp: 3000 },
        },
      }))
      const state = s.store._entryStatesForTest.get(sid)
      // reducer：assistant 投影（toolCalls completed）+ toolResult 窗口局部配对回填（isError → error 态）
      expect(state?.messages).toHaveLength(1)
      const tc = state?.messages[0].toolCalls?.[0]
      expect(tc).toMatchObject({ id: 'tc-9', toolName: 'read', output: 'file body', status: 'error' })
      s.dispose()
    })

    it('message_end 异常帧（entry 非 message type）→ 丢弃不累积', () => {
      const s = makeStore()
      const sid = 's-w21-bad'
      s.store.applyMessageEvent(sid, msg(sid, 'message.message_end', {
        entry: { type: 'compaction', timestamp: new Date(0).toISOString(), summary: 'x' },
      }))
      expect(s.store._entryStatesForTest.has(sid)).toBe(false)
      s.dispose()
    })

    it('disposeSession 清 entryStates 分区', () => {
      const s = makeStore()
      const sid = 's-w21-clean'
      s.store.applyMessageEvent(sid, msg(sid, 'message.message_end', {
        entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'user', content: 'x', timestamp: 0 } },
      }))
      expect(s.store._entryStatesForTest.has(sid)).toBe(true)
      s.store.disposeSession(sid)
      expect(s.store._entryStatesForTest.has(sid)).toBe(false)
      s.dispose()
    })
  })
})
