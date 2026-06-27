/**
 * useNewTaskFlow 状态机单测（#3，需求修正后「统一延迟 create」语义）。
 *
 * 覆盖（纯状态机守卫）：
 * - T1.2 startFlow→不调 create、state=landing、currentSessionId=null（统一延迟 create）
 * - T7.1 gitInfo==null→openBranchPopover 抛错回 idle
 * - T8.3 overlay 态 cancelFlow→cancelled
 * - T8.4 cancelled 重入 reenterFlow→landing
 * - T8.5 completed 终态→⌘N→销毁重建 idle→landing（startFlow 不 create，只 transition）
 * - T8.6 非法转换 idle→openBranchModal 抛错回 idle
 * - T6.5 openBranchModal 来源守卫：非 branch-popover 来源抛错回 idle
 *
 * 新设计下 landing 态 gitInfo 恒 null（统一延迟 create 后无 session）→
 * branch-popover/branch-modal 不可达。原 overlay 互斥（T8.1）、Esc 优先级（T8.2）、
 * branch-modal 来源正向、Esc 排队（T4.8）等依赖 branch 链路的测试已删（场景不可达）。
 * branch 组件层单测见 create-branch-modal.test.ts。
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
    it('landing 态 currentSession=null→gitInfo 派生 null→openBranchPopover 抛错回 idle', async () => {
      // 统一延迟 create：landing 态无绑定 session → gitInfo 恒 null（与目录是否 git 无关）
      setGroups([
        {
          id: 'git-history',
          label: 'repo',
          cwd: '/repo',
          gitBranch: 'main',
          status: 'idle',
          lastActiveAt: 100,
          modelId: 'm',
          tokenCount: 0,
        },
      ])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  // 新设计下 landing 态 gitInfo 恒 null → branch-popover/branch-modal 不可达，
  // 原 overlay 互斥（T8.1）/ Esc 优先级（T8.2）依赖 branch 链路的测试已删（场景不可达）。

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
    it('completeFlow→completed→⌘N 再 startFlow→销毁重建 idle→landing（startFlow 不 create，只 transition）', async () => {
      setGroups([gitSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
      const flow = useNewTaskFlow()
      await flow.startFlow() // 统一延迟 create：不调 create
      expect(apiMock.create).not.toHaveBeenCalled()
      flow.completeFlow() // 首条消息成功→终态
      expect(flow.state.value).toBe('completed')
      await flow.startFlow() // ⌘N 再触发→销毁重建
      expect(apiMock.create).not.toHaveBeenCalled() // startFlow 仍不 create
      expect(flow.state.value).toBe('landing')
      expect(flow.currentSessionId.value).toBeNull() // 重建后清空
    })
  })

  describe('非法转换（T8.6）', () => {
    it('idle 下直接 openBranchModal→抛错回 idle', () => {
      const flow = useNewTaskFlow()
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('landing 态 branch 不可达（T4.4）', () => {
    it('landing 态 currentSession=null→gitInfo 恒 null→branch chip 隐藏 + openBranchPopover 守卫不可达', async () => {
      // 即便历史 session 是 git 目录，landing 态 currentSession=null → gitInfo 派生 null
      setGroups([
        {
          id: 'git-history',
          label: 'repo',
          cwd: '/repo',
          gitBranch: 'main',
          status: 'idle',
          lastActiveAt: 100,
          modelId: 'm',
          tokenCount: 0,
        },
      ])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      // 状态机守卫：branch 相关动作在 landing 态不可达
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('openBranchModal 来源守卫（T6.5）', () => {
    it('非 branch-popover 来源（landing）→抛错回 idle', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow() // state=landing（非 branch-popover）
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })

    // 新设计下 landing→branch-popover 不可达（gitInfo null 守卫），
    // 「branch-popover 来源→正常进 branch-modal」正向用例已删（场景不可达）。
  })

  // 新设计下 landing 态 branch 链路不可达（gitInfo 恒 null），
  // 原 Esc 排队（T4.8）依赖 branch-popover 的测试已删（场景不可达）。

  /**
   * isActive 派生语义锁定：landing + 全部 overlay 态 → true（Workspace 渲染守卫依赖，
   * 延迟 create 下活跃期间 activeId=null 但须保持 Landing 挂载）；idle/completed/cancelled → false。
   * 防护：未来改状态枚举时若误把活跃态从集合移除，Workspace 守卫会静默回退到卸载 Landing，
   * 本块立刻红。
   */
  describe('isActive 派生（Workspace 渲染守卫真相源）', () => {
    it('idle → false（异常兜底态，无 session 无活跃 flow）', () => {
      const flow = useNewTaskFlow()
      expect(flow.state.value).toBe('idle')
      expect(flow.isActive.value).toBe(false)
    })

    it('landing → true（首次启动延迟 create，activeId=null 但须显示 Landing）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.state.value).toBe('landing')
      expect(flow.isActive.value).toBe(true)
    })

    it('dir-popover → true（点 directory chip 进 overlay，Landing 须保持挂载）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      expect(flow.state.value).toBe('dir-popover')
      expect(flow.isActive.value).toBe(true)
    })

    it('cancelled → false（overlay 打开时切 session，AC-3.10）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      flow.cancelFlow()
      expect(flow.state.value).toBe('cancelled')
      expect(flow.isActive.value).toBe(false)
    })

    it('cancelled → reenterFlow → landing → isActive 回 true（重选空 session 复活）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.cancelFlow()
      expect(flow.isActive.value).toBe(false)
      flow.reenterFlow()
      expect(flow.state.value).toBe('landing')
      expect(flow.isActive.value).toBe(true)
    })

    it('completed → false（首发成功终态，已绑定 activeId，由 hasSession 接管渲染）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.completeFlow()
      expect(flow.state.value).toBe('completed')
      expect(flow.isActive.value).toBe(false)
    })
  })
})
