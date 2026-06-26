/**
 * useNewTaskFlow 主流程集成测试（#1+#3+#4，T1.1/T1.3/T1.4/T1.5）。
 *
 * 集成边界：mock 最外层 @/api（session.create/remove），不 mock 内部 composable/store/resolveDefaultCwd。
 * 验证 startFlow 全链路数据流：触发点→resolveDefaultCwd→create(cwd)→state=landing。
 *
 * 覆盖：
 * - T1.1 常态：startFlow→resolveDefaultCwd→create(cwd)→state=landing 且 chip 回灌（currentCwd）
 * - T1.3 E1 双击并发：create 飞行中再 startFlow→in-flight 守卫只 create 一次
 * - T1.4 E2 非法 cwd：create reject→显错（startFlow reject）不静默回退、state 不进 landing
 * - T1.5 E3 spawn 失败：create reject→不留僵尸（currentSessionId=null）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/flow-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// 可控 create：测试按需让它 pending / resolve / reject
const createCtrl = vi.hoisted(() => ({
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>(),
  remove: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
}))

vi.mock('@/api', () => ({
  session: { create: createCtrl.create, remove: createCtrl.remove },
  git: {},
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
  createCtrl.remove.mockResolvedValue(undefined)
})

function setGroups(sessions: SessionSummary[]): void {
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const arr = byCwd.get(s.cwd) ?? []
    arr.push(s)
    byCwd.set(s.cwd, arr)
  }
  useSessionStore().setGroups(
    Array.from(byCwd, ([cwd, ss]): SessionGroup => ({ cwd, sessions: ss })),
  )
}

function mkSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: over.id ?? 's',
    label: over.label ?? 'label',
    cwd: over.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 0,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

describe('⌘N 主流程（startFlow 全链路）', () => {
  it('T1.1 startFlow→resolveDefaultCwd→create(cwd)→state=landing 且 chip 回灌', async () => {
    setGroups([
      mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 100 }),
      mkSession({ id: 'recent', cwd: '/recent-repo', lastActiveAt: 900 }),
    ])
    createCtrl.create.mockResolvedValue(
      mkSession({ id: 'new-1', cwd: '/recent-repo' }),
    )
    const flow = useNewTaskFlow()
    await flow.startFlow()
    // resolveDefaultCwd 取最近活跃 cwd（lastActiveAt=900→/recent-repo）
    expect(createCtrl.create).toHaveBeenCalledWith('/recent-repo')
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBe('new-1')
    expect(flow.currentCwd.value).toBe('/recent-repo') // chip 回灌
  })

  it('T1.3 E1 双击并发→in-flight 守卫，create 只调一次', async () => {
    setGroups([mkSession({ id: 'x', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValue(mkSession({ id: 'solo', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await Promise.all([flow.startFlow(), flow.startFlow()])
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
  })

  it('T1.4 E2 非法 cwd→create reject→startFlow reject、state 不进 landing、currentSessionId=null', async () => {
    setGroups([mkSession({ id: 'x', cwd: '/etc/nonexistent', lastActiveAt: 1 })])
    createCtrl.create.mockRejectedValue(new Error('invalid cwd'))
    const flow = useNewTaskFlow()
    await expect(flow.startFlow()).rejects.toThrow('invalid cwd')
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
    expect(flow.state.value).toBe('idle') // 不静默回退到 landing
    expect(flow.currentSessionId.value).toBeNull() // 不留半创建态
  })

  it('T1.5 E3 spawn 失败→create reject→不留僵尸 session', async () => {
    setGroups([mkSession({ id: 'x', cwd: '/noperm', lastActiveAt: 1 })])
    createCtrl.create.mockRejectedValue(new Error('pi spawn failed'))
    const flow = useNewTaskFlow()
    await expect(flow.startFlow()).rejects.toThrow('pi spawn failed')
    // create reject → runtime 已回滚实体，前端不绑定僵尸 session
    expect(flow.currentSessionId.value).toBeNull()
    expect(flow.state.value).toBe('idle')
  })
})
