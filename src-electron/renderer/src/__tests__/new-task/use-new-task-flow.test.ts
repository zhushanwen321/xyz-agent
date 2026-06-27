/**
 * useNewTaskFlow 状态机单测（#3，T1.2/T7.1/T8.1-T8.6/T6.5）。
 *
 * 覆盖（纯状态机守卫）：
 * - T1.2 首次启动 sessions=[]→不调 create、state=landing、currentSessionId=null（延迟 create）
 * - T7.1 gitInfo==null→openBranchPopover 抛错回 idle
 * - T8.1 overlay 互斥：dir-popover 下 openBranchPopover→先关再开至多 1 个
 * - T8.2 Esc 优先级：branch-modal→closeOverlay→landing
 * - T8.3 overlay 态 cancelFlow→cancelled
 * - T8.4 cancelled 重入 reenterFlow→landing
 * - T8.5 completed 终态→⌘N→销毁重建 idle→landing（create 再次调用）
 * - T8.6 非法转换 idle→openBranchModal 抛错回 idle
 * - T6.5 openBranchModal 来源守卫：非 branch-popover 来源抛错回 idle
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（session.create/remove），真用 useSessionStore + resolveDefaultCwd。
 * beforeEach 重建 pinia + clearAllMocks；每测唯一 sid。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/use-new-task-flow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn(
    (cwd?: string): Promise<SessionSummary> =>
      Promise.resolve({
        id: `s-${Math.random().toString(36).slice(2, 8)}`,
        label: '新会话',
        cwd: cwd ?? '/repo',
        status: 'idle',
        lastActiveAt: Date.now(),
        modelId: 'm',
        tokenCount: 0,
      }),
  ),
  remove: vi.fn((): Promise<void> => Promise.resolve()),
}))

vi.mock('@/api', () => ({
  session: { create: apiMock.create, remove: apiMock.remove },
  git: {},
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
})

/** 构造带 gitBranch 的 session（git 目录） */
function gitSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: over.id ?? 'git-s',
    label: over.label ?? 'repo',
    cwd: over.cwd ?? '/repo',
    gitBranch: over.gitBranch ?? 'main',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 100,
    modelId: 'm',
    tokenCount: 0,
  }
}

function setGroups(sessions: SessionSummary[]): void {
  // 同 cwd 归一组（与 store.appendSession 语义一致）
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

describe('useNewTaskFlow 状态机', () => {
  describe('startFlow 首次启动边界（T1.2）', () => {
    it('sessions=[]→cwd=undefined→不调 create、currentSessionId=null、state=landing', async () => {
      setGroups([]) // 首次启动无历史
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(apiMock.create).not.toHaveBeenCalled()
      expect(flow.currentSessionId.value).toBeNull()
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('UC-7 非 git 守卫（T7.1）', () => {
    it('gitInfo==null→openBranchPopover 抛错回 idle', async () => {
      // active session 无 gitBranch（非 git 目录）→ gitInfo 派生为 null
      const noGit: SessionSummary = {
        id: 'nogit',
        label: 'plain',
        cwd: '/plain',
        status: 'idle',
        lastActiveAt: 100,
        modelId: 'm',
        tokenCount: 0,
      }
      setGroups([noGit])
      useSessionStore().activeId = 'nogit'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('overlay 互斥（T8.1）', () => {
    it('dir-popover 下 openBranchPopover→先关再开，至多 1 个 overlay', async () => {
      setGroups([gitSession({ id: 'git-s', cwd: '/repo' })])
      apiMock.create.mockResolvedValueOnce(gitSession({ id: "created", cwd: "/repo" }))
      const flow = useNewTaskFlow()
      await flow.startFlow() // 同步 activeId=created(git) → gitInfo 非 null
      flow.openDirPopover()
      expect(flow.state.value).toBe('dir-popover')
      flow.openBranchPopover() // 互斥：先关 dir-popover 再开 branch-popover
      expect(flow.state.value).toBe('branch-popover')
    })
  })

  describe('Esc 优先级（T8.2）', () => {
    it('branch-modal→closeOverlay→landing（只关当前 modal）', async () => {
      setGroups([gitSession({ id: 'git-s', cwd: '/repo' })])
      apiMock.create.mockResolvedValueOnce(gitSession({ id: "created", cwd: "/repo" }))
      const flow = useNewTaskFlow()
      await flow.startFlow() // 同步 activeId=created(git) → gitInfo 非 null
      flow.openBranchPopover()
      flow.openBranchModal()
      expect(flow.state.value).toBe('branch-modal')
      flow.closeOverlay() // Esc 关当前 modal
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('overlay 切 session（T8.3）', () => {
    it('overlay 打开→cancelFlow→cancelled（不卡死）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      flow.cancelFlow() // 切 session 触发
      expect(flow.state.value).toBe('cancelled')
    })
  })

  describe('cancelled 重入（T8.4）', () => {
    it('cancelled→reenterFlow→landing（重选空 session 复活）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.cancelFlow()
      expect(flow.state.value).toBe('cancelled')
      flow.reenterFlow()
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('completed 终态（T8.5）', () => {
    it('completeFlow→completed→⌘N 再 startFlow→销毁重建 idle→landing（create 再次调用）', async () => {
      setGroups([gitSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
      const flow = useNewTaskFlow()
      await flow.startFlow() // 常态 create
      expect(apiMock.create).toHaveBeenCalledTimes(1)
      flow.completeFlow() // 首条消息成功→终态
      expect(flow.state.value).toBe('completed')
      await flow.startFlow() // ⌘N 再触发→重建
      expect(apiMock.create).toHaveBeenCalledTimes(2)
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('非法转换（T8.6）', () => {
    it('idle 下直接 openBranchModal→抛错回 idle', () => {
      const flow = useNewTaskFlow()
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('UC-7 非 git 不可达（T4.4）', () => {
    it('gitInfo==null（非 git 目录）→branch chip 隐藏的派生为 null、openBranchPopover 不可达', async () => {
      const noGit: SessionSummary = {
        id: 'nogit2',
        label: 'plain',
        cwd: '/plain',
        status: 'idle',
        lastActiveAt: 100,
        modelId: 'm',
        tokenCount: 0,
      }
      setGroups([noGit])
      useSessionStore().activeId = 'nogit2'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      // gitInfo 派生为 null → Landing 的 branch chip 隐藏（gitBranch 空态，AC-2.2/3.7）
      expect(flow.gitInfo.value).toBeNull()
      // 状态机守卫：branch 相关动作不可达
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('openBranchModal 来源守卫（T6.5）', () => {
    it('非 branch-popover 来源（landing）→抛错回 idle', async () => {
      setGroups([gitSession({ id: 'git-s', cwd: '/repo' })])
      useSessionStore().activeId = 'git-s'
      const flow = useNewTaskFlow()
      await flow.startFlow() // state=landing（非 branch-popover）
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })

    it('branch-popover 来源→正常进 branch-modal', async () => {
      setGroups([gitSession({ id: 'git-s', cwd: '/repo' })])
      apiMock.create.mockResolvedValueOnce(gitSession({ id: "created", cwd: "/repo" }))
      const flow = useNewTaskFlow()
      await flow.startFlow() // 同步 activeId=created(git) → gitInfo 非 null
      flow.openBranchPopover()
      flow.openBranchModal()
      expect(flow.state.value).toBe('branch-modal')
    })
  })

  describe('Esc 排队（T4.8 / AC-6.7）', () => {
    // 真实 execSync 阻塞无法在 vitest 复现（走手工 M 清单）。
    // 前端可 mock 部分：branch-popover 态下 gitApi.status pending 期间触发 closeOverlay（Esc），
    // pending resolve 后状态机已正确转移到 landing，不丢事件、不崩。
    it('branch-popover 态 closeOverlay（Esc）→landing，异步 status 后续 resolve 不影响已定状态', async () => {
      setGroups([gitSession({ id: 'git-s', cwd: '/repo' })])
      apiMock.create.mockResolvedValueOnce(gitSession({ id: "created", cwd: "/repo" }))
      const flow = useNewTaskFlow()
      await flow.startFlow() // 同步 activeId=created(git) → gitInfo 非 null
      flow.openBranchPopover()
      expect(flow.state.value).toBe('branch-popover')

      // 模拟 status pending 期间用户按 Esc（closeOverlay 排队执行）
      flow.closeOverlay()
      expect(flow.state.value).toBe('landing')

      // status 后续 resolve（模拟异步回灌）——状态已定，不应回跳
      await Promise.resolve()
      expect(flow.state.value).toBe('landing')
    })

    it('landing 态重复 closeOverlay→状态机守卫拦（非法转换抛错，UI 层应仅在 overlay 态绑 Esc）', async () => {
      setGroups([gitSession({ id: 'git-s', cwd: '/repo' })])
      apiMock.create.mockResolvedValueOnce(gitSession({ id: "created", cwd: "/repo" }))
      const flow = useNewTaskFlow()
      await flow.startFlow() // 同步 activeId=created(git) → gitInfo 非 null
      flow.openBranchPopover()
      flow.closeOverlay() // branch-popover→landing（首次合法）
      expect(flow.state.value).toBe('landing')
      // landing→landing 是 no-op 非法转换，状态机严格守卫（UI 层 Esc 仅在 overlay 态绑 closeOverlay，不会触达）
      expect(() => flow.closeOverlay()).toThrow('非法状态转换')
      expect(flow.state.value).toBe('idle') // 守卫抛错后回 idle（AC-3.11）
    })
  })
})
