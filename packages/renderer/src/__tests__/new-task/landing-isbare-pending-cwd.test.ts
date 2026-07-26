/**
 * Landing 态 isBareWorkspace 由 pendingCwd 驱动（W2 wave）。
 *
 * 背景：旧实现 Landing.vue 的 isBareWorkspace = flow.gitInfo.value?.isBare，而 gitInfo
 * 从**已绑定 session**（currentSession）派生。landing 态无 session → gitInfo=null →
 * isBare 恒 false → 即使 pendingCwd 指向 bare workspace，DirSelectPopover 也不显示
 * 「新建 worktree…」入口。
 *
 * W2 解法：isBare 改由 pendingCwd 驱动——useNewTaskDirSelect 新增 isBare ref，
 * watch pendingCwd 变化时调 workspace.detect(cwd)（runtime WorkspaceDetector 检测
 * 三态），结果回填 isBare（mode === 'bare-workspace'）。Landing.vue 改读 composable 的 isBare（而非 gitInfo）。
 *
 * 用例（LB-1/2/3）：
 * - LB-1: pendingCwd='/bare/ws' 且 detect 返 mode:'bare-workspace' → isBare.value === true
 * - LB-2: pendingCwd='/normal' 且 detect 返 mode:'plain-repo' → isBare.value === false
 * - LB-3: pendingCwd=null → 不调 detect，isBare.value === false（兜底）
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

// mock workspace API 域：detect 是 W2 新增的三态检测
const workspaceApiMock = vi.hoisted(() => ({
  detect: vi.fn<(cwd: string) => Promise<{ mode: 'bare-workspace' | 'plain-repo' | 'not-repo'; wsRoot: string; barePath: string; repoRoot: string; defaultBranch: string }>>(),
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
      detect: workspaceApiMock.detect,
      detectBare: workspaceApiMock.detectBare,
    },
  }
})

// mock worktreeApi.list（useNewTaskDirSelect 会调）
vi.mock('@/api/domains/worktree', () => ({
  worktreeApi: {
    list: vi.fn().mockResolvedValue({ items: [] }),
    listBranches: vi.fn().mockResolvedValue({ local: [], remote: [], defaultBranch: 'main' }),
    create: vi.fn(),
  },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  workspaceStoreMock.record.mockResolvedValue([])
})

describe('useNewTaskDirSelect — isBare 由 pendingCwd 驱动（W2）', () => {
  it('LB-1: pendingCwd 指向 bare workspace 且 detect 返 mode:bare-workspace → isBare.value===true', async () => {
    const { resetNewTaskFlow } = await import('@/composables/features/useNewTaskFlow')
    const { useNewTaskFlowState } = await import('@/composables/new-task/useNewTaskFlowState')
    resetNewTaskFlow()
    const { pendingCwd } = useNewTaskFlowState()

    const { useNewTaskDirSelect } = await import('@/composables/new-task/useNewTaskDirSelect')
    const dirSelect = useNewTaskDirSelect(() => pendingCwd.value)

    const isBare = (dirSelect as { isBare?: { value: boolean } }).isBare
    expect(isBare, 'useNewTaskDirSelect 应 export isBare ref').toBeDefined()

    workspaceApiMock.detect.mockResolvedValue({
      mode: 'bare-workspace',
      wsRoot: '/code/xyz-agent-workspace',
      barePath: '/code/xyz-agent-workspace/.bare',
      repoRoot: '/code/xyz-agent-workspace',
      defaultBranch: 'main',
    })

    // pendingCwd 变化触发 watch → 调 detect → 回填 isBare
    pendingCwd.value = '/code/xyz-agent-workspace/fix-x'
    await vi.waitFor(() => {
      expect(workspaceApiMock.detect).toHaveBeenCalledWith('/code/xyz-agent-workspace/fix-x')
    })
    await vi.waitFor(() => {
      expect(isBare!.value).toBe(true)
    })
  })

  it('LB-2: pendingCwd 普通目录且 detect 返 mode:plain-repo → isBare.value===false', async () => {
    const { resetNewTaskFlow } = await import('@/composables/features/useNewTaskFlow')
    const { useNewTaskFlowState } = await import('@/composables/new-task/useNewTaskFlowState')
    resetNewTaskFlow()
    const { pendingCwd } = useNewTaskFlowState()

    const { useNewTaskDirSelect } = await import('@/composables/new-task/useNewTaskDirSelect')
    const dirSelect = useNewTaskDirSelect(() => pendingCwd.value)
    const isBare = (dirSelect as { isBare?: { value: boolean } }).isBare
    expect(isBare, 'useNewTaskDirSelect 应 export isBare ref').toBeDefined()

    workspaceApiMock.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/normal/project',
      defaultBranch: 'main',
    })

    pendingCwd.value = '/normal/project'
    await vi.waitFor(() => {
      expect(workspaceApiMock.detect).toHaveBeenCalledWith('/normal/project')
    })
    await vi.waitFor(() => {
      expect(isBare!.value).toBe(false)
    })
  })

  it('LB-3: pendingCwd=null → 不调 detect，isBare.value===false（兜底）', async () => {
    const { resetNewTaskFlow } = await import('@/composables/features/useNewTaskFlow')
    const { useNewTaskFlowState } = await import('@/composables/new-task/useNewTaskFlowState')
    resetNewTaskFlow()
    const { pendingCwd } = useNewTaskFlowState()

    const { useNewTaskDirSelect } = await import('@/composables/new-task/useNewTaskDirSelect')
    const dirSelect = useNewTaskDirSelect(() => pendingCwd.value)
    const isBare = (dirSelect as { isBare?: { value: boolean } }).isBare
    expect(isBare, 'useNewTaskDirSelect 应 export isBare ref').toBeDefined()

    // pendingCwd 保持 null（resetNewTaskFlow 已置 null），watch 不应触发 detect
    pendingCwd.value = null
    await new Promise((r) => setTimeout(r, 0))

    expect(workspaceApiMock.detect).not.toHaveBeenCalled()
    expect(isBare!.value).toBe(false)
  })
})
