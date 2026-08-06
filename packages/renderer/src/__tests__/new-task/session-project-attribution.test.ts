/**
 * useNewTaskFlow 归属 project 透传测试（D14 语义修正 2026-08-04：session 创建时归属 activeProject）。
 *
 * 用户主诉求回归防护：在命名 project 下新建任务 → create 请求携带 projectId →
 * runtime 写 sidecar → 切回该 project 时 session 列表能看到。
 *
 * mock 策略：与 use-new-task-flow.test.ts 同套（vi.hoisted + vi.mock('@/api')），
 * 真用 useProjectStore（默认 project name='' → 不传 projectId）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/session-project-attribution.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn(
    (cwd?: string, _label?: string, _presetId?: string, projectId?: string): Promise<SessionSummary> =>
      Promise.resolve({
        id: `s-${Math.random().toString(36).slice(2, 8)}`,
        label: '新会话',
        cwd: cwd ?? '/repo',
        status: 'idle',
        lastActiveAt: Date.now(),
        modelId: 'm',
        tokenCount: 0,
        projectId: projectId || undefined,
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
  // 否则 projectId 读取旧 pinia 的 projectStore（dedup 测试红过）
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

describe('useNewTaskFlow: create 透传归属 projectId（D14 语义修正）', () => {
  it('命名 project 下新建任务 → create 第 4 参数携带 activeProjectId', async () => {
    const projectStore = useProjectStore()
    projectStore.addProject('Test') // 命名 project 成为 active
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('修 bug'))

    expect(apiMock.create).toHaveBeenCalledTimes(1)
    expect(apiMock.create).toHaveBeenCalledWith('/repo', '修 bug', undefined, projectStore.activeProjectId)
  })

  it('默认项目下新建任务 → create 第 4 参数为 undefined（未归类，不写 sidecar）', async () => {
    // localStorage 空 → 默认 project name=''
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('修 bug'))

    expect(apiMock.create).toHaveBeenCalledTimes(1)
    expect(apiMock.create).toHaveBeenCalledWith('/repo', '修 bug', undefined, undefined)
  })

  it('切到另一个命名 project 后新建 → 携带新 project id', async () => {
    const projectStore = useProjectStore()
    const a = projectStore.addProject('A')
    projectStore.addProject('B')
    projectStore.setActiveProject(a)
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('任务一'))

    expect(apiMock.create).toHaveBeenCalledWith('/repo', '任务一', undefined, a)
  })

  it('create 失败（空 content guard 返回 null）→ 无 create 调用', async () => {
    const projectStore = useProjectStore()
    projectStore.addProject('Test')
    setGroups('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments(''))

    expect(apiMock.create).not.toHaveBeenCalled()
  })
})
