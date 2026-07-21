/**
 * R1 真实 flow 数据链路集成测试（review R1/R9）。
 *
 * worktree-integration.test.ts 把 useNewTaskFlow 整体 mock，直接注入 isBare:true ——
 * 绕过了真实数据路径（SessionSummary.isBareWorkspace → gitInfo computed → Landing isBareWorkspace →
 * DirSelectPopover action-create-worktree 渲染）。三视角事故同构反模式：mock 恰好掩盖了
 * gitInfo computed 不填 isBare 的 bug，测试全绿但生产环境入口永不显示。
 *
 * 本文件用**真实 useNewTaskFlow**（非 mock），驱动完整链路：
 *   submitFirstMessage create → runtime 返回带 isBareWorkspace 的 SessionSummary
 *   → controller.bindCurrentSession → gitInfo computed 派生 isBare
 *   → 传 isBare 给真实 DirSelectPopover → action-create-worktree 渲染
 *
 * 覆盖：
 * - RF-1: runtime session.isBareWorkspace=true → 真实 flow gitInfo.isBare=true + DirSelectPopover 渲染 action
 * - RF-2: runtime session.isBareWorkspace=false → gitInfo.isBare=false + action 不渲染
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/worktree-real-flow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, RecentWorkspaceRecord } from '@xyz-agent/shared'

// ── api mock：session.create 控制返回的 SessionSummary（含 isBareWorkspace）──
// 真实 flow 经 sessionApi.create 拿到 runtime 摘要 → bindCurrentSession。不 mock useNewTaskFlow。
const sessionCreateMock = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/api', () => ({
  session: {
    create: sessionCreateMock.create,
    remove: vi.fn().mockResolvedValue(undefined),
    // PR #87：submitFirstMessage 现调 sessionApi.getCommands（兜底拉取 slash 命令）；
    // loadSubagents/loadWorkflows 也在首发路径内。给空返回避免 unhandled rejection。
    getCommands: vi.fn().mockResolvedValue({ commands: [] }),
    getSubagents: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
  },
  // submitFirstMessage → useFileTree.loadTree / useSubagentStore / useWorkflowStore fire-and-forget
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  chat: { send: vi.fn().mockResolvedValue(undefined), streamSubscribe: (): (() => void) => () => {} },
}))

// ── workspaceStore mock：submitFirstMessage 兜底 cwd 用 defaultCwd ──
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as RecentWorkspaceRecord[],
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
  record: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import DirSelectPopover from '@/components/new-task/DirSelectPopover.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
})

/** 构造带 gitBranch + isBareWorkspace 的 session（模拟 runtime WorkspaceDetector 检测后的摘要）。 */
function mkSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: over.id ?? 'bare-s',
    label: over.label ?? 'repo',
    cwd: over.cwd ?? '/ws/feat-a',
    gitBranch: over.gitBranch ?? 'feat-a',
    isBareWorkspace: over.isBareWorkspace,
    status: 'idle',
    lastActiveAt: 1,
    modelId: 'm',
    tokenCount: 0,
  }
}

describe('RF-1: 真实 flow — session.isBareWorkspace=true → gitInfo.isBare=true + action 渲染', () => {
  it('submitFirstMessage create 绑定 bare session → flow.gitInfo.isBare 派生 true → DirSelectPopover 显 action-create-worktree', async () => {
    // 模拟 runtime create 返回带 isBareWorkspace:true 的 session（WorkspaceDetector 检测 .bare 命中）
    sessionCreateMock.create.mockResolvedValueOnce(mkSession({ isBareWorkspace: true }))
    workspaceStoreMock.defaultCwd = '/ws/feat-a'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage('bare workspace')

    // 真实数据链路断言（非 mock 注入）：gitInfo.isBare 从 session.isBareWorkspace 派生
    expect(flow.gitInfo.value).not.toBeNull()
    expect(flow.gitInfo.value?.isBare).toBe(true)

    // 真实组件渲染链路：把真实 flow.gitInfo.isBare 传给 DirSelectPopover（与 Landing.vue 同逻辑）
    const wrapper = mount(DirSelectPopover, {
      props: {
        currentCwd: null,
        isBareWorkspace: flow.gitInfo.value?.isBare ?? false,
      },
    })
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(true)
  })
})

describe('RF-2: 真实 flow — session.isBareWorkspace=false → gitInfo.isBare=false + action 不渲染', () => {
  it('普通 git repo（isBareWorkspace=false）→ action-create-worktree 不渲染', async () => {
    sessionCreateMock.create.mockResolvedValueOnce(mkSession({ isBareWorkspace: false, cwd: '/repo', gitBranch: 'main' }))
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage('normal repo')

    expect(flow.gitInfo.value?.isBare).toBe(false)

    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null, isBareWorkspace: flow.gitInfo.value?.isBare ?? false },
    })
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(false)
  })

  it('session 无 isBareWorkspace 字段（旧 runtime）→ gitInfo.isBare 兜底 false → action 不渲染', async () => {
    // isBareWorkspace undefined → 兜底 false（与 Landing.vue `?? false` 一致）
    sessionCreateMock.create.mockResolvedValueOnce(mkSession({ isBareWorkspace: undefined, cwd: '/repo', gitBranch: 'main' }))
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage('no bare field')

    expect(flow.gitInfo.value?.isBare).toBe(false)

    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null, isBareWorkspace: flow.gitInfo.value?.isBare ?? false },
    })
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(false)
  })
})
