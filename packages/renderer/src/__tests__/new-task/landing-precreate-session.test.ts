/**
 * Landing 选目录延迟 create 单测。
 *
 * 设计原意是「延迟 create」：选目录只记 pendingCwd（chip 回灌所见即所得），
 * session 由首发提交 submitFirstMessage 创建。曾因 slash 浮层在 landing 无命令源，
 * 临时改为「选目录即预创建 session」取 pi get_commands 真实命令。
 *
 * 本次改动：CommandPopover 双源（session 态用 commandStore，landing 态用
 * settingsStore.skills 全局扫描），landing slash 浮层不再依赖预建 session，
 * 故恢复延迟 create 原设计——避免空 session 堆积。
 *
 * 验证：
 * - 选目录不 create session（currentSessionId 恒 null）
 * - 重选目录只更新 pendingCwd（不删旧建新，因无旧 session）
 * - 选目录后首发提交才 create（pendingCwd 作为 create 的 cwd）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/landing-precreate-session.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn((cwd?: string): Promise<SessionSummary> => Promise.resolve({
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    label: '新会话',
    cwd: cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'm',
    tokenCount: 0,
  })),
  remove: vi.fn((): Promise<void> => Promise.resolve()),
}))

vi.mock('@/api', () => ({
  session: { create: apiMock.create, remove: apiMock.remove },
  // submitFirstMessage → useFileTree.loadTree 调 fileApi.tree/gitApi.status（Promise.allSettled）；给空返回避免 unhandled rejection
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  workspace: { record: vi.fn().mockResolvedValue([]), listRecent: vi.fn().mockResolvedValue([]) },
}))

// mock useChat.send（submitFirstMessage 会调）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ send: vi.fn(() => Promise.resolve()), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(), compact: vi.fn() }),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
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
    id: over.id ?? 's', label: over.label ?? 'label', cwd: over.cwd ?? '/repo',
    status: 'idle', lastActiveAt: 0, modelId: 'm', tokenCount: 0, ...over,
  }
}

/** dir-popover 态选目录（真实路径：startFlow→landing→openDirPopover→selectWorkspace） */
async function pickDir(flow: ReturnType<typeof useNewTaskFlow>, cwd: string): Promise<void> {
  flow.openDirPopover()
  await flow.selectWorkspace(cwd)
}

describe('Landing 选目录延迟 create（不预建 session）', () => {
  it('U4: selectWorkspace 选目录 → 不 create，只记 pendingCwd（currentSessionId 恒 null）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    expect(flow.currentSessionId.value).toBeNull()

    await pickDir(flow, '/my-project')

    expect(apiMock.create).not.toHaveBeenCalled() // 延迟 create：不建 session
    expect(flow.currentSessionId.value).toBeNull() // 恒 null
    expect(flow.currentCwd.value).toBe('/my-project') // chip 回灌 pendingCwd
  })

  it('U4b: selectWorkspace 重选不同目录 → 只更新 pendingCwd（无旧 session 可删）', async () => {
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await pickDir(flow, '/repo-a')
    expect(flow.currentCwd.value).toBe('/repo-a')

    await pickDir(flow, '/repo-b')

    expect(apiMock.create).not.toHaveBeenCalled() // 始终不建
    expect(apiMock.remove).not.toHaveBeenCalled() // 无旧 session 可删
    expect(flow.currentCwd.value).toBe('/repo-b') // pendingCwd 更新
    expect(flow.currentSessionId.value).toBeNull()
  })

  it('U4c: selectWorkspace 选同目录 → noop（不重复操作，仅关 popover）', async () => {
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/repo') // 首次记
    expect(flow.currentCwd.value).toBe('/repo')

    flow.openDirPopover()
    await flow.selectWorkspace('/repo') // 同值 noop

    expect(apiMock.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing') // 仅关 popover
    expect(flow.currentCwd.value).toBe('/repo')
  })

  it('U5: 选目录后首发提交 → 才 create session（pendingCwd 作为 create cwd）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/elsewhere', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await pickDir(flow, '/picked') // 只记 pendingCwd
    expect(apiMock.create).not.toHaveBeenCalled()

    await flow.submitFirstMessage('hello')

    // 首发提交才 create，用 pendingCwd（/picked）而非 resolveDefaultCwd（/elsewhere）；label='hello'（≤10 原文）
    expect(apiMock.create).toHaveBeenCalledTimes(1)
    expect(apiMock.create).toHaveBeenCalledWith('/picked', 'hello')
  })
})
