import { describe, it, expect } from 'vitest'
import type {
  SessionManagerSendResult,
  SessionManagerErrorResult,
} from './types'

/**
 * A7: SendResult 类型变更验证
 * 
 * 验证 SessionManagerSendResult 从 {blocked, rejected} 改为 {queued: true}
 * 旧形状应被类型系统拒绝（@ts-expect-error 验证）
 */
describe('A7 - SendResult 类型变更', () => {
  it('新形状 {queued: true} 可赋值给 SessionManagerSendResult', () => {
    const result: SessionManagerSendResult = { queued: true }
    expect(result.queued).toBe(true)
  })

  it('旧形状 {blocked: true, rejected: true} 应被类型系统拒绝', () => {
    // @ts-expect-error - 旧形状不应赋值给新类型
    const oldResult: SessionManagerSendResult = { blocked: true, rejected: true }
    expect(oldResult).toBeDefined()
  })

  it('错误形状 {error, hint} 仍兼容 SessionManagerErrorResult', () => {
    const errorResult: SessionManagerErrorResult = {
      error: 'session unreachable',
      hint: 'retry send_to_session after checking get_session_status',
    }
    expect(errorResult.error).toBe('session unreachable')
    expect(errorResult.hint).toContain('retry')
  })
})
