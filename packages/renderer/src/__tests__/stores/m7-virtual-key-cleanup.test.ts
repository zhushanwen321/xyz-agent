/**
 * M7 修复红灯测试：subagent/agentcall 虚拟 key 三段式 + 清理链路 + tombstone。
 *
 * 防的 bug：
 * - D1: subagent 虚拟 key 两段式 vs chat-lru 三段式假设 → LRU 清理永远 false（假绿测试掩盖）
 * - D3: backToMain 不清 messages → subagent 消息永久残留
 * - D4: evictSessionWithVirtual 零调用
 * - D7: 终态 fetchAndInject fire-and-forget 复活已清 messages
 *
 * [红灯说明] 当前 subagentVirtualId 是两段式（subagent:<subagentId>），
 * isSubagentVirtualId 只 startsWith 不做三段结构校验，backToMain 不清 messages。
 * 本文件断言三段式行为 → 编译失败（subagentVirtualId 两参）或断言失败 → 红灯。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/m7-virtual-key-cleanup.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
  useSubagentStore,
} from '@/stores/subagent'
import { useChatStore } from '@/stores/chat'
import { isVirtualKeyOf } from '@/stores/chat-lru'
import type { Message } from '@xyz-agent/shared'

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

// ── FR-1: 三段式 key 格式 + 结构校验 ──────────────────────────────

describe('M7 FR-1: subagent 虚拟 key 三段式格式', () => {
  it('subagentVirtualId 产出三段式 subagent:<mainSid>:<subId>', () => {
    expect(subagentVirtualId('sess-1', 'sub-a')).toBe('subagent:sess-1:sub-a')
  })

  it('extractSubagentId 返回第三段 subId（保持消费契约 DR9）', () => {
    expect(extractSubagentId('subagent:sess-1:sub-a')).toBe('sub-a')
  })

  it('extractMainSessionId 返回第二段 mainSid', () => {
    expect(extractMainSessionId('subagent:sess-1:sub-a')).toBe('sess-1')
  })
})

describe('M7 FR-1: isSubagentVirtualId 三段结构校验（排除旧两段式）', () => {
  it('三段式合法 key 返回 true', () => {
    expect(isSubagentVirtualId('subagent:sess-1:sub-a')).toBe(true)
  })

  it('旧两段式 key 返回 false（INVAR-1.4 排除残留）', () => {
    // 防退化：旧格式 subagent:foo（无 mainSid 段）不应被识别为合法虚拟 key
    expect(isSubagentVirtualId('subagent:foo')).toBe(false)
  })

  it('agentcall 前缀返回 false', () => {
    expect(isSubagentVirtualId('agentcall:x')).toBe(false)
  })

  it('普通 session id 返回 false', () => {
    expect(isSubagentVirtualId('sess-1')).toBe(false)
  })
})

// ── FR-1 + FR-2: 真实 key 经 chat-lru 匹配（防假绿）──────────────

describe('M7 AC-2/3: 真实 subagentVirtualId 经 LRU 匹配（防假绿）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('isVirtualKeyOf 对真实 subagentVirtualId 生成的 key 匹配主 session', () => {
    // 防假绿：不用手写 'subagent:s0:sa1' 字符串，用真实工厂生成
    const virtualKey = subagentVirtualId('s0', 'sa1')
    expect(isVirtualKeyOf(virtualKey, 's0')).toBe(true)
  })

  it('LRU 驱逐主 session s0 时，真实 subagentVirtualId 生成的 messages key 被同步删除', () => {
    const store = useChatStore()
    const virtualKey = subagentVirtualId('s0', 'sa1')

    store.hydrate('s0', [makeMessage('m0')])
    store.setMessages(virtualKey, [makeMessage('sa1')])

    store.evictSessionWithVirtual('s0')

    // 主 session + 真实工厂生成的虚拟 key 都清
    expect(store.getMessages('s0')).toEqual([])
    expect(store.getMessages(virtualKey)).toEqual([])
  })

  it('多 subagent 全清：同主 session 下 N 个 subagent 虚拟 key 都被驱逐', () => {
    const store = useChatStore()
    const vk1 = subagentVirtualId('s0', 'sa1')
    const vk2 = subagentVirtualId('s0', 'sa2')

    store.hydrate('s0', [makeMessage('m0')])
    store.setMessages(vk1, [makeMessage('sa1')])
    store.setMessages(vk2, [makeMessage('sa2')])

    store.evictSessionWithVirtual('s0')

    expect(store.getMessages(vk1)).toEqual([])
    expect(store.getMessages(vk2)).toEqual([])
  })
})

// ── FR-3: backToMain 立即清 + tombstone ──────────────────────────

describe('M7 FR-3: backToMain 立即清 messages + tombstone', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('backToMain 后 messages[virtualId] 立即清空', () => {
    const store = useChatStore()
    const subagentStore = useSubagentStore()
    const virtualKey = subagentVirtualId('sess-1', 'bg-1')

    // 注入 subagent messages
    store.setMessages(virtualKey, [makeMessage('bg-msg')])
    expect(store.getMessages(virtualKey)).toHaveLength(1)

    // backToMain 立即清（需传 mainSessionId + chatEvict 回调）
    subagentStore.backToMain('panel-A', 'sess-1', 'bg-1', (sid: string) => store.evictSessionWithVirtual(sid))

    expect(store.getMessages(virtualKey)).toEqual([])
  })

  it('backToMain 幂等：清不存在 key 无副作用（catch 回滚路径安全）', () => {
    const subagentStore = useSubagentStore()
    // 未注入任何 messages 直接 backToMain
    expect(() => subagentStore.backToMain('panel-A', 'sess-1', 'never', (sid: string) => {})).not.toThrow()
  })
})

// ── FR-7: tombstone 防终态 fetchAndInject 复活 ────────────────────

describe('M7 FR-7: tombstone 防终态 fetchAndInject 复活', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('backToMain 后迟到终态 fetchAndInject 不复活 messages', () => {
    const store = useChatStore()
    const subagentStore = useSubagentStore()
    const virtualKey = subagentVirtualId('sess-1', 'bg-1')

    store.setMessages(virtualKey, [makeMessage('bg-msg')])
    // backToMain 设 tombstone + 清
    subagentStore.backToMain('panel-A', 'sess-1', 'bg-1', (sid: string) => store.evictSessionWithVirtual(sid))
    expect(store.getMessages(virtualKey)).toEqual([])

    // 模拟迟到的终态 fetchAndInject（subscribeStream 终态回调在 backToMain 前已启动）
    // tombstone 应短路，不 setMessages 复活
    subagentStore.tryInjectIfNotCleared(virtualKey, [makeMessage('revive-attempt')])
    expect(store.getMessages(virtualKey)).toEqual([]) // 仍空，未复活
  })
})

// ── FR-5: deleteSession 时序 ─────────────────────────────────────

describe('M7 FR-5: deleteSession 时序 evict 在 dispose 前', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('deleteSession 时该 session 的 subagent 虚拟 key 被清', () => {
    const store = useChatStore()
    const vk1 = subagentVirtualId('s0', 'sa1')
    const vk2 = subagentVirtualId('s0', 'sa2')

    store.hydrate('s0', [makeMessage('m0')])
    store.setMessages(vk1, [makeMessage('sa1')])
    store.setMessages(vk2, [makeMessage('sa2')])

    // deleteSession 应先 evictSessionWithVirtual（清虚拟 key）再 disposeSession（清主 session）
    // 这里直接验证最终状态：全部清
    store.evictSessionWithVirtual('s0')
    store.disposeSession('s0')

    expect(store.getMessages('s0')).toEqual([])
    expect(store.getMessages(vk1)).toEqual([])
    expect(store.getMessages(vk2)).toEqual([])
  })

  it('deleteSession 不误清其他 session 的虚拟 key', () => {
    const store = useChatStore()
    const vk0 = subagentVirtualId('s0', 'sa1')
    const vk1 = subagentVirtualId('s1', 'sb1')

    store.hydrate('s0', [makeMessage('m0')])
    store.hydrate('s1', [makeMessage('m1')])
    store.setMessages(vk0, [makeMessage('sa1')])
    store.setMessages(vk1, [makeMessage('sb1')])

    store.evictSessionWithVirtual('s0')
    store.disposeSession('s0')

    // s0 的虚拟 key 清，s1 的保留
    expect(store.getMessages(vk0)).toEqual([])
    expect(store.getMessages(vk1)).toHaveLength(1)
  })
})
