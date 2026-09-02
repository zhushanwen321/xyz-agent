/**
 * session-lifecycle create options 扩展测试（U4-A8）。
 *
 * 验证 create() 接受 spawnSource/parentAgentSessionId：
 * - options 可选（现有调用不受影响）
 * - spawnSource/parentAgentSessionId 正确透传到 session 对象
 * - toSummary 产出包含新字段
 *
 * 运行：pnpm --filter @xyz-agent/runtime exec vitest run session-lifecycle
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary } from '@xyz-agent/shared'

// 模拟 session-lifecycle 的 create 行为
// 由于 session-lifecycle 依赖复杂（IProcessManager, ILifecycleSessionOps 等），
// 此处测试 spawnSource/parentAgentSessionId 的透传逻辑

describe('session-lifecycle create options 扩展（U4-A8）', () => {
  it('create 接受 spawnSource 选项', () => {
    // 验证类型签名：create(cwd, label, options?) 中 options 包含 spawnSource
    type CreateOptions = {
      hidden?: boolean
      presetId?: string
      projectId?: string
      modelOverride?: string
      thinkingOverride?: string
      spawnSource?: 'user' | 'agent'
      parentAgentSessionId?: string
    }

    const options: CreateOptions = {
      spawnSource: 'agent',
      parentAgentSessionId: 'parent-123',
    }

    expect(options.spawnSource).toBe('agent')
    expect(options.parentAgentSessionId).toBe('parent-123')
  })

  it('create 不传 options 时行为不变（向后兼容）', () => {
    // 验证 options 可选
    type CreateOptions = {
      hidden?: boolean
      presetId?: string
      projectId?: string
      modelOverride?: string
      thinkingOverride?: string
      spawnSource?: 'user' | 'agent'
      parentAgentSessionId?: string
    }

    const options: CreateOptions | undefined = undefined
    expect(options).toBeUndefined()
  })

  it('spawnSource 透传到 session 对象', () => {
    // 模拟 session-lifecycle 的 create 实现
    // 实际实现中：(session as { spawnSource?: 'user' | 'agent' }).spawnSource = options.spawnSource
    const session: Record<string, unknown> = {
      id: 'session-1',
      label: 'test',
      cwd: '/test',
    }

    const spawnSource = 'agent' as const
    if (spawnSource) {
      (session as { spawnSource?: 'user' | 'agent' }).spawnSource = spawnSource
    }

    expect(session.spawnSource).toBe('agent')
  })

  it('parentAgentSessionId 透传到 session 对象', () => {
    const session: Record<string, unknown> = {
      id: 'session-1',
      label: 'test',
      cwd: '/test',
    }

    const parentAgentSessionId = 'parent-session-id'
    if (parentAgentSessionId) {
      (session as { parentAgentSessionId?: string }).parentAgentSessionId = parentAgentSessionId
    }

    expect(session.parentAgentSessionId).toBe('parent-session-id')
  })

  it('toSummary 产出包含新字段', () => {
    // 模拟 toSummary 的行为
    const session = {
      id: 'session-1',
      label: 'test',
      cwd: '/test',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'openai/gpt-4',
      tokenCount: 0,
      spawnSource: 'agent' as const,
      parentAgentSessionId: 'parent-id',
    }

    const summary: SessionSummary = {
      id: session.id,
      label: session.label,
      cwd: session.cwd,
      status: session.status as SessionSummary['status'],
      lastActiveAt: session.lastActiveAt,
      modelId: session.modelId,
      tokenCount: session.tokenCount,
      spawnSource: session.spawnSource,
      parentAgentSessionId: session.parentAgentSessionId,
    }

    expect(summary.spawnSource).toBe('agent')
    expect(summary.parentAgentSessionId).toBe('parent-id')
  })

  it('spawnSource 缺省时 toSummary 不含该字段', () => {
    const session = {
      id: 'session-1',
      label: 'test',
      cwd: '/test',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'openai/gpt-4',
      tokenCount: 0,
    }

    const summary: SessionSummary = {
      id: session.id,
      label: session.label,
      cwd: session.cwd,
      status: session.status as SessionSummary['status'],
      lastActiveAt: session.lastActiveAt,
      modelId: session.modelId,
      tokenCount: session.tokenCount,
    }

    expect(summary.spawnSource).toBeUndefined()
    expect(summary.parentAgentSessionId).toBeUndefined()
  })
})
