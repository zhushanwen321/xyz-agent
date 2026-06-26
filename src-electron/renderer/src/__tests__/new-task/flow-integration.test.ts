/**
 * useNewTaskFlow 主流程 + 选目录/选分支集成测试（#1+#3+#4+#5+#6，
 * T1.1/T1.3/T1.4/T1.5 + T3.1/T3.3/T3.4/T3.5/T4.1前端/T4.2）。
 *
 * 集成边界：mock 最外层 @/api（session.create/remove + git.checkout）+ lib/ipc（pickDirectory），
 * 不 mock 内部 composable/store/resolveDefaultCwd/recentWorkspaces。验证跨层数据流。
 *
 * 覆盖（选目录 #5）：
 * - T3.1 selectWorkspace(cwd)：cwd 变→delete 空旧+create 新→state=landing 且 chip 回灌；cwd 未变→noop
 * - T3.3 openDirDialog：pickDirectory canceled=false→delete 旧+create(newCwd)→chip 回灌新 cwd
 * - T3.4 openDirDialog：canceled=true→落回 dir-popover，chip 不变，不调 delete/create
 * - T3.5 E5 IPC 抛错：pickDirectory reject→startFlow reject 显错不崩、state 不卡死
 * 覆盖（选分支 #6）：
 * - T4.1 前端 selectBranch(name)→gitApi.checkout→state=landing
 * - T4.2 confirmDirtySwitch(name)→gitApi.checkout（留工作区，不 stash）→state=landing
 * 覆盖（创建分支 #7）：
 * - T6.1 前端 submitCreateBranch(name)→gitApi.createBranch→state=landing
 * - T6.6 飞行中重复点击→in-flight 守卫 createBranch 只调一次
 * - T6.7 飞行中 Esc→孤儿 promise 忽略不重复 transition 不回灌 chip
 * - T6.3 前端 createBranch reject→留 branch-modal（D-7）错误向上抛
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/flow-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// 可控依赖：测试按需让 create/pickDirectory/checkout pending/resolve/reject
const createCtrl = vi.hoisted(() => ({
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>(),
  remove: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const gitCtrl = vi.hoisted(() => ({
  checkout: vi.fn<(sessionId: string, name: string) => Promise<void>>().mockResolvedValue(undefined),
  createBranch: vi.fn<(sessionId: string, name: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const pickCtrl = vi.hoisted(() => ({
  pickDirectory: vi.fn<() => Promise<{ canceled: boolean; path: string | null }>>(),
}))

vi.mock('@/api', () => ({
  session: { create: createCtrl.create, remove: createCtrl.remove },
  git: { checkout: gitCtrl.checkout, createBranch: gitCtrl.createBranch },
}))
vi.mock('@/lib/ipc', () => ({ pickDirectory: pickCtrl.pickDirectory }))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
  createCtrl.remove.mockResolvedValue(undefined)
  gitCtrl.checkout.mockResolvedValue(undefined)
  gitCtrl.createBranch.mockResolvedValue(undefined)
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

describe('选目录链路（selectWorkspace / openDirDialog，#5）', () => {
  it('T3.1 列表选择 cwd 变→delete 空旧+create 新→state=landing 且 chip 回灌', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 100 })])
    createCtrl.create.mockResolvedValue(mkSession({ id: 'cur', cwd: '/last-repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow() // state=landing, currentCwd=/last-repo
    expect(flow.state.value).toBe('landing')
    flow.openDirPopover() // landing→dir-popover
    expect(flow.state.value).toBe('dir-popover')

    // 选一个不同的 workspace
    createCtrl.create.mockResolvedValue(mkSession({ id: 'new-2', cwd: '/other-repo' }))
    await flow.selectWorkspace('/other-repo')
    expect(createCtrl.remove).toHaveBeenCalledWith('cur') // delete 空旧
    expect(createCtrl.create).toHaveBeenCalledWith('/other-repo')
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/other-repo') // chip 回灌新 cwd
  })

  it('T3.1 cwd 未变→noop（仅关 popover，不调 delete/create）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValue(mkSession({ id: 'cur', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    createCtrl.remove.mockClear()
    createCtrl.create.mockClear()
    await flow.selectWorkspace('/repo') // 同 cwd
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing') // 仅关 popover
  })
})

describe('OS dialog 分支（openDirDialog，#5）', () => {
  it('T3.3 pickDirectory canceled=false→delete 旧+create(newCwd)→chip 回灌新 cwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValue(mkSession({ id: 'cur', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockResolvedValue({ canceled: false, path: '/picked-dir' })
    createCtrl.create.mockResolvedValue(mkSession({ id: 'picked', cwd: '/picked-dir' }))
    await flow.openDirDialog()
    expect(createCtrl.remove).toHaveBeenCalledWith('cur')
    expect(createCtrl.create).toHaveBeenCalledWith('/picked-dir')
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/picked-dir')
  })

  it('T3.4 pickDirectory canceled=true→落回 dir-popover，chip 不变，不调 delete/create', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValue(mkSession({ id: 'cur', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockResolvedValue({ canceled: true, path: null })
    createCtrl.remove.mockClear()
    createCtrl.create.mockClear()
    await flow.openDirDialog()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('dir-popover') // 落回
    expect(flow.currentCwd.value).toBe('/repo') // chip 不变
  })

  it('T3.5 E5 pickDirectory reject→openDirDialog reject 显错不崩、state 落回不卡死', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValue(mkSession({ id: 'cur', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockRejectedValue(new Error('getFocusedWindow null'))
    await expect(flow.openDirDialog()).rejects.toThrow('getFocusedWindow null')
    // 显错向上抛（调用方接 toast），state 不卡在 dir-dialog
    expect(flow.state.value).not.toBe('dir-dialog')
  })
})

describe('选分支链路（selectBranch / confirmDirtySwitch，#6）', () => {
  it('T4.1 selectBranch(name)→gitApi.checkout(sessionId,name)→state=landing', async () => {
    setGroups([
      mkSession({ id: 'old', cwd: '/repo', gitBranch: 'main', lastActiveAt: 1 }),
    ])
    const created = mkSession({ id: 'cur', cwd: '/repo', gitBranch: 'main' })
    createCtrl.create.mockResolvedValue(created)
    const flow = useNewTaskFlow()
    await flow.startFlow()
    // startFlow 创建的 session 需进 store，否则 session.active 为 null → gitInfo null（useSidebar.selectSession 负责此步）
    const store = useSessionStore()
    store.appendSession(created)
    store.activeId = 'cur'
    flow.openBranchPopover() // landing→branch-popover（gitInfo 非 null）
    expect(flow.state.value).toBe('branch-popover')

    await flow.selectBranch('feature/x')
    expect(gitCtrl.checkout).toHaveBeenCalledWith('cur', 'feature/x')
    expect(flow.state.value).toBe('landing')
  })

  it('T4.2 confirmDirtySwitch(name)→gitApi.checkout（留工作区，不 stash）→state=landing', async () => {
    setGroups([
      mkSession({ id: 'old', cwd: '/repo', gitBranch: 'main', lastActiveAt: 1 }),
    ])
    const created = mkSession({ id: 'cur', cwd: '/repo', gitBranch: 'main' })
    createCtrl.create.mockResolvedValue(created)
    const flow = useNewTaskFlow()
    await flow.startFlow()
    const store = useSessionStore()
    store.appendSession(created)
    store.activeId = 'cur'
    flow.openBranchPopover()

    await flow.confirmDirtySwitch('feature/y')
    expect(gitCtrl.checkout).toHaveBeenCalledWith('cur', 'feature/y')
    // v1 选「留在工作区」：不调任何 stash 相关 api（git 域无 stash 方法，checkout 由 git 默认携带未提交改动）
    expect(flow.state.value).toBe('landing')
  })

  it('T4.5(前端) checkout reject→留 branch-popover 显错，state 不进 landing', async () => {
    setGroups([
      mkSession({ id: 'old', cwd: '/repo', gitBranch: 'main', lastActiveAt: 1 }),
    ])
    const created = mkSession({ id: 'cur', cwd: '/repo', gitBranch: 'main' })
    createCtrl.create.mockResolvedValue(created)
    const flow = useNewTaskFlow()
    await flow.startFlow()
    const store = useSessionStore()
    store.appendSession(created)
    store.activeId = 'cur'
    flow.openBranchPopover()
    gitCtrl.checkout.mockRejectedValue(new Error('checkout conflict'))
    await expect(flow.selectBranch('feature/z')).rejects.toThrow('checkout conflict')
    expect(flow.state.value).toBe('branch-popover') // 留 popover 显错
  })
})

describe('创建分支链路（submitCreateBranch，#7）', () => {
  /** 进 branch-modal 态（复用：startFlow→landing→openBranchPopover→openBranchModal） */
  async function toBranchModal(): Promise<void> {
    setGroups([mkSession({ id: 'old', cwd: '/repo', gitBranch: 'main', lastActiveAt: 1 })])
    const created = mkSession({ id: 'cur', cwd: '/repo', gitBranch: 'main' })
    createCtrl.create.mockResolvedValue(created)
    const flow = useNewTaskFlow()
    await flow.startFlow()
    const store = useSessionStore()
    store.appendSession(created)
    store.activeId = 'cur'
    flow.openBranchPopover()
    flow.openBranchModal()
    expect(flow.state.value).toBe('branch-modal')
  }

  it('T6.1 submitCreateBranch(合法名)→gitApi.createBranch→state=landing', async () => {
    await toBranchModal()
    const flow = useNewTaskFlow()
    await flow.submitCreateBranch('feat/new')
    expect(gitCtrl.createBranch).toHaveBeenCalledWith('cur', 'feat/new')
    expect(flow.state.value).toBe('landing')
  })

  it('T6.6 飞行中重复点击→in-flight 守卫，createBranch 只调一次', async () => {
    await toBranchModal()
    const flow = useNewTaskFlow()
    let resolveCreate!: () => void
    gitCtrl.createBranch.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveCreate = r
      }),
    )
    const p1 = flow.submitCreateBranch('feat/a')
    const p2 = flow.submitCreateBranch('feat/a') // 飞行中守卫→直接 return
    resolveCreate()
    await Promise.all([p1, p2])
    expect(gitCtrl.createBranch).toHaveBeenCalledTimes(1)
  })

  it('T6.7 飞行中 Esc→孤儿 promise 忽略，不重复 transition 不回灌', async () => {
    await toBranchModal()
    const flow = useNewTaskFlow()
    let resolveCreate!: () => void
    gitCtrl.createBranch.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveCreate = r
      }),
    )
    const p = flow.submitCreateBranch('feat/orphan') // 不 await，飞行中
    flow.closeOverlay() // Esc→branch-modal→landing
    expect(flow.state.value).toBe('landing')
    resolveCreate() // 后台 promise resolve
    await p
    // 孤儿 promise 忽略：state 仍 landing（未重复 transition 抛错），不回灌
    expect(flow.state.value).toBe('landing')
  })

  it('T6.3(前端) createBranch reject→留 branch-modal（D-7），错误向上抛', async () => {
    await toBranchModal()
    const flow = useNewTaskFlow()
    gitCtrl.createBranch.mockRejectedValue(new Error('branch exists'))
    await expect(flow.submitCreateBranch('feat/dup')).rejects.toThrow('branch exists')
    expect(flow.state.value).toBe('branch-modal') // D-7 留 modal 可重试
  })
})
