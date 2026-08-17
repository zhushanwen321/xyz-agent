/**
 * domain/chat bash-effects 迁移单测（语义等价锁定，w2 原样迁移）。
 *
 * 锁定 findLastStreamingBashIndex 语义：
 * - 从后往前找最后一条 bashExecution + streaming 的 system 消息
 * - 无则返回 -1
 *
 * （bashStartEffect/bashResultEffect/markBashError 依赖 MessageEffectContext + commitMessages，
 * 属 effect 编排层，行为锁定在 renderer 集成测试 chat-bash-effects.test.ts，本 core 测试聚焦纯查找函数。）
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@xyz-agent/shared'
import { findLastStreamingBashIndex } from '../bash-effects'

function bashMsg(status: Message['status'], extra: Partial<Message> = {}): Message {
  return {
    id: `bash-${Math.random().toString(36).slice(2)}`,
    role: 'system',
    content: '',
    status,
    bashExecution: {
      command: 'echo hi',
      output: '',
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 0,
    },
    ...extra,
  } as Message
}

describe('findLastStreamingBashIndex', () => {
  it('空列表返回 -1', () => {
    expect(findLastStreamingBashIndex([])).toBe(-1)
  })

  it('无 streaming bash 返回 -1', () => {
    const list: Message[] = [
      bashMsg('complete'),
      bashMsg('error'),
      { id: 'x', role: 'system', content: '', status: 'streaming' } as Message, // 非 bash
    ]
    expect(findLastStreamingBashIndex(list)).toBe(-1)
  })

  it('命中最后一条 streaming bash', () => {
    const list: Message[] = [
      bashMsg('streaming'),
      bashMsg('complete'), // 已完成的不算
      bashMsg('streaming'), // 这条才是最后一条 streaming
    ]
    expect(findLastStreamingBashIndex(list)).toBe(2)
  })

  it('非 streaming 状态的 bash 消息不算（status 必须为 streaming）', () => {
    const list: Message[] = [
      bashMsg('complete'),
      bashMsg('error'),
    ]
    expect(findLastStreamingBashIndex(list)).toBe(-1)
  })

  it('无 bashExecution 标记的 streaming 消息不算', () => {
    const list: Message[] = [
      { id: 'x', role: 'assistant', content: '', status: 'streaming' } as Message,
    ]
    expect(findLastStreamingBashIndex(list)).toBe(-1)
  })
})
