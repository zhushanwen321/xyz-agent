/**
 * TC-1..TC-4：useSidebarNew 接缝 composable 集成测试（w5）。
 *
 * TC-1 selectSession 全编排（renderer 专属步骤 + core 步骤时序，关键不变量：ensureStreamSubscription
 *   先于 panel.loadSession；hydrate 首次触发二次跳过；focusedSessionId 派生）
 * TC-2 deleteSession 代理 core（S3 hooks 调用 + wasActive 回退）
 * TC-3 loadSessions 双分支（成功填 groups / 失败 setListLoadError）
 * TC-4 返回签名对齐 useSidebar（含全字段 + toggleCollapse/goOverview 行为）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useSidebarNew.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'
import { useSidebarStore } from '@/stores/sidebar'
import { useNavigationStore } from '@/stores/navigation'

// vi.hoisted 保证 mock fn 在 vi.mock factory（hoisted 到顶部）执行时已初始化
const mocks = vi.hoisted(() => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
  ensureStreamSub: vi.fn(),
  loadTree: vi.fn(),
  cancelFlow: vi.fn(),
  startFlow: vi.fn().mockResolvedValue(undefined),
}))

// ── api 层 mock ──
vi.mock('@/api/domains/session', () => ({
  switchSession: mocks.switchSession,
  list: mocks.list,
  remove: mocks.remove,
  create: vi.fn(),
  rename: vi.fn(),
  removeByCwd: vi.fn(),
  migrateImage: vi.fn(),
  writeSegments: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/api/domains/chat', () => ({
  getHistory: mocks.getHistory,
  send: vi.fn(),
  streamSubscribe: vi.fn(),
}))
vi.mock('@/api/events', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  const chat = await import('@/api/domains/chat')
  return { ...actual, session, chat }
})

// ── useChat composable mock（ensureStreamSubscription spy + useChat stubs）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: vi.fn(() => ({
    setHistoryTruncated: vi.fn(),
    disposeSession: vi.fn(),
  })),
  ensureStreamSubscription: mocks.ensureStreamSub,
}))
// ── useFileTree mock（loadTree fire-forget spy）──
vi.mock('@/composables/features/file-tree/useFileTree', () => ({ useFileTree: vi.fn(() => ({ loadTree: mocks.loadTree })) }))
// ── useNewTaskFlow mock（isActive/cancelFlow/startFlow/currentSession controllable）──
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: vi.fn(() => ({
    isActive: { value: false },
    cancelFlow: mocks.cancelFlow,
    startFlow: mocks.startFlow,
    currentSession: { value: null },
    presetCwd: vi.fn(),
  })),
}))
// ── fork/handoff mock（正交职责，stub 即可）──
vi.mock('@/composables/features/fork-handoff/useForkActions', () => ({
  useForkActions: () => ({
    forkSession: vi.fn(),
    forkSessionAsk: vi.fn(),
    forkFromLastAssistant: vi.fn(),
    enterForkModeFromLastAssistant: vi.fn(),
  }),
}))
vi.mock('@/composables/features/fork-handoff/useHandoffActions', () => ({
  useHandoffActions: () => ({
    handoff: vi.fn(),
    abortHandoff: vi.fn(),
    handoffFromLastAssistant: vi.fn(),
    enterHandoffModeFromLastAssistant: vi.fn(),
  }),
}))
// registerAppCommands 经 commandStore（真实），不需 mock

import { useSidebarNew, resetSidebarNewForTest } from '@/composables/features/sidebar/useSidebarNew'

function summary(id: string, cwd = '/a'): SessionSummary {
  return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1, modelId: '' }
}
function group(sessions: SessionSummary[], cwd = '/a'): SessionGroup {
  return { cwd, label: cwd, sessions }
}

describe('useSidebarNew 接缝（TC-1..TC-4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetSidebarNewForTest()
    vi.clearAllMocks()
  })

  it('TC-1 selectSession 全编排：ensureStreamSubscription 先于 panel.loadSession；首次 hydrate；focusedSessionId 派生', async () => {
    const sidebar = useSidebarNew()
    // seed 接缝本地 store（C-W5-5 raw createSessionStore 实例）
    sidebar.__testStore.setGroups([group([summary('s1'), summary('s2')])])
    // panel 绑定模拟：selectSession 内 syncSessionToPanel 调 panel.loadSession(activePanelId, id)
    // focusedSessionId 读 panel.focusedSessionId（= active panel leaf.sessionId）

    await sidebar.selectSession('s2')

    // 关键不变量（C-W3-4）：ensureStreamSubscription 调用且先于 panel 载入
    expect(mocks.ensureStreamSub).toHaveBeenCalledWith('s2', expect.anything(), expect.anything())
    // switchSession api 调用
    expect(mocks.switchSession).toHaveBeenCalledWith('s2')
    // 接缝本地 store activeId 更新（C-W5-5 raw store .value 生效）
    expect(sidebar.__testStore.activeId.value).toBe('s2')
    // 首次 hydrate：getHistory 调用
    expect(mocks.getHistory).toHaveBeenCalledWith('s2')
    // 文件树预加载 fire-forget
    expect(mocks.loadTree).toHaveBeenCalledWith('s2')
    // panel 载入后 focusedSessionId 派生为 s2
    expect(sidebar.focusedSessionId.value).toBe('s2')

    // 二次 selectSession 同 sid：isHydrated 守卫→getHistory 不重复调
    mocks.getHistory.mockClear()
    await sidebar.selectSession('s2')
    expect(mocks.getHistory).not.toHaveBeenCalled()
  })

  it('TC-1b flow 活跃时切 session → cancelFlow（AC-3.10）', async () => {
    const { useNewTaskFlow } = await import('@/composables/features/new-task/useNewTaskFlow')
    vi.mocked(useNewTaskFlow).mockReturnValueOnce({
      isActive: { value: true },
      cancelFlow: mocks.cancelFlow,
      startFlow: mocks.startFlow,
      currentSession: { value: null },
      presetCwd: vi.fn(),
    } as unknown as ReturnType<typeof useNewTaskFlow>)
    const sidebar = useSidebarNew()
    sidebar.__testStore.setGroups([group([summary('s1')])])

    await sidebar.selectSession('s1')

    expect(mocks.cancelFlow).toHaveBeenCalledTimes(1)
  })

  it('TC-2 deleteSession 代理 core：api.remove 调 + S3 清理 + wasActive 回退 selectSession', async () => {
    const removeMock = (await import('@/api/domains/session')).remove as ReturnType<typeof vi.fn>
    removeMock.mockResolvedValue(undefined)
    const sidebar = useSidebarNew()
    sidebar.__testStore.setGroups([group([summary('s1'), summary('s2')])])
    // 先 select s1 使其 active（触发 wasActive 回退路径）
    await sidebar.selectSession('s1')
    mocks.switchSession.mockClear()

    await sidebar.deleteSession('s1')

    // api.remove 调
    expect(removeMock).toHaveBeenCalledWith('s1')
    // wasActive 回退：selectSession(s2) → switchSession('s2')
    expect(mocks.switchSession).toHaveBeenCalledWith('s2')
    // s1 从列表移除
    expect(sidebar.__testStore.list.value.find((s) => s.id === 's1')).toBeUndefined()
  })

  it('TC-3 loadSessions 成功填 groups 清 error；失败 setListLoadError 不抛', async () => {
    const sidebar = useSidebarNew()
    mocks.list.mockResolvedValueOnce([group([summary('s1')])])
    await sidebar.loadSessions()
    expect(sidebar.__testStore.list.value.length).toBe(1)
    expect(sidebar.__testStore.listLoadError.value).toBeNull()

    // 失败分支
    mocks.list.mockRejectedValueOnce(new Error('rpc down'))
    await sidebar.loadSessions()
    expect(sidebar.__testStore.listLoadError.value).toBe('rpc down')
  })

  it('TC-4 返回签名对齐 useSidebar（含全字段）+ toggleCollapse/goOverview 行为', () => {
    const sidebar = useSidebarNew()
    const keys = Object.keys(sidebar).filter((k) => k !== '__testStore')
    const expected = [
      'focusedSessionId', 'focusedSession', 'selectSession', 'newSession', 'retryHistory',
      'goOverview', 'loadSessions', 'initApp', 'onConnected', 'toggleCollapse',
      'syncSessionToPanel', 'renameSession', 'deleteSession', 'deleteFolder',
      'forkSession', 'forkSessionAsk', 'forkFromLastAssistant', 'enterForkModeFromLastAssistant',
      'handoff', 'abortHandoff', 'handoffFromLastAssistant', 'enterHandoffModeFromLastAssistant',
    ]
    for (const k of expected) {
      expect(keys, `返回对象应含字段 ${k}`).toContain(k)
    }

    // toggleCollapse 翻转 sidebar.collapsed
    const sidebarStore = useSidebarStore()
    const before = sidebarStore.collapsed
    sidebar.toggleCollapse()
    expect(sidebarStore.collapsed).toBe(!before)

    // goOverview → navigation.push({view:'overview'})
    const navigation = useNavigationStore()
    sidebar.goOverview()
    expect(navigation.current.view).toBe('overview')
  })
})
