/**
 * useNewTaskFlow 自动归因测试（D14：新建 session 成功后 cwd 归入 activeProject）。
 *
 * 用户主诉求回归防护：在命名 project 下新建任务 → 目录自动归入该 project →
 * 切回该 project 时 session 列表能看到（SessionList 过滤消费 activeWorkspaceCwds）。
 *
 * mock 策略：与 use-new-task-flow.test.ts 同套（vi.hoisted + vi.mock('@/api')），
 * 真用 useProjectStore（localStorage 默认 project name='' → addWorkspace 守卫不归因）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/session-project-attribution.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
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
  chatSend: vi.fn((): Promise<void> => Promise.resolve()),
  streamSubscribe: vi.fn((): (() => void) => () => {}),
  chatBash: vi.fn((): Promise<void> => Promise.resolve()),
  chatAbortBash: vi.fn((): Promise<void> => Promise.resolve()),
}))

vi.mock('@/api', () => ({
  session: { create: apiMock.create, remove: apiMock.remove, subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }), unsubscribe: vi.fn().mockResolvedValue(undefined), migrateImage: vi.fn().mockResolvedValue(undefined), writeSegments: vi.fn().mockResolvedValue(undefined) },
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  chat: { send: apiMock.chatSend, streamSubscribe: apiMock.streamSubscribe, bash: apiMock.chatBash, abortBash: apiMock.chatAbortBash },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))

const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
  record: vi.fn(),
}))

const toastMock = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastMock.error }),
}))

import { useNewTaskFlow, resetNewTaskFlow, __resetNewTaskFlowForTesting } from '@/composables/features/new-task/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'
import { useProjectStore } from '@/stores/project'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  // renderer 壳 cachedFlow 单例（捕获首次调用时的 pinia store）必须重建，
  // 否则归因写入旧 pinia 的 projectStore，断言读新 pinia 不一致（dedup 测试红过）
  __resetNewTaskFlowForTesting()
  vi.clearAllMocks()
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  localStorage.removeItem('xyz-agent:projects')
})

function setGroups(cwd: string): void {
  useSessionStore().setGroups([
    { cwd, sessions: [{ id: 'hist', label: 'hist', cwd, status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0 }] },
  ] as SessionGroup[])
}

describe('useNewTaskFlow: 新建 session 自动归因到 activeProject（D14）', () => {
  it('命名 project 下新建任务 → cwd 归入 activeProject.workspaces', async () => {
    const projectStore = useProjectStore()
    projectStore.addProject('Test') // 命名 project 成为 active
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('修 bug'))

    expect(apiMock.create).toHaveBeenCalledTimes(1)
    expect(projectStore.activeProject!.workspaces.map((w) => w.cwd)).toEqual(['/repo'])
    expect(projectStore.activeWorkspaceCwds).toEqual(['/repo'])
  })

  it('同目录重复建任务 → 不重复归因（dedup）', async () => {
    const projectStore = useProjectStore()
    projectStore.addProject('Test')
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('任务一'))
    // 第二个任务（同目录）——重建 flow（completed 终态需销毁重建，T8.5）
    resetNewTaskFlow()
    __resetNewTaskFlowForTesting()
    await useNewTaskFlow().startFlow()
    await useNewTaskFlow().submitFirstMessage(textToSegments('任务二'))

    expect(projectStore.activeProject!.workspaces).toHaveLength(1)
  })

  it('默认 project（name 空）→ 不归因（显示全部语义，workspaces 保持空）', async () => {
    const projectStore = useProjectStore()
    // localStorage 空 → 默认 project name=''
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('修 bug'))

    expect(projectStore.activeProject!.name).toBe('')
    expect(projectStore.activeProject!.workspaces).toHaveLength(0)
  })

  it('create 失败（返回 null）→ 不归因', async () => {
    const projectStore = useProjectStore()
    projectStore.addProject('Test')
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'
    // 空 content guard：createSessionFlow 对空 segments 返回 null
    const flow = useNewTaskFlow()
    await flow.startFlow()

    await flow.submitFirstMessage(textToSegments(''))

    expect(projectStore.activeProject!.workspaces).toHaveLength(0)
  })
})
