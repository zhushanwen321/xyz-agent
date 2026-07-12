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
import { GUI_WIDGET_MARKER, ASK_USER_MARKER } from '@xyz-agent/extension-protocol'
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

// ── 富交互：guiInteract marker 检测 + 普通 select options 透传（U6-U8）──

/** 辅助：构造 pi extension_ui_request{method:'select'} 事件 */
function makeSelectEvent(title: string, options: unknown[], id = 'req-x'): Record<string, unknown> {
  return {
    type: 'extension_ui_request',
    method: 'select',
    id,
    title,
    options,
  }
}

/** 辅助：从 translate 结果中提取 message 事件 */
function findMessage(results: PiTranslatedEvent[]):
  { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined {
  return results.find(r => r.kind === 'message') as
    { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined
}

/** 辅助：从 translate 结果中提取 extension-ui kind 事件 */
function findExtensionUi(results: PiTranslatedEvent[]): PiTranslatedEvent | undefined {
  return results.find(r => r.kind === 'extension-ui')
}

describe('event-adapter: ask-user ASK_USER_MARKER 检测 (U6-U8)', () => {
  it('U6: title=marker + options[0] 合法 JSON → 透传 questions + extension-ui kind 事件', () => {
    const questions = [{ header: 'db', question: '选哪个?', options: [{ label: 'PG' }] }]
    const payload = JSON.stringify({ questions, allowCancel: false })
    const event = makeSelectEvent(ASK_USER_MARKER, [payload], 'req-askuser')

    const results = translate(event, 'sess-1')

    // extension-ui kind 事件必须存在（timeout-manager 据此注册 5min 超时）
    const extUi = findExtensionUi(results)
    expect(extUi).toBeDefined()

    // message 帧：extension.ui_request + askUser=true + askUserQuestions 透传
    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.ui_request')
    expect(msg!.message.payload.askUser).toBe(true)
    expect(msg!.message.payload.method).toBe('select')
    expect(msg!.message.payload.requestId).toBe('req-askuser')
    expect(msg!.message.payload.askUserQuestions).toEqual(questions)
    expect(msg!.message.payload.allowCancel).toBe(false)
    // ask-user 分支不传 options（避免前端把 JSON payload 当下拉选项）
    expect(msg!.message.payload.options).toBeUndefined()
  })

  it('U7: 普通 select（title≠marker）→ options 透传 string[]（.map(String)，不拍扁）', () => {
    // pi select 真实格式：string[]，不是 {label,value} 对象数组
    const event = makeSelectEvent('Pick a color', ['red', 'green', 'blue'], 'req-normal')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.ui_request')
    expect(msg!.message.payload.method).toBe('select')
    expect(msg!.message.payload.title).toBe('Pick a color')
    // options 透传 string[]，不是 undefined[]（旧 .map(o=>o.label) bug）
    expect(msg!.message.payload.options).toEqual(['red', 'green', 'blue'])
    // 非 marker → 无 askUser 字段
    expect(msg!.message.payload.askUser).toBeUndefined()
  })

  it('U8: title=marker 但 options[0] 非法 JSON → 降级普通 select', () => {
    const event = makeSelectEvent(ASK_USER_MARKER, ['not-valid-json{'], 'req-bad')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.ui_request')
    expect(msg!.message.payload.method).toBe('select')
    // 降级为普通 select（无 askUser/askUserQuestions 字段）
    expect(msg!.message.payload.askUser).toBeUndefined()
    // options 经 .map(String) 透传
    expect(msg!.message.payload.options).toEqual(['not-valid-json{'])
  })

  it('U8: title=marker 但 options 为空数组 → 降级普通 select', () => {
    const event = makeSelectEvent(ASK_USER_MARKER, [], 'req-empty')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.askUser).toBeUndefined()
  })

  it('U6: confirm/input/editor 不受 marker 检测影响（method≠select 不进 marker 分支）', () => {
    const event = {
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-confirm',
      title: ASK_USER_MARKER,  // title 碰巧是 marker，但 method 不是 select
      message: 'sure?',
    }

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.method).toBe('confirm')
    expect(msg!.message.payload.askUser).toBeUndefined()
  })
})
