/**
 * F1 修复测试：message-converter toolResult 分支透传 details 字段
 *
 * 验证重开 session 后 __gui__ 数据不丢失（规则 7.5）。
 */

import { describe, it, expect } from 'vitest'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'

describe('message-converter: F1 toolResult details 透传', () => {
  it('toolResult 含 details.__gui__ → toolCall.details 包含 __gui__', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'toolCall', id: 'tc-1', name: 'todo', arguments: { action: 'list' } },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'todo',
        isError: false,
        content: [{ type: 'text', text: 'Task list updated' }],
        details: {
          __gui__: {
            v: 1,
            component: { type: 'task-list', props: { items: [{ id: 1, text: 'test', status: 'completed' }] } },
          },
          action: 'list',
          todos: [{ id: 1, text: 'test', status: 'completed' }],
        },
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)

    // 找到 assistant 消息
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.toolCalls).toBeDefined()
    expect(assistant!.toolCalls).toHaveLength(1)

    const tc = assistant!.toolCalls![0]
    expect(tc.id).toBe('tc-1')
    expect(tc.output).toBe('Task list updated')
    // ★ 核心断言：details 透传，含 __gui__
    expect(tc.details).toBeDefined()
    expect(tc.details?.__gui__).toBeDefined()
    const gui = tc.details?.__gui__ as { v: number; component: { type: string } }
    expect(gui.v).toBe(1)
    expect(gui.component.type).toBe('task-list')
    // extension 自身的 details 字段也保留
    expect(tc.details?.action).toBe('list')
  })

  it('toolResult 无 details → toolCall.details 不设置', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-2', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'file1\nfile2' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const assistant = messages.find(m => m.role === 'assistant')
    const tc = assistant!.toolCalls![0]
    expect(tc.details).toBeUndefined()
  })

  it('toolResult details 为数组 → 不透传（防 Array 当 object）', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-3', name: 'test', arguments: {} },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-3',
        toolName: 'test',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        details: [{ unexpected: 'array' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const assistant = messages.find(m => m.role === 'assistant')
    const tc = assistant!.toolCalls![0]
    // 数组型 details 不透传（与 event-adapter handleToolExecutionEnd 的 !Array.isArray 约束一致）
    expect(tc.details).toBeUndefined()
  })
})

describe('message-converter: outputRaw 历史恢复（对称实时路径）', () => {
  it('toolResult content 含 ANSI → output 存 stripAnsi 版本，outputRaw 存原始', () => {
    const ansiText = '\x1b[32mgreen\x1b[0m text'
    const history = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-raw-1', name: 'bash', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-raw-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: ansiText }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const tc = messages.find(m => m.role === 'assistant')!.toolCalls![0]
    // output 是 stripAnsi 后的纯文本
    expect(tc.output).toBe('green text')
    // outputRaw 保留原始 ANSI（对称实时路径，规则 7.5）
    expect(tc.outputRaw).toBe(ansiText)
  })

  it('toolResult content 不含 ANSI → outputRaw 不设置', () => {
    const history = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-raw-2', name: 'bash', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-raw-2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'plain text' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const tc = messages.find(m => m.role === 'assistant')!.toolCalls![0]
    expect(tc.output).toBe('plain text')
    expect(tc.outputRaw).toBeUndefined()
  })
})
