/**
 * Extension GUI 协议 — event-adapter 测试
 *
 * 验证：
 * - setWidget marker 检测：NUL marker 编码的 GuiComponent JSON 解码为 extension:widgetGui 帧
 * - handleToolExecutionUpdate：提取 partialResult.details 而非整体对象
 * - handleToolExecutionEnd：outputRaw 提取（含 ANSI 不经 stripAnsi）
 */

import { describe, it, expect } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import { GUI_WIDGET_MARKER } from '@xyz-agent/extension-protocol'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

// ── 辅助：构造 pi setWidget 事件 ──
function makeSetWidgetEvent(widgetKey: string, widgetLines: unknown[]): Record<string, unknown> {
  return {
    type: 'extension_ui_request',
    method: 'setWidget',
    widgetKey,
    widgetLines,
  }
}

// ── 辅助：构造 pi tool_execution_update 事件 ──
function makeToolUpdateEvent(toolCallId: string, partialResult: unknown): Record<string, unknown> {
  return {
    type: 'tool_execution_update',
    toolCallId,
    partialResult,
  }
}

// ── 辅助：构造 pi tool_execution_end 事件 ──
function makeToolEndEvent(toolCallId: string, result: unknown): Record<string, unknown> {
  return {
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'test_tool',
    result,
  }
}

describe('event-adapter: setWidget GUI marker 检测', () => {
  it('NUL marker 编码的 GuiComponent → extension:widgetGui 帧', () => {
    const guiComponent = { type: 'task-list', props: { items: [{ id: 1, text: 'task', status: 'pending' }] } }
    const encoded = [GUI_WIDGET_MARKER + JSON.stringify(guiComponent)]
    const event = makeSetWidgetEvent('todo', encoded)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widgetGui')
    expect(msg!.message.payload.widgetKey).toBe('todo')
    // gui 字段应是解析后的 GuiComponent 对象
    const gui = msg!.message.payload.gui as { type: string; props: { items: unknown[] } }
    expect(gui.type).toBe('task-list')
    expect(gui.props.items).toHaveLength(1)
  })

  it('普通文本 widgetLines → 走原 stripAnsi 路径 extension:widget', () => {
    const event = makeSetWidgetEvent('todo', ['\x1b[32mDone\x1b[0m', 'Next: work'])

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widget')
    expect(msg!.message.payload.widgetKey).toBe('todo')
    // stripAnsi 后的纯文本行
    expect(msg!.message.payload.lines).toEqual(['Done', 'Next: work'])
  })

  it('marker 但 JSON 解析失败 → 降级 stripAnsi 路径', () => {
    const badJson = [GUI_WIDGET_MARKER + '{invalid json}']
    const event = makeSetWidgetEvent('todo', badJson)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    // 降级到普通 widget（不崩溃）
    expect(msg!.message.type).toBe('extension:widget')
  })

  it('marker JSON 合法但非 GuiComponent 形状（缺 type/props）→ 降级 stripAnsi 路径', () => {
    // 合法 JSON 但不是 GuiComponent（无 type 字符串 + props 对象）
    const badShape = [GUI_WIDGET_MARKER + JSON.stringify({ foo: 'bar', type: 42 })]
    const event = makeSetWidgetEvent('todo', badShape)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widget')
  })
})

describe('event-adapter: handleToolExecutionUpdate details 提取', () => {
  it('partialResult 含 details.__gui__ → detail 提取 details 内容', () => {
    const partialResult = {
      details: {
        __gui__: { v: 1, component: { type: 'subagent-trace', props: {} } },
        progress: 50,
      },
      content: 'working...',
    }
    const event = makeToolUpdateEvent('tc-1', partialResult)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('message.tool_call_update')
    const detail = msg!.message.payload.detail as Record<string, unknown>
    // detail 应该提取了 partialResult.details（含 __gui__），而非整个 partialResult
    expect(detail.__gui__).toBeDefined()
    expect(detail.progress).toBe(50)
    // detail 不应包含 content（那是 partialResult 顶层的字段）
    expect(detail.content).toBeUndefined()
  })

  it('partialResult 无 details → fallback 用整个对象', () => {
    // subagent 的 progress 形态：partialResult 本身就是扁平的进度对象
    const partialResult = { currentTool: 'bash', turnCount: 3 }
    const event = makeToolUpdateEvent('tc-1', partialResult)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    const detail = msg!.message.payload.detail as Record<string, unknown>
    expect(detail.currentTool).toBe('bash')
    expect(detail.turnCount).toBe(3)
  })

  it('partialResult 为字符串 → detail 为字符串', () => {
    const event = makeToolUpdateEvent('tc-1', 'loading...')

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.payload.detail).toBe('loading...')
  })
})

describe('event-adapter: setStatus textRaw (保留 ANSI 颜色信息)', () => {
  // 审计项 B：协议 spec §8.1 要求 setStatus 不再 stripAnsi（保留颜色信息），或提供 textRaw 字段。
  // 此处验证 text（stripAnsi 后纯文本，向后兼容）+ textRaw（原始 ANSI 文本）同时产出。
  it('statusText 含 ANSI → status-broadcast payload 含 text(stripAnsi) + textRaw(原始 ANSI)', () => {
    const event = {
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'task-progress',
      statusText: '\x1b[32mRunning\x1b[0m 3/5',
    }

    const results = translate(event, 'sess-1')

    // status-set 中间事件：保留 text + textRaw
    const statusSet = results.find(r => r.kind === 'status-set') as
      PiTranslatedEvent & { kind: 'status-set'; text: string; textRaw?: string } | undefined
    expect(statusSet).toBeDefined()
    expect(statusSet!.key).toBe('task-progress')
    expect(statusSet!.text).toBe('Running 3/5')
    expect(statusSet!.textRaw).toBe('\x1b[32mRunning\x1b[0m 3/5')

    // status-broadcast WS 帧：payload 含 text + textRaw
    const broadcast = results.find(r => r.kind === 'status-broadcast') as
      { kind: 'status-broadcast'; message: { type: string; payload: Record<string, unknown> } } | undefined
    expect(broadcast).toBeDefined()
    expect(broadcast!.message.type).toBe('extension:status')
    const payload = broadcast!.message.payload as { statusKey: string; text: string; textRaw?: string }
    expect(payload.statusKey).toBe('task-progress')
    expect(payload.text).toBe('Running 3/5')
    expect(payload.textRaw).toBe('\x1b[32mRunning\x1b[0m 3/5')
  })

  it('statusText 无 ANSI → textRaw 仍携带原文（前端可自行决定是否使用）', () => {
    const event = {
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'plain',
      statusText: 'plain text status',
    }

    const results = translate(event, 'sess-1')

    const broadcast = results.find(r => r.kind === 'status-broadcast') as
      { kind: 'status-broadcast'; message: { type: string; payload: Record<string, unknown> } } | undefined
    expect(broadcast).toBeDefined()
    const payload = broadcast!.message.payload as { text: string; textRaw?: string }
    expect(payload.text).toBe('plain text status')
    expect(payload.textRaw).toBe('plain text status')
  })
})

describe('event-adapter: handleToolExecutionEnd outputRaw', () => {
  it('result.content 含 ANSI → outputRaw 保留原始 ANSI', () => {
    const result = {
      content: [{ type: 'text', text: '\x1b[32msuccess\x1b[0m' }],
      details: { __gui__: { v: 1, component: { type: 'task-list', props: { items: [] } } } },
    }
    const event = makeToolEndEvent('tc-1', result)

    const results = translate(event, 'sess-1')

    const tcEnd = results.find(r => r.kind === 'tool-call-end') as
      PiTranslatedEvent & { kind: 'tool-call-end'; output: string; outputRaw?: string; details?: Record<string, unknown> }

    expect(tcEnd).toBeDefined()
    // output 已 stripAnsi
    expect(tcEnd.output).toBe('success')
    // outputRaw 保留原始 ANSI
    expect(tcEnd.outputRaw).toBe('\x1b[32msuccess\x1b[0m')
    // details 透传
    expect(tcEnd.details?.__gui__).toBeDefined()
  })
})
