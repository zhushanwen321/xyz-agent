import { describe, it, expect } from 'vitest'
import { rebuildHistoryFromEntries } from '../../../infra/pi/entry-tree-builder.js'
import type { SegmentsMetadataFile } from '@xyz-agent/shared'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCustomEntry,
  PiSessionLabelEntry,
  PiSessionCompactionEntry,
  PiHistoryMessage,
  PiHistoryToolResult,
  PiHistoryContentPart,
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
  content?: PiHistoryContentPart[]
  timestamp?: string
}): PiSessionMessageEntry {
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message: {
      role: overrides.role ?? 'user',
      content: overrides.content ?? [{ type: 'text', text: overrides.text ?? 'hello' }],
      timestamp: Date.now(),
    },
  }
}

/**
 * 构造 toolResult message entry。
 *
 * toolResult 在 pi entry 树里也是 message entry（type:'message'），其 message.role='toolResult'，
 * 额外字段 toolCallId/toolName/isError/details。rebuildHistoryFromEntries 经 convertPiHistory
 * 把它合并到上一个 assistant.toolCalls[toolCallId 匹配]（C1 修复核心回归点）。
 */
function makeToolResultEntry(overrides: {
  id: string
  parentId?: string | null
  toolCallId: string
  toolName?: string
  text?: string
  isError?: boolean
  details?: Record<string, unknown>
  timestamp?: string
}): PiSessionMessageEntry {
  const message: PiHistoryToolResult = {
    role: 'toolResult',
    content: [{ type: 'text', text: overrides.text ?? 'tool output' }],
    timestamp: Date.now(),
    toolCallId: overrides.toolCallId,
    toolName: overrides.toolName ?? 'tool',
    ...(overrides.isError !== undefined && { isError: overrides.isError }),
    ...(overrides.details !== undefined && { details: overrides.details }),
  }
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message,
  }
}

/**
 * 构造"特殊 role" message entry（compactionSummary / custom / branchSummary）。
 *
 * 这些 role 在 pi get_messages 返回的扁平列表里是顶层 role，但 pi entry 树持久化时也作为
 * message entry 存储（type:'message'，message.role 为对应特殊值）。
 * rebuildHistoryFromEntries 提取 entry.message 后走 convertPiHistory，由其内部分支转成 system
 * 消息（C1 修复核心回归点——之前直接 convertSinglePiMessage 对这些 role 返回 null 丢弃）。
 */
function makeSpecialRoleEntry(overrides: {
  id: string
  parentId?: string | null
  role: 'compactionSummary' | 'custom' | 'branchSummary'
  // 角色专属字段透传到 message 上（用 Record 松结构，由调用方负责形状）
  message: Record<string, unknown>
  timestamp?: string
}): PiSessionMessageEntry {
  // 特殊 role（compactionSummary/custom/branchSummary）不在 PiHistoryMessage 的 role 联合里
  // （那是 pi get_messages 扁平历史 role；entry 树持久化时也作为 message entry 存）。
  // convertPiHistory 签名收 unknown[]，运行时按 m.role 字符串分派，故这里经 unknown 断言绕过 TS。
  const message = { role: overrides.role, content: [], timestamp: Date.now(), ...overrides.message } as unknown as PiHistoryMessage
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message,
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

  // ════════════════════════════════════════════════════════════════════
  // C1 回归测试：toolResult / compactionSummary / custom / branchSummary
  // ════════════════════════════════════════════════════════════════════
  // 背景：rebuildHistoryFromEntries 原本直接调 convertSinglePiMessage，对 toolResult/特殊 role
  // 返回 null 全部丢弃。C1 修复改为整批走 convertPiHistory，复用 toolResult 合并 +
  // compactionSummary/custom/branchSummary → system 消息处理（AGENTS.md #7.5：可重开恢复）。
  // 以下 5 个用例覆盖这 4 类 entry 的还原，是 C1 回归的硬性 gate。

  // ── C1 用例 1：toolResult 合并到上一个 assistant.toolCalls ──────────
  it('C1 case 1: toolResult message entry → merged into preceding assistant.toolCalls (output/outputRaw/isError/details restored)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({
        id: 'msg-c1-01',
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me check' }],
      }),
      makeMessageEntry({
        id: 'msg-c1-02',
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-c1-1', name: 'readFile', arguments: { path: '/foo' } },
        ],
      }),
      makeToolResultEntry({
        id: 'msg-c1-03',
        toolCallId: 'tc-c1-1',
        toolName: 'readFile',
        text: 'file contents here',
        details: {
          __gui__: { v: 1, component: { type: 'stats-line', props: { items: [] } } },
        },
      }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // toolResult 不产独立 message（合并到上一个 assistant），共 2 条（text assistant + toolCall assistant）
    expect(messages).toHaveLength(2)
    const toolCallAssistant = messages[1]
    expect(toolCallAssistant.role).toBe('assistant')
    expect(toolCallAssistant.toolCalls).toHaveLength(1)
    const tc = toolCallAssistant.toolCalls![0]
    expect(tc.id).toBe('tc-c1-1')
    // ★ C1 核心断言：output 还原（之前丢失）
    expect(tc.output).toBe('file contents here')
    // status: 非 error → completed（默认值，不被 toolResult 改写）
    expect(tc.status).toBe('completed')
    // ★ C1 核心断言：details（含 __gui__）透传（之前丢失，违反规则 7.5）
    expect(tc.details).toEqual({
      __gui__: { v: 1, component: { type: 'stats-line', props: { items: [] } } },
    })
  })

  // ── C1 用例 2：toolResult isError=true → toolCall.status='error' ────
  it('C1 case 2: toolResult isError=true → merged toolCall.status="error" (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({
        id: 'msg-c1-10',
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-c1-2', name: 'bash', arguments: { cmd: 'exit 1' } },
        ],
      }),
      makeToolResultEntry({
        id: 'msg-c1-11',
        toolCallId: 'tc-c1-2',
        toolName: 'bash',
        text: 'command failed',
        isError: true,
      }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    // ★ C1 核心断言：error 状态还原（之前 toolResult 被丢，status 恒为 completed）
    expect(messages[0].toolCalls![0].status).toBe('error')
    expect(messages[0].toolCalls![0].output).toBe('command failed')
  })

  // ── C1 用例 3：compactionSummary message entry → system 消息 ────────
  it('C1 case 3: compactionSummary message entry → system message with compactionSummary field (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg-c1-20', role: 'user', text: '问题' }),
      makeSpecialRoleEntry({
        id: 'msg-c1-21',
        role: 'compactionSummary',
        message: { summary: '上下文已压缩', tokensBefore: 10000, timestamp: 12345 },
      }),
      makeMessageEntry({ id: 'msg-c1-22', role: 'assistant', text: '回答' }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(compaction) + assistant = 3 条（之前 compactionSummary 被丢，只剩 2 条）
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    const sysMsg = messages[1]
    // ★ C1 核心断言：compactionSummary 字段还原
    expect(sysMsg.compactionSummary).toEqual({
      summary: '上下文已压缩',
      tokensBefore: 10000,
      timestamp: 12345,
    })
    expect(sysMsg.content).toBe('上下文已压缩')
  })

  // ── C1 用例 4：custom message entry (bg-notify) → system 消息 ───────
  it('C1 case 4: custom message entry (subagent-bg-notify) → system message with customType + bgNotify (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg-c1-30', role: 'user', text: 'run subagent' }),
      makeSpecialRoleEntry({
        id: 'msg-c1-31',
        role: 'custom',
        message: {
          customType: 'subagent-bg-notify',
          content: 'Subagent "coder" (job-1) completed. Result:\nDone.',
          details: {
            id: 'job-1',
            status: 'done',
            agent: 'coder',
            model: 'claude-4.5',
            result: 'Done.',
            startedAt: 1000,
            endedAt: 13000,
          },
          display: true,
        },
      }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(custom) = 2 条（之前 custom 被丢，只剩 1 条）
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system'])
    const sysMsg = messages[1]
    // ★ C1 核心断言：customType + bgNotify 还原
    expect(sysMsg.customType).toBe('subagent-bg-notify')
    expect(sysMsg.bgNotify).toBeDefined()
    const rec = sysMsg.bgNotify as { id: string; agent: string; status: string }
    expect(rec.id).toBe('job-1')
    expect(rec.agent).toBe('coder')
    expect(rec.status).toBe('done')
    // display 透传
    expect(sysMsg.display).toBe(true)
  })

  // ── C1 用例 5：branchSummary message entry → system 消息 ────────────
  it('C1 case 5: branchSummary message entry → system message with branchSummary field (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeSpecialRoleEntry({
        id: 'msg-c1-40',
        role: 'branchSummary',
        message: { summary: '分支摘要内容', fromId: 'msg-abc', timestamp: 456 },
      }),
      makeMessageEntry({ id: 'msg-c1-41', role: 'assistant', text: '继续' }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // system(branch) + assistant = 2 条（之前 branchSummary 被丢，只剩 1 条）
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant'])
    const sysMsg = messages[0]
    // ★ C1 核心断言：branchSummary 字段还原
    expect(sysMsg.branchSummary).toEqual({
      summary: '分支摘要内容',
      fromId: 'msg-abc',
      timestamp: 456,
    })
    expect(sysMsg.content).toBe('分支摘要内容')
  })

  // ── C1 用例 6：完整混合流（user→assistant→toolResult→compaction→custom→assistant）──
  it('C1 case 6: mixed stream (toolResult + compaction + custom + user messages) all restored in order', () => {
    const userEntryId = 'msg-c1-50'
    const clientUuid = 'u-c1-mixed'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '开始' }),
      makeClientMsgIdEntry({ id: 'cus-c1-50', clientUuid, userEntryId }),
      makeMessageEntry({
        id: 'msg-c1-51',
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-mix', name: 'read', arguments: { path: '/x' } }],
      }),
      makeToolResultEntry({
        id: 'msg-c1-52',
        toolCallId: 'tc-mix',
        text: 'ok',
      }),
      makeSpecialRoleEntry({
        id: 'msg-c1-53',
        role: 'compactionSummary',
        message: { summary: '压缩', tokensBefore: 500, timestamp: 999 },
      }),
      makeSpecialRoleEntry({
        id: 'msg-c1-54',
        role: 'custom',
        message: { customType: 'subagent-bg-notify', content: 'bg done', details: { id: 'j', status: 'done', agent: 'a', startedAt: 1 } },
      }),
      makeMessageEntry({ id: 'msg-c1-55', role: 'assistant', text: '完成' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'image', id: 'img-mix', path: '/tmp/m.png', fileName: 'm.png', displayName: 'm.png' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // user(toolResult 合并不产独立 msg) + system(compaction) + system(custom) + assistant = 5
    expect(messages).toHaveLength(5)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'system', 'assistant'])
    // user message 回填 image badge（segments 回填与 C1 修复正交，但同时生效）
    expect(messages[0].content).toEqual([
      { type: 'image', id: 'img-mix', path: '/tmp/m.png', fileName: 'm.png', displayName: 'm.png' },
    ])
    // toolResult 合并到 messages[1] 的 toolCall
    expect(messages[1].toolCalls![0].output).toBe('ok')
    // compaction system message
    expect(messages[2].compactionSummary).toBeDefined()
    // custom system message
    expect(messages[3].customType).toBe('subagent-bg-notify')
  })
})
