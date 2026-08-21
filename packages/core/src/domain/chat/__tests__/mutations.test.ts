/**
 * domain/chat mutations 单测（W10 D-1 容器范式适配 + W13 R-17 核心断言重写 + W5 D5 锚定切分）。
 *
 * 锁定 commitMessages/deleteMessages/truncateMessagesFrom/prependHistory 在
 * `Map<string, ShallowRef<Message[]>>` 容器下的写入语义（07 文档 §3.3.2 不变式）：
 * 1. 外层 Map 引用只在「增删 sid key」时替换；sid 已存在时 commit 只替换内层 ref 的 .value。
 * 2. 每 sid 的分区 ref 一旦创建（首次 commit），引用在 session 存活期间稳定。
 * 3. 分区隔离：A sid commit 不触碰 B sid 的分区 ref（引用与内容均不动）。
 *
 * [W5 D5] splitHistoryBeforeAnchor 三级定位（exact / fingerprint / none）+
 * prependHistory 兜底断言（命中重复 warn + 行为仍去重）+ 「活跃 session 翻旧历史无重复」
 * 端到端行为断言（hydrate 尾窗 + live 消息混合 id 空间下 load-more 不重复前插）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { shallowRef } from 'vue'
import type { Message } from '@xyz-agent/shared'
import { textToSegments } from '@xyz-agent/shared'
import {
  commitMessages,
  deleteMessages,
  truncateMessagesFrom,
  prependHistory,
  splitHistoryBeforeAnchor,
  type MessagesRef,
} from '../mutations'

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

/** 文件侧 user 消息（hydrate/全量路径产物形态：id 与 piEntryId 均为 entry 派生 id） */
function fileUser(entryId: string, text: string, timestamp: number): Message {
  return { id: entryId, piEntryId: entryId, role: 'user', content: text, status: 'complete', timestamp }
}

/** 文件侧 assistant 消息（同 fileUser，role 区分供指纹路径断言） */
function fileAssistant(entryId: string, text: string, timestamp: number): Message {
  return { id: entryId, piEntryId: entryId, role: 'assistant', content: text, status: 'complete', timestamp }
}

/** 文件侧 system 消息（compaction 等族：无 piEntryId 字段，id 即 entry 派生 id——对称取值的关键形态） */
function fileSystem(entryId: string, text: string, timestamp: number): Message {
  return { id: entryId, role: 'system', content: text, status: 'complete', timestamp }
}

/** live 侧 user 消息（appendUser 直插形态：u- 前缀 id、content 为 Segment[]、无 piEntryId） */
function liveUser(id: string, text: string): Message {
  return { id, role: 'user', content: textToSegments(text), status: 'complete', timestamp: 99 }
}

/** live 侧 assistant 消息（overlay 路径形态：e<N> 派生 id、无 piEntryId） */
function liveAssistant(id: string, text: string): Message {
  return { id, role: 'assistant', content: text, status: 'complete', timestamp: 99 }
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
    const before = ref.value
    deleteMessages(ref, 'nope')
    expect(ref.value).not.toBe(before) // deleteMessages 无条件 new Map 整体替换（不查 key 是否存在）
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

  it('[W5 D5] 兜底断言：命中重复即 console.warn（说明锚切分异常），行为仍去重（安全网）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ref = makeRef({ s1: [makeMessage('b'), makeMessage('c')] })
      prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b'), makeMessage('c')])
      // 行为仍是安全网去重（锚切分异常时宁可少插不可重插）
      expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
      // 断言面：命中重复必须出声（锚切分异常的诊断信号）
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain('prependHistory deduped 2')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('[W5 D5] 无重复时不 warn（锚切分正常路径零噪音）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ref = makeRef({ s1: [makeMessage('c')] })
      prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
      expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('splitHistoryBeforeAnchor（W5 D5 锚定切分）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exact：user 消息锚按 piEntryId 精确命中，只返回锚之前的段', () => {
    const full = [
      fileUser('ent-0', 'q0', 0),
      fileSystem('ent-1', 'compaction', 1),
      fileUser('ent-2', 'q2', 2), // ← 锚（hydrate 尾窗首条）
      fileAssistant('ent-3', 'a3', 3),
    ]
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'ent-2', full[2])
    expect(strategy).toBe('exact')
    expect(segment.map((m) => m.id)).toEqual(['ent-0', 'ent-1'])
  })

  it('exact：system 消息锚（无 piEntryId 字段）按 id 命中——取值 piEntryId ?? id 的对称形态', () => {
    // 尾窗首条是 compaction 等 system 族消息的场景：锚 = 其 id（无 piEntryId 字段）
    const full = [fileUser('ent-0', 'q0', 0), fileSystem('ent-1', 'ctx compressed', 1), fileUser('ent-2', 'q2', 2)]
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'ent-1', full[1])
    expect(strategy).toBe('exact')
    expect(segment.map((m) => m.id)).toEqual(['ent-0'])
  })

  it('exact：锚即全量首条 → 空段（没有更早历史，调用方据此隐藏加载更多）', () => {
    const full = [fileUser('ent-0', 'q0', 0), fileUser('ent-1', 'q1', 1)]
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'ent-0', full[0])
    expect(strategy).toBe('exact')
    expect(segment).toHaveLength(0)
  })

  it('fingerprint：锚 id 未命中（外部改写）时按 role+首段文本+timestamp 定位，取最后一个匹配位', () => {
    // full[1] 与 full[2] 同指纹（同 role 同文本同 timestamp，如 steer 重发同文）；
    // 取最后一个匹配位（最接近尾窗），取首个会多前插一段已存在的历史
    const full = [
      fileUser('ent-0', 'q0', 0),
      fileUser('ent-x', 'dup text', 5),
      fileUser('ent-y', 'dup text', 5), // ← 最后一个匹配位
      fileUser('ent-3', 'q3', 6),
    ]
    const anchorSource = fileUser('rewritten-away', 'dup text', 5)
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'rewritten-away', anchorSource)
    expect(strategy).toBe('fingerprint')
    expect(segment.map((m) => m.id)).toEqual(['ent-0', 'ent-x'])
  })

  it('fingerprint：Segment[] content 取首个 text 段（chip 段不参与指纹）', () => {
    const full = [fileUser('ent-0', 'q0', 0), fileUser('ent-1', 'real text', 7)]
    // 锚消息是 live/Segment[] 形态：首个 text 段与 full[1] 同文（chip 段不干扰）
    const anchorSource: Message = {
      id: 'gone',
      role: 'user',
      content: [{ type: 'skill', name: 'review' }, { type: 'text', text: 'real text' }],
      status: 'complete',
      timestamp: 7,
    }
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'gone', anchorSource)
    expect(strategy).toBe('fingerprint')
    expect(segment.map((m) => m.id)).toEqual(['ent-0'])
  })

  it('fingerprint：role 不同不算同一消息（同文本同时间的 user ≠ assistant）', () => {
    const full = [fileUser('ent-0', 'q0', 0), fileAssistant('ent-1', 'same', 5)]
    const anchorSource = fileUser('gone', 'same', 5)
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'gone', anchorSource)
    expect(strategy).toBe('none')
    expect(segment).toHaveLength(2) // none = 全量返回，退回 id 去重兜底
  })

  it('none：零匹配（id 与指纹均未命中）→ 全量返回 + strategy none（调用方 warn + id 去重兜底）', () => {
    const full = [fileUser('ent-0', 'q0', 0), fileUser('ent-1', 'q1', 1)]
    const { segment, strategy } = splitHistoryBeforeAnchor(full, 'vanished', fileUser('vanished', 'other', 9))
    expect(strategy).toBe('none')
    expect(segment).toBe(full)
  })

  it('锚缺失（undefined）→ 直接走 none（无锚场景不尝试指纹）', () => {
    const full = [fileUser('ent-0', 'q0', 0)]
    const { segment, strategy } = splitHistoryBeforeAnchor(full, undefined, undefined)
    expect(strategy).toBe('none')
    expect(segment).toBe(full)
  })

  it('[用户可见行为] 活跃 session 翻旧历史无重复：hydrate 尾窗 + live 消息混合 id 空间，锚切分后旧历史前插一次', () => {
    // 场景（设计文档机制 5，G5）：session hydrate 尾窗后又聊了两轮（live 消息），
    // 点「加载更多」——旧实现按 id 去重会把 live 消息的文件对应物全部重复前插。
    // 用户可见断言：对话流内容（用户在 UI 读到的消息序列）无重复、顺序稳定、live 消息不被动。
    const tailWindow = [
      fileUser('ent-u2', 'question 2', 20), // ← hydrate 尾窗首条 = 锚
      fileAssistant('ent-a2', 'answer 2', 21),
    ]
    const liveMsgs = [
      liveUser('u-111', 'question 3'),
      liveAssistant('e0', 'answer 3'),
    ]
    const ref = makeRef({ s1: [...tailWindow, ...liveMsgs] })

    // getFullHistory（文件全量）：更早历史 + 尾窗对应物（id 相同）+ live 消息的文件对应物（id 永不相等）
    const fullHistory = [
      fileUser('ent-u0', 'question 0', 10),
      fileAssistant('ent-a0', 'answer 0', 11),
      fileUser('ent-u1', 'question 1', 15),
      ...tailWindow, // 尾窗消息的文件形态（与 store 中 id 相同）
      fileUser('ent-u3', 'question 3', 30), // live u-111 的文件对应物
      fileAssistant('ent-a3', 'answer 3', 31), // live e0 的文件对应物
    ]

    // hydrate 记锚（store.hydrate 同规则：尾窗首条 piEntryId ?? id）+ 锚消息 = store 最旧消息
    const anchor = tailWindow[0].piEntryId ?? tailWindow[0].id
    const anchorSource = ref.value.get('s1')!.value[0]
    const { segment, strategy } = splitHistoryBeforeAnchor(fullHistory, anchor, anchorSource)
    expect(strategy).toBe('exact')

    prependHistory(ref, 's1', segment)

    // 用户可见断言 1：对话流完整且无重复（内容视角——同一条消息只出现一次）
    const finalMsgs = ref.value.get('s1')!.value
    const texts = finalMsgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    expect(texts).toEqual([
      'question 0', 'answer 0', 'question 1', // 前插的更早历史（文件序）
      'question 2', 'answer 2', // hydrate 尾窗
      JSON.stringify(textToSegments('question 3')), 'answer 3', // live 消息原样保留
    ])
    // 用户可见断言 2：live 消息不被文件对应物重复（u-111/e0 恰好各出现一次，无 ent-u3/ent-a3 混入）
    expect(finalMsgs.filter((m) => m.id === 'u-111')).toHaveLength(1)
    expect(finalMsgs.filter((m) => m.id === 'e0')).toHaveLength(1)
    expect(finalMsgs.some((m) => m.id === 'ent-u3' || m.id === 'ent-a3')).toBe(false)
    // 用户可见断言 3：总数 = 更早段 + 尾窗 + live（无任何重复前插）
    expect(finalMsgs).toHaveLength(7)
  })
})
