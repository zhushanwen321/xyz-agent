/**
 * domain/chat mutations 迁移单测（语义等价锁定，w1 原样迁移）。
 *
 * 锁定 commitMessages/deleteMessages/truncateMessagesFrom/prependHistory 的不可变写入语义：
 * 核心不变式——「新 Map → set/delete → 整体赋值 .value」，value 引用必须变化
 * （shallowRef 下 Map mutation 不触发响应式，整体替换才触发）。
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@xyz-agent/shared'
import {
  commitMessages,
  deleteMessages,
  truncateMessagesFrom,
  prependHistory,
  type MessagesRef,
} from '../mutations'

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

function makeRef(seed: Record<string, Message[]> = {}): MessagesRef {
  return { value: new Map(Object.entries(seed)) }
}

describe('commitMessages', () => {
  it('set 后整体赋值 .value：value 引用变化 + 内容正确', () => {
    const ref = makeRef()
    const before = ref.value
    commitMessages(ref, 's1', [makeMessage('m1')])
    expect(ref.value).not.toBe(before) // 不可变：整体替换触发 shallowRef
    expect(ref.value.get('s1')).toHaveLength(1)
    expect(ref.value.get('s1')![0].id).toBe('m1')
  })

  it('保留其他 session 的既有条目（不原地 mutation）', () => {
    const ref = makeRef({ s0: [makeMessage('m0')] })
    commitMessages(ref, 's1', [makeMessage('m1')])
    expect(ref.value.get('s0')).toHaveLength(1)
    expect(ref.value.get('s1')).toHaveLength(1)
  })
})

describe('deleteMessages', () => {
  it('delete 后整体赋值：value 引用变化 + 条目消失', () => {
    const ref = makeRef({ s0: [makeMessage('m0')], s1: [makeMessage('m1')] })
    const before = ref.value
    deleteMessages(ref, 's0')
    expect(ref.value).not.toBe(before)
    expect(ref.value.has('s0')).toBe(false)
    expect(ref.value.has('s1')).toBe(true)
  })

  it('删除不存在的 key 为 no-op（value 仍整体赋值，内容不变）', () => {
    const ref = makeRef({ s0: [makeMessage('m0')] })
    deleteMessages(ref, 'nope')
    expect(ref.value.has('nope')).toBe(false)
    expect(ref.value.get('s0')).toHaveLength(1)
  })

  it('泛型 V 兼容 Map<string, unknown> 宽类型（chat-lru deps 用）', () => {
    const ref: { value: Map<string, unknown> } = { value: new Map([['a', 1]]) }
    deleteMessages(ref, 'a')
    expect(ref.value.has('a')).toBe(false)
  })
})

describe('truncateMessagesFrom', () => {
  const msgs = [makeMessage('a'), makeMessage('b'), makeMessage('c')]

  it('inclusive=true：截断包含 messageId，保留其之前（编辑重发语义，useChat editAndResend 传 true）', () => {
    const ref = makeRef({ s1: msgs })
    truncateMessagesFrom(ref, 's1', 'b', true)
    expect(ref.value.get('s1')!.map((m) => m.id)).toEqual(['a'])
  })

  it('inclusive=false：截断不包含 messageId，保留到含 messageId', () => {
    const ref = makeRef({ s1: msgs })
    truncateMessagesFrom(ref, 's1', 'b', false)
    expect(ref.value.get('s1')!.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('messageId 不存在：no-op，不写入', () => {
    const ref = makeRef({ s1: msgs })
    const before = ref.value
    truncateMessagesFrom(ref, 's1', 'zzz', true)
    expect(ref.value).toBe(before) // 幂等：无变化不触发写入
    expect(ref.value.get('s1')).toHaveLength(3)
  })

  it('session 不存在：no-op（不新增条目）', () => {
    const ref = makeRef()
    const before = ref.value
    truncateMessagesFrom(ref, 'ghost', 'a', true)
    expect(ref.value).toBe(before)
    expect(ref.value.has('ghost')).toBe(false)
  })
})

describe('prependHistory', () => {
  it('按 messageId 去重合并到列表头部', () => {
    const ref = makeRef({ s1: [makeMessage('b'), makeMessage('c')] })
    prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
    expect(ref.value.get('s1')!.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('幂等：无新消息不触发写入（value 引用不变）', () => {
    const ref = makeRef({ s1: [makeMessage('a')] })
    const before = ref.value
    prependHistory(ref, 's1', [makeMessage('a')])
    expect(ref.value).toBe(before)
  })

  it('session 无历史时全量作为头部', () => {
    const ref = makeRef()
    prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
    expect(ref.value.get('s1')!.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
