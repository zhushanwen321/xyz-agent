/**
 * domain/chat mutations 单测（W10 D-1 容器范式适配 + W13 R-17 核心断言重写）。
 *
 * 锁定 commitMessages/deleteMessages/truncateMessagesFrom/prependHistory 在
 * `Map<string, ShallowRef<Message[]>>` 容器下的写入语义（07 文档 §3.3.2 不变式）：
 * 1. 外层 Map 引用只在「增删 sid key」时替换；sid 已存在时 commit 只替换内层 ref 的 .value。
 * 2. 每 sid 的分区 ref 一旦创建（首次 commit），引用在 session 存活期间稳定。
 * 3. 分区隔离：A sid commit 不触碰 B sid 的分区 ref（引用与内容均不动）。
 */
import { describe, it, expect } from 'vitest'
import { shallowRef } from 'vue'
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

/** seed 值用真实 shallowRef 构造（与生产 store 声明同形态） */
function makeRef(seed: Record<string, Message[]> = {}): MessagesRef {
  return {
    value: new Map(Object.entries(seed).map(([sid, msgs]) => [sid, shallowRef(msgs)])),
  }
}

describe('commitMessages', () => {
  it('首次建 key：外层 Map 引用替换 + 新 key + 内层 .value 内容正确', () => {
    const ref = makeRef()
    const before = ref.value
    commitMessages(ref, 's1', [makeMessage('m1')])
    expect(ref.value).not.toBe(before) // 增 session 是外层 Map 替换的唯一触发点
    expect(ref.value.has('s1')).toBe(true)
    expect(ref.value.get('s1')!.value).toHaveLength(1)
    expect(ref.value.get('s1')!.value[0].id).toBe('m1')
  })

  it('同 sid commit：外层 Map 引用恒等 + 分区 ref 引用恒等 + 内层 .value 数组替换', () => {
    const ref = makeRef()
    commitMessages(ref, 's1', [makeMessage('m1')])
    const mapAfterFirst = ref.value
    const partition = ref.value.get('s1')!
    const arrBefore = partition.value

    commitMessages(ref, 's1', [makeMessage('m1'), makeMessage('m2')])

    expect(ref.value).toBe(mapAfterFirst) // 不变式 1：同 sid 更新不替换外层 Map
    expect(ref.value.get('s1')).toBe(partition) // 不变式 2：分区 ref 引用稳定
    expect(partition.value).not.toBe(arrBefore) // 数组整体替换（触发 shallowRef 响应）
    expect(partition.value.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('分区隔离：A sid commit 不动 B sid 的分区 ref（引用与内容均不变）', () => {
    const ref = makeRef({ a: [makeMessage('a1')], b: [makeMessage('b1')] })
    const mapBefore = ref.value
    const partitionB = ref.value.get('b')!
    const arrB = partitionB.value

    commitMessages(ref, 'a', [makeMessage('a1'), makeMessage('a2')])

    expect(ref.value).toBe(mapBefore) // Map 恒等（'a' 已存在，不建 key）
    expect(ref.value.get('b')).toBe(partitionB) // B 分区 ref 引用不变
    expect(ref.value.get('b')!.value).toBe(arrB) // B 分区数组引用不变
    expect(ref.value.get('a')!.value.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('保留其他 session 的既有条目（不原地 mutation）', () => {
    const ref = makeRef({ s0: [makeMessage('m0')] })
    commitMessages(ref, 's1', [makeMessage('m1')])
    expect(ref.value.get('s0')!.value).toHaveLength(1)
    expect(ref.value.get('s1')!.value).toHaveLength(1)
  })
})

describe('deleteMessages', () => {
  it('delete 后外层 Map 替换 + 条目消失 + 其他分区 ref 引用稳定', () => {
    const ref = makeRef({ s0: [makeMessage('m0')], s1: [makeMessage('m1')] })
    const before = ref.value
    const partitionS1 = ref.value.get('s1')!
    deleteMessages(ref, 's0')
    expect(ref.value).not.toBe(before) // 减 session 触发 Map 替换
    expect(ref.value.has('s0')).toBe(false)
    expect(ref.value.has('s1')).toBe(true)
    expect(ref.value.get('s1')).toBe(partitionS1) // 未删分区 ref 引用不变
  })

  it('删除不存在的 key：Map 仍整体替换，其他条目内容不变', () => {
    const ref = makeRef({ s0: [makeMessage('m0')] })
    deleteMessages(ref, 'nope')
    expect(ref.value.has('nope')).toBe(false)
    expect(ref.value.get('s0')!.value).toHaveLength(1)
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
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a'])
  })

  it('inclusive=false：截断不包含 messageId，保留到含 messageId', () => {
    const ref = makeRef({ s1: msgs })
    truncateMessagesFrom(ref, 's1', 'b', false)
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('messageId 不存在：no-op，不写入', () => {
    const ref = makeRef({ s1: msgs })
    const mapBefore = ref.value
    const partition = ref.value.get('s1')!
    const arrBefore = partition.value
    truncateMessagesFrom(ref, 's1', 'zzz', true)
    expect(ref.value).toBe(mapBefore) // 幂等：Map 不替换
    expect(partition.value).toBe(arrBefore) // 分区数组引用也不变（未走 commit）
    expect(ref.value.get('s1')!.value).toHaveLength(3)
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
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('幂等：无新消息不触发写入（Map 与分区数组引用均不变）', () => {
    const ref = makeRef({ s1: [makeMessage('a')] })
    const before = ref.value
    const arrBefore = ref.value.get('s1')!.value
    prependHistory(ref, 's1', [makeMessage('a')])
    expect(ref.value).toBe(before)
    expect(ref.value.get('s1')!.value).toBe(arrBefore)
  })

  it('session 无历史时全量作为头部（走首建 key 分支，Map 替换）', () => {
    const ref = makeRef()
    const before = ref.value
    prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
    expect(ref.value).not.toBe(before) // 空分区 → 首建 key → Map 替换
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
