import { describe, it, expect } from 'vitest'
import { rebuildHistoryFromEntries } from '../../../infra/pi/entry-tree-builder.js'
import type { SegmentsMetadataFile } from '@xyz-agent/shared'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCustomEntry,
  PiSessionLabelEntry,
  PiSessionCompactionEntry,
} from '../../../infra/pi/pi-protocol.js'

// ── 测试数据工厂 ────────────────────────────────────────────────────
// 参考 pi get_entries 真实返回结构（步骤 0 verify 脚本打印过）：
// entry.id 是 pi 生成的随机 id，parentId 串成树，timestamp 是 ISO string。

/** 构造 message entry。role/content/timestamp 可定制。 */
function makeMessageEntry(overrides: {
  id: string
  parentId?: string | null
  role?: 'user' | 'assistant'
  text?: string
  timestamp?: string
}): PiSessionMessageEntry {
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message: {
      role: overrides.role ?? 'user',
      content: [{ type: 'text', text: overrides.text ?? 'hello' }],
      timestamp: Date.now(),
    },
  }
}

/**
 * 构造 xyz.client-msg-id custom entry。data 结构由 xyz-agent extension 定义。
 *
 * `data` 参数语义：传 undefined → 用正常默认结构；传任何值（含 null / 畸形对象）→ 原样使用。
 * 用 'data' in overrides 检测是否显式传了 data（区分 undefined 默认 vs 显式 undefined），
 * 不用 ?? —— ?? 会把 null/undefined 都当 nullish 走默认，无法测试 data:null 降级。
 */
function makeClientMsgIdEntry(overrides: {
  id: string
  parentId?: string | null
  clientUuid: string
  userEntryId: string
  data?: unknown // 传任何值（含 null）原样用；不传则用正常默认结构
  timestamp?: string
}): PiSessionCustomEntry {
  const data = 'data' in overrides
    ? overrides.data
    : { clientUuid: overrides.clientUuid, userEntryId: overrides.userEntryId }
  return {
    type: 'custom',
    customType: 'xyz.client-msg-id',
    id: overrides.id,
    parentId: overrides.parentId ?? overrides.userEntryId,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.100Z',
    data,
  }
}

/** 构造 segments sidecar。 */
function makeSegmentsMetadata(entries: SegmentsMetadataFile['entries']): SegmentsMetadataFile {
  return { version: 1, entries }
}

/** 从 Message.content 提取纯文本（Segment[] | string 归一）。测试断言辅助。 */
function contentToText(content: ReturnType<typeof rebuildHistoryFromEntries>['messages'][number]['content']): string {
  if (typeof content === 'string') return content
  return content.map((s) => (s.type === 'text' ? s.text : `[${s.type}]`)).join('')
}

describe('rebuildHistoryFromEntries', () => {
  // ── 用例 1：纯 message entry（无 custom）──────────────────────────
  it('case 1: pure message entries without custom → empty clientUuidMap, default textToSegments content', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg00100', role: 'user', text: '看图' }),
      makeMessageEntry({ id: 'msg00101', role: 'assistant', text: '好的' }),
      makeMessageEntry({ id: 'msg00102', role: 'user', text: '再见' }),
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(3)
    expect(clientUuidMap.size).toBe(0)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    // user message content 是 textToSegments 默认产出（单个 text segment）
    expect(messages[0].content).toEqual([{ type: 'text', text: '看图' }])
    expect(messages[2].content).toEqual([{ type: 'text', text: '再见' }])
    // piEntryId 从 entry.id 填充
    expect(messages[0].piEntryId).toBe('msg00100')
    expect(messages[1].piEntryId).toBe('msg00101')
  })

  // ── 用例 2：映射命中 + segmentsMetadata 命中 → 回填完整 Segment[] ──
  it('case 2: clientUuid map hit + segmentsMetadata hit → content replaced with structured segments (incl image)', () => {
    const userEntryId = 'msg00200'
    const clientUuid = 'u-test-uuid-002'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '[图片 1] 看图' }),
      makeClientMsgIdEntry({ id: 'cus00200', clientUuid, userEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        // 完整结构化 Segment[]：image badge + text，还原 composer 提交时的 badge
        segments: [
          { type: 'image', id: 'img-1', path: '/tmp/a.png', fileName: 'a.png', displayName: '截图.png' },
          { type: 'text', text: '看图' },
        ],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // user message content 被替换为完整结构化 segments（含 image badge）
    expect(messages[0].content).toEqual([
      { type: 'image', id: 'img-1', path: '/tmp/a.png', fileName: 'a.png', displayName: '截图.png' },
      { type: 'text', text: '看图' },
    ])
  })

  // ── 用例 3：映射命中但 segmentsMetadata 缺 → 保持默认产出 ──────────
  it('case 3: clientUuid map hit but segmentsMetadata null → keep default textToSegments content', () => {
    const userEntryId = 'msg00300'
    const clientUuid = 'u-test-uuid-003'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '[图片 1] 看图' }),
      makeClientMsgIdEntry({ id: 'cus00300', clientUuid, userEntryId }),
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // segmentsMetadata 为 null → 保持 convertSinglePiMessage 默认产出（textToSegments，无 image badge）
    expect(messages[0].content).toEqual([{ type: 'text', text: '[图片 1] 看图' }])
  })

  // ── 用例 4：多 user message 顺序保留（部分有映射）────────────────
  it('case 4: multiple user messages preserve order, partial mapping backfills only mapped ones', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg00400', role: 'user', text: '第一句（有映射）' }),
      makeClientMsgIdEntry({ id: 'cus00400', clientUuid: 'uuid-400', userEntryId: 'msg00400' }),
      makeMessageEntry({ id: 'msg00401', role: 'user', text: '第二句（无映射）' }),
      makeMessageEntry({ id: 'msg00402', role: 'user', text: '第三句（有映射）' }),
      makeClientMsgIdEntry({ id: 'cus00402', clientUuid: 'uuid-402', userEntryId: 'msg00402' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid: 'uuid-400',
        segments: [{ type: 'file', path: '/a.ts' }, { type: 'text', text: '第一句（有映射）' }],
        timestamp: Date.now(),
      },
      {
        clientUuid: 'uuid-402',
        segments: [{ type: 'mention', name: 'user' }, { type: 'text', text: '第三句（有映射）' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(3)
    expect(clientUuidMap.size).toBe(2)
    // 顺序保留
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'user'])
    // 第 1、3 回填结构化 segments，第 2 默认 textToSegments
    expect(messages[0].content).toEqual([{ type: 'file', path: '/a.ts' }, { type: 'text', text: '第一句（有映射）' }])
    expect(messages[1].content).toEqual([{ type: 'text', text: '第二句（无映射）' }])
    expect(messages[2].content).toEqual([{ type: 'mention', name: 'user' }, { type: 'text', text: '第三句（有映射）' }])
  })

  // ── 用例 5：custom entry 在 message entry 之前（顺序无关）──────────
  it('case 5: custom entry before message entry → still matches (two-pass, order-independent)', () => {
    const userEntryId = 'msg00500'
    const clientUuid = 'u-test-uuid-005'
    const entries: PiSessionEntry[] = [
      // custom entry 先出现
      makeClientMsgIdEntry({ id: 'cus00500', clientUuid, userEntryId }),
      // message entry 后出现
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'image', id: 'img-5', path: '/tmp/b.png', fileName: 'b.png', displayName: 'b.png' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // 仍能匹配并回填（两遍遍历，custom 在前不影响）
    expect(messages[0].content).toEqual([
      { type: 'image', id: 'img-5', path: '/tmp/b.png', fileName: 'b.png', displayName: 'b.png' },
    ])
  })

  // ── 用例 6：custom entry 在 message entry 之后（顺序无关）──────────
  it('case 6: custom entry after message entry → still matches (order-independent, reverse of case 5)', () => {
    const userEntryId = 'msg00600'
    const clientUuid = 'u-test-uuid-006'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
      makeClientMsgIdEntry({ id: 'cus00600', clientUuid, userEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'skill', name: 'review' }, { type: 'text', text: '看图' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    expect(messages[0].content).toEqual([
      { type: 'skill', name: 'review' },
      { type: 'text', text: '看图' },
    ])
  })

  // ── 用例 7：畸形 custom entry data → 跳过该 entry，不崩溃 ──────────
  it('case 7: malformed custom entry data (clientUuid not string) → skip entry, no crash, fallback to default', () => {
    const userEntryId = 'msg00700'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
      // 畸形 data：clientUuid 是 number（不是 string）
      makeClientMsgIdEntry({
        id: 'cus00700',
        clientUuid: 'ignored',
        userEntryId,
        data: { clientUuid: 12345, userEntryId }, // clientUuid 类型错
      }),
      // 另一个畸形 data：userEntryId 缺失
      makeClientMsgIdEntry({
        id: 'cus00701',
        clientUuid: 'ignored2',
        userEntryId,
        data: { clientUuid: 'only-uuid' }, // 缺 userEntryId
      }),
      // 第三个畸形 data：data 是 null
      makeClientMsgIdEntry({
        id: 'cus00702',
        clientUuid: 'ignored3',
        userEntryId,
        data: null,
      }),
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    // 所有畸形 custom entry 都被跳过，clientUuidMap 为空
    expect(clientUuidMap.size).toBe(0)
    // 无映射 → 默认 textToSegments 产出
    expect(messages[0].content).toEqual([{ type: 'text', text: '看图' }])
  })

  // ── 用例 8：非 message 非 custom entry（label/summary）→ 跳过 ──────
  it('case 8: label/compaction entries (non-message, non-client-msg-id) → skipped, do not affect messages', () => {
    const labelEntry: PiSessionLabelEntry = {
      type: 'label',
      id: 'lbl00800',
      parentId: null,
      timestamp: '2026-07-25T10:00:00.000Z',
      label: '重要',
      targetId: 'msg00800',
    }
    // compaction entry：pi compact 产生的摘要（type:'compaction'，本函数不消费，应跳过）
    const compactionEntry: PiSessionCompactionEntry = {
      type: 'compaction',
      id: 'sum00800',
      parentId: null,
      timestamp: '2026-07-25T10:00:00.000Z',
      summary: '已压缩',
      firstKeptEntryId: 'msg00800',
      tokensBefore: 1000,
    }
    // 非 xyz.client-msg-id 的 custom entry（其他扩展的 custom）也应跳过
    const otherCustomEntry: PiSessionCustomEntry = {
      type: 'custom',
      customType: 'other.extension-type',
      id: 'cus00800',
      parentId: null,
      timestamp: '2026-07-25T10:00:00.000Z',
      data: { foo: 'bar' },
    }

    const entries: PiSessionEntry[] = [
      labelEntry,
      makeMessageEntry({ id: 'msg00800', role: 'user', text: '正常消息' }),
      compactionEntry,
      otherCustomEntry,
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    // 只有 1 个 message entry 被转，其余 label/compaction/其他 custom 全跳过
    expect(messages).toHaveLength(1)
    expect(clientUuidMap.size).toBe(0)
    expect(messages[0].content).toEqual([{ type: 'text', text: '正常消息' }])
  })

  // ── 补充用例 9：assistant message 不回填 segments（只 user 回填）───
  it('case 9 (extra): assistant message never backfills segments even with mapping (only user role backfills)', () => {
    const assistantEntryId = 'msg00900'
    const clientUuid = 'u-test-uuid-009'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: assistantEntryId, role: 'assistant', text: 'assistant 回复' }),
      // 恶意/异常：custom entry 指向 assistant entry（正常不该发生，但防御）
      makeClientMsgIdEntry({ id: 'cus00900', clientUuid, userEntryId: assistantEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'image', id: 'img-9', path: '/tmp/c.png', fileName: 'c.png', displayName: 'c.png' }],
        timestamp: Date.now(),
      },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    // assistant message content 保持 string（不被 segments 覆盖），只 user 回填
    expect(messages[0].content).toBe('assistant 回复')
  })

  // ── 补充用例 10：空 segments sidecar 条目（segments: []）不覆盖默认 ──
  it('case 10 (extra): empty segments in sidecar (segments: []) → do not override default (avoid clearing valid default)', () => {
    const userEntryId = 'msg01000'
    const clientUuid = 'u-test-uuid-010'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
      makeClientMsgIdEntry({ id: 'cus01000', clientUuid, userEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      { clientUuid, segments: [], timestamp: Date.now() }, // 空 segments
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    // 空 segments 不覆盖默认产出（避免把有效 textToSegments 结果清空成空数组）
    expect(contentToText(messages[0].content)).toBe('看图')
  })
})
