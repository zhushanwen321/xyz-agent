/**
 * Landing 态 isBareWorkspace 由 pendingCwd 驱动（W2 wave）。
 *
 * 背景：旧实现 Landing.vue 的 isBareWorkspace = flow.gitInfo.value?.isBare，而 gitInfo
 * 从**已绑定 session**（currentSession）派生。landing 态无 session → gitInfo=null →
 * isBare 恒 false → 即使 pendingCwd 指向 bare workspace，DirSelectPopover 也不显示
 * 「新建 worktree…」入口。
 *
 * W2 解法：isBare 改由 pendingCwd 驱动——useNewTaskDirSelect 新增 isBare ref，
 * watch pendingCwd 变化时调 workspace.detectBare(cwd)（runtime WorkspaceDetector 检测
 * .bare 命中），结果回填 isBare。Landing.vue 改读 composable 的 isBare（而非 gitInfo）。
 *
 * 红灯原因（实现未写，TDD 红灯合理）：
 * 1. useNewTaskDirSelect 未 export isBare ref → 解构 isBare 为 undefined → .value 报错
 * 2. 未 import/watch workspace.detectBare → mock 的 detectBare 不被调
 *
 * 用例（LB-1/2/3）：
 * - LB-1: pendingCwd='/bare/ws' 且 detectBare 返 isBare:true → isBare.value === true
 * - LB-2: pendingCwd='/normal' 且 detectBare 返 isBare:false → isBare.value === false
 * - LB-3: pendingCwd=null → 不调 detectBare，isBare.value === false（兜底）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/landing-isbare-pending-cwd.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// mock workspaceStore（useNewTaskDirSelect 内部 useWorkspaceStore）
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  record: vi.fn().mockResolvedValue([]),
  load: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

// mock lib/ipc.pickDirectory（openDirDialog 会调，避免真实 IPC）
vi.mock('@/lib/ipc', () => ({
  pickDirectory: vi.fn().mockResolvedValue({ canceled: true, path: '' }),
}))

// mock workspace API 域：detectBare 是 W2 新增（当前未实现，mock 给可控返回）
const workspaceApiMock = vi.hoisted(() => ({
  detectBare: vi.fn<(cwd: string) => Promise<{ isBare: boolean; wsRoot: string; barePath: string }>>(),
}))

vi.mock('@/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api')
  return {
    ...actual,
    workspace: {
      ...(actual.workspace as object),
      listRecent: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue([]),
      detectBare: workspaceApiMock.detectBare,
    },
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  workspaceStoreMock.record.mockResolvedValue([])
})

describe('useNewTaskDirSelect — isBare 由 pendingCwd 驱动（W2）', () => {
  it('LB-1: pendingCwd 指向 bare workspace 且 detectBare 返 isBare:true → isBare.value===true', async () => {
    const { resetNewTaskFlow } = await import('@/composables/features/useNewTaskFlow')
    const { useNewTaskFlowState } = await import('@/composables/new-task/useNewTaskFlowState')
    resetNewTaskFlow()
    const { pendingCwd } = useNewTaskFlowState()

    const { useNewTaskDirSelect } = await import('@/composables/new-task/useNewTaskDirSelect')
    const dirSelect = useNewTaskDirSelect(() => pendingCwd.value)

    // isBare 是 W2 新增的 export，实现未写时为 undefined → 此处解构失败/报错（红灯信号）
    const isBare = (dirSelect as { isBare?: { value: boolean } }).isBare
    expect(isBare, 'useNewTaskDirSelect 应 export isBare ref').toBeDefined()

    workspaceApiMock.detectBare.mockResolvedValue({
      isBare: true,
      wsRoot: '/code/xyz-agent-workspace',
      barePath: '/code/xyz-agent-workspace/.bare',
    })

    // pendingCwd 变化触发 watch → 调 detectBare → 回填 isBare
    pendingCwd.value = '/code/xyz-agent-workspace/fix-x'
    // 等待 watch（flush:post 或 pre）+ async detectBare resolve
    await vi.waitFor(() => {
      expect(workspaceApiMock.detectBare).toHaveBeenCalledWith('/code/xyz-agent-workspace/fix-x')
    })
    await vi.waitFor(() => {
      expect(isBare!.value).toBe(true)
    })
  })

  it('LB-2: pendingCwd 普通目录且 detectBare 返 isBare:false → isBare.value===false', async () => {
    const { resetNewTaskFlow } = await import('@/composables/features/useNewTaskFlow')
    const { useNewTaskFlowState } = await import('@/composables/new-task/useNewTaskFlowState')
    resetNewTaskFlow()
    const { pendingCwd } = useNewTaskFlowState()

    const { useNewTaskDirSelect } = await import('@/composables/new-task/useNewTaskDirSelect')
    const dirSelect = useNewTaskDirSelect(() => pendingCwd.value)
    const isBare = (dirSelect as { isBare?: { value: boolean } }).isBare
    expect(isBare, 'useNewTaskDirSelect 应 export isBare ref').toBeDefined()

    workspaceApiMock.detectBare.mockResolvedValue({ isBare: false, wsRoot: '', barePath: '' })

    pendingCwd.value = '/normal/project'
    await vi.waitFor(() => {
      expect(workspaceApiMock.detectBare).toHaveBeenCalledWith('/normal/project')
    })
    await vi.waitFor(() => {
      expect(isBare!.value).toBe(false)
    })
  })

  it('LB-3: pendingCwd=null → 不调 detectBare，isBare.value===false（兜底）', async () => {
    const { resetNewTaskFlow } = await import('@/composables/features/useNewTaskFlow')
    const { useNewTaskFlowState } = await import('@/composables/new-task/useNewTaskFlowState')
    resetNewTaskFlow()
    const { pendingCwd } = useNewTaskFlowState()

    const { useNewTaskDirSelect } = await import('@/composables/new-task/useNewTaskDirSelect')
    const dirSelect = useNewTaskDirSelect(() => pendingCwd.value)
    const isBare = (dirSelect as { isBare?: { value: boolean } }).isBare
    expect(isBare, 'useNewTaskDirSelect 应 export isBare ref').toBeDefined()

    // pendingCwd 保持 null（resetNewTaskFlow 已置 null），watch 不应触发 detectBare
    pendingCwd.value = null
    // 让可能的 watch flush 跑完
    await new Promise((r) => setTimeout(r, 0))

    expect(workspaceApiMock.detectBare).not.toHaveBeenCalled()
    expect(isBare!.value).toBe(false)
  })
})
