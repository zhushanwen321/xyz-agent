/**
 * EventAdapter message_update / message_start 定向测试（CRAP 靶子：handleMessageUpdate /
 * handleMessageStart）。
 *
 * 已有覆盖：FR-5 error sub-type、FR-2 customType 透传、toolResult/user role 忽略、
 * toolcall_end 锚点（equivalence/tool-call-index）。本文件补齐 sub-type 翻译矩阵的
 * 其余分支与 message_start 的畸形字段守卫（type-safety review：来源是 extension 第三方
 * 代码，畸形值不得以谎报类型进 wire 帧）：
 * - text_delta / thinking_delta：delta 缺省空串 + contentIndex 锚点透传（D-2 合帧依据）
 * - thinking_start / thinking_end：载荷形态（含 contentIndexAnchor 缺省不产字段）
 * - toolcall_start / toolcall_delta / text_start / text_end：noop（噪声抑制）
 * - 未知 sub-type：warn + noop（不崩）
 * - customStart 畸形守卫：customType 非字符串不误入 custom 分支、details 数组/原始值 →
 *   undefined、content 非字符串 → undefined、display 非布尔 → undefined
 *
 * 运行：cd packages/runtime && npx vitest run test/event-adapter-message-stream.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createEventAdapter, type WsSender, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { ServerMessage, ServerMessageUnion } from '@xyz-agent/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

// 帧收窄：sent 元素是宽联合 ServerMessage（payload 全联合），按 type 断言到判别联合
// 成员后 payload 形状取自 protocol SSOT（ServerMessageMap），不手写字段形状。
type CustomStartFrame = Extract<ServerMessageUnion, { type: 'message.customStart' }>
type MessageStartFrame = Extract<ServerMessageUnion, { type: 'message.message_start' }>

type PiTestEvent = PiMessage & Record<string, unknown>

function createAdapter(options?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send, options)
  return { adapter, sent }
}

const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

function dispatchOne(adapter: EventAdapter, event: PiTestEvent): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(event)
      return () => {}
    },
  })
}

function messageUpdate(sub: Record<string, unknown>): PiTestEvent {
  return { type: 'message_update', assistantMessageEvent: sub }
}

const SID = 'test-session-1'

describe('message_update sub-type 翻译矩阵（handleMessageUpdate）', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const r = createAdapter()
    adapter = r.adapter
    sent = r.sent
  })

  it('text_delta：delta 透传 + contentIndex 锚点透传（有序插入锚点）', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'text_delta', delta: 'hel', contentIndex: 2 }))
    await flushAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.text_delta')
    expect(sent[0].payload).toEqual({ sessionId: SID, delta: 'hel', contentIndex: 2 })
  })

  it('text_delta：delta 缺省空串 + 无 contentIndex 不产锚点字段（payload 形态稳定）', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'text_delta' }))
    await flushAsync()
    expect(sent[0].payload).toEqual({ sessionId: SID, delta: '' })
  })

  it('thinking_delta：delta + contentIndex 同构透传（W07 微项 1：与 text_delta 对齐）', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'thinking_delta', delta: 'reason', contentIndex: 0 }))
    await flushAsync()
    expect(sent[0].type).toBe('message.thinking_delta')
    expect(sent[0].payload).toEqual({ sessionId: SID, delta: 'reason', contentIndex: 0 })
  })

  it('thinking_start：contentIndex 有则透传、无则不产字段；thinking_end：无锚点字段', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'thinking_start', contentIndex: 1 }))
    await flushAsync()
    expect(sent[0].type).toBe('message.thinking_start')
    expect(sent[0].payload).toEqual({ sessionId: SID, contentIndex: 1 })

    const r2 = createAdapter()
    dispatchOne(r2.adapter, messageUpdate({ type: 'thinking_start' }))
    await flushAsync()
    expect(r2.sent[0].payload).toEqual({ sessionId: SID })

    const r3 = createAdapter()
    dispatchOne(r3.adapter, messageUpdate({ type: 'thinking_end' }))
    await flushAsync()
    expect(r3.sent[0].type).toBe('message.thinking_end')
    expect(r3.sent[0].payload).toEqual({ sessionId: SID })
  })

  it('噪声 sub-type（toolcall_start/delta、text_start/end）→ noop：零 WS 帧产出', async () => {
    for (const type of ['toolcall_start', 'toolcall_delta', 'text_start', 'text_end']) {
      dispatchOne(adapter, messageUpdate({ type }))
    }
    await flushAsync()
    expect(sent).toEqual([])
  })

  it('未知 sub-type → warn + noop（不崩、不断流）', async () => {
    expect(() => dispatchOne(adapter, messageUpdate({ type: 'future_subtype' }))).not.toThrow()
    await flushAsync()
    expect(sent).toEqual([])
  })

  it('assistantMessageEvent 缺失 → noop（防御：异常帧不产 WS 消息）', async () => {
    dispatchOne(adapter, { type: 'message_update' })
    await flushAsync()
    expect(sent).toEqual([])
  })
})

describe('message_start 畸形字段守卫（handleMessageStart custom 分支）', () => {
  it('customType 非字符串（number / null）→ 不走 custom 分支，按 assistant turn 产 message_start', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, { type: 'message_start', message: { customType: 123, content: 'x' } })
    await flushAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start') // fallback 分支（非 customStart）
    const start = sent[0] as MessageStartFrame
    expect(start.payload.messageId).toMatch(/^a-/) // 生成 messageId 供 file_changes 挂载
  })

  it('details 畸形（数组 / 原始值）→ customStart 帧 details 缺省（不透传谎报类型）', async () => {
    for (const bad of [[1, 2], 'string-details', 42]) {
      const { adapter, sent } = createAdapter()
      dispatchOne(adapter, { type: 'message_start', message: { customType: 'subagent-bg-notify', details: bad } })
      await flushAsync()
      expect(sent[0].type).toBe('message.customStart')
      const custom = sent[0] as CustomStartFrame
      expect(custom.payload.details).toBeUndefined()
    }
  })

  it('content 非字符串 / display 非布尔 → 对应字段缺省（customType 合法仍走 custom 分支）', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, {
      type: 'message_start',
      message: { customType: 'workflow-result', content: 99, display: 'yes' },
    })
    await flushAsync()
    expect(sent[0].type).toBe('message.customStart')
    const custom = sent[0] as CustomStartFrame
    expect(custom.payload.customType).toBe('workflow-result')
    expect(custom.payload.content).toBeUndefined()
    expect(custom.payload.display).toBeUndefined()
  })

  it('msg 有但无 role 且无 customType（assistant turn 变体）→ fallback messageId 路径', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, { type: 'message_start', message: { summary: 'partial' } })
    await flushAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start')
    const start = sent[0] as MessageStartFrame
    expect(start.payload.messageId).toMatch(/^a-/)
  })
})
